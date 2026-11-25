/**
 * The phone page without glasses, a backend or the Even app: every state the
 * page can be in, one after another, driven by a stand-in for the app.
 *
 *   npm run dev:app      then open  http://localhost:5173/dev/storyboard.html
 *
 *   ?state=review-added   show one state
 *   ?play=1               walk through all of them, like a real session
 *   ?long=200             use an article of 200 paragraphs (for measuring)
 *   ?lang=zh              Chinese interface
 *
 * It exists to look at, and measure, how the page moves between states (see
 * scripts/motion-check.ts). It is not part of the built app.
 */
import { isLang } from "../shared/i18n.ts";
import type { Annotation, ArticleView, Features, HomeView, Lang, LibraryRow, RecordingView } from "../shared/types.ts";
import type { Screen } from "../src/app.ts";
import { mountPhone, type PhoneHost } from "../src/phone/ui.ts";

const params = new URLSearchParams(location.search);
const long = Number(params.get("long") ?? 0);

// ---------- one article, in the states it passes through ----------

const SAID =
  "I want to write about why I stopped keeping a to-do list. For about three years I kept one giant list, and it just kept growing. At one point it had four hundred items on it.\n\nAnd the problem wasn't that I was lazy. The problem was that the list never told me what mattered today. I tried the Eisenhower matrix, which I think President Eisenhower invented in 1954, and that didn't help either.\n\nWhat finally worked was really simple. Every morning I write down three things, on paper, and that's it. If something isn't one of the three, it waits.";

const P = {
  open: "For about three years I kept one giant to-do list, and it only ever grew. At one point it had four hundred items on it.",
  direct: "I kept one giant to-do list for three years. It never once told me what mattered today.",
  lazy: "The problem wasn't that I was lazy. The list never told me what mattered today.",
  claim: "which President Eisenhower invented in 1954",
  corrected: "which is named after President Eisenhower, who described the idea in a 1954 speech",
  added: "The matrix as people use it today was popularised by Stephen Covey in The 7 Habits of Highly Effective People, published in 1989.",
  simple: "What finally worked was simple. Every morning I write down three things, on paper, and that's it. If something isn't one of the three, it waits.",
};
const filler = Array.from({ length: long }, (_, i) => `Paragraph ${i + 1}. ${P.simple} ${P.lazy}`).join("\n\n");

function markdown(o: { direct?: boolean; a1?: "open" | "applied"; a2?: "open" | "kept" | "removed"; a3?: "open" | "answered" }): string {
  const claim = o.a1 === "applied" ? P.corrected : `<mark data-id="a1">${P.claim}</mark>`;
  const added = o.a2 === "removed" ? "" : ` <mark data-id="a2">${P.added}</mark>`;
  const since = o.a3 === "answered" ? "for about six months" : `<mark data-id="a3">for a while now</mark>`;
  return [
    o.direct ? P.direct : P.open,
    P.lazy,
    `I tried the Eisenhower matrix, ${claim}, and that didn't help either.${added}`,
    P.simple,
    `I've been doing that ${since}. I get more done, and I feel less guilty.`,
    ...(filler ? [filler] : []),
  ].join("\n\n");
}

const SOURCE = { sourceTitle: "Time management: The Eisenhower Method (Wikipedia)", sourceUrl: "https://en.wikipedia.org/wiki/Time_management" };
function notes(o: { a1?: Annotation["state"]; a2?: Annotation["state"]; a3?: Annotation["state"] }): Annotation[] {
  return [
    { id: "a1", kind: "diff", note: "Eisenhower described the idea in a 1954 speech; the matrix itself was drawn up later by others.", suggestion: P.corrected, ...SOURCE, state: o.a1 ?? "open" },
    { id: "a2", kind: "added", note: "Says where the matrix comes from.", suggestion: "", ...SOURCE, state: o.a2 ?? "open" },
    { id: "a3", kind: "ask", note: "How long have you been using the three-things list?", suggestion: "", sourceTitle: "", sourceUrl: "", state: o.a3 ?? "open" },
  ];
}

const take = (status: RecordingView["status"], text = ""): RecordingView => ({ id: "r1", status, text, durationMs: 45_000, error: "" });

function article(o: Partial<ArticleView> = {}): ArticleView {
  return {
    id: "demo",
    status: "ready",
    phase: "",
    title: "Why I stopped keeping a to-do list",
    gist: "A giant to-do list never says what matters today. Three things on paper each morning does.",
    markdown: markdown({}),
    annotations: notes({}),
    recordings: [take("ready", SAID)],
    words: 122,
    error: "",
    revising: false,
    revisionError: "",
    lastChange: "",
    heard: "",
    canUndo: false,
    publishedUrl: "",
    seen: true,
    updatedAt: 0,
    ...o,
  };
}

