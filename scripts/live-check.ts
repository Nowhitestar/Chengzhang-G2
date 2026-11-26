/**
 * One article through the real backend with real Claude, step by step.
 *
 *   npm run live                 (English interface)
 *   LANG_UI=zh npm run live      (Chinese interface; the material stays English)
 *
 * Speech-to-text is simulated (MOCK_STT): it returns the canned to-do-list talk,
 * which is word for word what the real recogniser returned for that take.
 * Everything else is real: tidy, research with web search, write, edit, answer.
 * One run costs real money; the token use of each step is printed at the end.
 */
if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENROUTER_API_KEY) {
  console.error(
    "No Claude key. Set ANTHROPIC_API_KEY (straight to Anthropic) or OPENROUTER_API_KEY,\n" +
      "in the environment or in .env, then run `npm run live` again.",
  );
  process.exit(1);
}
process.env.MOCK_STT = "1";
process.env.MOCK_DELAY_MS = "0";
process.env.DATA_DIR = ":memory:";
delete process.env.MOCK_AI;
delete process.env.MOCK_LLM;
delete process.env.ACCESS_CODE;
delete process.env.NOTION_TOKEN;

import type { Hono } from "hono";
import type { ArticleView } from "../shared/types.ts";
import type { CallUsage } from "../server/llm.ts";
import { tone } from "../tests/helpers-audio.ts";

const { createApp } = await import("../server/app.ts");
const { onUsage } = await import("../server/llm.ts");
const { config } = await import("../server/config.ts");
const { PROMPT_VERSION } = await import("../server/prompts.ts");

const lang = process.env.LANG_UI === "zh" ? "zh" : "en";
const usage: CallUsage[] = [];
onUsage((u) => usage.push(u));

const app = createApp() as Hono<any>;
let token = "";
async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
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
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text as T };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const article = async (id: string) => (await call<ArticleView>("GET", `/api/articles/${id}`)).data;
async function until(id: string, done: (a: ArticleView) => boolean, minutes = 10): Promise<ArticleView> {
  const end = Date.now() + minutes * 60_000;
  while (Date.now() < end) {
    const a = await article(id);
    if (done(a)) return a;
    await sleep(500);
  }
  throw new Error("timed out waiting for the article");
}
async function say(articleId: string, seconds: number, purpose = "material", target = ""): Promise<void> {
  const rec = (await call<{ id: string }>("POST", `/api/articles/${articleId}/recordings`, { purpose, target })).data.id;
  await call("PUT", `/api/recordings/${rec}/chunks/0`, tone(seconds));
  await call("POST", `/api/recordings/${rec}/finish`, { chunks: 1, durationMs: seconds * 1000 });
}

const line = "─".repeat(72);
function heading(name: string, started: number): void {
  console.log(`\n${line}\n${name}  (${((Date.now() - started) / 1000).toFixed(1)} s)\n${line}`);
}
function fail(what: string, detail: string): never {
  console.error(`\n✗ ${what}: ${detail}`);
  process.exit(1);
}
const openNotes = (a: ArticleView) => a.annotations.filter((n) => n.state === "open");

console.log(
  `Live check: ${config.llm.direct ? "Anthropic API" : "OpenRouter"} · write ${config.llm.model} · research ${config.llm.researchModel}` +
    ` · ${config.llm.searches} searches · prompts ${PROMPT_VERSION} · interface ${lang}`,
);

token = (await call<{ token: string }>("POST", "/api/session", { lang })).data.token;
const id = (await call<{ id: string }>("POST", "/api/articles")).data.id;

// 1. Talk for thirty seconds; the transcript is tidied by Claude.
let t0 = Date.now();
await say(id, 30);
let a = await until(id, (x) => x.recordings[0]?.status === "ready" || x.recordings[0]?.status === "failed");
heading("1. Recording → tidy", t0);
if (a.recordings[0]!.status === "failed") fail("tidy", a.recordings[0]!.error);
console.log(a.recordings[0]!.text);

