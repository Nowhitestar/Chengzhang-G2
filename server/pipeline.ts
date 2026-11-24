/**
 * The work that happens after the author stops talking. Everything here runs
 * in the background inside this one process: the app polls the article and
 * shows whatever state it is in.
 *
 *   slices of audio → transcript → tidy                       (per recording)
 *   material → fact check → article with notes                (compose)
 *   one spoken sentence → the article, changed                (edit / answer)
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeT, type T } from "../shared/i18n.ts";
import { collapseBlank, markIds, markInner, removeMark, replaceMark, unwrapMark } from "../shared/text.ts";
import type { AnnAction, Annotation } from "../shared/types.ts";
import { config } from "./config.ts";
import { callClaude, callClaudeJson, LlmError, type Source } from "./llm.ts";
import {
  ArticleSchema,
  EDIT_SYSTEM,
  EditSchema,
  editUser,
  RESEARCH_SYSTEM,
  researchUser,
  TIDY_SYSTEM,
  tidyUser,
  WRITE_SYSTEM,
  writeUser,
  type ArticleDraft,
} from "./prompts.ts";
import { pcmMs, SttError, transcribe } from "./stt.ts";
import * as store from "./store.ts";

const userT = (userId: string): T => makeT(store.userLang(userId));
const say = (err: unknown, t: T): string =>
  err instanceof LlmError ? err.text(t) : err instanceof SttError ? err.message : t("出错了，请再试一次。", "Something went wrong. Please try again.");

// ---------- audio slices ----------

const audioDir = () => join(config.dataDir === ":memory:" ? ".data-test" : config.dataDir, "audio");
const audioPath = (recordingId: string, idx: number) => join(audioDir(), `${recordingId}-${idx}.pcm`);

/** Transcriptions in flight, so "finish" can wait for the last slices. */
const inFlight = new Map<string, Promise<void>>();
const key = (recordingId: string, idx: number) => `${recordingId}:${idx}`;

async function transcribeSlice(rec: store.RecordingRow, idx: number, pcm: Uint8Array): Promise<void> {
  const t = userT(rec.user_id);
  try {
    const text = await transcribe(pcm, t, { purpose: rec.purpose, idx });
    store.putChunk(rec.id, idx, { status: "done", text });
    rmSync(audioPath(rec.id, idx), { force: true });
  } catch (err) {
    // The audio stays on disk so "finish" can try once more.
    store.putChunk(rec.id, idx, { status: "failed", error: say(err, t) });
  }
}

/**
 * One slice of a recording arrived. It is kept on disk only until it has been
 * transcribed; after that only the words remain.
 */
export function acceptSlice(rec: store.RecordingRow, idx: number, pcm: Uint8Array): void {
  mkdirSync(audioDir(), { recursive: true });
  writeFileSync(audioPath(rec.id, idx), pcm);
  store.putChunk(rec.id, idx, { status: "pending" });
  store.addUsage(rec.user_id, "audio_ms", pcmMs(pcm));
  const job = transcribeSlice(rec, idx, pcm).finally(() => inFlight.delete(key(rec.id, idx)));
  inFlight.set(key(rec.id, idx), job);
}

function dropAudio(recordingId: string, count: number): void {
  for (let i = 0; i < count; i++) rmSync(audioPath(recordingId, i), { force: true });
}

/** The words of a whole recording, slices joined in order. Retries slices that failed the first time. */
async function transcriptOf(rec: store.RecordingRow, count: number): Promise<string> {
  await Promise.all(Array.from({ length: count }, (_, i) => inFlight.get(key(rec.id, i))).filter(Boolean));
  const t = userT(rec.user_id);
  let chunks = store.chunksOf(rec.id);
  for (let i = 0; i < count; i++) {
    const c = chunks.find((x) => x.idx === i);
    if (c?.status === "done") continue;
    let pcm: Uint8Array;
    try {
      pcm = readFileSync(audioPath(rec.id, i));
    } catch {
      throw new SttError(t("有一段录音没传上来。", "Part of the recording didn’t upload."));
    }
    const text = await transcribe(pcm, t, { purpose: rec.purpose, idx: i });
    store.putChunk(rec.id, i, { status: "done", text });
  }
  chunks = store.chunksOf(rec.id);
  return chunks
    .filter((c) => c.idx < count)
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join(" ");
}

