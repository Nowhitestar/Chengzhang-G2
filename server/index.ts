/**
 * Starts the backend. In production it also serves the built G2 app from
 * dist/, so one address is enough for both.
 */
import { existsSync, readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.ts";
import { config, notionReady } from "./config.ts";
import { db } from "./db.ts";
import { recover } from "./pipeline.ts";

db();
recover();

const app = createApp();

if (existsSync("dist/index.html")) {
  const index = readFileSync("dist/index.html", "utf8");
  app.use("/*", serveStatic({ root: "./dist" }));
  // Anything that is not a file or an API route is the app itself.
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound() : c.html(index)));
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const writing = config.mock.llm ? "simulated" : `${config.llm.model} (${config.llm.direct ? "Anthropic" : "OpenRouter"})`;
  const hearing = config.mock.stt ? "simulated" : `${config.stt.model} (${config.stt.provider})`;
  console.log(`[chengzhang] listening on :${info.port}`);
  console.log(`[chengzhang] writing: ${writing} · transcription: ${hearing} · notion: ${notionReady() ? "on" : "off"}`);
  if (config.demo) console.log("[chengzhang] demo mode: set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) for the real thing");
  if (!config.accessCode) console.log("[chengzhang] no ACCESS_CODE set: any device that can reach this server can use it");
});