// 2. Write it up: research with web search, then the article with notes.
t0 = Date.now();
await call("POST", `/api/articles/${id}/compose`);
a = await until(id, (x) => x.status === "ready" || x.status === "failed");
heading("2. Compose (research + write)", t0);
if (a.status === "failed") fail("compose", a.error);
console.log(`Title: ${a.title}`);
console.log(`Gist (${[...a.gist].length} chars): ${a.gist}`);
console.log(`\n${a.markdown}\n`);
for (const n of a.annotations) {
  console.log(`[${n.id}] ${n.kind}: ${n.note}`);
  if (n.suggestion) console.log(`     suggestion: ${n.suggestion}`);
  if (n.sourceUrl) console.log(`     source: ${n.sourceTitle} <${n.sourceUrl}>`);
}
if (!a.annotations.length) console.log("(no notes)");

// 3. Decide each note: use the correction, keep the addition, answer the question by voice.
t0 = Date.now();
heading("3. Decide each note", t0);
for (const n of openNotes(a)) {
  if (n.kind === "diff" || n.kind === "added") {
    const action = n.kind === "diff" ? "apply" : "keep";
    const res = await call<ArticleView>("POST", `/api/articles/${id}/annotations/${n.id}`, { action });
    if (res.status !== 200) fail(`${action} ${n.id}`, JSON.stringify(res.data));
    a = res.data;
    console.log(`[${n.id}] ${action} → ${a.annotations.find((x) => x.id === n.id)!.state}`);
  }
}
for (const n of openNotes(a).filter((x) => x.kind === "ask")) {
  const started = Date.now();
  await say(id, 2, "answer", n.id);
  a = await until(id, (x) => !x.revising && (x.annotations.find((y) => y.id === n.id)!.state !== "open" || x.revisionError !== ""));
  if (a.revisionError) fail(`answer ${n.id}`, a.revisionError);
  console.log(`[${n.id}] answered "${a.heard}" → ${a.annotations.find((x) => x.id === n.id)!.state} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  console.log(`     summary: ${a.lastChange}`);
}
// Deciding a note twice is refused, in the interface language (the backend's own words, no model).
const decided = a.annotations.find((n) => n.state !== "open");
if (decided) {
  const again = await call<{ error: string }>("POST", `/api/articles/${id}/annotations/${decided.id}`, { action: "keep" });
  console.log(`[${decided.id}] decided again → ${again.status}: ${again.data.error}`);
}
console.log(`\n${a.markdown}`);

// 4. A spoken change, then undo.
t0 = Date.now();
const before = a.markdown;
await say(id, 2, "instruction");
a = await until(id, (x) => !x.revising && (x.lastChange !== "" || x.revisionError !== ""));
heading("4. Spoken change: “Make the opening more direct.”", t0);
if (a.revisionError) fail("edit", a.revisionError);
console.log(`Heard: ${a.heard}\nSummary: ${a.lastChange}\n\n${a.markdown}`);
const undone = await call<ArticleView>("POST", `/api/articles/${id}/undo`);
console.log(`\nUndo: ${undone.status === 200 && undone.data.markdown === before ? "back to the text before the change" : `FAILED (${undone.status})`}`);

// Usage.
console.log(`\n${line}\nUsage\n${line}`);
let tin = 0;
let tout = 0;
let searches = 0;
for (const u of usage) {
  console.log(`${u.step.padEnd(9)} ${u.model.padEnd(20)} in ${String(u.tokensIn).padStart(7)}  out ${String(u.tokensOut).padStart(6)}  searches ${u.searches}  ${(u.ms / 1000).toFixed(1)} s`);
  tin += u.tokensIn;
  tout += u.tokensOut;
  searches += u.searches;
}
console.log(`${"total".padEnd(30)} in ${String(tin).padStart(7)}  out ${String(tout).padStart(6)}  searches ${searches}`);
process.exit(0);
