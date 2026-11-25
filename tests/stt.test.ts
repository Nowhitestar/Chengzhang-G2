/**
 * Speech-to-text against a provider that is busy, refusing, or fine. The
 * provider is a stand-in for `fetch`; nothing leaves the machine.
 */
process.env.STT_PROVIDER = "dashscope";
process.env.DASHSCOPE_API_KEY = "test-key";
process.env.DASHSCOPE_BASE_URL = "https://stt.example/compatible-mode/v1";
process.env.MOCK_LLM = "1";
process.env.STT_RETRY_MS = "1,1,1";
delete process.env.MOCK_AI;
delete process.env.MOCK_STT;

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { makeT } from "../shared/i18n.ts";
import { tone } from "./helpers-audio.ts";

const { transcribe, SttError } = await import("../server/stt.ts");
const t = makeT("en");
const hint = { purpose: "material" as const, idx: 0 };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers each call with the next reply in the list; the last one repeats. */
function provider(...replies: Array<[number, unknown]>): { calls: number } {
  const seen = { calls: 0 };
  globalThis.fetch = (async () => {
    const [status, body] = replies[Math.min(seen.calls, replies.length - 1)]!;
    seen.calls++;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return seen;
}
const heard = (text: string) => ({ choices: [{ message: { content: text } }] });

test("a busy provider is asked again, and the take is not lost", async () => {
  const seen = provider([429, { error: { message: "rate limit" } }], [503, { error: "overloaded" }], [200, heard(" Three things, on paper. ")]);
  assert.equal(await transcribe(tone(2), t, hint), "Three things, on paper.");
  assert.equal(seen.calls, 3);
});

test("a provider that stays busy is given up on, with a reason a person can act on", async () => {
  const seen = provider([429, { error: { message: "rate limit" } }]);
  await assert.rejects(transcribe(tone(2), t, hint), (err) => err instanceof SttError && /Too many transcription requests/.test(err.message));
  assert.equal(seen.calls, 4, "the first try and three more");
});

test("a refused key is not retried", async () => {
  const seen = provider([401, { error: { message: "invalid api key" } }]);
  await assert.rejects(transcribe(tone(2), t, hint), (err) => err instanceof SttError && /key is invalid/.test(err.message));
  assert.equal(seen.calls, 1);
});

test("silence is never sent: speech models invent words for an empty clip", async () => {
  const seen = provider([200, heard("Thank you for watching.")]);
  assert.equal(await transcribe(new Uint8Array(32000), t, hint), "");
  assert.equal(seen.calls, 0);
});