const draft = (recordings: RecordingView[], o: Partial<ArticleView> = {}) => article({ status: "draft", title: "", gist: "", markdown: "", annotations: [], recordings, ...o });
const simulated = (["speech", "writing"].includes(params.get("demo") ?? "") ? params.get("demo") : params.get("demo") === "0" ? "" : "both") as Features["simulated"];
const features: Features = { notion: params.get("notion") === "1", demo: simulated !== "", simulated };
const home = (rows: HomeView["rows"] = [], finished = 0): HomeView => ({ rows, finished, features });

const afterCheck = article({ markdown: markdown({ a1: "applied" }), annotations: notes({ a1: "applied" }) });
const afterKeep = article({ markdown: markdown({ a1: "applied", a2: "kept" }), annotations: notes({ a1: "applied", a2: "kept" }) });
const answered = article({
  markdown: markdown({ a1: "applied", a2: "kept", a3: "answered" }),
  annotations: notes({ a1: "applied", a2: "kept", a3: "answered" }),
  lastChange: "Added your answer: about six months.",
  heard: "Um, about six months.",
  canUndo: true,
});
const changed = article({ ...answered, markdown: markdown({ direct: true, a1: "applied", a2: "kept", a3: "answered" }), lastChange: "Made the opening more direct.", heard: "Make the opening more direct." });

const LIBRARY: LibraryRow[] = [
  { id: "demo", status: "ready", title: "Why I stopped keeping a to-do list", preview: "", updatedAt: 3 },
  { id: "b", status: "composing", title: "", preview: "What I learned shipping on a Friday", updatedAt: 2 },
  { id: "c", status: "draft", title: "", preview: "Notes for the offsite", updatedAt: 1 },
];

/** Every state of the page, in the order a session meets them. `ms` is how long ?play=1 stays on it. */
const STATES: Array<{ name: string; screen: Screen; ms: number; ink?: "grow" | "keep"; held?: boolean; library?: LibraryRow[] }> = [
  { name: "boot", screen: { name: "boot" }, ms: 900 },
  { name: "home", screen: { name: "home", view: home() }, ms: 1800 },
  { name: "talking", screen: { name: "listening", purpose: "material", question: "", confirm: false }, ms: 9000, ink: "grow" },
  { name: "throw-away", screen: { name: "listening", purpose: "material", question: "", confirm: true }, ms: 1800, ink: "grow" },
  { name: "talking-on", screen: { name: "listening", purpose: "material", question: "", confirm: false }, ms: 2500, ink: "grow" },
  { name: "saving", screen: { name: "saving", purpose: "material", question: "" }, ms: 900, ink: "keep" },
  { name: "tidying", screen: { name: "notes", article: draft([take("processing")]) }, ms: 1600 },
  { name: "said", screen: { name: "notes", article: draft([take("ready", SAID)]) }, ms: 2400 },
  { name: "checking", screen: { name: "composing", article: draft([take("ready", SAID)], { status: "composing", phase: "research" }) }, ms: 1800 },
  { name: "writing", screen: { name: "composing", article: draft([take("ready", SAID)], { status: "composing", phase: "write" }) }, ms: 1800 },
  { name: "ready", screen: { name: "brief", article: article(), note: "" }, ms: 3200 },
  { name: "review-check", screen: { name: "review", article: article(), id: "a1" }, ms: 2600 },
  { name: "review-added", screen: { name: "review", article: afterCheck, id: "a2" }, ms: 2600 },
  { name: "review-question", screen: { name: "review", article: afterKeep, id: "a3" }, ms: 2400 },
  { name: "answering", screen: { name: "listening", purpose: "answer", question: "How long have you been using the three-things list?", confirm: false }, ms: 2600, ink: "grow" },
  { name: "answer-saving", screen: { name: "saving", purpose: "answer", question: "How long have you been using the three-things list?" }, ms: 700, ink: "keep" },
  { name: "revising", screen: { name: "revising", article: article({ ...afterKeep, revising: true, heard: "Um, about six months." }), then: "review" }, ms: 1500 },
  { name: "answer-added", screen: { name: "changed", article: answered, then: "review" }, ms: 2600 },
  { name: "notes-done", screen: { name: "brief", article: answered, note: "All notes done." }, ms: 2200 },
  { name: "reading", screen: { name: "reader", article: answered, source: "article", pages: ["For about three years I kept one giant to-do list", "What finally worked was simple. Every morning"], page: 0 }, ms: 1600 },
  { name: "reading-2", screen: { name: "reader", article: answered, source: "article", pages: ["For about three years I kept one giant to-do list", "What finally worked was simple. Every morning"], page: 1 }, ms: 1600 },
  { name: "saying-a-change", screen: { name: "listening", purpose: "instruction", question: "", confirm: false }, ms: 2400, ink: "grow", held: true },
  { name: "change-saving", screen: { name: "saving", purpose: "instruction", question: "" }, ms: 700, ink: "keep", held: true },
  { name: "changing", screen: { name: "revising", article: article({ ...answered, revising: true, heard: "Make the opening more direct." }), then: "brief" }, ms: 1500 },
  { name: "changed", screen: { name: "changed", article: changed, then: "brief" }, ms: 2800 },
  { name: "undone", screen: { name: "brief", article: answered, note: "Undone." }, ms: 2000 },
  { name: "home-with-articles", screen: { name: "home", view: home([], 1) }, ms: 2600, library: LIBRARY },
  { name: "offline", screen: { name: "problem", kind: "offline", message: "Can’t reach the Chengzhang server.\nCheck the phone’s connection, then tap to try again." }, ms: 2000 },
  { name: "code", screen: { name: "problem", kind: "code", message: "" }, ms: 2400 },
  { name: "notice", screen: { name: "notice", message: "I didn’t hear anything." }, ms: 1600 },
  { name: "failed", screen: { name: "failed", article: draft([take("ready", SAID)], { status: "failed", error: "The model service returned an error (529)." }) }, ms: 2000 },
];

