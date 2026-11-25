/**
 * The app's side of the backend API. The device keeps one bearer token; if the
 * backend no longer knows it (a fresh database, say) a new one is requested
 * and the call is retried once.
 */
import type {
  AnnAction,
  ArticleView,
  Features,
  HomeView,
  Lang,
  LibraryRow,
  RecordingPurpose,
} from "../shared/types.ts";

/** Empty means "same origin", which is how the app is served in development and from the backend itself. */
const BASE = String(import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** network: could not reach the backend · access_code: the backend wants its code · auth, limit, not_found… */
    readonly code: string,
  ) {
    super(message);
  }
}

export interface Storage {
  get(key: string): Promise<string>;
  set(key: string, value: string): Promise<void>;
}

const TOKEN_KEY = "chengzhang.token";
const CODE_KEY = "chengzhang.code";

export class Api {
  private token = "";
  private opening: Promise<void> | null = null;
  features: Features = { notion: false, demo: false, simulated: "" };

  constructor(
    private readonly storage: Storage,
    private lang: Lang,
  ) {}

  setLang(lang: Lang): void {
    this.lang = lang;
    if (this.token) void this.call("PATCH", "/api/me", { lang }).catch(() => {});
  }

  /** Make sure this device has a token. Throws ApiError("access_code") when the backend wants a code first. */
  async open(code?: string): Promise<void> {
    if (code !== undefined) await this.storage.set(CODE_KEY, code.trim());
    if (!this.token) this.token = await this.storage.get(TOKEN_KEY);
    if (this.token && code === undefined) return;
    this.opening ??= (async () => {
      const saved = await this.storage.get(CODE_KEY);
      const res = await this.raw("POST", "/api/session", { lang: this.lang, code: saved }, false);
      const data = (await res.json()) as { token: string; features: Features };
      this.token = data.token;
      this.features = data.features;
      await this.storage.set(TOKEN_KEY, this.token);
    })().finally(() => (this.opening = null));
    await this.opening;
  }

  private async raw(method: string, path: string, body: unknown, auth = true): Promise<Response> {
    const binary = body instanceof Uint8Array;
    let res: Response;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: {
          ...(auth && this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(body !== undefined ? { "Content-Type": binary ? "application/octet-stream" : "application/json" } : {}),
        },
        body: body === undefined ? undefined : binary ? (body as BodyInit) : JSON.stringify(body),
      });
    } catch {
      throw new ApiError("offline", 0, "network");
    }
    if (res.ok) return res;
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(data.error || `HTTP ${res.status}`, res.status, data.code || (res.status >= 500 ? "server" : "request"));
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.open();
    try {
      return (await (await this.raw(method, path, body)).json()) as T;
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== "auth") throw err;
      // The backend forgot this device. Introduce it again and retry once.
      this.token = "";
      await this.storage.set(TOKEN_KEY, "");
      await this.open();
      return (await (await this.raw(method, path, body)).json()) as T;
    }
  }

  home = () =>
    this.call<HomeView>("GET", "/api/home").then((h) => {
      this.features = h.features;
      return h;
    });
  library = () => this.call<{ rows: LibraryRow[] }>("GET", "/api/articles").then((r) => r.rows);
  createArticle = () => this.call<{ id: string }>("POST", "/api/articles").then((r) => r.id);
  article = (id: string) => this.call<ArticleView>("GET", `/api/articles/${id}`);
  deleteArticle = (id: string) => this.call<unknown>("DELETE", `/api/articles/${id}`);
  seen = (id: string) => this.call<unknown>("POST", `/api/articles/${id}/seen`);
  compose = (id: string) => this.call<unknown>("POST", `/api/articles/${id}/compose`);
  decide = (id: string, annotationId: string, action: AnnAction) =>
    this.call<ArticleView>("POST", `/api/articles/${id}/annotations/${annotationId}`, { action });
  undo = (id: string) => this.call<ArticleView>("POST", `/api/articles/${id}/undo`);
  edit = (id: string, instruction: string) => this.call<unknown>("POST", `/api/articles/${id}/edit`, { instruction });
  publish = (id: string) => this.call<{ url: string }>("POST", `/api/articles/${id}/publish`, { target: "notion" });

  startRecording = (articleId: string, purpose: RecordingPurpose, target = "") =>
    this.call<{ id: string }>("POST", `/api/articles/${articleId}/recordings`, { purpose, target }).then((r) => r.id);
  uploadSlice = (recordingId: string, idx: number, pcm: Uint8Array) =>
    this.call<unknown>("PUT", `/api/recordings/${recordingId}/chunks/${idx}`, pcm);
  finishRecording = (recordingId: string, chunks: number, durationMs: number) =>
    this.call<unknown>("POST", `/api/recordings/${recordingId}/finish`, { chunks, durationMs });
  discardRecording = (recordingId: string) => this.call<unknown>("DELETE", `/api/recordings/${recordingId}`);

  async markdown(id: string): Promise<string> {
    await this.open();
    return (await this.raw("GET", `/api/articles/${id}/markdown`, undefined)).text();
  }
}
