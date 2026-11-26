/**
 * Reading and writing the database. Nothing outside this file writes SQL.
 */
import { createHash, randomBytes } from "node:crypto";
import { snippet, wordCount } from "../shared/text.ts";
import type {
  Annotation,
  ArticleStatus,
  ArticleView,
  HomeRow,
  Lang,
  LibraryRow,
  Phase,
  RecordingPurpose,
  RecordingStatus,
  RecordingView,
} from "../shared/types.ts";
import { all, one, run } from "./db.ts";

export const newId = () => randomBytes(9).toString("base64url");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const now = () => Date.now();

// ---------- devices ----------

export interface User {
  id: string;
  lang: Lang;
  /** The access code it came in with ("" when the server asked for none). */
  access_code: string;
}

/** A device gets a random token once and keeps it. Only its hash is stored. */
export function createUser(lang: Lang, accessCode = ""): { user: User; token: string } {
  const id = newId();
  const token = randomBytes(32).toString("base64url");
  run("INSERT INTO users (id, token_hash, lang, access_code, created_at) VALUES (?, ?, ?, ?, ?)", id, hash(token), lang, accessCode, now());
  return { user: { id, lang, access_code: accessCode }, token };
}

export function userByToken(token: string): User | undefined {
  return one<User>("SELECT id, lang, access_code FROM users WHERE token_hash = ?", hash(token));
}

export function setLang(userId: string, lang: Lang): void {
  run("UPDATE users SET lang = ? WHERE id = ?", lang, userId);
}

// ---------- articles ----------

export interface ArticleRow {
  id: string;
  user_id: string;
  status: ArticleStatus;
  phase: Phase;
  title: string;
  gist: string;
  markdown: string;
  annotations: string;
  error: string;
  revising: number;
  revision_error: string;
  last_change: string;
  heard: string;
  seen: number;
  published_url: string;
  created_at: number;
  updated_at: number;
}

export function createArticle(userId: string): string {
  const id = newId();
  run("INSERT INTO articles (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)", id, userId, now(), now());
  return id;
}

export function getArticle(userId: string, id: string): ArticleRow | undefined {
  return one<ArticleRow>("SELECT * FROM articles WHERE id = ? AND user_id = ?", id, userId);
}

export function articleById(id: string): ArticleRow | undefined {
  return one<ArticleRow>("SELECT * FROM articles WHERE id = ?", id);
}

type ArticlePatch = Partial<Omit<ArticleRow, "id" | "user_id" | "created_at" | "updated_at" | "annotations">> & { annotations?: Annotation[] };

/** `touch: false` leaves the "last changed" time alone, for changes the author would not call a change. */
export function updateArticle(id: string, patch: ArticlePatch, touch = true): void {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  const cols = entries.map(([k]) => `${k} = ?`);
  const vals = entries.map(([k, v]) => (k === "annotations" ? JSON.stringify(v) : (v as string | number)));
  if (touch) {
    cols.push("updated_at = ?");
    vals.push(now());
  }
  run(`UPDATE articles SET ${cols.join(", ")} WHERE id = ?`, ...vals, id);
}

export function deleteArticle(userId: string, id: string): boolean {
  return run("DELETE FROM articles WHERE id = ? AND user_id = ?", id, userId).changes > 0;
}

export const parseAnnotations = (json: string): Annotation[] => {
  try {
    return JSON.parse(json) as Annotation[];
  } catch {
    return [];
  }
};

export function articleView(a: ArticleRow): ArticleView {
  return {
    id: a.id,
    status: a.status,
    phase: a.phase,
    title: a.title,
    gist: a.gist,
    markdown: a.markdown,
    annotations: parseAnnotations(a.annotations),
    recordings: takesOf(a.id).map(recordingView),
    words: a.markdown ? wordCount(a.markdown) : 0,
    error: a.error,
    revising: Boolean(a.revising),
    revisionError: a.revision_error,
    lastChange: a.last_change,
    heard: a.heard,
    canUndo: Boolean(one("SELECT 1 AS x FROM versions WHERE article_id = ? LIMIT 1", a.id)),
    publishedUrl: a.published_url,
    seen: Boolean(a.seen),
    updatedAt: a.updated_at,
  };
}

interface ListRow {
  id: string;
  status: ArticleStatus;
  title: string;
  seen: number;
  updated_at: number;
  recordings: number;
  first_text: string | null;
}