/** Material is cleaned up by the model. If that fails the raw words are still good material. */
async function tidy(raw: string): Promise<string> {
  try {
    const { text } = await callClaude({ step: "tidy", system: TIDY_SYSTEM, user: tidyUser(raw), effort: "low", maxTokens: 12000 });
    return text.trim() || raw;
  } catch (err) {
    console.error("[tidy] using the raw transcript:", err instanceof Error ? err.message : err);
    return raw;
  }
}

/**
 * The author finished talking. Material is transcribed and tidied; a spoken
 * change or answer goes straight on to edit the article.
 */
export async function finishRecording(recordingId: string, count: number, durationMs: number): Promise<void> {
  const rec = store.recordingById(recordingId);
  if (!rec) return;
  const t = userT(rec.user_id);
  store.updateRecording(rec.id, { status: "processing", chunk_count: count, duration_ms: durationMs, error: "" });
  if (rec.purpose !== "material") store.updateArticle(rec.article_id, { revising: 1, phase: "revise", revision_error: "", last_change: "", heard: "" });
  try {
    const raw = await transcriptOf(rec, count);
    dropAudio(rec.id, count);
    if (!raw) throw new SttError(t("没听到内容。", "I didn’t hear anything."));
    if (rec.purpose === "material") {
      store.updateRecording(rec.id, { raw });
      store.updateRecording(rec.id, { text: await tidy(raw), status: "ready" });
      return;
    }
    store.updateRecording(rec.id, { raw, text: raw, status: "ready" });
    await applySpokenChange(rec.article_id, raw, rec.purpose === "answer" ? rec.target : "");
  } catch (err) {
    dropAudio(rec.id, count);
    const message = say(err, t);
    store.updateRecording(rec.id, { status: "failed", error: message });
    if (rec.purpose !== "material") store.updateArticle(rec.article_id, { revising: 0, phase: "", revision_error: message });
  }
}

export function discardRecording(rec: store.RecordingRow): void {
  dropAudio(rec.id, Math.max(rec.chunk_count, store.chunksOf(rec.id).length, 8));
  store.deleteRecording(rec.id);
}

// ---------- compose ----------

const normalizeUrl = (u: string) =>
  u
    .trim()
    .replace(/[)\].,;，。、]+$/, "")
    .replace(/\/$/, "")
    .toLowerCase();

/**
 * Make the marks in the text and the notes agree, and enforce the one hard
 * rule: a sentence the AI added stays only if its source is a page the fact
 * check actually found. Otherwise the sentence is deleted along with its note.
 */
