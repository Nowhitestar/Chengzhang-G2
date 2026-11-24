/**
 * Fitting words into boxes. The glasses have one proportional font and no way
 * to ask "did that fit?", so everything is measured beforehand with the
 * firmware's own glyph widths (@evenrealities/pretext).
 */
import { getTextWidth, measureTextWrap } from "@evenrealities/pretext";
import { PAD, WIDTH } from "./display.ts";

const encoder = new TextEncoder();
export const bytes = (s: string) => encoder.encode(s).length;

/** The firmware takes at most 999 bytes in a text box and 63 in a list row. */
const MAX_TEXT_BYTES = 999;
const MAX_ITEM_BYTES = 63;
/** A list row is inset on both sides and keeps a little air before the border. */
const ITEM_WIDTH = WIDTH - 40;

export const innerWidth = (boxWidth = WIDTH) => boxWidth - PAD * 2;
export const lineCount = (text: string, width = innerWidth()) => (text ? measureTextWrap(text, width).lineCount : 0);
export const textWidth = (text: string) => getTextWidth(text);

/** Largest prefix (by code points) that satisfies `fits`, found by bisection. */
function longestPrefix(chars: string[], fits: (s: string) => boolean): number {
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(chars.slice(0, mid).join(""))) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const trimEnd = (s: string) => s.replace(/[\s,.;:，。；：、]+$/u, "");

/** Cut text so it fills at most `lines` lines of a box, ending with an ellipsis when cut. */
export function clamp(text: string, lines: number, width = innerWidth()): string {
  const flat = text.trim();
  if (lines <= 0) return "";
  if (lineCount(flat, width) <= lines && bytes(flat) <= MAX_TEXT_BYTES) return flat;
  const chars = Array.from(flat);
  const n = longestPrefix(chars, (s) => lineCount(s + "…", width) <= lines && bytes(s) <= MAX_TEXT_BYTES - 3);
  const cut = chars.slice(0, n).join("");
  // Prefer to stop at a word boundary when one is close.
  const space = cut.lastIndexOf(" ");
  return trimEnd(space > cut.length * 0.75 ? cut.slice(0, space) : cut) + "…";
}

/** One list row: a single line, within the firmware's byte limit. */
export function item(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (textWidth(flat) <= ITEM_WIDTH && bytes(flat) <= MAX_ITEM_BYTES) return flat;
  const chars = Array.from(flat);
  const n = longestPrefix(chars, (s) => textWidth(s + "…") <= ITEM_WIDTH && bytes(s) <= MAX_ITEM_BYTES - 3);
  return trimEnd(chars.slice(0, n).join("")) + "…";
}

/** Split into pieces that can each be wrapped on their own: words for Latin text, single characters for CJK. */
function tokens(paragraph: string): string[] {
  return paragraph.match(/[぀-ヿ㐀-鿿豈-﫿＀-￯　-〿]|[^\s぀-ヿ㐀-鿿豈-﫿＀-￯　-〿]+\s*|\s+/gu) ?? [];
}

/**
 * Break text into pages of `lines` lines. Paragraphs flow across pages like a
 * book; a heading is never left alone at the bottom of a page.
 */
export function paginate(text: string, lines: number, width = innerWidth()): string[] {
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const pages: string[] = [];
  let page: string[] = [];
  let used = 0;
  const flush = () => {
    if (page.length) pages.push(page.join("\n\n"));
    page = [];
    used = 0;
  };
  for (let p = 0; p < paragraphs.length; p++) {
    let rest = paragraphs[p]!;
    const heading = rest.startsWith("■ ");
    while (rest) {
      const gap = page.length ? 1 : 0; // a blank line between paragraphs
      const free = lines - used - gap;
      const need = lineCount(rest, width);
      if (need <= free && !(heading && need === free && p < paragraphs.length - 1 && page.length)) {
        page.push(rest);
        used += gap + need;
        rest = "";
        break;
      }
      // Not enough room. Start a new page rather than leave one or two orphan lines, or split a heading.
      if ((free < 2 || heading) && page.length) {
        flush();
        continue;
      }
      const parts = tokens(rest);
      const room = page.length ? free : lines;
      let lo = 0;
      let hi = parts.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineCount(parts.slice(0, mid).join("").trimEnd(), width) <= room) lo = mid;
        else hi = mid - 1;
      }
      const take = Math.max(1, lo);
      page.push(parts.slice(0, take).join("").trimEnd());
      rest = parts.slice(take).join("").trimStart();
      flush();
    }
  }
  flush();
  return pages.length ? pages : [""];
}