// ---------- a stand-in for the app ----------

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const asked = params.get("lang");
let lang: Lang = isLang(asked) ? asked : "en";
let screen: Screen = { name: "boot" };
let strokes: number[] = [];
let talkingMs = 0;
let held = false;
let library: LibraryRow[] = [];
let inkTimer = 0;

/** Speech-shaped ink: strokes of one to three, a new line now and then. */
function grow(): void {
  window.clearInterval(inkTimer);
  let n = 0;
  inkTimer = window.setInterval(() => {
    talkingMs += 350;
    if (++n % 2 === 0) strokes.push(n % 26 === 0 ? 0 : 1 + ((n * 7) % 3));
    notify();
  }, 350);
}

const host: PhoneHost = {
  get screen() {
    return screen;
  },
  get lang() {
    return lang;
  },
  get strokes() {
    return strokes;
  },
  get talkingMs() {
    return talkingMs;
  },
  get held() {
    return held;
  },
  api: {
    features,
    library: async () => library,
    markdown: async () => "# Why I stopped keeping a to-do list\n",
    publish: () => new Promise((resolve) => window.setTimeout(() => resolve({ url: "https://www.notion.so/demo" }), 1200)),
  },
  subscribe: (l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  setLang(next) {
    lang = next;
    notify();
  },
  retry: () => go("home"),
  enterCode: (code) => (code === "open" ? Promise.resolve(go("home")) : Promise.reject(new Error("no"))),
  openFromPhone: () => go("ready"),
  deleteFromPhone: async () => go("home"),
  published(_id, url) {
    if ("article" in screen) screen = { ...screen, article: { ...screen.article, publishedUrl: url } } as Screen;
    notify();
  },
};

function go(name: string): void {
  const state = STATES.find((s) => s.name === name);
  if (!state) throw new Error(`no such state: ${name}`);
  window.clearInterval(inkTimer);
  if (state.ink === "grow") {
    if (screen.name !== "listening" && screen.name !== "saving") {
      strokes = [];
      talkingMs = 0;
    }
    grow();
  } else if (state.ink !== "keep") {
    strokes = [];
    talkingMs = 0;
  }
  held = Boolean(state.held);
  library = state.library ?? [];
  screen = state.screen;
  notify();
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
async function play(speed = 1): Promise<void> {
  for (const state of STATES) {
    go(state.name);
    await sleep(state.ms / speed);
  }
}

mountPhone(host, { get: async () => "", set: async () => {} });
Object.assign(window, { storyboard: { go, play, states: STATES.map((s) => s.name), host } });

if (params.get("play")) void play(Number(params.get("speed") ?? 1));
else go(params.get("state") ?? "home");