export function reconcile(draft: ArticleDraft, found: Source[]): { markdown: string; annotations: Annotation[] } {
  const allowed = new Set(found.map((s) => normalizeUrl(s.url)));
  let md = draft.markdown;
  const inText = new Set(markIds(md));
  const kept: Annotation[] = [];
  const seen = new Set<string>();
  for (const a of draft.annotations) {
    if (!inText.has(a.id) || seen.has(a.id)) continue;
    seen.add(a.id);
    const sourced = Boolean(a.source_url) && allowed.has(normalizeUrl(a.source_url));
    if (a.kind === "added" && !sourced) {
      md = removeMark(md, a.id);
      continue;
    }
    if (a.kind === "diff" && !a.suggestion.trim()) {
      md = unwrapMark(md, a.id);
      continue;
    }
    kept.push({
      id: a.id,
      kind: a.kind,
      note: a.note.trim(),
      suggestion: a.suggestion.trim(),
      sourceTitle: sourced ? a.source_title.trim() : "",
      sourceUrl: sourced ? a.source_url.trim() : "",
      state: "open",
    });
  }
  // A mark nobody explains is just text.
  for (const id of inText) if (!kept.some((a) => a.id === id)) md = unwrapMark(md, id);
  return { markdown: collapseBlank(md.replace(/^#\s+.*\n+/, "")), annotations: kept };
}

/** What the author said, as the writer sees it. */
export function materialText(recordings: store.RecordingRow[]): string {
  const ready = recordings.filter((r) => (r.text || r.raw).trim());
  if (ready.length === 1) return (ready[0]!.text || ready[0]!.raw).trim();
  return ready.map((r, i) => `## Recording ${i + 1}\n\n${(r.text || r.raw).trim()}`).join("\n\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "Write it up" can be tapped while the last recording is still being tidied: wait for it. */
async function settledMaterial(articleId: string): Promise<store.RecordingRow[]> {
  for (let waited = 0; waited < 150_000; waited += 500) {
    const recs = store.materialOf(articleId);
    if (!recs.some((r) => r.status === "processing")) return recs;
    await sleep(500);
  }
  return store.materialOf(articleId);
}

const composing = new Set<string>();

/** Write the article. Returns at once; the article's status says how it is going. */
export function startCompose(articleId: string): void {
  if (composing.has(articleId)) return;
  composing.add(articleId);
  store.updateArticle(articleId, { status: "composing", phase: "research", error: "", revising: 0, revision_error: "", last_change: "" });
  void compose(articleId).finally(() => composing.delete(articleId));
}

async function compose(articleId: string): Promise<void> {
  const article = store.articleById(articleId);
  if (!article) return;
  const t = userT(article.user_id);
  try {
    const material = materialText(await settledMaterial(articleId));
    if (!material) throw new LlmError("还没有可以写的内容。先讲一段。", "There’s nothing to write from yet. Say something first.");

    let research = "";
    let sources: Source[] = [];
    if (config.llm.searches > 0) {
      try {
        const found = await callClaude({
          step: "research",
          system: RESEARCH_SYSTEM,
          user: researchUser(material),
          effort: "medium",
          webSearch: config.llm.searches,
          research: true,
          maxTokens: 16000,
        });
        research = found.text;
        sources = found.sources;
      } catch (err) {
        // The article does not depend on the fact check: write it without additions.
        console.error("[compose] fact check skipped:", err instanceof Error ? err.message : err);
      }
    }

    store.updateArticle(articleId, { phase: "write" });
    const draft = await callClaudeJson({
      step: "write",
      system: WRITE_SYSTEM,
      user: writeUser(material, research, sources),
      effort: "medium",
      format: ArticleSchema,
    });
    const { markdown, annotations } = reconcile(draft, sources);
    if (!markdown.trim()) throw new LlmError("没写出内容，请再试一次。", "Nothing was written. Please try again.");
    store.clearVersions(articleId);
    store.updateArticle(articleId, {
      status: "ready",
      phase: "",
      title: draft.title.trim(),
      gist: draft.gist.trim(),
      markdown,
      annotations,
      seen: 0,
      error: "",
      published_url: "",
    });
  } catch (err) {
    store.updateArticle(articleId, { status: "failed", phase: "", error: say(err, t) });
  }
}

// ---------- changes the author asks for ----------

/**
 * Apply one thing the author said. `questionId` is set when they were
 * answering one of the AI's questions.
 */
export async function applySpokenChange(articleId: string, instruction: string, questionId: string): Promise<void> {
  const article = store.articleById(articleId);
  if (!article) return;
  const t = userT(article.user_id);
  const before = store.parseAnnotations(article.annotations);
  const question = before.find((a) => a.id === questionId && a.kind === "ask");
  store.updateArticle(articleId, { revising: 1, phase: "revise", heard: instruction, revision_error: "", last_change: "" });
  try {
    const result = await callClaudeJson({
      step: question ? "answer" : "edit",
      system: EDIT_SYSTEM,
      user: editUser(article, instruction, question ? { id: question.id, text: question.note } : undefined),
      effort: "low",
      format: EditSchema,
    });
    if (!result.changed || !result.markdown.trim()) {
      store.updateArticle(articleId, {
        revising: 0,
        phase: "",
        revision_error: result.summary.trim() || t("没听明白要改什么。", "I didn’t catch what to change."),
      });
      return;
    }
    // Notes follow their marks: a mark the change removed takes its note with it.
    let markdown = result.markdown;
    const present = new Set(markIds(markdown));
    const annotations = before.map((a): Annotation => {
      if (a.state !== "open" && a.state !== "kept") return a;
      if (question && a.id === question.id) return { ...a, state: "answered" };
      return present.has(a.id) ? a : { ...a, state: "removed" };
    });
    if (question && present.has(question.id)) markdown = unwrapMark(markdown, question.id);
    for (const id of present) if (!annotations.some((a) => a.id === id)) markdown = unwrapMark(markdown, id);
    store.saveVersion(article);
    store.updateArticle(articleId, {
      title: result.title.trim() || article.title,
      gist: result.gist.trim() || article.gist,
      markdown: collapseBlank(markdown),
      annotations,
      revising: 0,
      phase: "",
      last_change: result.summary.trim(),
    });
  } catch (err) {
    store.updateArticle(articleId, { revising: 0, phase: "", revision_error: say(err, t) });
  }
}

/** The author's decision on one AI note. No model involved: it only edits the text. */
export function resolveAnnotation(article: store.ArticleRow, annotationId: string, action: AnnAction): boolean {
  const annotations = store.parseAnnotations(article.annotations);
  const a = annotations.find((x) => x.id === annotationId);
  if (!a || a.state !== "open") return false;
  let markdown = article.markdown;
  if (a.kind === "added") {
    if (action === "keep") {
      a.state = "kept"; // the mark stays so the source can travel with the sentence on export
    } else if (action === "remove") {
      markdown = removeMark(markdown, a.id);
      a.state = "removed";
    } else return false;
  } else if (a.kind === "diff") {
    if (action === "apply") {
      markdown = replaceMark(markdown, a.id, a.suggestion);
      a.state = "applied";
    } else if (action === "keep" || action === "dismiss") {
      markdown = unwrapMark(markdown, a.id);
      a.state = "dismissed";
    } else return false;
  } else {
    if (action !== "dismiss") return false;
    markdown = unwrapMark(markdown, a.id);
    a.state = "dismissed";
  }
  store.saveVersion(article);
  store.updateArticle(article.id, { markdown, annotations, last_change: "", revision_error: "" });
  return true;
}

/** The words a note is attached to, for showing the note on its own. */
export const annotationContext = (article: store.ArticleRow, id: string) => markInner(article.markdown, id);

// ---------- after a restart ----------

export function recover(): void {
  const { composing: stuck, revising, processing } = store.interruptedWork();
  for (const a of stuck) {
    store.updateArticle(a.id, { status: "failed", phase: "", error: userT(a.user_id)("写到一半被打断了，再试一次。", "Writing was interrupted. Try again.") });
  }
  for (const a of revising) {
    store.updateArticle(a.id, { revising: 0, phase: "", revision_error: userT(a.user_id)("改到一半被打断了，再说一次。", "The change was interrupted. Say it again.") });
  }
  // Slices are still on disk until transcribed, so an interrupted recording can simply be finished again.
  for (const r of processing) void finishRecording(r.id, r.chunk_count, r.duration_ms);
  if (stuck.length || revising.length || processing.length) {
    console.log(`[recover] ${stuck.length} composing, ${revising.length} revising, ${processing.length} recordings picked up`);
  }
}
