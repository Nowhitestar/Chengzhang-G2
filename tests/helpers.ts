/**
 * Tests run the real backend in-process, with an in-memory database and the
 * simulated AI (no network, no keys).
 */
process.env.MOCK_AI = "1";
process.env.MOCK_DELAY_MS = "0";
process.env.DATA_DIR = ":memory:";
delete process.env.ACCESS_CODE;
delete process.env.NOTION_TOKEN;

import type { Hono } from "hono";
import type { ArticleView } from "../shared/types.ts";
import { tone } from "./helpers-audio.ts";

export { tone };

const { createApp } = await import("../server/app.ts");
const { resetDbForTests } = await import("../server/db.ts");

export interface Client {
  app: Hono<any>;
  token: string;
  call: <T = any>(method: string, path: string, body?: unknown) => Promise<{ status: number; data: T }>;
  article: (id: string) => Promise<ArticleView>;
  until: (id: string, done: (a: ArticleView) => boolean) => Promise<ArticleView>;
  say: (articleId: string, seconds: number, purpose?: string, target?: string) => Promise<string>;
}

export async function newClient(lang = "en"): Promise<Client> {
  resetDbForTests();
  const app = createApp() as Hono<any>;
  let token = "";
  const call: Client["call"] = async (method, path, body) => {
    const binary = body instanceof Uint8Array;
    const res = await app.request(path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": binary ? "application/octet-stream" : "application/json" } : {}),
      },
      body: body === undefined ? undefined : binary ? (body as BodyInit) : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // plain text (the Markdown export)
    }
    return { status: res.status, data };
  };
  token = (await call<{ token: string }>("POST", "/api/session", { lang })).data.token;
  const article: Client["article"] = async (id) => (await call<ArticleView>("GET", `/api/articles/${id}`)).data;
  const until: Client["until"] = async (id, done) => {
    for (let i = 0; i < 400; i++) {
      const a = await article(id);
      if (done(a)) return a;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out waiting for the article");
  };
  const say: Client["say"] = async (articleId, seconds, purpose = "material", target = "") => {
    const rec = (await call<{ id: string }>("POST", `/api/articles/${articleId}/recordings`, { purpose, target })).data.id;
    // Two slices, to exercise joining.
    const half = tone(seconds / 2);
    await call("PUT", `/api/recordings/${rec}/chunks/0`, half);
    await call("PUT", `/api/recordings/${rec}/chunks/1`, half);
    await call("POST", `/api/recordings/${rec}/finish`, { chunks: 2, durationMs: seconds * 1000 });
    return rec;
  };
  return { app, token, call, article, until, say };
}
