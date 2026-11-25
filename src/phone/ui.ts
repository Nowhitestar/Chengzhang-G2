/**
 * The page on the phone. The glasses are where things happen; this page is the
 * paper next to them: it says what the glasses are doing, shows the article
 * properly typeset, and holds the few things that need a real screen (copying
 * the article out, entering an access code, choosing the language).
 *
 * The page keeps one skeleton whatever the app is doing:
 *
 *   top       the mark, the language
 *   status    where the glasses are: a small label, at most one headline, a line or two
 *   the page  what is being made: ink while talking, then the words, then the article
 *   library   everything written so far (opening page only)
 *
 * Every state is rendered as HTML for that skeleton and handed to the motion
 * layer (motion.ts), which works out what moved, changed, arrived or left and
 * shows exactly that. Nothing here animates anything by hand, with one
 * exception: the clock and the ink, which change several times a second and
 * are updated directly.
 */
import { makeT, type T } from "../../shared/i18n.ts";
import { hostOf, markIds, markInner } from "../../shared/text.ts";
import type { Annotation, ArticleView, Features, Lang, LibraryRow } from "../../shared/types.ts";
import { ApiError, type Storage } from "../api.ts";
import type { Screen } from "../app.ts";
import { escapeHtml as e, mdToHtml } from "./markdown.ts";
import { EASE, hash, morph, motionOK, T as TIME, transition } from "./motion.ts";
import "./style.css";

/** What the page needs from the app. The real app provides it; so does the storyboard used to check the motion. */
export interface PhoneHost {
  readonly screen: Screen;
  readonly lang: Lang;
  /** Every stroke of ink in the current take (1..3 for a stroke, 0 for a new line). */
  readonly strokes: readonly number[];
  readonly talkingMs: number;
  /** The take was started by pressing and holding. */
  readonly held: boolean;
  readonly api: {
    features: Features;
    library(): Promise<LibraryRow[]>;
    markdown(id: string): Promise<string>;
    publish(id: string): Promise<{ url: string }>;
  };
  subscribe(listener: () => void): () => void;
  setLang(lang: Lang): void;
  retry(): void;
  enterCode(code: string): Promise<void>;
  openFromPhone(id: string): void;
  deleteFromPhone(id: string): Promise<void>;
  published(id: string, url: string): void;
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" role="img" aria-label="成章"><rect class="logo-paper" width="240" height="240"/><g transform="translate(120 120) scale(1.12) translate(-120 -120)"><g class="logo-ink" stroke-width="18" stroke-linecap="round" fill="none"><path d="M108 41H132"/><path d="M54 75H186"/><path d="M78 109H162"/><path d="M78 143H162"/></g><rect class="logo-seal" x="76" y="168" width="88" height="42" rx="12"/></g></svg>`;
const CHECK = `<svg class="check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.6l3 3 6-7.2"/></svg>`;
/** Three dots of ink that breathe in turn: something is being worked on. */
const DOTS = `<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>`;

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export function showOutsideEven(): void {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root || root.childElementCount) return;
  root.innerHTML = `<p class="outside">Chengzhang runs inside the Even Realities app, on G2 glasses.<br>Open this address there, or in the Even Hub simulator.</p>`;
}

