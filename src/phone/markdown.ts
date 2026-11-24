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

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function inline(raw: string, notes: Map<string, Annotation>): string {
  let s = escapeHtml(raw);
  s = s.replace(/&lt;mark data-id=&quot;([\w-]+)&quot;&gt;([\s\S]*?)&lt;\/mark&gt;/g, (_m, id: string, inner: string) => {
    const n = notes.get(id);
    if (!n || (n.state !== "open" && n.state !== "kept")) return inner;
    return `<mark class="note ${n.kind} ${n.state}" data-id="${id}">${inner}</mark>`;
  });
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function mdToHtml(md: string, annotations: Annotation[]): string {
  const notes = new Map(annotations.map((a) => [a.id, a]));
  const out: string[] = [];
  let paragraph: string[] = [];
  let listTag = "";
  const flush = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(" "), notes)}</p>`);
    paragraph = [];
  };
  const endList = () => {
    if (listTag) out.push(`</${listTag}>`);
    listTag = "";
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
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
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
      const level = Math.min(4, heading[1]!.length + 1);
      out.push(`<h${level}>${inline(heading[2]!, notes)}</h${level}>`);
    } else if (bullet || numbered) {
      flush();
      const tag = bullet ? "ul" : "ol";
      if (listTag !== tag) {
        endList();
        out.push(`<${tag}>`);
        listTag = tag;
      }
      out.push(`<li>${inline((bullet ?? numbered)![1]!, notes)}</li>`);
    } else if (quote) {
      flush();
      endList();
      out.push(`<blockquote>${inline(quote[1]!, notes)}</blockquote>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      endList();
      out.push("<hr>");
    } else {
      endList();
      paragraph.push(line.trim());
    }
  }
  flush();
  endList();
  return out.join("\n");
}