const LIST_SQL = `
  SELECT a.id, a.status, a.title, a.seen, a.updated_at,
    (SELECT COUNT(*) FROM recordings r WHERE r.article_id = a.id AND r.purpose = 'material' AND r.status != 'failed') AS recordings,
    (SELECT COALESCE(NULLIF(r.text, ''), r.raw) FROM recordings r
      WHERE r.article_id = a.id AND r.purpose = 'material' AND (r.text != '' OR r.raw != '')
      ORDER BY r.created_at LIMIT 1) AS first_text
  FROM articles a WHERE a.user_id = ?`;

/**
 * The opening page shows a row only when there is something to tell the author:
 * an article is ready and unopened, one is being written, one could not be
 * written, or the most recent unfinished one is waiting for more.
 */
export function homeRows(userId: string): HomeRow[] {
  const rows = all<ListRow>(`${LIST_SQL} ORDER BY a.updated_at DESC LIMIT 60`, userId);
  const out: HomeRow[] = [];
  let draftShown = false;
  for (const r of rows) {
    const base = { id: r.id, title: r.title, preview: snippet(r.first_text ?? "", 28), recordings: r.recordings, updatedAt: r.updated_at };
    if (r.status === "ready" && !r.seen) out.push({ ...base, kind: "ready" });
    else if (r.status === "composing") out.push({ ...base, kind: "composing" });
    else if (r.status === "failed") out.push({ ...base, kind: "failed" });
    else if (r.status === "draft" && r.recordings > 0 && !draftShown) {
      draftShown = true;
      out.push({ ...base, kind: "draft" });
    }
  }
  const order = { ready: 0, composing: 1, failed: 2, draft: 3 } as const;
  return out.sort((x, y) => order[x.kind] - order[y.kind] || y.updatedAt - x.updatedAt).slice(0, 6);
}

export function finishedCount(userId: string): number {
  return Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM articles WHERE user_id = ? AND status = 'ready'", userId)?.n ?? 0);
}

export function libraryRows(userId: string): LibraryRow[] {
  return all<ListRow>(`${LIST_SQL} AND (a.status != 'draft' OR EXISTS (SELECT 1 FROM recordings r WHERE r.article_id = a.id)) ORDER BY a.updated_at DESC LIMIT 100`, userId).map(
    (r) => ({ id: r.id, status: r.status, title: r.title, preview: snippet(r.first_text ?? "", 40), updatedAt: r.updated_at }),
  );
}

/** Drafts that never got a recording are clutter: drop the old ones. */
export function pruneEmptyDrafts(userId: string): void {
  run(
    `DELETE FROM articles WHERE user_id = ? AND status = 'draft' AND updated_at < ?
       AND NOT EXISTS (SELECT 1 FROM recordings r WHERE r.article_id = articles.id)`,
    userId,
    now() - 10 * 60_000,
  );
}

// ---------- recordings ----------

export interface RecordingRow {
  id: string;
  article_id: string;
  user_id: string;
  purpose: RecordingPurpose;
  target: string;
  status: RecordingStatus;
  raw: string;
  text: string;
  duration_ms: number;
  chunk_count: number;
  error: string;
  created_at: number;
}

export function createRecording(articleId: string, userId: string, purpose: RecordingPurpose, target: string): string {
  const id = newId();
  run(
    "INSERT INTO recordings (id, article_id, user_id, purpose, target, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    articleId,
    userId,
    purpose,
    target,
    now(),
  );
  run("UPDATE articles SET updated_at = ? WHERE id = ?", now(), articleId);
  return id;
}

export function getRecording(userId: string, id: string): RecordingRow | undefined {
  return one<RecordingRow>("SELECT * FROM recordings WHERE id = ? AND user_id = ?", id, userId);
}

export function recordingById(id: string): RecordingRow | undefined {
  return one<RecordingRow>("SELECT * FROM recordings WHERE id = ?", id);
}