export function mountPhone(app: PhoneHost, storage: Storage, root = document.querySelector<HTMLElement>("#app")!): void {
  root.innerHTML = `<main class="page"></main><div class="toast" role="status" aria-live="polite" hidden></div>`;
  const page = root.querySelector<HTMLElement>(".page")!;
  const toastEl = root.querySelector<HTMLElement>(".toast")!;

  // What only this page knows.
  let library: LibraryRow[] = [];
  let libraryFor = "";
  let codeError = "";
  let notionBusy = false;
  /** Deleting takes two taps: the first arms the button for a few seconds. */
  let deleteArmed = "";
  /** The article whose Markdown was just copied, for a moment. */
  let copied = "";

  // ---------- the toast: one element, reused ----------

  let toastTimer = 0;
  let toastOut: Animation | null = null;
  function toast(message: string): void {
    window.clearTimeout(toastTimer);
    toastOut?.cancel();
    const showing = !toastEl.hidden;
    toastEl.textContent = message;
    toastEl.hidden = false;
    if (!showing) {
      toastEl.animate(
        motionOK() ? [{ opacity: 0, transform: "translate(-50%, 12px)" }, { opacity: 1, transform: "translate(-50%, 0)" }] : [{ opacity: 0 }, { opacity: 1 }],
        { duration: TIME.base, easing: EASE.out },
      );
    }
    toastTimer = window.setTimeout(() => {
      toastOut = toastEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: TIME.fast, easing: EASE.in });
      toastOut.finished.then(
        () => (toastEl.hidden = true),
        () => {},
      );
    }, 2200);
  }

  async function copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Older WebViews have no clipboard API: fall back to a hidden text box.
      const box = document.createElement("textarea");
      box.value = text;
      box.style.position = "fixed";
      box.style.opacity = "0";
      document.body.append(box);
      box.select();
      const ok = document.execCommand("copy");
      box.remove();
      return ok;
    }
  }

  // ---------- the status: where the glasses are ----------

  interface Status {
    /** Small line above: where we are. May contain the working dots. */
    label?: string;
    /** At most one headline. */
    head?: string;
    /** A smaller headline, for messages rather than moments. */
    small?: boolean;
    lines?: string[];
    /** Show the clock and the ink. */
    talk?: "live" | "saving";
    extra?: string;
  }

  function status(s: Screen, t: T, open: number): Status {
    switch (s.name) {
      case "boot":
        return { label: `<span class="late">${DOTS}</span>` };
      case "home":
        return { head: t("想到哪，\n讲到哪。", "Think it,\nsay it."), lines: [t("在眼镜上轻点镜腿，开始讲。", "Tap the temple of your glasses to start talking.")] };
      case "library":
        return { label: t("眼镜上", "On the glasses"), head: t("全部文章", "All articles") };
      case "listening":
      case "saving": {
        const label =
          s.name === "saving"
            ? `${t("在保存", "Saving")}${DOTS}`
            : s.purpose === "material"
              ? t("在听", "Listening")
              : s.purpose === "instruction"
                ? t("说一句，改一下", "Say a change")
                : t("想问你一句", "A question for you");
        const line =
          s.name === "listening" && s.confirm
            ? t("不要这段录音了？在眼镜上选。还在录。", "Throw this recording away? Choose on the glasses. Still recording.")
            : s.purpose === "material"
              ? t("停顿、重复都没关系。讲完在镜腿上点一下。", "Pauses are fine. Tap the temple when done.")
              : s.purpose === "instruction"
                ? app.held
                  ? t("说一句要怎么改。说完松手。", "Say what to change. Let go when done.")
                  : t("说一句要怎么改。说完点一下。", "Say what to change. Tap when done.")
                : e(s.question);
        return { label, talk: s.name === "saving" ? "saving" : "live", lines: [line] };
      }
      case "notes": {
        const takes = s.article.recordings;
        const n = takes.filter((r) => r.status !== "failed").length;
        const last = takes[takes.length - 1];
        const line =
          last?.status === "failed"
            ? t(`刚才那段没能转成文字：${e(last.error)}`, `That last recording couldn’t be turned into words: ${e(last.error)}`)
            : last?.status === "processing"
              ? `${t("正在把刚才讲的整理出来", "Tidying up what you just said")}${DOTS}`
              : t("在眼镜上选「写成文章」，或者接着讲。", "On the glasses, choose “Write it up”, or keep talking.");
        return { label: t("素材", "What you said"), head: t(`讲了 ${n} 段`, `${n} ${n === 1 ? "recording" : "recordings"}`), lines: [line] };
      }
      case "composing":
        return {
          label: `${s.article.phase === "write" ? t("在成文", "Writing it up") : t("在查证", "Checking the facts")}${DOTS}`,
          head: t("正在写", "Writing"),
          lines: [t("要一两分钟。可以先离开，写好了会出现在打开页。", "Takes a minute or two. You can leave: it will be waiting on the opening page.")],
        };
      case "failed":
        return { label: t("没写成", "Couldn’t write it"), head: e(s.article.error || t("出了点问题。", "Something went wrong.")), small: true, lines: [t("在眼镜上选「再试一次」。", "On the glasses, choose “Try again”.")] };
      case "brief":
        return {
          label: e(s.note || t("写好了", "Ready")),
          lines: open ? [t(`有 ${open} 处等你定：在眼镜上逐条看。`, `${open} ${open === 1 ? "note is" : "notes are"} waiting for you: go through them on the glasses.`)] : [],
        };
      case "review": {
        const n = s.article.annotations.find((x) => x.id === s.id);
        // The same count the glasses show: notes already decided, plus this one.
        const all = s.article.annotations.length;
        const what =
          n?.kind === "added"
            ? t(`AI 补了一句：${e(n.note)}`, `The AI added a sentence: ${e(n.note)}`)
            : n?.kind === "diff"
              ? t(`资料的说法：${e(n.note)}`, `What the source says: ${e(n.note)}`)
              : e(n?.note ?? "");
        return { label: `${t("逐条定夺", "Going through the notes")} · ${all - open + 1}/${all}`, lines: [what] };
      }
      case "reader":
        return { label: `${t("在眼镜上读", "Reading on the glasses")} · ${s.page + 1}/${s.pages.length}` };
      case "revising":
        return { label: `${t("在改", "Changing it")}${DOTS}`, lines: s.article.heard ? [`${t("听到的是：", "Heard: ")}“${e(s.article.heard)}”`] : [] };
      case "changed":
        return {
          label: s.article.revisionError ? t("没改成", "Not changed") : t("改好了", "Changed"),
          lines: [e(s.article.revisionError || s.article.lastChange), ...(s.article.heard ? [`${t("听到的是：", "Heard: ")}“${e(s.article.heard)}”`] : [])],
        };
      case "problem":
        if (s.kind === "code") {
          return {
            head: t("填入访问码", "Enter the access code"),
            small: true,
            lines: [t("访问码由搭建这个成章服务的人提供，只需要填一次。", "Whoever runs this Chengzhang server gave it to you. You only need it once.")],
            extra:
              `<form class="form${codeError ? " wrong" : ""}" data-key="code-form" data-form="code"><input name="code" autocomplete="off" autocapitalize="off" placeholder="${t("访问码", "Access code")}" aria-label="${t("访问码", "Access code")}"><button class="btn solid">${t("继续", "Continue")}</button></form>` +
              (codeError ? `<p class="line alert" data-key="code-error" role="alert">${e(codeError)}</p>` : ""),
          };
        }
        return {
          head: e(s.message),
          small: true,
          extra: `<div class="actions" data-key="retry"><button class="btn" data-act="retry">${t("重试", "Try again")}</button></div>`,
        };
      case "notice":
        return { head: e(s.message), small: true };
    }
  }

  // ---------- the page: what is being made ----------

  function noteRow(a: ArticleView, n: Annotation, t: T, focus: string): string {
    const kind = n.kind === "added" ? t("AI 补充", "AI added") : n.kind === "diff" ? t("有出入", "Check") : t("提问", "Question");
    const said = markInner(a.markdown, n.id);
    const main = n.kind === "added" ? said || n.note : n.kind === "diff" ? `${said ? `“${said}” → ` : ""}${n.note}` : n.note;
    const state =
      n.state === "open"
        ? ""
        : {
            kept: t("留着了", "Kept"),
            removed: t("删掉了", "Removed"),
            applied: t("按资料改了", "Corrected"),
            dismissed: n.kind === "diff" ? t("照你说的", "Left as you said") : t("跳过了", "Skipped"),
            answered: t("回答了", "Answered"),
          }[n.state];
    const src = /^https?:\/\//i.test(n.sourceUrl) ? `<a href="${e(n.sourceUrl)}" target="_blank" rel="noopener noreferrer">${e(n.sourceTitle || hostOf(n.sourceUrl))}</a>` : "";
    return (
      `<li class="${n.id === focus ? "focus" : ""}${state ? " settled" : ""}" data-key="n-${e(n.id)}">` +
      `<span class="kind ${n.kind}">${e(kind)}</span>` +
      `<span class="what" data-key="n-${e(n.id)}-w" data-swap>${e(main)}${state ? ` <span class="state">· ${e(state)}</span>` : ""}</span>` +
      (src ? `<span class="src">${src}</span>` : "") +
      `</li>`
    );
  }

  const label = (key: string, html: string) => `<span class="btn-label" data-key="${key}" data-swap>${html}</span>`;

  function removeButton(id: string, t: T): string {
    const armed = deleteArmed === id;
    return `<button class="btn quiet${armed ? " armed" : ""}" data-key="delete" data-size="w" data-act="delete" data-id="${e(id)}">${label(
      "delete-l",
      armed ? t("再点一次，彻底删除", "Tap again to delete for good") : t("删除", "Delete"),
    )}</button>`;
  }

  function card(s: Screen, t: T): string {
    const article = "article" in s ? s.article : null;
    if (!article) return "";
    if (article.status === "ready" && article.markdown) {
      const order = markIds(article.markdown);
      const focus = s.name === "review" ? s.id : "";
      const notes = [...article.annotations].sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));
      const notion = !app.api.features.notion
        ? ""
        : article.publishedUrl
          ? `<a class="btn" data-key="notion" href="${e(article.publishedUrl)}" target="_blank" rel="noopener noreferrer">${label("notion-l", t("在 Notion 里打开", "Open in Notion"))}</a>`
          : `<button class="btn" data-key="notion" data-size="w" data-act="notion" data-id="${e(article.id)}" ${notionBusy ? "disabled" : ""}>${label(
              "notion-l",
              notionBusy ? `${t("在发", "Sending")}${DOTS}` : t("发到 Notion", "Send to Notion"),
            )}</button>`;
      return (
        `<article class="card" data-key="card" data-size>` +
        `<h1 data-key="title" data-swap>${e(article.title)}</h1>` +
        `<p class="gist" data-key="gist" data-swap>${e(article.gist)}</p>` +
        `<div class="prose" data-key="prose" data-stagger>${mdToHtml(article.markdown, article.annotations, focus)}</div>` +
        (notes.length ? `<ul class="notes" data-key="notes">${notes.map((n) => noteRow(article, n, t, focus)).join("")}</ul>` : "") +
        `<div class="actions" data-key="actions">` +
        `<button class="btn solid" data-key="copy" data-size="w" data-act="copy" data-id="${e(article.id)}">${label(
          "copy-l",
          copied === article.id ? `${CHECK}${t("复制了", "Copied")}` : t("复制 Markdown", "Copy Markdown"),
        )}</button>` +
        notion +
        removeButton(article.id, t) +
        `</div></article>`
      );
    }
    // Not written yet: what was said. While a recording is still being tidied, faint lines hold its place.
    const takes = article.recordings.filter((r) => r.status !== "failed");
    if (!takes.length) return "";
    const blocks = takes
      .map((r) =>
        r.text
          ? r.text
              .split(/\n{2,}/)
              .map((p) => `<p data-key="m-${hash(p)}">${e(p)}</p>`)
              .join("")
          : `<div class="skeleton" data-key="sk-${e(r.id)}" aria-hidden="true"><i></i><i></i><i></i></div>`,
      )
      .join(`<hr>`);
    return (
      `<article class="card material${s.name === "composing" ? " working" : ""}" data-key="card" data-size>` +
      // Its own key: what was said is not the article, so one leaves and the other arrives.
      `<div class="prose" data-key="said" data-stagger>${blocks}</div>` +
      `<div class="actions" data-key="actions">${removeButton(article.id, t)}</div></article>`
    );
  }

  function render(): string {
    const s = app.screen;
    const lang = app.lang;
    const t = makeT(lang);
    const article = "article" in s ? s.article : null;
    const open = article ? article.annotations.filter((n) => n.state === "open").length : 0;
    const st = status(s, t, open);

    const top =
      `<header class="top" data-key="top">` +
      `<div class="brand">${LOGO}<span data-key="brand" data-swap>${t("成章", "Chengzhang")}</span></div>` +
      `<div class="lang" role="group" aria-label="Language" data-lang="${lang}">` +
      `<button data-act="lang" data-lang="en" aria-pressed="${lang === "en"}">EN</button>` +
      `<button data-act="lang" data-lang="zh" aria-pressed="${lang === "zh"}">中文</button>` +
      `</div></header>`;

    // Says exactly which half is pretend, so nobody takes a simulated article for the model's work.
    const simulated = app.api.features.simulated || (app.api.features.demo ? "both" : "");
    const banner = simulated
      ? `<div class="banner" data-key="banner" data-swap data-in="fade">${
          simulated === "writing"
            ? t("演示模式：你讲的话是真的转成了文字；写作是模拟的。", "Demo mode: your speech is really transcribed. The writing is simulated.")
            : simulated === "speech"
              ? t("演示模式：转写是模拟的；写作是真的。", "Demo mode: transcription is simulated. The writing is real.")
              : t("演示模式：后端没有配置模型密钥，转写和写作都是模拟的。", "Demo mode: the backend has no model key, so transcription and writing are simulated.")
        }</div>`
      : "";

    const statusHtml =
      `<section class="status" data-key="status" data-size>` +
      (st.label ? `<div class="label" data-key="label" data-swap>${st.label}</div>` : "") +
      (st.head ? `<h1 class="display${st.small ? " small" : ""}" data-key="head" data-swap>${st.head}</h1>` : "") +
      (st.talk
        ? `<div class="talk${st.talk === "saving" ? " saving" : ""}" data-key="talk" data-static><div class="clock" role="timer"><span class="dot" aria-hidden="true"></span><span class="time">00:00</span></div><div class="bars" aria-hidden="true"><div class="bars-inner"></div></div></div>`
        : "") +
      (st.lines ?? []).map((line, i) => `<p class="line" data-key="line${i}" data-swap>${line}</p>`).join("") +
      (st.extra ?? "") +
      `</section>`;

    const wantsLibrary = s.name === "home" || s.name === "library";
    const state = (r: LibraryRow) => ({ draft: t("还在攒", "Collecting"), composing: t("正在写", "Writing"), failed: t("没写成", "Couldn’t write"), ready: "" })[r.status];
    const libraryHtml =
      wantsLibrary && library.length
        ? `<section class="library" data-key="library"><p class="section-label" data-key="library-l" data-swap>${t("写过的", "Your articles")}</p><div class="rows" data-key="rows" data-stagger>${library
            .map(
              (r) =>
                `<button class="row" data-key="row-${e(r.id)}" data-act="open" data-id="${e(r.id)}"><span class="title">${e(r.title || r.preview || t("新的一篇", "New article"))}</span><span class="sub" data-key="row-${e(r.id)}-s" data-swap>${e(state(r) ?? "")}</span></button>`,
            )
            .join("")}</div></section>`
        : "";

    const hint = `<footer class="hint" data-key="hint" data-swap>${t(
      "在眼镜上：<b>点一下</b>选中或继续，<b>上下滑</b>移动，<b>双击</b>返回。讲的时候屏幕上不出字。",
      "On the glasses: <b>tap</b> to choose or continue, <b>swipe</b> to move, <b>double-tap</b> to go back. No words appear while you talk.",
    )}</footer>`;

    return top + banner + statusHtml + card(s, t) + libraryHtml + hint;
  }

  // ---------- the clock and the ink: updated directly, many times a second ----------

  /** How many strokes each ink box already shows. */
  const drawn = new WeakMap<Element, number>();

  function syncTalk(): void {
    const talk = page.querySelector<HTMLElement>(".talk:not([data-exiting])");
    if (!talk) return;
    const time = talk.querySelector<HTMLElement>(".time")!;
    const text = clock(app.talkingMs);
    if (time.textContent !== text) time.textContent = text;

    const bars = talk.querySelector<HTMLElement>(".bars")!;
    const inner = talk.querySelector<HTMLElement>(".bars-inner")!;
    const strokes = app.strokes;
    let have = drawn.get(inner) ?? 0;
    if (strokes.length < have) {
      inner.replaceChildren();
      have = 0;
    }
    if (strokes.length === have) return;
    // Strokes that were already there when the box appeared are simply there; new ones are drawn.
    const fresh = have > 0 || strokes.length <= 2;
    for (let i = have; i < strokes.length; i++) {
      const n = strokes[i]!;
      const bar = document.createElement("span");
      bar.className = n ? `bar${fresh ? " new" : ""}` : "bar break";
      if (n) bar.style.width = `${n * 14}px`;
      inner.append(bar);
    }
    drawn.set(inner, strokes.length);
    // Once the ink fills its box, the oldest lines slide up and fade out of the top.
    const over = inner.scrollHeight - bars.clientHeight;
    inner.style.transform = over > 0 ? `translateY(${-over}px)` : "";
    bars.classList.toggle("full", over > 0);
  }

  // ---------- after a change has been shown ----------

  let lastArticle = "";
  let lastFocus = "";
  let lastPage = "";

  function settle(entered: Element[]): void {
    const s = app.screen;
    const article = "article" in s && s.article.status === "ready" ? s.article : null;

    // Words of a finished article that changed (a correction, an answer, a spoken change): a brief wash of ink
    // behind them says "this is what changed".
    if (article && lastArticle === article.id) {
      for (const el of entered) {
        if (!(el instanceof HTMLElement) || !el.parentElement?.classList.contains("prose")) continue;
        el.classList.add("flash");
        el.addEventListener("animationend", () => el.classList.remove("flash"), { once: true });
      }
    }
    lastArticle = article?.id ?? "";

    // The note being decided on the glasses: bring its sentence into view here. Coming from another note,
    // wait until what was just decided has been shown (the highlight draining, the corrected words
    // arriving) before moving on: one thing at a time, where the eye already is.
    const focus = s.name === "review" ? s.id : "";
    if (focus && focus !== lastFocus) reveal(() => page.querySelector<HTMLElement>("mark.focus"), "center", lastFocus ? SETTLE_MS : 0);
    lastFocus = focus;

    // The page being read on the glasses: follow along.
    const reading = s.name === "reader" && s.source === "article" ? `${s.article.id}:${s.page}` : "";
    if (reading && reading !== lastPage && s.name === "reader") {
      const start = (s.pages[s.page] ?? "").replace(/^[■•│〔\s\d.]+/, "").slice(0, 18);
      const first = s.page === 0;
      reveal(
        () =>
          (start ? Array.from(page.querySelectorAll<HTMLElement>(".prose > [data-key]")).find((el) => el.textContent?.includes(start)) : undefined) ??
          (first ? page.querySelector<HTMLElement>(".card") : null),
        "start",
      );
    }
    lastPage = reading;
  }

  /** How long a decision takes to show: the highlighter's stroke, and a breath. */
  const SETTLE_MS = 600;
  let revealTimer = 0;

  /**
   * Scroll something into view, unless it is comfortably in view already. The element is looked up
   * when the time comes, because by then the page may hold a new one in its place; asking again
   * replaces a scroll that has not started yet.
   */
  function reveal(find: () => HTMLElement | null | undefined, block: "center" | "start", after = 0): void {
    window.clearTimeout(revealTimer);
    const go = () => {
      const el = find();
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.top > innerHeight * 0.12 && r.bottom < innerHeight * 0.8) return;
      el.scrollIntoView({ block, behavior: motionOK() ? "smooth" : "auto" });
    };
    // Never in the same frame as the change itself, so the two do not fight over it.
    if (after > 0) revealTimer = window.setTimeout(go, after);
    else requestAnimationFrame(go);
  }

  // ---------- drawing ----------

  let shown = "";
  function draw(): void {
    const s = app.screen;
    document.documentElement.lang = app.lang === "zh" ? "zh-CN" : "en";

    // Everything written so far, fetched when the opening page (or what it lists) changes.
    if (s.name === "home" || s.name === "library") {
      const key = s.name === "home" ? JSON.stringify(s.view?.rows ?? null) + (s.view?.finished ?? "") : "library";
      if (key !== libraryFor) {
        libraryFor = key;
        app.api
          .library()
          .then((rows) => {
            library = rows;
            draw();
          })
          .catch(() => {});
      }
    }

    const html = render();
    if (html !== shown) {
      shown = html;
      const { entered } = transition(page, () => morph(page, html));
      settle(entered);
    }
    syncTalk();
  }

  // ---------- touch ----------

  root.addEventListener("click", (event) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!el || el.closest("[data-exiting]")) return;
    const t = makeT(app.lang);
    const id = el.dataset.id ?? "";
    switch (el.dataset.act) {
      case "lang": {
        const lang = el.dataset.lang as Lang;
        if (lang === app.lang) return;
        void storage.set("chengzhang.lang", lang);
        app.setLang(lang);
        break;
      }
      case "retry":
        app.retry();
        break;
      case "open":
        app.openFromPhone(id);
        break;
      case "copy":
        void app.api
          .markdown(id)
          .then(copy)
          .then((ok) => {
            if (!ok) return toast(t("没能复制", "Couldn’t copy"));
            // The button itself says so, for a moment, right where the finger is.
            copied = id;
            draw();
            window.setTimeout(() => {
              if (copied !== id) return;
              copied = "";
              draw();
            }, 1800);
          })
          .catch(() => toast(t("没能复制", "Couldn’t copy")));
        break;
      case "delete":
        if (deleteArmed !== id) {
          deleteArmed = id;
          draw();
          window.setTimeout(() => {
            if (deleteArmed !== id) return;
            deleteArmed = "";
            draw();
          }, 4000);
        } else {
          deleteArmed = "";
          void app
            .deleteFromPhone(id)
            .then(() => toast(t("删掉了", "Deleted")))
            .catch(() => toast(t("没能删除", "Couldn’t delete it")));
        }
        break;
      case "notion":
        notionBusy = true;
        draw();
        void app.api
          .publish(id)
          .then(({ url }) => {
            app.published(id, url);
            toast(t("发到 Notion 了", "Sent to Notion"));
          })
          .catch((err) => toast(err instanceof ApiError ? err.message : t("没能发到 Notion", "Couldn’t send it to Notion")))
          .finally(() => {
            notionBusy = false;
            draw();
          });
        break;
    }
  });

  root.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement;
    if (form.dataset.form !== "code") return;
    event.preventDefault();
    const code = String(new FormData(form).get("code") ?? "").trim();
    if (!code) return;
    codeError = "";
    draw();
    void app.enterCode(code).catch((err) => {
      codeError = err instanceof ApiError ? err.message : makeT(app.lang)("没连上，再试一次。", "Couldn’t connect. Try again.");
      draw();
    });
  });

  app.subscribe(draw);
  draw();
}
