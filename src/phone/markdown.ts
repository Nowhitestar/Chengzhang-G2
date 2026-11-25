/**
 * The article as HTML for the phone page. Everything is escaped first; only
 * the handful of tags produced here ever reach the page.
 *
 * The AI's notes keep the meaning they have in Chengzhang:
 *   highlight   a sentence the AI added, not decided yet
 *   thin line   an addition the author kept (the source stays attached)
 *   wavy red    something that disagrees with a source
 *   dashed      a question for the author
 */
import type { Annotation } from "../../shared/types.ts";
import { hash } from "./motion.ts";

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function inline(raw: string, notes: Map<string, Annotation>, focus: string): string {
  let s = escapeHtml(raw);
  s = s.replace(/&lt;mark data-id=&quot;([\w-]+)&quot;&gt;([\s\S]*?)&lt;\/mark&gt;/g, (_m, id: string, inner: string) => {
    const n = notes.get(id);
    if (!n || (n.state !== "open" && n.state !== "kept")) return inner;
    return `<mark class="note ${n.kind} ${n.state}${id === focus ? " focus" : ""}" data-id="${id}">${inner}</mark>`;
  });
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/** The words of a piece of Markdown without the note markers around them. */
const wordsOf = (raw: string) => raw.replace(/<\/?mark[^>]*>/g, "");

/**
 * `focus` is the note being decided on the glasses right now, if any.
 *
 * Every top-level block carries a key made from its words (not from the notes
 * wrapped around them). A block the author did not touch is therefore the same
 * element before and after a change, and only what really changed is seen to
 * change.
 */
export function mdToHtml(md: string, annotations: Annotation[], focus = ""): string {
  const notes = new Map(annotations.map((a) => [a.id, a]));
  const blocks: Array<{ tag: string; inner: string; words: string }> = [];
  let paragraph: string[] = [];
  // Held in an object so the two helpers below and the loop all see the same list.
  const run: { list: { tag: string; items: string[]; words: string[] } | null } = { list: null };
  const flush = () => {
    if (paragraph.length) {
      const raw = paragraph.join(" ");
      blocks.push({ tag: "p", inner: inline(raw, notes, focus), words: wordsOf(raw) });
    }
    paragraph = [];
  };
  const endList = () => {
    if (run.list) blocks.push({ tag: run.list.tag, inner: run.list.items.join(""), words: run.list.words.join("\n") });
    run.list = null;
  };
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s{0,3}(```|~~~)/.exec(line);
    if (fence) {
      flush();
      endList();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!); i++) body.push(lines[i]!);
      blocks.push({ tag: "pre", inner: `<code>${escapeHtml(body.join("\n"))}</code>`, words: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      endList();
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (heading) {
      flush();
      endList();
      blocks.push({ tag: `h${Math.min(4, heading[1]!.length + 1)}`, inner: inline(heading[2]!, notes, focus), words: wordsOf(heading[2]!) });
    } else if (bullet || numbered) {
      flush();
      const tag = bullet ? "ul" : "ol";
      if (run.list?.tag !== tag) {
        endList();
        run.list = { tag, items: [], words: [] };
      }
      const raw = (bullet ?? numbered)![1]!;
      run.list.items.push(`<li>${inline(raw, notes, focus)}</li>`);
      run.list.words.push(wordsOf(raw));
    } else if (quote) {
      flush();
      endList();
      blocks.push({ tag: "blockquote", inner: inline(quote[1]!, notes, focus), words: wordsOf(quote[1]!) });
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      endList();
      blocks.push({ tag: "hr", inner: "", words: "---" });
    } else {
      endList();
      paragraph.push(line.trim());
    }
  }
  flush();
  endList();

  // The same words twice (two rules, a repeated line) still need different keys.
  const seen = new Map<string, number>();
  return blocks
    .map((b) => {
      const base = hash(b.tag + b.words);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const key = `b-${base}${n ? `-${n}` : ""}`;
      return b.tag === "hr" ? `<hr data-key="${key}">` : `<${b.tag} data-key="${key}">${b.inner}</${b.tag}>`;
    })
    .join("");
}
