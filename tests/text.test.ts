import assert from "node:assert/strict";
import { test } from "node:test";
import { exportMarkdown, hostOf, markIds, markInner, removeMark, replaceMark, snippet, toGlassesText, unwrapMark, wordCount } from "../shared/text.ts";
import type { Annotation } from "../shared/types.ts";

const note = (id: string, kind: Annotation["kind"], state: Annotation["state"] = "open", extra: Partial<Annotation> = {}): Annotation => ({
  id,
  kind,
  note: "",
  suggestion: "",
  sourceTitle: "",
  sourceUrl: "",
  state,
  ...extra,
});

const MD = 'First. <mark data-id="a1">Added by the AI.</mark> Then <mark data-id="a2">a claim</mark>, and more.';

test("marks can be found, read, unwrapped, replaced and removed", () => {
  assert.deepEqual(markIds(MD), ["a1", "a2"]);
  assert.equal(markInner(MD, "a2"), "a claim");
  assert.equal(unwrapMark(MD, "a2"), 'First. <mark data-id="a1">Added by the AI.</mark> Then a claim, and more.');
  assert.equal(replaceMark(MD, "a2", "a corrected claim"), 'First. <mark data-id="a1">Added by the AI.</mark> Then a corrected claim, and more.');
  assert.equal(removeMark(MD, "a1"), 'First. Then <mark data-id="a2">a claim</mark>, and more.');
});

test("removing a marked sentence leaves no stray space before punctuation", () => {
  assert.equal(removeMark('It grew <mark data-id="a1">a lot</mark>, then stopped.', "a1"), "It grew, then stopped.");
  assert.equal(removeMark('One.\n\n<mark data-id="a1">Alone.</mark>\n\nTwo.', "a1"), "One.\n\nTwo.");
});

test("a replacement containing $ is taken literally", () => {
  assert.equal(replaceMark('Cost <mark data-id="a1">ten</mark>.', "a1", "$1 or $&"), "Cost $1 or $&.");
});

test("words are counted for Latin text and characters for Chinese", () => {
  assert.equal(wordCount("It's a well-known fact."), 4);
  assert.equal(wordCount("我不再用待办清单了。"), 9);
  assert.equal(wordCount("用 Vite 打包"), 4);
  assert.equal(wordCount('**Bold** and <mark data-id="a1">marked</mark> [link](https://example.com)'), 4);
});

test("a snippet stops at a word and says it was cut", () => {
  assert.equal(snippet("short", 20), "short");
  assert.equal(snippet("I want to write about why I stopped", 20), "I want to write…");
});

test("the glasses get plain text, with undecided AI sentences in brackets", () => {
  const md = '## Why\n\nPlain **bold** text. <mark data-id="a1">Added.</mark> <mark data-id="a2">Kept.</mark>\n\n- one\n- two\n\n> quoted\n\n1. first';
  const text = toGlassesText(md, [note("a1", "added"), note("a2", "added", "kept")]);
  assert.equal(text, "■ Why\n\nPlain bold text. 〔Added.〕 Kept.\n\n• one\n• two\n\n│ quoted\n\n1. first");
});

test("the export has no markers, and kept additions carry their source as a footnote", () => {
  const md = 'Said. <mark data-id="a1">Added one.</mark> <mark data-id="a2">Added two.</mark> <mark data-id="a3">asked</mark>';
  const out = exportMarkdown("Title", md, [
    note("a1", "added", "kept", { sourceTitle: "A [page]", sourceUrl: "https://a.example/x" }),
    note("a2", "added", "open", { sourceTitle: "", sourceUrl: "https://b.example/y" }),
    note("a3", "ask"),
  ]);
  assert.equal(
    out,
    "# Title\n\nSaid. Added one.[^1] Added two.[^2] asked\n\n---\n\n**Sources**\n\n[^1]: [A page](https://a.example/x)\n[^2]: [https://b.example/y](https://b.example/y)\n",
  );
});

test("a source is shown by its host", () => {
  assert.equal(hostOf("https://www.example.com/a/b?c=1"), "example.com");
  assert.equal(hostOf("not a url"), "not a url");
});
