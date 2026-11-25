/**
 * Checks how the phone page moves, by measuring it in a real browser.
 *
 *   npm run motion
 *
 * It opens the storyboard (dev/storyboard.html: every state of the page, no
 * glasses or backend needed) in headless Chromium and:
 *
 *   1. walks every state at four sizes, in light and dark, in both languages,
 *      and fails if anything overflows sideways, logs an error, or leaves a
 *      fading copy behind;
 *   2. measures frame times through every transition with the CPU slowed 4×
 *      (roughly a mid-range phone), once with the normal article and once with
 *      an article of 200 paragraphs;
 *   3. interrupts transitions with new ones every few frames and checks the
 *      page still ends up exactly as if it had gone there directly;
 *   4. turns on "reduce motion" and checks nothing travels.
 *
 * Needs Playwright with Chromium: `npm i --no-save playwright && npx playwright install chromium`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<R, A = unknown>(fn: string | ((arg: A) => R | Promise<R>), arg?: A): Promise<R>;
  waitForTimeout(ms: number): Promise<void>;
  on(event: string, handler: (arg: { type(): string; text(): string } & Error) => void): void;
  context(): { newCDPSession(page: Page): Promise<{ send(method: string, params?: unknown): Promise<unknown> }> };
  close(): Promise<void>;
}
interface Browser {
  newContext(options: Record<string, unknown>): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>;
  close(): Promise<void>;
}

const require = createRequire(import.meta.url);
let chromium: { launch(): Promise<Browser> };
try {
  ({ chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } });
} catch {
  console.error("This check needs Playwright with Chromium. Install it with: npm i --no-save playwright && npx playwright install chromium");
  process.exit(2);
}

const PORT = 15174;
const BASE = `http://localhost:${PORT}/dev/storyboard.html`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const failures: string[] = [];
const fail = (message: string) => {
  failures.push(message);
  console.log(`  FAIL ${message}`);
};

let server: ChildProcess | null = null;
async function startServer(): Promise<void> {
  server = spawn(process.execPath, [join("node_modules", "vite", "bin", "vite.js"), "--port", String(PORT), "--strictPort"], { stdio: "ignore", detached: true });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error("the dev server did not start");
}
function stopServer(): void {
  try {
    if (server?.pid) process.kill(-server.pid, "SIGTERM");
  } catch {
    // already gone
  }
}

async function open(browser: Browser, o: { width: number; height: number; scheme?: string; reduce?: boolean; query?: string }): Promise<{ page: Page; close: () => Promise<void>; errors: string[] }> {
  const context = await browser.newContext({
    viewport: { width: o.width, height: o.height },
    colorScheme: o.scheme ?? "light",
    reducedMotion: o.reduce ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}?state=boot${o.query ? `&${o.query}` : ""}`);
  await page.waitForTimeout(300);
  return { page, close: () => context.close(), errors };
}

const states = (page: Page) => page.evaluate<string[]>("window.storyboard.states");
const go = (page: Page, name: string) => page.evaluate((n) => (window as unknown as { storyboard: { go(n: string): void } }).storyboard.go(n), name);

// ---------- 1. every state, every size ----------

async function everyState(browser: Browser): Promise<void> {
  console.log("\n1. Every state at every size, light and dark, both languages");
  const sizes = [
    { width: 320, height: 640 },
    { width: 390, height: 844 },
    { width: 600, height: 800 },
    { width: 1280, height: 800 },
  ];
  let visited = 0;
  for (const size of sizes) {
    for (const scheme of ["light", "dark"]) {
      for (const lang of ["en", "zh"]) {
        const { page, close, errors } = await open(browser, { ...size, scheme, query: `lang=${lang}&notion=1` });
        for (const name of await states(page)) {
          await go(page, name);
          await page.waitForTimeout(620);
          visited++;
          const report = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - innerWidth,
            ghosts: document.querySelectorAll("[data-exiting]").length,
            // Nothing may be wider than the page it sits in.
            wide: Array.from(document.querySelectorAll<HTMLElement>(".page *")).filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5 && !el.closest(".bars")).length,
          }));
          const where = `${name} @ ${size.width}px ${scheme} ${lang}`;
          if (report.overflow > 0) fail(`${where}: the page scrolls sideways by ${report.overflow}px`);
          if (report.wide > 0) fail(`${where}: ${report.wide} element(s) stick out of the right edge`);
          if (report.ghosts > 0) fail(`${where}: ${report.ghosts} fading copy(ies) left behind`);
        }
        for (const err of errors) fail(`${size.width}px ${scheme} ${lang}: console error: ${err}`);
        await close();
      }
    }
  }
  console.log(`  ${visited} state visits checked`);
}

// ---------- 2. frame times ----------

interface Frames {
  n: number;
  mean: number;
  p95: number;
  max: number;
  /** Frames that took more than one and a half refresh intervals. */
  late: number;
}

/**
 * Runs in the page (kept as text so the build tool does not rewrite it): go to a state, then time every frame
 * for `ms` milliseconds.
 */
const MEASURE = `(name, ms) => new Promise((resolve) => {
  const gaps = [];
  let last = 0;
  const start = performance.now();
  window.storyboard.go(name);
  function tick(now) {
    if (last) gaps.push(now - last);
    last = now;
    if (now - start < ms) return requestAnimationFrame(tick);
    const sorted = gaps.slice().sort((a, b) => a - b);
    resolve({
      n: gaps.length,
      mean: gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length),
      p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
      max: sorted[sorted.length - 1] || 0,
      late: gaps.filter((g) => g > 25).length,
    });
  }
  requestAnimationFrame(tick);
})`;

const measure = (page: Page, name: string, ms: number) => page.evaluate<Frames>(`(${MEASURE})(${JSON.stringify(name)}, ${ms})`);

