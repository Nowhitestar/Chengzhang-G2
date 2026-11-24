/**
 * The HTTP API the G2 app talks to. Every call except /api/health and
 * /api/session carries the device's bearer token.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { isLang, makeT, type T } from "../shared/i18n.ts";
import { exportMarkdown } from "../shared/text.ts";
import type { AnnAction, Features, HomeView, Lang, RecordingPurpose } from "../shared/types.ts";
import { config, notionReady } from "./config.ts";
import { publishToNotion } from "./notion.ts";
import * as pipeline from "./pipeline.ts";
import { PROMPT_VERSION } from "./prompts.ts";
import * as store from "./store.ts";

type Env = { Variables: { user: store.User; t: T } };

const features = (): Features => ({ notion: notionReady(), demo: config.demo });

/** 1.5 MB is about 45 seconds of 16 kHz mono audio; the app cuts slices well below that. */
const MAX_SLICE_BYTES = 1_500_000;
const MAX_SLICES = 400;

export function createApp(): Hono<Env> {
  const app = new Hono<Env>();

  app.use(
    "/api/*",
    cors({
      origin: config.corsOrigins.includes("*") ? "*" : config.corsOrigins,
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 86400,
    }),
  );

  app.onError((err, c) => {
    console.error("[api]", c.req.method, c.req.path, err);
    return c.json({ error: "Something went wrong on the server." }, 500);
  });

  app.get("/api/health", (c) =>
    c.json({ ok: true, mode: config.demo ? "demo" : "live", accessCode: Boolean(config.accessCode), prompts: PROMPT_VERSION }),
  );

  /** A device introduces itself once. With ACCESS_CODE set it must also know the code. */
  app.post("/api/session", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { code?: string; lang?: string };
    const lang: Lang = isLang(body.lang) ? body.lang : "en";
    const t = makeT(lang);
    if (config.accessCode && (body.code || "").trim() !== config.accessCode) {
      return c.json({ error: t("访问码不对。", "That access code isn’t right."), code: "access_code" }, 403);
    }
    const { token } = store.createUser(lang);
    return c.json({ token, features: features() });
  });

  app.use("/api/*", async (c, next) => {
    const token = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") || "")?.[1];
    const user = token ? store.userByToken(token) : undefined;
    if (!user) return c.json({ error: "Sign in again.", code: "auth" }, 401);
    c.set("user", user);
    c.set("t", makeT(user.lang));
    await next();
  });

  const article = (c: Context<Env>) => store.getArticle(c.get("user").id, c.req.param("id") ?? "");
  const notFound = (c: Context<Env>) => c.json({ error: c.get("t")("找不到这篇文章。", "Can’t find that article."), code: "not_found" }, 404);

  app.patch("/api/me", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { lang?: string };
    if (isLang(body.lang)) store.setLang(c.get("user").id, body.lang);
    return c.json({ ok: true });
  });

  app.get("/api/home", (c) => {
    const userId = c.get("user").id;
    store.pruneEmptyDrafts(userId);
    const view: HomeView = { rows: store.homeRows(userId), finished: store.finishedCount(userId), features: features() };
    return c.json(view);
  });

  app.get("/api/articles", (c) => c.json({ rows: store.libraryRows(c.get("user").id) }));

  app.post("/api/articles", (c) => c.json({ id: store.createArticle(c.get("user").id) }));

  app.get("/api/articles/:id", (c) => {
    const a = article(c);
    return a ? c.json(store.articleView(a)) : notFound(c);
  });

  app.delete("/api/articles/:id", (c) => {
    const a = article(c);
    if (!a) return notFound(c);
    for (const r of store.takesOf(a.id)) pipeline.discardRecording(r);
    store.deleteArticle(a.user_id, a.id);
    return c.json({ ok: true });
  });

  /** The author opened the finished article: it no longer needs a row on the opening page. */
  app.post("/api/articles/:id/seen", (c) => {
    const a = article(c);
    if (!a) return notFound(c);
    if (!a.seen) store.updateArticle(a.id, { seen: 1 }, false);
    return c.json({ ok: true });
  });

  app.post("/api/articles/:id/recordings", async (c) => {
    const a = article(c);
    if (!a) return notFound(c);
    const t = c.get("t");
    const body = (await c.req.json().catch(() => ({}))) as { purpose?: RecordingPurpose; target?: string };
    const purpose: RecordingPurpose = body.purpose === "instruction" || body.purpose === "answer" ? body.purpose : "material";
    if (purpose !== "material" && a.status !== "ready") {
      return c.json({ error: t("这篇还没写好。", "This article isn’t written yet."), code: "not_ready" }, 409);
    }
    const used = store.usageToday(a.user_id);
    if (used.audio_ms >= config.limits.audioMinutesPerDay * 60_000) {
      return c.json({ error: t("今天讲得够多了，明天再来。", "That’s the daily limit for talking. Come back tomorrow."), code: "limit" }, 429);
    }
    if (purpose !== "material" && used.edits >= config.limits.editsPerDay) {
      return c.json({ error: t("今天改得够多了，明天再来。", "That’s the daily limit for changes. Come back tomorrow."), code: "limit" }, 429);
    }
    return c.json({ id: store.createRecording(a.id, a.user_id, purpose, (body.target || "").slice(0, 40)) });
  });

  /** One slice of raw microphone audio: 16 kHz, 16-bit, mono PCM. */
  app.put(
    "/api/recordings/:id/chunks/:idx",
    bodyLimit({ maxSize: MAX_SLICE_BYTES, onError: (c) => c.json({ error: "That slice is too large." }, 413) }),
    async (c) => {
      const rec = store.getRecording(c.get("user").id, c.req.param("id"));
      const idx = Number(c.req.param("idx"));
      if (!rec || rec.status !== "recording") return c.json({ error: "No such recording.", code: "not_found" }, 404);
      if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_SLICES) return c.json({ error: "Bad slice number." }, 400);
      const pcm = new Uint8Array(await c.req.arrayBuffer());
      if (pcm.length < 2) return c.json({ error: "Empty slice." }, 400);
      pipeline.acceptSlice(rec, idx, pcm.subarray(0, pcm.length - (pcm.length % 2)));
      return c.json({ ok: true });
    },
  );

  app.post("/api/recordings/:id/finish", async (c) => {
    const rec = store.getRecording(c.get("user").id, c.req.param("id"));
    if (!rec) return c.json({ error: "No such recording.", code: "not_found" }, 404);
    if (rec.status !== "recording") return c.json({ ok: true }); // already finished: a retried request
    const body = (await c.req.json().catch(() => ({}))) as { chunks?: number; durationMs?: number };
    const count = Math.max(0, Math.min(MAX_SLICES, Math.floor(Number(body.chunks) || 0)));
    if (!count) {
      pipeline.discardRecording(rec);
      return c.json({ ok: true, discarded: true });
    }
    if (rec.purpose !== "material") store.addUsage(rec.user_id, "edits", 1);
    void pipeline.finishRecording(rec.id, count, Math.max(0, Math.floor(Number(body.durationMs) || 0)));
    return c.json({ ok: true });
  });

  /** Throw a recording away: a take the author cancelled, or material they no longer want. */
  app.delete("/api/recordings/:id", (c) => {
    const rec = store.getRecording(c.get("user").id, c.req.param("id"));
    if (rec) pipeline.discardRecording(rec);
    return c.json({ ok: true });
  });

  app.post("/api/articles/:id/compose", (c) => {
    const a = article(c);
    if (!a) return notFound(c);
    const t = c.get("t");
    if (a.status === "composing") return c.json({ ok: true });
    if (!store.materialOf(a.id).length) {
      return c.json({ error: t("还没有可以写的内容。先讲一段。", "There’s nothing to write from yet. Say something first."), code: "empty" }, 409);
    }
    if (store.usageToday(a.user_id).composes >= config.limits.composesPerDay) {
      return c.json({ error: t("今天写得够多了，明天再来。", "That’s the daily limit for articles. Come back tomorrow."), code: "limit" }, 429);
    }
    store.addUsage(a.user_id, "composes", 1);
    pipeline.startCompose(a.id);
    return c.json({ ok: true });
  });

  /** A change typed on the phone instead of spoken. */
  app.post("/api/articles/:id/edit", async (c) => {
    const a = article(c);
    if (!a) return notFound(c);
    const t = c.get("t");
    const body = (await c.req.json().catch(() => ({}))) as { instruction?: string };
    const instruction = (body.instruction || "").trim().slice(0, 2000);
    if (a.status !== "ready" || a.revising || !instruction) return c.json({ error: t("现在改不了。", "Can’t change it right now."), code: "busy" }, 409);
    if (store.usageToday(a.user_id).edits >= config.limits.editsPerDay) {
      return c.json({ error: t("今天改得够多了，明天再来。", "That’s the daily limit for changes. Come back tomorrow."), code: "limit" }, 429);
    }
    store.addUsage(a.user_id, "edits", 1);
    void pipeline.applySpokenChange(a.id, instruction, "");
    return c.json({ ok: true });
  });

  app.post("/api/articles/:id/annotations/:annId", async (c) => {
    const a = article(c);
    if (!a) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { action?: AnnAction };
    const ok = a.status === "ready" && !a.revising && pipeline.resolveAnnotation(a, c.req.param("annId"), body.action ?? "keep");
    if (!ok) return c.json({ error: c.get("t")("这一条已经处理过了。", "That note was already dealt with."), code: "stale" }, 409);
    return c.json(store.articleView(store.articleById(a.id)!));
  });

  app.post("/api/articles/:id/undo", (c) => {
    const a = article(c);
    if (!a) return notFound(c);
    if (a.revising || !store.restoreVersion(a.id)) return c.json({ error: c.get("t")("没有可以撤销的。", "Nothing to undo."), code: "nothing" }, 409);
    return c.json(store.articleView(store.articleById(a.id)!));
  });

  app.get("/api/articles/:id/markdown", (c) => {
    const a = article(c);
    if (!a) return notFound(c);
    const md = exportMarkdown(a.title, a.markdown, store.parseAnnotations(a.annotations), c.get("t")("参考资料", "Sources"));
    return c.text(md, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });

  app.post("/api/articles/:id/publish", async (c) => {
    const a = article(c);
    if (!a) return notFound(c);
    const t = c.get("t");
    if (!notionReady()) return c.json({ error: t("还没有接上 Notion。", "Notion isn’t connected."), code: "not_configured" }, 409);
    if (a.status !== "ready") return c.json({ error: t("这篇还没写好。", "This article isn’t written yet."), code: "not_ready" }, 409);
    try {
      const url = await publishToNotion(a.title, exportMarkdown("", a.markdown, store.parseAnnotations(a.annotations), t("参考资料", "Sources")));
      store.updateArticle(a.id, { published_url: url });
      return c.json({ url });
    } catch (err) {
      console.error("[notion]", err);
      return c.json({ error: t("没能发到 Notion。", "Couldn’t send it to Notion."), code: "notion" }, 502);
    }
  });

  return app;
}
