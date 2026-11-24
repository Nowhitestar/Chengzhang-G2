/**
 * The app itself: which screen is showing, what a tap does there, and when to
 * ask the backend how things are going.
 *
 * How it feels on the glasses:
 *
 *   opening page ── tap ──▶ talk (ink, no words) ── tap ──▶ what you said
 *        ▲                                                     │ "Write it up"
 *        │                                                     ▼
 *   double-tap is always "back"            writing… (you can leave)
 *                                                              │
 *        title + what it says in one line  ◀───────────────────┘
 *        │
 *        ├─ go through the AI's notes one by one: keep / remove / answer out loud
 *        ├─ read it, a page at a time
 *        └─ say a change ("make the opening more direct") ── undo if you don't like it
 */
import { AudioInputSource, type EvenAppBridge, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { makeT, type T } from "../shared/i18n.ts";
import { hostOf, markIds, markInner, snippet, toGlassesText } from "../shared/text.ts";
import type { Annotation, ArticleView, HomeRow, HomeView, Lang, LibraryRow, RecordingPurpose } from "../shared/types.ts";
import { Api, ApiError, type Storage } from "./api.ts";
import { DemoMic, Recorder } from "./audio.ts";
import { Display, type Page } from "./glasses/display.ts";
import { Ink } from "./glasses/ink.ts";
import { readInput, type Input } from "./glasses/input.ts";
import { lineCount, paginate } from "./glasses/layout.ts";
import * as layout from "./glasses/screens.ts";

/** Everything the app can be showing. */
export type Screen =
  | { name: "boot" }
  | { name: "problem"; kind: "offline" | "code" | "mic" | "other"; message: string }
  | { name: "home"; view: HomeView | null }
  | { name: "library"; rows: LibraryRow[] }
  | {
      name: "listening";
      purpose: RecordingPurpose;
      /** The question being answered, when purpose is "answer". */
      question: string;
      /** Asking whether to throw the recording away (it keeps recording meanwhile). */
      confirm: boolean;
    }
  | { name: "saving" }
  | { name: "notes"; article: ArticleView }
  | { name: "composing"; article: ArticleView }
  | { name: "failed"; article: ArticleView }
  | { name: "brief"; article: ArticleView; note: string }
  | { name: "review"; article: ArticleView; id: string }
  | { name: "reader"; article: ArticleView; source: "article" | "material"; pages: string[]; page: number }
  | { name: "revising"; article: ArticleView; then: "brief" | "review" }
  | { name: "changed"; article: ArticleView; then: "brief" | "review" }
  | { name: "notice"; message: string };

interface Entry {
  label: string;
  run: () => void | Promise<void>;
}

interface Talk {
  recorder: Recorder;
  ink: Ink;
  articleId: string;
  /** Resolves to the recording's id once the backend has created it. */
  recording: Promise<string>;
  purpose: RecordingPurpose;
  target: string;
  timer: number;
  startedAt: number;
  /** Where to go if the take is thrown away. */
  back: () => void;
  then: "brief" | "review";
  /** Started by pressing and holding: letting go ends it. */
  held: boolean;
}

/** The clock is refreshed every tick; a stroke of ink is added every second tick. */
const TICK_MS = 350;
const POLL_MS = 1500;
const RESUME_KEY = "chengzhang.resume";
const TAKE_KEY = "chengzhang.take";

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export class App {
  screen: Screen = { name: "boot" };
  /** What the list on screen does, row by row. */
  private entries: Entry[] = [];
  /** Bumped on every change of screen, so late answers from the backend can tell they are stale. */
  private epoch = 0;
  private busy = false;
  private talk: Talk | null = null;
  private poll: number | null = null;
  private readonly display: Display;
  /** Set with ?mic=demo: speech-shaped noise instead of the real microphone. */
  private readonly demoMic = new URLSearchParams(location.search).get("mic") === "demo" ? new DemoMic() : null;
  private t: T;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly bridge: EvenAppBridge,
    readonly api: Api,
    private readonly storage: Storage,
    public lang: Lang,
  ) {
    this.display = new Display(bridge);
    this.t = makeT(lang);
  }

  // ---------- plumbing ----------

  /** The phone-side page listens here to mirror what is going on. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The ink on screen while talking, for the phone-side picture. */
  get strokes(): number[] {
    return this.talk?.ink.strokes ?? [];
  }

  get talkingMs(): number {
    return this.talk?.recorder.elapsedMs ?? 0;
  }

  setLang(lang: Lang): void {
    this.lang = lang;
    this.t = makeT(lang);
    this.api.setLang(lang);
    this.render();
  }

  private go(screen: Screen): number {
    this.screen = screen;
    this.epoch++;
    console.info(`[screen] ${screen.name}`);
    if (this.poll !== null) {
      window.clearInterval(this.poll);
      this.poll = null;
    }
    this.remember();
    this.render();
    return this.epoch;
  }

  /** Change the current screen's data without it counting as navigation. */
  private update(screen: Screen): void {
    this.screen = screen;
    this.render();
  }

  private render(): void {
    const { page, entries } = this.build();
    this.entries = entries ?? [];
    void this.display.show(page);
    for (const l of this.listeners) l();
  }

  /** Remember which article is open, so a restart of the phone app lands in the same place. */
  private remember(): void {
    const s = this.screen;
    const articleId = "article" in s ? s.article.id : "";
    void this.storage.set(RESUME_KEY, articleId);
  }

  private watch(articleId: string, onChange: (a: ArticleView) => void): void {
    const epoch = this.epoch;
    this.poll = window.setInterval(async () => {
      try {
        const a = await this.api.article(articleId);
        if (this.epoch === epoch) onChange(a);
      } catch {
        // offline for a moment: the next tick tries again
      }
    }, POLL_MS);
  }

  /** Run something that talks to the backend; show a clear screen when it fails. */
  private async attempt(work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await work();
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy = false;
    }
  }

  private fail(err: unknown): void {
    const t = this.t;
    if (err instanceof ApiError && err.code === "network") {
      this.go({
        name: "problem",
        kind: "offline",
        message: t("连不上成章的服务器。\n看看手机的网络，然后点一下重试。", "Can’t reach the Chengzhang server.\nCheck the phone’s connection, then tap to try again."),
      });
    } else if (err instanceof ApiError && err.code === "access_code") {
      this.go({
        name: "problem",
        kind: "code",
        message: t("还差一步：在手机上打开成章，填入访问码。", "One more step: open Chengzhang on your phone and enter the access code."),
      });
    } else if (err instanceof ApiError && err.status < 500 && err.status > 0) {
      this.go({ name: "notice", message: err.message });
    } else {
      console.error("[app]", err);
      this.go({ name: "problem", kind: "other", message: t("出了点问题。点一下重试。", "Something went wrong. Tap to try again.") });
    }
  }

  // ---------- starting up ----------

  async start(): Promise<void> {
    this.render();
    await this.attempt(async () => {
      await this.api.open();
      await this.salvage();
      const resume = await this.storage.get(RESUME_KEY);
      if (resume) {
        try {
          this.openWith(await this.api.article(resume));
          return;
        } catch (err) {
          if (err instanceof ApiError && err.code === "network") throw err;
          // the article is gone: fall through to the opening page
        }
      }
      await this.home();
    });
  }

  /** From the phone page: try again after a problem. */
  retry(): void {
    void this.start();
  }

  /** From the phone page: the access code was typed in. Rejects when the backend does not accept it. */
  async enterCode(code: string): Promise<void> {
    await this.api.open(code);
    await this.start();
  }

  /** From the phone page: open an article on the glasses as well. */
  openFromPhone(id: string): void {
    if (this.talk) return; // not while recording
    void this.attempt(() => this.open(id));
  }

  /** From the phone page: delete an article for good, then go back to the opening page. */
  async deleteFromPhone(id: string): Promise<void> {
    if (this.talk) return;
    await this.api.deleteArticle(id);
    await this.attempt(() => this.home());
  }

  /** From the phone page: the article was sent to Notion. */
  published(id: string, url: string): void {
    const s = this.screen;
    if ("article" in s && s.article.id === id) this.update({ ...s, article: { ...s.article, publishedUrl: url } } as Screen);
  }

  /**
   * If the phone app was closed in the middle of talking, the slices that were
   * already uploaded are still waiting on the backend. Finish that recording so
   * what was said is not lost.
   */
  private async salvage(): Promise<void> {
    const saved = await this.storage.get(TAKE_KEY);
    if (!saved) return;
    await this.storage.set(TAKE_KEY, "");
    try {
      const take = JSON.parse(saved) as { id: string; slices: number; ms: number };
      if (take.slices > 0) await this.api.finishRecording(take.id, take.slices, take.ms);
      else await this.api.discardRecording(take.id);
    } catch {
      // nothing to salvage
    }
  }

  // ---------- input ----------

  /** Every event from the glasses arrives here. */
  onEvent(event: EvenHubEvent): void {
    const pcm = event.audioEvent?.audioPcm;
    if (pcm) {
      this.talk?.recorder.push(pcm);
      return;
    }
    const input = readInput(event);
    if (input) this.onInput(input);
  }

  onInput(input: Input): void {
    if (input.type === "exit") {
      void this.leave();
      return;
    }
    if (input.type === "covered" || input.type === "uncovered") return;
    if (input.type === "release") {
      if (this.talk?.held) void this.doneTalking();
      return;
    }
    if (this.busy) return;
    if (input.type === "hold") {
      this.holdToTalk();
      return;
    }
    const s = this.screen;
    switch (s.name) {
      case "boot":
      case "saving":
        return;
      case "problem":
        if (input.type === "double") void this.bridge.shutDownPageContainer(1);
        else if (input.type === "tap") void this.start();
        return;
      case "notice":
        void this.attempt(() => this.home());
        return;
      case "home":
        // The opening page is the root: a double tap here asks the system to close the app.
        if (input.type === "double") void this.bridge.shutDownPageContainer(1);
        else if (input.type === "tap") {
          if (this.entries.length) void this.choose(input.index);
          else void this.startTalking({ purpose: "material", back: () => void this.home() });
        }
        return;
      case "listening":
        if (s.confirm) {
          if (input.type === "tap") void this.choose(input.index);
          else if (input.type === "double") this.update({ ...s, confirm: false });
        } else if (input.type === "tap") void this.doneTalking();
        else if (input.type === "double") this.update({ ...s, confirm: true });
        return;
      case "reader":
        if (input.type === "double") this.closeReader(s);
        else if (input.type === "up") this.turn(s, -1);
        else this.turn(s, +1);
        return;
      case "composing":
        // Nothing to decide here; any touch goes back to the opening page while the writing continues.
        if (input.type === "tap" || input.type === "double") void this.attempt(() => this.home());
        return;
      default:
        if (input.type === "tap") void this.choose(input.index);
        else if (input.type === "double") this.back();
        return;
    }
  }

  /**
   * Press and hold on a finished article to say a change; let go when done.
   * On one of the AI's questions, the same gesture answers it. It is a shortcut:
   * everything it does is also in the list on screen.
   */
  private holdToTalk(): void {
    const s = this.screen;
    if (this.talk || !("article" in s) || s.article.status !== "ready" || s.article.revising) return;
    const a = s.article;
    const note = s.name === "review" ? a.annotations.find((n) => n.id === s.id) : undefined;
    if (note?.kind === "ask") {
      void this.startTalking({
        purpose: "answer",
        articleId: a.id,
        target: note.id,
        question: note.note,
        back: () => this.go({ name: "review", article: a, id: note.id }),
        then: "review",
        held: true,
      });
    } else if (s.name === "brief" || s.name === "changed" || (s.name === "reader" && s.source === "article")) {
      void this.startTalking({ purpose: "instruction", articleId: a.id, back: () => this.showBrief(a), then: "brief", held: true });
    }
  }

  private async choose(index: number): Promise<void> {
    const entry = this.entries[index];
    if (!entry) return;
    await this.attempt(async () => {
      await entry.run();
    });
  }

  /** Double tap: one step back. */
  private back(): void {
    const s = this.screen;
    switch (s.name) {
      case "review":
      case "changed":
        this.showBrief(s.article);
        return;
      case "revising":
        return; // nothing to go back to until the change is done
      default:
        void this.attempt(() => this.home());
    }
  }

  /** The app is closing: stop the microphone and keep what was said. */
  private async leave(): Promise<void> {
    const talk = this.talk;
    if (!talk) return;
    this.talk = null;
    window.clearInterval(talk.timer);
    void this.microphone(false);
    try {
      const { slices, durationMs } = await talk.recorder.finish();
      await this.api.finishRecording(await talk.recording, slices, durationMs);
      await this.storage.set(TAKE_KEY, "");
    } catch {
      // whatever was uploaded is finished on the next launch (see salvage)
    }
  }

  // ---------- opening page ----------

  private async home(): Promise<void> {
    const cached = this.screen.name === "home" ? this.screen.view : null;
    const epoch = this.go({ name: "home", view: cached });
    const view = await this.api.home();
    if (this.epoch !== epoch) return;
    this.update({ name: "home", view });
    // While something is being written, look again every few seconds so "Writing" turns into "Ready".
    if (view.rows.some((r) => r.kind === "composing")) {
      this.poll = window.setInterval(async () => {
        try {
          const next = await this.api.home();
          if (this.epoch !== epoch) return;
          if (JSON.stringify(next) !== JSON.stringify((this.screen as { view: HomeView }).view)) this.update({ name: "home", view: next });
          if (!next.rows.some((r) => r.kind === "composing") && this.poll !== null) {
            window.clearInterval(this.poll);
            this.poll = null;
          }
        } catch {
          // try again on the next tick
        }
      }, 4000);
    }
  }

  private rowLabel(row: HomeRow): string {
    const t = this.t;
    const name = row.title || (row.preview ? t(`「${row.preview}」`, `“${row.preview}”`) : t("新的一篇", "New article"));
    switch (row.kind) {
      case "ready":
        return t(`写好了：${name}`, `Ready: ${name}`);
      case "composing":
        return t(`正在写：${name}`, `Writing: ${name}`);
      case "failed":
        return t(`没写成：${name}`, `Couldn’t write: ${name}`);
      case "draft":
        return t(`接着讲：${name}`, `Pick up: ${name}`);
    }
  }

  private async open(id: string): Promise<void> {
    this.openWith(await this.api.article(id));
  }

  /** Go to the screen that fits the state the article is in. */
  private openWith(a: ArticleView): void {
    if (a.status === "composing") this.showComposing(a);
    else if (a.status === "failed") this.go({ name: "failed", article: a });
    else if (a.status === "ready") {
      if (a.revising) this.showRevising(a, "brief");
      else this.showBrief(a);
    } else if (a.recordings.length) this.showNotes(a);
    else void this.home();
  }

  private async library(): Promise<void> {
    this.go({ name: "library", rows: await this.api.library() });
  }

  // ---------- talking ----------

  /** Start recording at once; the article and the recording are created in the background. */
  private async startTalking(o: {
    purpose: RecordingPurpose;
    articleId?: string;
    target?: string;
    question?: string;
    back: () => void;
    then?: "brief" | "review";
    held?: boolean;
  }): Promise<void> {
    if (this.talk) return;
    const articleReady = o.articleId ? Promise.resolve(o.articleId) : this.api.createArticle();
    const recording = articleReady.then((id) => this.api.startRecording(id, o.purpose, o.target ?? ""));
    recording.catch(() => {});
    let sent = 0;
    const recorder = new Recorder({
      upload: async (idx, pcm) => {
        const id = await recording;
        await this.api.uploadSlice(id, idx, pcm);
        sent = Math.max(sent, idx + 1);
        // Note how far the upload got, so an interrupted take can be finished on the next launch.
        void this.storage.set(TAKE_KEY, JSON.stringify({ id, slices: sent, ms: Math.round(recorder.elapsedMs) }));
      },
    });
    const questionLines = o.question ? Math.min(3, lineCount(o.question)) : 0;
    const talk: Talk = {
      recorder,
      ink: new Ink(layout.inkRows(questionLines)),
      articleId: "",
      recording,
      purpose: o.purpose,
      target: o.target ?? "",
      timer: 0,
      startedAt: Date.now(),
      back: o.back,
      then: o.then ?? "brief",
      held: o.held ?? false,
    };
    this.talk = talk;
    this.go({ name: "listening", purpose: o.purpose, question: o.question ?? "", confirm: false });
    void articleReady.then((id) => (talk.articleId = id)).catch(() => {});

    let lastClock = "";
    let ticks = 0;
    talk.timer = window.setInterval(() => {
      if (this.talk !== talk) return;
      const changed = ++ticks % 2 === 0 && talk.ink.add(recorder.takeLevel());
      const now = clock(recorder.elapsedMs);
      if (changed || now !== lastClock) {
        lastClock = now;
        this.render();
      }
      if (!recorder.elapsedMs && Date.now() - talk.startedAt > 4000) {
        this.dropTalk();
        this.go({
          name: "problem",
          kind: "mic",
          message: this.t(
            "没收到麦克风的声音。\n请在手机上允许成章使用眼镜的麦克风，然后点一下重试。",
            "No sound from the microphone.\nAllow Chengzhang to use the glasses’ microphone on your phone, then tap to try again.",
          ),
        });
      }
    }, TICK_MS);

    try {
      await this.microphone(true);
      await recording;
    } catch (err) {
      if (this.talk !== talk) return;
      this.dropTalk();
      this.fail(err instanceof ApiError ? err : new ApiError("mic", 0, "other"));
    }
  }

  private async microphone(on: boolean): Promise<void> {
    if (this.demoMic) {
      if (on) this.demoMic.start((pcm) => this.talk?.recorder.push(pcm));
      else this.demoMic.stop();
      return;
    }
    const ok = on ? await this.bridge.audioControl(true, AudioInputSource.Glasses) : await this.bridge.audioControl(false);
    if (on && !ok) throw new Error("the microphone did not open");
  }

  /** Stop the microphone and forget the take, without telling the backend anything yet. */
  private dropTalk(): Talk | null {
    const talk = this.talk;
    if (!talk) return null;
    this.talk = null;
    window.clearInterval(talk.timer);
    talk.recorder.cancel();
    void this.microphone(false);
    void this.storage.set(TAKE_KEY, "");
    void talk.recording.then((id) => this.api.discardRecording(id)).catch(() => {});
    return talk;
  }

  private throwAway(): void {
    const talk = this.dropTalk();
    talk?.back();
  }

  private async doneTalking(): Promise<void> {
    const talk = this.talk;
    if (!talk || this.busy) return;
    const t = this.t;
    // A tap by mistake, or nothing but silence: there is nothing to keep.
    if (talk.recorder.elapsedMs < 800 || !talk.recorder.heard) {
      this.dropTalk();
      const epoch = this.go({ name: "notice", message: t("没听到内容。", "I didn’t hear anything.") });
      window.setTimeout(() => this.epoch === epoch && talk.back(), 1600);
      return;
    }
    this.busy = true;
    window.clearInterval(talk.timer);
    void this.microphone(false);
    this.go({ name: "saving" });
    try {
      const { slices, durationMs } = await talk.recorder.finish();
      const id = await talk.recording;
      await this.api.finishRecording(id, slices, durationMs);
      await this.storage.set(TAKE_KEY, "");
      this.talk = null;
      const article = await this.api.article(talk.articleId);
      this.busy = false;
      if (talk.purpose === "material") this.showNotes(article);
      else this.showRevising({ ...article, revising: true }, talk.then);
    } catch (err) {
      this.busy = false;
      if (err instanceof ApiError && err.code !== "network") {
        this.dropTalk();
        this.fail(err);
        return;
      }
      // The recording is still in memory. Say so, and let a tap try again.
      this.go({
        name: "problem",
        kind: "offline",
        message: t("录音还没传上去。\n看看手机的网络，然后点一下重试。录音还在。", "The recording hasn’t uploaded yet.\nCheck the phone’s connection, then tap to try again. Nothing is lost."),
      });
    }
  }

  // ---------- what you said ----------

  private showNotes(article: ArticleView): void {
    this.go({ name: "notes", article });
    if (article.recordings.some((r) => r.status === "processing")) {
      this.watch(article.id, (a) => {
        if (this.screen.name !== "notes") return;
        this.update({ name: "notes", article: a });
        if (!a.recordings.some((r) => r.status === "processing") && this.poll !== null) {
          window.clearInterval(this.poll);
          this.poll = null;
        }
      });
    }
  }

  private async compose(article: ArticleView): Promise<void> {
    await this.api.compose(article.id);
    this.showComposing({ ...article, status: "composing", phase: "research" });
  }

  private showComposing(article: ArticleView): void {
    this.go({ name: "composing", article });
    this.watch(article.id, (a) => {
      if (a.status === "ready") this.showBrief(a);
      else if (a.status === "failed") this.go({ name: "failed", article: a });
      else if (this.screen.name === "composing" && a.phase !== this.screen.article.phase) this.update({ name: "composing", article: a });
    });
  }

  // ---------- the finished article ----------

  private showBrief(article: ArticleView, note = ""): void {
    this.go({ name: "brief", article, note });
    if (!article.seen) void this.api.seen(article.id).catch(() => {});
  }

  /** Notes the author has not decided on yet, in the order they appear in the text. */
  private openNotes(a: ArticleView): Annotation[] {
    const order = markIds(a.markdown);
    return a.annotations.filter((n) => n.state === "open").sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));
  }

  /** Show the next undecided note, or go back to the article when none are left. */
  private review(article: ArticleView): void {
    const next = this.openNotes(article)[0];
    if (next) this.go({ name: "review", article, id: next.id });
    else this.showBrief(article, this.t("都定完了。", "All notes done."));
  }

  private async decide(article: ArticleView, id: string, action: "keep" | "remove" | "apply" | "dismiss"): Promise<void> {
    this.review(await this.api.decide(article.id, id, action));
  }

  private read(article: ArticleView, source: "article" | "material"): void {
    const body =
      source === "article"
        ? toGlassesText(article.markdown, article.annotations)
        : article.recordings
            .map((r) => r.text)
            .filter(Boolean)
            .join("\n");
    this.go({ name: "reader", article, source, pages: paginate(body, layout.PAGE_LINES), page: 0 });
  }

  private turn(s: Extract<Screen, { name: "reader" }>, by: number): void {
    const page = s.page + by;
    if (page < 0) return;
    if (page >= s.pages.length) this.closeReader(s);
    else this.update({ ...s, page });
  }

  private closeReader(s: Extract<Screen, { name: "reader" }>): void {
    if (s.source === "article") this.showBrief(s.article);
    else this.showNotes(s.article);
  }

  private showRevising(article: ArticleView, then: "brief" | "review"): void {
    this.go({ name: "revising", article, then });
    this.watch(article.id, (a) => {
      if (a.revising) {
        if (this.screen.name === "revising" && a.heard !== this.screen.article.heard) this.update({ name: "revising", article: a, then });
        return;
      }
      this.go({ name: "changed", article: a, then });
    });
  }

  private async undo(article: ArticleView): Promise<void> {
    this.showBrief(await this.api.undo(article.id), this.t("撤销了。", "Undone."));
  }

  private async publish(article: ArticleView): Promise<void> {
    const t = this.t;
    this.update({ name: "brief", article, note: t("在发到 Notion…", "Sending to Notion…") });
    const { url } = await this.api.publish(article.id);
    this.showBrief({ ...article, publishedUrl: url }, t("发到 Notion 了。", "Sent to Notion."));
  }

  // ---------- drawing ----------

  /** The page for the current screen, and what each row of its list does. */
  private build(): { page: Page; entries?: Entry[] } {
    const t = this.t;
    const s = this.screen;
    const brand = t("成章", "Chengzhang");
    const labels = (entries: Entry[]) => entries.map((e) => e.label);

    switch (s.name) {
      case "boot":
        return { page: layout.words({ main: brand }) };

      case "problem":
        return { page: layout.words({ head: brand, main: s.message }) };

      case "notice":
        return { page: layout.words({ head: brand, main: s.message }) };

      case "saving":
        return { page: layout.words({ main: t("在保存…", "Saving…") }) };

      case "home": {
        const view = s.view;
        const demo = view?.features.demo ? t(" · 演示模式", " · demo mode") : "";
        if (!view || (!view.rows.length && !view.finished)) {
          return {
            page: layout.words({
              head: brand + demo,
              main: t("想到哪，\n讲到哪。", "Think it,\nsay it."),
              foot: view ? t("● 轻点，开始讲", "● Tap to start talking") : " ",
              footLines: 1,
              footBright: true,
            }),
          };
        }
        const entries: Entry[] = [
          { label: t("● 讲一篇新的", "● Start a new one"), run: () => this.startTalking({ purpose: "material", back: () => void this.home() }) },
          ...view.rows.map((row) => ({ label: this.rowLabel(row), run: () => this.open(row.id) })),
        ];
        if (view.finished) entries.push({ label: t(`全部文章（${view.finished}）`, `All articles (${view.finished})`), run: () => this.library() });
        return { page: layout.menu({ head: t("想到哪，讲到哪。", "Think it, say it.") + demo, items: labels(entries) }), entries };
      }

      case "library": {
        const rows = s.rows.filter((r) => r.status === "ready").slice(0, 20);
        const entries = rows.map((r) => ({ label: r.title || r.preview || t("没有标题", "Untitled"), run: () => this.open(r.id) }));
        if (!entries.length) return { page: layout.words({ head: t("全部文章", "All articles"), main: t("还没有写好的文章。", "No finished articles yet.") }) };
        return { page: layout.menu({ head: t("全部文章", "All articles"), items: labels(entries) }), entries };
      }

      case "listening": {
        const talk = this.talk;
        const time = `● ${clock(talk?.recorder.elapsedMs ?? 0)}`;
        if (s.confirm) {
          const entries: Entry[] = [
            { label: t("接着讲", "Keep talking"), run: () => this.update({ ...s, confirm: false }) },
            { label: t("不要了", "Throw it away"), run: () => this.throwAway() },
          ];
          return {
            page: layout.choice({ head: time + t(" · 还在录", " · still recording"), main: t("不要这段录音了？", "Throw this recording away?"), items: labels(entries), rows: 2 }),
            entries,
          };
        }
        const held = talk?.held;
        const foot =
          s.purpose === "material"
            ? t("停顿、重复都没关系。讲完点一下。", "Pauses are fine. Tap when done.")
            : s.purpose === "instruction"
              ? held
                ? t("说一句要怎么改。说完松手。", "Say what to change. Let go when done.")
                : t("说一句要怎么改。说完点一下。", "Say what to change. Tap when done.")
              : held
                ? t("直接回答。说完松手。", "Answer out loud. Let go when done.")
                : t("直接回答。说完点一下。", "Answer out loud. Tap when done.");
        return { page: layout.listening({ clock: time, ink: talk?.ink.text ?? "", foot, question: s.question || undefined }) };
      }

      case "notes": {
        const a = s.article;
        const n = a.recordings.length;
        const minutes = Math.max(1, Math.round(a.recordings.reduce((sum, r) => sum + r.durationMs, 0) / 60_000));
        const tidying = a.recordings.some((r) => r.status === "processing");
        const last = a.recordings[n - 1];
        const headLine =
          t(`讲了 ${n} 段 · ${minutes} 分钟`, `${n} ${n === 1 ? "recording" : "recordings"} · ${minutes} min`) + (tidying ? t(" · 在整理", " · tidying up") : "");
        const preview = last?.text
          ? t(`「${snippet(last.text, 200)}」`, `“${snippet(last.text, 200)}”`)
          : t("正在把刚才讲的整理出来…", "Tidying up what you just said…");
        const entries: Entry[] = [
          { label: t("写成文章", "Write it up"), run: () => this.compose(a) },
          {
            label: t("接着讲", "Keep talking"),
            run: () => this.startTalking({ purpose: "material", articleId: a.id, back: () => void this.attempt(() => this.open(a.id)) }),
          },
          { label: t("看看我讲了什么", "Read what I said"), run: () => this.read(a, "material") },
          {
            label: t("删掉最后一段", "Remove the last recording"),
            run: async () => {
              if (last) await this.api.discardRecording(last.id);
              await this.open(a.id);
            },
          },
        ];
        return { page: layout.choice({ head: headLine, main: preview, items: labels(entries), rows: 4 }), entries };
      }

      case "composing": {
        const phase = s.article.phase === "write" ? t("在成文…", "Writing it up…") : t("在查证…", "Checking the facts…");
        return {
          page: layout.words({
            head: t("正在写", "Writing"),
            main: phase,
            foot: t("要一两分钟。可以先离开，写好了会出现在打开页。", "Takes a minute or two. You can leave: it will be waiting on the opening page."),
            footLines: 2,
          }),
        };
      }

      case "failed": {
        const a = s.article;
        const entries: Entry[] = [
          { label: t("再试一次", "Try again"), run: () => this.compose(a) },
          { label: t("返回", "Back"), run: () => this.home() },
        ];
        return { page: layout.choice({ head: t("没写成", "Couldn’t write it"), main: a.error || t("出了点问题。", "Something went wrong."), items: labels(entries), rows: 2 }), entries };
      }

      case "brief": {
        const a = s.article;
        const open = this.openNotes(a).length;
        const count = t(`${a.words} 字`, `${a.words} words`);
        const headLine = s.note || (open ? t(`写好了 · ${count} · ${open} 处等你定`, `Ready · ${count} · ${open} ${open === 1 ? "note" : "notes"} for you`) : t(`写好了 · ${count}`, `Ready · ${count}`));
        const entries: Entry[] = [];
        if (open) entries.push({ label: t(`逐条定夺（${open}）`, open === 1 ? "Go through 1 note" : `Go through ${open} notes`), run: () => this.review(a) });
        entries.push({ label: t("读全文", "Read it"), run: () => this.read(a, "article") });
        entries.push({
          label: t("说一句，改一下（也可以按住说）", "Say a change (or press and hold)"),
          run: () => this.startTalking({ purpose: "instruction", articleId: a.id, back: () => this.showBrief(a), then: "brief" }),
        });
        if (this.api.features.notion) {
          entries.push(a.publishedUrl ? { label: t("再发一次到 Notion", "Send to Notion again"), run: () => this.publish(a) } : { label: t("发到 Notion", "Send to Notion"), run: () => this.publish(a) });
        }
        if (a.canUndo) entries.push({ label: t("撤销上一次改动", "Undo the last change"), run: () => this.undo(a) });
        return { page: layout.brief({ head: headLine, title: a.title, gist: a.gist, items: labels(entries) }), entries };
      }

      case "review": {
        const a = s.article;
        const note = a.annotations.find((n) => n.id === s.id)!;
        const all = a.annotations.length;
        const at = all - this.openNotes(a).length + 1;
        const where = ` · ${at}/${all}`;
        const said = markInner(a.markdown, note.id).replace(/\s+/g, " ");
        const source = note.sourceUrl ? t(`来源：${hostOf(note.sourceUrl)}`, `Source: ${hostOf(note.sourceUrl)}`) : "";
        if (note.kind === "added") {
          const entries: Entry[] = [
            { label: t("留着", "Keep it"), run: () => this.decide(a, note.id, "keep") },
            { label: t("删掉", "Remove it"), run: () => this.decide(a, note.id, "remove") },
          ];
          return { page: layout.choice({ head: t("AI 补充", "AI added") + where, main: `〔${said}〕`, aside: source, items: labels(entries), rows: 2 }), entries };
        }
        if (note.kind === "diff") {
          const entries: Entry[] = [
            { label: t("照我说的", "Leave it as I said"), run: () => this.decide(a, note.id, "dismiss") },
            { label: t(`改成：${note.suggestion}`, `Change to: ${note.suggestion}`), run: () => this.decide(a, note.id, "apply") },
          ];
          return {
            page: layout.choice({
              head: t("和资料有出入", "Check this") + where,
              main: t(`你说的：「${said}」\n资料：${note.note}`, `You said: “${said}”\nBut: ${note.note}`),
              aside: source,
              items: labels(entries),
              rows: 2,
            }),
            entries,
          };
        }
        const entries: Entry[] = [
          {
            label: t("用语音回答", "Answer out loud"),
            run: () =>
              this.startTalking({ purpose: "answer", articleId: a.id, target: note.id, question: note.note, back: () => this.go({ name: "review", article: a, id: note.id }), then: "review" }),
          },
          { label: t("跳过", "Skip"), run: () => this.decide(a, note.id, "dismiss") },
        ];
        return { page: layout.choice({ head: t("想问你一句", "A question for you") + where, main: note.note, items: labels(entries), rows: 2 }), entries };
      }

      case "reader": {
        const of = `${s.page + 1} / ${s.pages.length}`;
        const last = s.page === s.pages.length - 1;
        return {
          page: layout.reading({
            body: s.pages[s.page] ?? "",
            foot: last ? t(`${of} · 点一下返回`, `${of} · tap: back`) : t(`${of} · 点一下翻页 · 双击返回`, `${of} · tap: next · double-tap: back`),
          }),
        };
      }

      case "revising": {
        const heard = s.article.heard ? t(`听到的是：「${s.article.heard}」`, `Heard: “${s.article.heard}”`) : "";
        return { page: layout.words({ head: t("在改", "Changing it"), main: t("在改…", "Changing it…"), foot: heard || " ", footLines: 2 }) };
      }

      case "changed": {
        const a = s.article;
        const heard = a.heard ? t(`听到的是：「${a.heard}」`, `Heard: “${a.heard}”`) : "";
        const more = s.then === "review" && this.openNotes(a).length > 0;
        if (a.revisionError) {
          const entries: Entry[] = [
            {
              label: t("再说一次", "Say it again"),
              run: () => this.startTalking({ purpose: "instruction", articleId: a.id, back: () => this.showBrief(a), then: "brief" }),
            },
            { label: t("返回", "Back"), run: () => (more ? this.review(a) : this.showBrief(a)) },
          ];
          return { page: layout.choice({ head: t("没改成", "Not changed"), main: a.revisionError, aside: heard, asideLines: 2, items: labels(entries), rows: 2 }), entries };
        }
        const entries: Entry[] = [
          { label: more ? t("好，下一条", "OK, next note") : t("好", "OK"), run: () => (more ? this.review(a) : this.showBrief(a)) },
          { label: t("撤销", "Undo"), run: () => this.undo(a) },
          { label: t("读全文", "Read it"), run: () => this.read(a, "article") },
        ];
        return {
          page: layout.choice({ head: t("改好了", "Changed"), main: a.lastChange || t("改好了。", "Done."), aside: heard, asideLines: 2, items: labels(entries), rows: 3 }),
          entries,
        };
      }
    }
  }
}
