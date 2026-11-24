/**
 * The article is Markdown. Notes the AI leaves are wrapped in the text as
 * <mark data-id="a1">…</mark>; what each note means lives next to the article
 * as an Annotation. This file is the only place that knows that format.
 */
import type { Annotation } from "./types.ts";

const MARK = /<mark data-id="([\w-]+)">([\s\S]*?)<\/mark>/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const oneMark = (id: string) => new RegExp(`<mark data-id="${escapeRe(id)}">([\\s\\S]*?)</mark>`, "g");

export function markIds(md: string): string[] {
  return Array.from(md.matchAll(MARK), (m) => m[1]!);
}

/** The text a note is attached to. */
export function markInner(md: string, id: string): string {
  return oneMark(id).exec(md)?.[1]?.trim() ?? "";
}

/** Keep the words, drop the marker. */
export function unwrapMark(md: string, id: string): string {
  return md.replace(oneMark(id), "$1");
}

/** Replace the marked words (used when the author accepts a correction). */
export function replaceMark(md: string, id: string, text: string): string {
  return md.replace(oneMark(id), () => text);
}

/** Delete the marked words, then tidy the gap they leave. */
export function removeMark(md: string, id: string): string {
  return collapseBlank(
    md
      .replace(oneMark(id), "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/ +([,.;:!?，。；：！？、])/g, "$1")
      .replace(/^[ \t]+$/gm, ""),
  );
}

export function unwrapAll(md: string): string {
  return md.replace(MARK, "$2");
}

export function collapseBlank(md: string): string {
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g;

/** Words for Latin text, characters for Chinese, Japanese and Korean. */
export function wordCount(text: string): number {
  const plain = stripMarkdown(unwrapAll(text));
  const cjk = plain.match(CJK)?.length ?? 0;
  const latin = plain.replace(CJK, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  return cjk + latin;
}

export function isMostlyCjk(text: string): boolean {
  const cjk = text.match(CJK)?.length ?? 0;
  return cjk > 0 && cjk * 2 >= text.replace(/\s/g, "").length;
}

/** First words of something, cut at a word boundary where there is one. */
export function snippet(text: string, max: number): string {
  const flat = stripMarkdown(unwrapAll(text)).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:，。；：、]+$/, "") + "…";
}

/** Inline Markdown down to the words a person would read. */
function stripInline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/(^|[^\w_])_([^_\n]+)_/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[\^[\w-]+\]/g, "");
}

export function stripMarkdown(md: string): string {
  return md
    .split("\n")
    .map((line) => stripInline(line.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "")))
    .join("\n");
}

/**
 * The article as plain text for the glasses: one font, no bold, no colour.
 * Headings get a square, list items a bullet, and sentences the AI added that
 * the author has not decided on yet sit between 〔 〕 so they stand out.
 */
export function toGlassesText(md: string, annotations: Annotation[]): string {
  const open = new Set(annotations.filter((a) => a.kind === "added" && a.state === "open").map((a) => a.id));
  const marked = md.replace(MARK, (_m, id: string, inner: string) => (open.has(id) ? `〔${inner.trim()}〕` : inner));
  const out: string[] = [];
  let fence = false;
  for (const raw of marked.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("───");
      continue;
    }
    if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-")) continue; // table rule
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push("■ " + stripInline(heading[1]!).trim());
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const bullet = /\d/.test(item[2]!) ? item[2]!.replace(")", ".") : "•";
      out.push(`${bullet} ${stripInline(item[3]!).trim()}`);
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      out.push("│ " + stripInline(quote[1]!).trim());
      continue;
    }
    if (line.includes("|") && /^\s*\|.*\|\s*$/.test(line)) {
      out.push(
        line
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => stripInline(c).trim())
          .join(" · "),
      );
      continue;
    }
    out.push(stripInline(line));
  }
  return collapseBlank(out.join("\n"));
}

/**
 * Clean Markdown to take elsewhere. Markers are dropped; every AI addition the
 * author kept (or has not removed) becomes a footnote that names its source.
 */
export function exportMarkdown(title: string, md: string, annotations: Annotation[], sourcesLabel = "Sources"): string {
  const notes: string[] = [];
  const byId = new Map(annotations.map((a) => [a.id, a]));
  const body = md.replace(MARK, (_m, id: string, inner: string) => {
    const a = byId.get(id);
    if (!a || a.kind !== "added" || !a.sourceUrl || a.state === "removed") return inner;
    notes.push(`[^${notes.length + 1}]: [${(a.sourceTitle || a.sourceUrl).replace(/[[\]]/g, "")}](${a.sourceUrl})`);
    return `${inner}[^${notes.length}]`;
  });
  const head = title && !/^\s*#\s/.test(body) ? `# ${title}\n\n` : "";
  const tail = notes.length ? `\n\n---\n\n**${sourcesLabel}**\n\n${notes.join("\n")}` : "";
  return head + collapseBlank(body) + tail + "\n";
}

/** Hostname without "www.", for showing a source in a few characters. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
}
