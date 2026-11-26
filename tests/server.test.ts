import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.ts";

const { markdownToBlocks, pageId, richText } = await import("../server/notion.ts");
const { reconcile, materialText } = await import("../server/pipeline.ts");
const { pcmToWav, peak } = await import("../server/stt.ts");

const draft = (markdown: string, annotations: Array<[string, "added" | "diff" | "ask", string, string?]>) => ({
  title: "T",
  gist: "G",
  markdown,
  annotations: annotations.map(([id, kind, source_url, suggestion]) => ({ id, kind, note: "n", suggestion: suggestion ?? "", source_title: "S", source_url })),
});

test("an AI sentence stays only if its source was actually found", () => {
  const found = [{ title: "Real", url: "https://real.example/page/" }];
  const out = reconcile(
    draft('Said. <mark data-id="a1">Sourced.</mark> <mark data-id="a2">Invented.</mark> <mark data-id="a3">No source at all.</mark>', [
      ["a1", "added", "https://REAL.example/page"],
      ["a2", "added", "https://made-up.example/"],
      ["a3", "added", ""],
    ]),
    found,
  );
  assert.equal(out.markdown, 'Said. <mark data-id="a1">Sourced.</mark>');
  assert.deepEqual(out.annotations.map((a) => a.id), ["a1"]);
  assert.equal(out.annotations[0]!.state, "open");
});

test("marks and notes are made to agree", () => {
  const out = reconcile(
    draft('# Title in the body\n\n<mark data-id="a1">claim</mark> and <mark data-id="a9">orphan</mark> and <mark data-id="a2">vague</mark>.', [
      ["a1", "diff", "https://unknown.example/", "corrected claim"],
      ["a2", "ask", ""],
      ["a2", "ask", ""], // a duplicate note
      ["a5", "ask", ""], // a note with no mark
      ["a6", "diff", "", ""], // would be dropped anyway: no mark
    ]),
    [],
  );
  assert.equal(out.markdown, '<mark data-id="a1">claim</mark> and orphan and <mark data-id="a2">vague</mark>.');
  assert.deepEqual(out.annotations.map((a) => [a.id, a.kind, a.sourceUrl]), [
    ["a1", "diff", ""], // kept as a hint, but an unverified source is not shown
    ["a2", "ask", ""],
  ]);
});

test("several recordings are labelled for the writer; one is passed as it is", () => {
  const rec = (text: string, raw = "") => ({ text, raw }) as never;
  assert.equal(materialText([rec("only one")]), "only one");
  assert.equal(materialText([rec("first"), rec("", "raw second"), rec("")]), "## Recording 1\n\nfirst\n\n## Recording 2\n\nraw second");
});

test("raw microphone audio gets a correct WAV header", () => {
  const wav = pcmToWav(new Uint8Array(3200));
  const v = new DataView(wav.buffer);
  assert.equal(wav.length, 3244);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
  assert.equal(v.getUint32(4, true), 3236);
  assert.equal(v.getUint16(22, true), 1); // mono
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 3200);
  assert.equal(peak(new Uint8Array(3200)), 0);
});

test("Markdown becomes Notion blocks", () => {
  const blocks = markdownToBlocks("Intro **bold** and [a link](https://example.com).\n\n## Heading\n\n- one\n- two\n\n1. first\n\n> quote\n\n```\ncode\n```\n\n---\n\n[^1]: [Source](https://s.example)");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["paragraph", "heading_2", "bulleted_list_item", "bulleted_list_item", "numbered_list_item", "quote", "code", "divider", "paragraph"],
  );
  const runs = (blocks[0] as unknown as { paragraph: { rich_text: Array<{ text: { content: string; link?: { url: string } }; annotations?: { bold?: boolean } }> } }).paragraph.rich_text;
  assert.deepEqual(
    runs.map((r) => [r.text.content, Boolean(r.annotations?.bold), r.text.link?.url ?? ""]),
    [
      ["Intro ", false, ""],
      ["bold", true, ""],
      [" and ", false, ""],
      ["a link", false, "https://example.com"],
      [".", false, ""],
    ],
  );
});

test("long text is split into runs Notion accepts, and footnote marks stay readable", () => {
  const runs = richText("x".repeat(4500) + " fact[^2]");
  assert.ok(runs.every((r) => r.text.content.length <= 2000));
  assert.equal(runs.map((r) => r.text.content).join(""), "x".repeat(4500) + " fact[2]");
});

test("a Notion page id is accepted bare, dashed, or as the end of a page address", () => {
  const id = "0123456789abcdef0123456789abcdef";
  assert.equal(pageId(id), id);
  assert.equal(pageId("01234567-89ab-cdef-0123-456789abcdef"), id);
  assert.equal(pageId(`https://www.notion.so/My-page-${id}?pvs=4`), id);
});

test("access codes are read with their daily allowances", async () => {
  const { parseCodes } = await import("../server/config.ts");
  assert.deepEqual([...parseCodes(" judges:40, friends ,talk:0,, bad code:3")], [
    ["judges", 40],
    ["friends", 0],
    ["talk", 0],
  ]);
  assert.equal(parseCodes("").size, 0);
});
