/**
 * Builds the app against a deployed backend and packs it as an .ehpk.
 *
 *   API_ORIGIN=https://your-backend.example.com npm run pack
 *
 * The packed app calls that backend, so its origin goes into the build
 * (VITE_API_BASE) and into the manifest's network whitelist. app.json in the
 * repository only carries a placeholder; it is never modified.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const input = (process.env.API_ORIGIN || "").trim();
if (!input) fail("Set API_ORIGIN to the address of your deployed backend, for example:\n  API_ORIGIN=https://your-backend.example.com npm run pack");
let origin = "";
try {
  const url = new URL(input);
  if (url.protocol !== "https:") fail("API_ORIGIN must start with https:// (the Even app only allows secure origins in production).");
  origin = url.origin;
} catch {
  fail(`API_ORIGIN is not an address: ${input}`);
}

const modules = (...parts: string[]) => join("node_modules", ...parts);
const run = (label: string, script: string, args: string[], env: Record<string, string> = {}) => {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) fail(`${label} failed.`);
};

run("Type check", modules("typescript", "bin", "tsc"), ["--noEmit"]);
run("Build", modules("vite", "bin", "vite.js"), ["build"], { VITE_API_BASE: origin });

const manifest = JSON.parse(readFileSync("app.json", "utf8")) as { version: string; permissions: Array<{ name: string; whitelist?: string[] }> };
const network = manifest.permissions.find((p) => p.name === "network");
if (!network) fail("app.json has no network permission.");
network!.whitelist = [origin];
mkdirSync(".pack", { recursive: true });
writeFileSync(join(".pack", "app.json"), JSON.stringify(manifest, null, 2));

const sdk = (JSON.parse(readFileSync(modules("@evenrealities", "even_hub_sdk", "package.json"), "utf8")) as { version: string }).version;
const out = `chengzhang-${manifest.version}.ehpk`;
run("Pack", modules("@evenrealities", "evenhub-cli", "main.js"), ["pack", join(".pack", "app.json"), "dist", "-o", out, "--sdk-ver", sdk]);
console.log(`\n${out} is ready. It talks to ${origin}.`);
