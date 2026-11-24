/**
 * Storage: one SQLite file (Node's built-in driver, no native dependency).
 * The schema is a list of numbered steps; each runs once and is recorded.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL UNIQUE,
     lang TEXT NOT NULL DEFAULT 'en',
     created_at INTEGER NOT NULL
   );
   CREATE TABLE articles (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     status TEXT NOT NULL DEFAULT 'draft',
     phase TEXT NOT NULL DEFAULT '',
     title TEXT NOT NULL DEFAULT '',
     gist TEXT NOT NULL DEFAULT '',
     markdown TEXT NOT NULL DEFAULT '',
     annotations TEXT NOT NULL DEFAULT '[]',
     error TEXT NOT NULL DEFAULT '',
     revising INTEGER NOT NULL DEFAULT 0,
     revision_error TEXT NOT NULL DEFAULT '',
     last_change TEXT NOT NULL DEFAULT '',
     heard TEXT NOT NULL DEFAULT '',
     seen INTEGER NOT NULL DEFAULT 0,
     published_url TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX articles_user ON articles(user_id, updated_at DESC);
   CREATE TABLE recordings (
     id TEXT PRIMARY KEY,
     article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
     user_id TEXT NOT NULL,
     purpose TEXT NOT NULL DEFAULT 'material',
     target TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'recording',
     raw TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL DEFAULT '',
     duration_ms INTEGER NOT NULL DEFAULT 0,
     chunk_count INTEGER NOT NULL DEFAULT 0,
     error TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   );
   CREATE INDEX recordings_article ON recordings(article_id, created_at);
   CREATE TABLE chunks (
     recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
     idx INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     text TEXT NOT NULL DEFAULT '',
     error TEXT NOT NULL DEFAULT '',
     PRIMARY KEY (recording_id, idx)
   );
   CREATE TABLE versions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     gist TEXT NOT NULL,
     markdown TEXT NOT NULL,
     annotations TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX versions_article ON versions(article_id, id DESC);
   CREATE TABLE usage (
     user_id TEXT NOT NULL,
     day TEXT NOT NULL,
     audio_ms INTEGER NOT NULL DEFAULT 0,
     composes INTEGER NOT NULL DEFAULT 0,
     edits INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, day)
   );`,
];

let handle: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (handle) return handle;
  const memory = config.dataDir === ":memory:";
  if (!memory) mkdirSync(config.dataDir, { recursive: true });
  const d = new DatabaseSync(memory ? ":memory:" : join(config.dataDir, "chengzhang.sqlite"));
  d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  d.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set(d.prepare("SELECT version FROM schema_migrations").all().map((r) => Number(r.version)));
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (done.has(version)) return;
    d.exec("BEGIN");
    try {
      d.exec(sql);
      d.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, Date.now());
      d.exec("COMMIT");
    } catch (err) {
      d.exec("ROLLBACK");
      throw err;
    }
  });
  handle = d;
  return d;
}

/** Tests open a fresh in-memory database between cases. */
export function resetDbForTests(): void {
  handle?.close();
  handle = null;
}

type Param = string | number | bigint | null;
type Row = Record<string, unknown>;

export const all = <T = Row>(sql: string, ...params: Param[]): T[] => db().prepare(sql).all(...params) as T[];
export const one = <T = Row>(sql: string, ...params: Param[]): T | undefined => db().prepare(sql).get(...params) as T | undefined;
export const run = (sql: string, ...params: Param[]) => db().prepare(sql).run(...params);
