import assert from "node:assert/strict";
import { test } from "node:test";
import { OsEventTypeList } from "@evenrealities/even_hub_sdk";
import { frameLevel, Recorder, VOICE_LEVEL } from "../src/audio.ts";
import { Ink } from "../src/glasses/ink.ts";
import { readInput } from "../src/glasses/input.ts";
import { bytes, clamp, item, lineCount, paginate, textWidth } from "../src/glasses/layout.ts";
import { tone } from "./helpers.ts";

test("text is cut to the lines a box has, with an ellipsis", () => {
  const long = "The quick brown fox jumps over the lazy dog. ".repeat(12);
  const cut = clamp(long, 2);
  assert.ok(cut.endsWith("…"));
  assert.ok(lineCount(cut) <= 2);
  assert.equal(clamp("fits", 2), "fits");
  const zh = clamp("想到哪，讲到哪。".repeat(30), 3);
  assert.ok(lineCount(zh) <= 3 && zh.endsWith("…"));
});

test("a list row stays on one line and within the firmware's 63 bytes", () => {
  const row = item("写好了：我为什么不再用待办清单，以及三年里我试过的所有办法");
  assert.ok(bytes(row) <= 63, `${bytes(row)} bytes`);
  assert.ok(row.endsWith("…"));
  const en = item("Ready: Why I stopped keeping a to-do list and what I do every single morning instead of that");
  assert.ok(bytes(en) <= 63 && textWidth(en) <= 536);
  assert.equal(item("Read it"), "Read it");
});

test("pages never exceed their lines, lose no words, and keep a heading with its text", () => {
  const body = ["■ First part", "Alpha beta gamma delta. ".repeat(40).trim(), "■ Second part", "想到哪，讲到哪。".repeat(60), "Tail."].join("\n");
  const pages = paginate(body, 9);
  assert.ok(pages.length > 2);
  for (const p of pages) assert.ok(lineCount(p) <= 9, `page has ${lineCount(p)} lines`);
  const squash = (s: string) => s.replace(/\s+/g, "");
  assert.equal(squash(pages.join("")), squash(body));
  for (const p of pages.slice(0, -1)) assert.ok(!/■ [^\n]*$/.test(p), "a heading is not the last thing on a page");
  assert.deepEqual(paginate("", 9), [""]);
});

test("a tap has no event type on the wire; the first list row has no index", () => {
  assert.deepEqual(readInput({ sysEvent: {} } as never), { type: "tap", index: 0 });
  assert.deepEqual(readInput({ listEvent: { containerID: 3 } } as never), { type: "tap", index: 0 });
  assert.deepEqual(readInput({ listEvent: { currentSelectItemIndex: 2 } } as never), { type: "tap", index: 2 });
  assert.deepEqual(readInput({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } } as never), { type: "double" });
  assert.deepEqual(readInput({ textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } } as never), { type: "up" });
  assert.deepEqual(readInput({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } } as never), { type: "down" });
  assert.deepEqual(readInput({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } } as never), { type: "hold" });
  assert.deepEqual(readInput({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT } } as never), { type: "release" });
  assert.deepEqual(readInput({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } } as never), { type: "exit" });
  // A microphone frame, or anything else without a touch envelope, is not a tap.
  assert.equal(readInput({ audioEvent: { audioPcm: new Uint8Array(4) } } as never), null);
  assert.equal(readInput({} as never), null);
});

test("loudness follows decibels: silence is 0, speech is well above the voice threshold", () => {
  assert.equal(frameLevel(new Uint8Array(3200)), 0);
  assert.ok(frameLevel(tone(0.1)) > VOICE_LEVEL + 0.3);
});

test("ink grows with speech, breaks the line after a pause, and keeps only the last rows", () => {
  const ink = new Ink(3);
  const rows = (): string[] => String(ink.text).split("\n");
  assert.equal(ink.add(0), false, "silence at the start draws nothing");
  ink.add(0.4);
  ink.add(0.6);
  ink.add(0.9);
  assert.equal(ink.text, "━ ━━ ━━━");
  ink.add(0);
  ink.add(0);
  assert.equal(ink.add(0), true, "the third quiet tick starts a new line");
  ink.add(0.9);
  assert.equal(ink.text, "━ ━━ ━━━\n━━━");
  assert.deepEqual(ink.strokes, [1, 2, 3, 0, 3]);
  for (let i = 0; i < 200; i++) ink.add(0.9);
  assert.equal(rows().length, 3);
  for (const row of rows()) assert.ok(textWidth(row) <= 568);
});

test("a recording is cut into slices at pauses, every slice is uploaded, and failed uploads are retried", async () => {
  const sent: Array<[number, number]> = [];
  let failures = 2;
  const rec = new Recorder({
    upload: async (idx, pcm) => {
      if (idx === 0 && failures-- > 0) throw new Error("offline");
      sent.push([idx, pcm.length]);
    },
  });
  const loud = tone(0.1);
  const quiet = new Uint8Array(3200);
  for (let i = 0; i < 160; i++) rec.push(loud); // 16 s of speech: past the minimum, no pause yet
  for (let i = 0; i < 4; i++) rec.push(quiet); // a 0.4 s pause: cut here
  for (let i = 0; i < 30; i++) rec.push(loud); // 3 more seconds
  assert.equal(rec.heard, true);
  assert.equal(Math.round(rec.elapsedMs), 19400);
  const done = await rec.finish();
  assert.deepEqual(done, { slices: 2, durationMs: 19400 });
  sent.sort((a, b) => a[0] - b[0]);
  // The cut comes once the pause has lasted 0.3 s, so the last quiet frame opens the second slice.
  assert.deepEqual(sent, [
    [0, 163 * 3200],
    [1, 31 * 3200],
  ]);
});

test("when a slice cannot be uploaded the recording is kept, and finishing again sends it", async () => {
  let online = false;
  const sent: number[] = [];
  const rec = new Recorder({
    upload: async (idx) => {
      if (!online) throw new Error("offline");
      sent.push(idx);
    },
  });
  for (let i = 0; i < 20; i++) rec.push(tone(0.1));
  await assert.rejects(rec.finish());
  online = true;
  assert.deepEqual(await rec.finish(), { slices: 1, durationMs: 2000 });
  assert.deepEqual(sent, [0]);
});