async function frameTimes(browser: Browser): Promise<void> {
  console.log("\n2. Frame times through every transition (CPU slowed 4×; a frame is 16.7 ms)");
  for (const long of [0, 200]) {
    const { page, close } = await open(browser, { width: 390, height: 844, query: long ? `long=${long}` : "" });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const all: Frames[] = [];
    let worst = { name: "", f: { n: 0, mean: 0, p95: 0, max: 0, late: 0 } as Frames };
    for (const name of await states(page)) {
      const f = await measure(page, name, 700);
      all.push(f);
      if (f.max > worst.f.max) worst = { name, f };
    }
    const total = all.reduce((a, f) => a + f.n, 0);
    const late = all.reduce((a, f) => a + f.late, 0);
    const mean = all.reduce((a, f) => a + f.mean * f.n, 0) / total;
    const p95 = Math.max(...all.map((f) => f.p95));
    console.log(
      `  ${long ? `article of ${long} paragraphs` : "normal article".padEnd(25)}: ${total} frames, mean ${mean.toFixed(1)} ms, worst p95 ${p95.toFixed(1)} ms, ` +
        `late frames ${late} (${((late / total) * 100).toFixed(1)}%), longest ${worst.f.max.toFixed(0)} ms entering "${worst.name}"`,
    );
    if (late / total > 0.03) fail(`${long ? "long" : "normal"} article: ${((late / total) * 100).toFixed(1)}% of frames were late (limit 3%)`);
    await close();
  }
}

// ---------- 3. interrupting ----------

async function interrupt(browser: Browser): Promise<void> {
  console.log("\n3. Interrupting transitions every few frames");
  const { page, close, errors } = await open(browser, { width: 390, height: 844 });
  const names = await states(page);
  // Three passes in different orders, each change arriving 50 ms after the last (mid-transition).
  for (const step of [1, 7, 11]) {
    for (let i = 0; i < names.length; i++) {
      await go(page, names[(i * step) % names.length]!);
      await page.waitForTimeout(50);
    }
  }
  const final = "changed"; // a state with the whole article and its notes, so there is plenty to compare
  await go(page, final);
  await page.waitForTimeout(900);
  /** The page with everything transient removed (inline styles the motion layer sets, the clock, the ink). */
  const settled = () => {
    const clone = document.querySelector(".page")!.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("[style]").forEach((el) => el.removeAttribute("style"));
    clone.querySelectorAll("[data-fresh]").forEach((el) => el.removeAttribute("data-fresh"));
    clone.querySelectorAll(".flash").forEach((el) => el.classList.remove("flash"));
    clone.querySelectorAll("[class='']").forEach((el) => el.removeAttribute("class"));
    clone.querySelectorAll(".bars-inner, .time").forEach((el) => el.replaceChildren());
    return {
      html: clone.innerHTML,
      ghosts: document.querySelectorAll("[data-exiting]").length,
      // Web Animations started by the motion layer (CSS loops such as the breathing dots do not count).
      running: document.getAnimations().filter((a) => !("animationName" in a) && !("transitionProperty" in a)).length,
    };
  };
  const after = await page.evaluate(settled);
  const fresh = await open(browser, { width: 390, height: 844 });
  await go(fresh.page, final);
  await fresh.page.waitForTimeout(900);
  const expected = (await fresh.page.evaluate(settled)).html;
  if (after.html !== expected) fail(`after ${names.length * 3} interrupted changes the page differs from going to "${final}" directly`);
  if (after.ghosts) fail(`${after.ghosts} fading copy(ies) left behind after interruptions`);
  if (after.running) fail(`${after.running} transition(s) still running 900 ms after the last change`);
  for (const err of [...errors, ...fresh.errors]) fail(`console error: ${err}`);
  console.log(`  ${names.length * 3} changes 50 ms apart, then "${final}": ${after.html === expected ? "identical to going there directly" : "DIFFERENT"}`);
  await close();
  await fresh.close();
}

// ---------- 4. reduce motion ----------

async function reducedMotion(browser: Browser): Promise<void> {
  console.log("\n4. With “reduce motion” on");
  const { page, close } = await open(browser, { width: 390, height: 844, reduce: true });
  let travelling = 0;
  let looping = 0;
  for (const name of await states(page)) {
    await go(page, name);
    await page.waitForTimeout(40);
    const seen = await page.evaluate(() => {
      let travelling = 0;
      let looping = 0;
      for (const a of document.getAnimations()) {
        const effect = a.effect as KeyframeEffect | null;
        const frames = effect?.getKeyframes() ?? [];
        const timing = effect?.getComputedTiming();
        const moves = frames.some((k) => ["transform", "translate", "scale", "width", "height"].some((p) => p in k && k[p] !== "none"));
        // Anything under a couple of milliseconds is "at once", which is what reduce motion asks for.
        if (moves && Number(timing?.duration ?? 0) > 5) travelling++;
        if (timing?.iterations === Infinity) looping++;
      }
      return { travelling, looping };
    });
    travelling += seen.travelling;
    looping += seen.looping;
    await page.waitForTimeout(200);
  }
  console.log(`  things that travel: ${travelling} · things that loop: ${looping}`);
  if (travelling) fail(`${travelling} animation(s) still move things with reduce motion on`);
  if (looping) fail(`${looping} animation(s) still loop with reduce motion on`);
  await close();
}

async function main(): Promise<void> {
  await startServer();
  const browser = await chromium.launch();
  try {
    await everyState(browser);
    await frameTimes(browser);
    await interrupt(browser);
    await reducedMotion(browser);
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(failures.length ? `\n${failures.length} problem(s) found.` : "\nAll motion checks passed.");
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  stopServer();
  process.exit(1);
});
