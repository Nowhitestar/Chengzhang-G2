/**
 * Walks the whole app in the Even Hub simulator, the way a person would with
 * the temple touchpad, and saves a picture of every screen to docs/screens/.
 *
 *   npm run e2e
 *
 * It starts its own backend (demo mode: the AI is simulated, no keys needed),
 * its own dev server and its own simulator, using a pretend microphone
 * (?mic=demo), so it runs on a machine with no microphone and no glasses.
 * On Linux without a display it runs the simulator under xvfb-run.
 *
 * Set LANG_UI=zh to walk the Chinese interface.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onBlack } from "./png.ts";

const lang = process.env.LANG_UI === "zh" ? "zh" : "en";
const API_PORT = 18787;
const APP_PORT = 15173;
const SIM_PORT = 19898;
const SIM = `http://127.0.0.1:${SIM_PORT}`;
const OUT = join("docs", "screens", lang);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const children: ChildProcess[] = [];
const dataDir = mkdtempSync(join(tmpdir(), "chengzhang-e2e-"));

function run(cmd: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"], detached: true });
  children.push(child);
  return child;
}

function stopAll(): void {
  for (const c of children) {
    try {
      if (c.pid) process.kill(-c.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
}

async function waitFor(url: string, what: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`${what} did not start (${url})`);
}

type Action = "click" | "double_click" | "up" | "down" | "long_press" | "long_press_release";

async function input(action: Action): Promise<void> {
  await fetch(`${SIM}/api/input`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
  await sleep(450);
}

interface Entry {
  id: number;
  level: string;
  message: string;
}
let seen = -1;

/** Wait until the app says it has moved to this screen (it logs every move). */
async function screen(name: string, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { entries } = (await (await fetch(`${SIM}/api/console`)).json()) as { entries: Entry[] };
    for (const e of entries) {
      if (e.id <= seen) continue;
      seen = e.id;
      // A failed request is not a failure by itself (a token from an earlier run is refused once, then renewed).
      const request = e.message.startsWith("[fetch]");
      if (!request && (e.level === "error" || e.message.startsWith("[uncaught]") || e.message.startsWith("[unhandledrejection]"))) {
        throw new Error(`the app reported an error: ${e.message.slice(0, 300)}`);
      }
      if (e.message.includes(`[screen] ${name}`)) {
        await sleep(700); // let the glasses finish drawing
        return;
      }
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for the "${name}" screen`);
}

/** Save what the glasses show (on black, as they look) and what the phone page shows. */
async function shot(name: string): Promise<void> {
  const glasses = Buffer.from(await (await fetch(`${SIM}/api/screenshot/glasses`)).arrayBuffer());
  writeFileSync(join(OUT, `${name}.png`), onBlack(glasses));
  const phone = await fetch(`${SIM}/api/screenshot/webview`);
  if (phone.ok) writeFileSync(join(OUT, `${name}-phone.png`), Buffer.from(await phone.arrayBuffer()));
  console.log(`  ${name}`);
}

const tap = () => input("click");
const back = () => input("double_click");
const down = () => input("down");

async function walk(): Promise<void> {
  console.log("opening page");
  await screen("home");
  await sleep(800);
  await shot("home");

  console.log("talk");
  await tap();
  await screen("listening");
  await sleep(9000);
  await shot("talking");
  await tap();
  await screen("notes");
  await sleep(3500); // the recording is being tidied
  await shot("what-you-said");

  console.log("keep talking, then think better of it");
  await down();
  await tap();
  await screen("listening");
  await sleep(1500);
  await back(); // asks before throwing anything away; it keeps recording meanwhile
  await sleep(900);
  await shot("throw-it-away");
  await down();
  await tap();
  await screen("notes");

  console.log("write it up");
  await tap();
  await screen("composing");
  await shot("writing");
  await screen("brief", 60_000);
  await shot("ready");

  console.log("go through the notes");
  await tap();
  await screen("review");
  await shot("note-check");
  await down();
  await tap(); // use the correction
  await screen("review");
  await shot("note-added");
  await tap(); // keep it
  await screen("review");
  await shot("note-question");
  await tap(); // answer out loud
  await screen("listening");
  await sleep(2500);
  await shot("answering");
  await tap();
  await screen("changed", 40_000);
  await shot("answer-added");
  await tap(); // OK
  await screen("brief");
  await shot("notes-done");

  console.log("read it");
  await tap();
  await screen("reader");
  await shot("reading");
  await back();
  await screen("brief");

  console.log("press and hold to say a change, then undo it");
  await input("long_press");
  await screen("listening");
  await sleep(2500);
  await shot("saying-a-change");
  await input("long_press_release");
  await screen("changed", 40_000);
  await shot("changed");
  await down();
  await tap(); // undo
  await screen("brief");
  await shot("undone");

  console.log("back to the opening page");
  await back();
  await screen("home");
  await sleep(1200);
  await shot("home-with-articles");
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  // Run the tools by their script files, with this same Node, rather than relying on shell shims.
  const require = createRequire(import.meta.url);
  const node = process.execPath;
  const tsx = require.resolve("tsx/cli");
  const vite = join("node_modules", "vite", "bin", "vite.js");
  const simulator = require.resolve("@evenrealities/evenhub-simulator/bin/index.js");

  run(node, [tsx, "server/index.ts"], { PORT: String(API_PORT), DATA_DIR: dataDir, MOCK_AI: "1", MOCK_DELAY_MS: "1500", ACCESS_CODE: "" });
  await waitFor(`http://127.0.0.1:${API_PORT}/api/health`, "the backend");
  run(node, [vite, "--port", String(APP_PORT), "--strictPort"], { PORT: String(API_PORT) });
  await waitFor(`http://127.0.0.1:${APP_PORT}/`, "the dev server");

  const simArgs = [simulator, `http://localhost:${APP_PORT}/?mic=demo&lang=${lang}`, "--automation-port", String(SIM_PORT)];
  const headless = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  if (headless && !existsSync("/usr/bin/xvfb-run")) throw new Error("no display: install xvfb, or run this on a desktop");
  if (headless) run("xvfb-run", ["-a", "-s", "-screen 0 1280x900x24", node, ...simArgs]);
  else run(node, simArgs);
  await waitFor(`${SIM}/api/ping`, "the simulator");

  await walk();
  console.log(`\nAll screens reached. Pictures are in ${OUT}/`);
}

main()
  .then(() => {
    stopAll();
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\nFAILED: ${err instanceof Error ? err.message : err}`);
    stopAll();
    process.exit(1);
  });