export function updateRecording(id: string, patch: Partial<Pick<RecordingRow, "status" | "raw" | "text" | "duration_ms" | "chunk_count" | "error">>): void {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  run(`UPDATE recordings SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, ...entries.map(([, v]) => v as string | number), id);
}

export function deleteRecording(id: string): void {
  run("DELETE FROM recordings WHERE id = ?", id);
}

/** What the author said for this article, oldest first: recordings that are transcribed or on their way. */
export function materialOf(articleId: string): RecordingRow[] {
  return all<RecordingRow>(
    "SELECT * FROM recordings WHERE article_id = ? AND purpose = 'material' AND status IN ('processing', 'ready') ORDER BY created_at",
    articleId,
  );
}

/** The same, plus recordings that could not be transcribed, so the author can be told. */
export function takesOf(articleId: string): RecordingRow[] {
  return all<RecordingRow>(
    "SELECT * FROM recordings WHERE article_id = ? AND purpose = 'material' AND status IN ('processing', 'ready', 'failed') ORDER BY created_at",
    articleId,
  );
}

export function recordingView(r: RecordingRow): RecordingView {
  return { id: r.id, status: r.status, text: r.text || (r.status === "ready" ? r.raw : ""), durationMs: r.duration_ms, error: r.error };
}

export interface ChunkRow {
  recording_id: string;
  idx: number;
  status: "pending" | "done" | "failed";
  text: string;
  error: string;
}

export function putChunk(recordingId: string, idx: number, patch: { status: ChunkRow["status"]; text?: string; error?: string }): void {
  run(
    `INSERT INTO chunks (recording_id, idx, status, text, error) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (recording_id, idx) DO UPDATE SET status = excluded.status, text = excluded.text, error = excluded.error`,
    recordingId,
    idx,
    patch.status,
    patch.text ?? "",
    patch.error ?? "",
  );
}

export function chunksOf(recordingId: string): ChunkRow[] {
  return all<ChunkRow>("SELECT * FROM chunks WHERE recording_id = ? ORDER BY idx", recordingId);
}

// ---------- undo ----------

const KEEP_VERSIONS = 20;

/** Remember the article as it is now, so the next change can be undone. */
export function saveVersion(a: ArticleRow): void {
  run(
    "INSERT INTO versions (article_id, title, gist, markdown, annotations, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    a.id,
    a.title,
    a.gist,
    a.markdown,
    a.annotations,
    now(),
  );
  run(
    "DELETE FROM versions WHERE article_id = ? AND id NOT IN (SELECT id FROM versions WHERE article_id = ? ORDER BY id DESC LIMIT ?)",
    a.id,
    a.id,
    KEEP_VERSIONS,
  );
}

/** Put back the most recent remembered version. Returns false when there is none. */
export function restoreVersion(articleId: string): boolean {
  const v = one<{ id: number; title: string; gist: string; markdown: string; annotations: string }>(
    "SELECT * FROM versions WHERE article_id = ? ORDER BY id DESC LIMIT 1",
    articleId,
  );
  if (!v) return false;
  run(
    "UPDATE articles SET title = ?, gist = ?, markdown = ?, annotations = ?, last_change = '', revision_error = '', updated_at = ? WHERE id = ?",
    v.title,
    v.gist,
    v.markdown,
    v.annotations,
    now(),
    articleId,
  );
  run("DELETE FROM versions WHERE id = ?", v.id);
  return true;
}

export function clearVersions(articleId: string): void {
  run("DELETE FROM versions WHERE article_id = ?", articleId);
}

// ---------- daily use ----------

const today = () => new Date().toISOString().slice(0, 10);

export interface Usage {
  audio_ms: number;
  composes: number;
  edits: number;
}

export function usageToday(userId: string): Usage {
  return one<Usage>("SELECT audio_ms, composes, edits FROM usage WHERE user_id = ? AND day = ?", userId, today()) ?? { audio_ms: 0, composes: 0, edits: 0 };
}

/** Today's use by every device that came in with this access code. */
export function usageTodayByCode(code: string): Usage {
  const sum = one<Usage>(
    `SELECT COALESCE(SUM(u.audio_ms), 0) AS audio_ms, COALESCE(SUM(u.composes), 0) AS composes, COALESCE(SUM(u.edits), 0) AS edits
     FROM usage u JOIN users d ON d.id = u.user_id WHERE d.access_code = ? AND u.day = ?`,
    code,
    today(),
  );
  return sum ?? { audio_ms: 0, composes: 0, edits: 0 };
}

export function addUsage(userId: string, field: keyof Usage, amount: number): void {
  run(
    `INSERT INTO usage (user_id, day, ${field}) VALUES (?, ?, ?)
     ON CONFLICT (user_id, day) DO UPDATE SET ${field} = ${field} + excluded.${field}`,
    userId,
    today(),
    amount,
  );
}

// ---------- after a restart ----------

/** Work that was running when the process stopped cannot finish; say so instead of spinning forever. */
export function interruptedWork(): { composing: ArticleRow[]; revising: ArticleRow[]; processing: RecordingRow[] } {
  return {
    composing: all<ArticleRow>("SELECT * FROM articles WHERE status = 'composing'"),
    revising: all<ArticleRow>("SELECT * FROM articles WHERE revising = 1"),
    processing: all<RecordingRow>("SELECT * FROM recordings WHERE status = 'processing'"),
  };
}

export function userLang(userId: string): Lang {
  return one<{ lang: Lang }>("SELECT lang FROM users WHERE id = ?", userId)?.lang ?? "en";
}
