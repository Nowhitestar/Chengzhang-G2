/**
 * Shapes shared by the G2 app (src/) and the backend (server/).
 * Everything the app knows about an article comes from these views.
 */

export type Lang = "en" | "zh";

/**
 * An article moves draft → composing → ready (or failed, which can be retried).
 * A ready article can be `revising` while a spoken change is being applied.
 */
export type ArticleStatus = "draft" | "composing" | "ready" | "failed";

/** What the backend is doing right now, so the glasses can say it in plain words. */
export type Phase = "" | "research" | "write" | "revise";

/**
 * Three kinds of notes the AI leaves in a draft. The author decides each one:
 *  - added: a sentence the AI added from a source it actually found
 *  - diff:  something the author said that disagrees with a source (a hint, never changed silently)
 *  - ask:   a question for the author, answerable by voice
 */
export type AnnKind = "added" | "diff" | "ask";

export type AnnState = "open" | "kept" | "removed" | "applied" | "dismissed" | "answered";

export interface Annotation {
  id: string;
  kind: AnnKind;
  /** added: why it was added · diff: what the source says · ask: the question */
  note: string;
  /** diff only: the corrected wording the author can choose to use */
  suggestion: string;
  sourceTitle: string;
  sourceUrl: string;
  state: AnnState;
}

export type RecordingPurpose = "material" | "instruction" | "answer";
export type RecordingStatus = "recording" | "processing" | "ready" | "failed";

export interface RecordingView {
  id: string;
  status: RecordingStatus;
  /** Tidied text (fillers removed, paragraphs), empty until ready. */
  text: string;
  durationMs: number;
  error: string;
}

export interface ArticleView {
  id: string;
  status: ArticleStatus;
  phase: Phase;
  title: string;
  /** One or two sentences: what the article says. Shown first on the glasses. */
  gist: string;
  /** Markdown; AI notes are wrapped as <mark data-id="a1">…</mark>. */
  markdown: string;
  annotations: Annotation[];
  /** What was said for this article, oldest first. A recording that could not be transcribed is listed as failed. */
  recordings: RecordingView[];
  words: number;
  /** Why composing failed, in the user's language. */
  error: string;
  revising: boolean;
  /** Why the last spoken change could not be applied. */
  revisionError: string;
  /** One line: what the last spoken change did. */
  lastChange: string;
  /** What the backend heard for the last spoken change or answer. */
  heard: string;
  canUndo: boolean;
  /** Set once the article was sent to Notion. */
  publishedUrl: string;
  /** False until the author has opened the finished article. */
  seen: boolean;
  updatedAt: number;
}

export interface HomeRow {
  id: string;
  kind: "ready" | "composing" | "failed" | "draft";
  title: string;
  /** First words of what was said, when there is no title yet. */
  preview: string;
  recordings: number;
  updatedAt: number;
}

export interface LibraryRow {
  id: string;
  status: ArticleStatus;
  title: string;
  preview: string;
  updatedAt: number;
}

export interface Features {
  /** "Send to Notion" is offered only when the backend is configured for it. */
  notion: boolean;
  /** True when the backend simulates any part of the AI (no key for it, or asked to). */
  demo: boolean;
  /** Which part is simulated: the speech-to-text, the writing, or both. Empty when nothing is. */
  simulated: "" | "speech" | "writing" | "both";
}

export interface HomeView {
  rows: HomeRow[];
  /** Number of finished articles, for the "All articles" entry. */
  finished: number;
  features: Features;
}

export type AnnAction = "keep" | "remove" | "apply" | "dismiss";

export interface ApiError {
  error: string;
  code?: string;
}
