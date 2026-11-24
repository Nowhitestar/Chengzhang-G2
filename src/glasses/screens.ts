/**
 * The layouts. Each function places a few boxes on the 576 × 288 canvas.
 *
 * Rules every screen follows:
 *  - one thing on screen, a few words;
 *  - a dim line at the top says where you are;
 *  - when there is a choice, it is a list at the bottom: swipe to move, tap to choose;
 *  - bright text is content, dim text is guidance.
 */
import { HEIGHT, LINE, linesHeight, ROW, WIDTH, type Box, type Brightness, type Page, type TextBox } from "./display.ts";
import { clamp, item, lineCount } from "./layout.ts";

const HEAD_H = linesHeight(1);

const text = (name: string, y: number, lines: number, content: string, brightness: Brightness = 4, capture = false): TextBox => ({
  kind: "text",
  name,
  x: 0,
  y,
  w: WIDTH,
  h: linesHeight(lines),
  text: clamp(content, lines),
  brightness,
  capture,
});

const head = (content: string): TextBox => text("head", 0, 1, content, 2);

function list(labels: string[], rows: number): Box {
  const visible = Math.min(rows, labels.length);
  return { kind: "list", name: "list", x: 0, y: HEIGHT - visible * ROW, w: WIDTH, h: visible * ROW, items: labels.map(item) };
}

/** How many lines fit between the header and something that starts at `bottom`, across `boxes` text boxes. */
const linesBetween = (top: number, bottom: number, boxes = 1) => Math.max(1, Math.floor((bottom - top - boxes * linesHeight(0)) / LINE));

/**
 * The general screen: where you are, something to read, and a choice.
 * `main` is the content; `aside` is a dimmer second block (a source, what was heard).
 */
export function choice(o: { head: string; main: string; aside?: string; asideLines?: number; items: string[]; rows?: number }): Page {
  const rows = Math.min(o.rows ?? 3, o.items.length);
  const bottom = HEIGHT - rows * ROW;
  const asideLines = o.aside ? Math.min(o.asideLines ?? 1, lineCount(o.aside)) : 0;
  const mainLines = linesBetween(HEAD_H, bottom, asideLines ? 2 : 1) - asideLines;
  const used = Math.min(mainLines, Math.max(1, lineCount(o.main)));
  const boxes: Box[] = [head(o.head), text("main", HEAD_H, used, o.main)];
  if (o.aside && asideLines) boxes.push(text("aside", HEAD_H + linesHeight(used), asideLines, o.aside, 2));
  boxes.push(list(o.items, rows));
  return { boxes };
}

/** A title, a few lines under it, and a choice: the finished article at a glance. */
export function brief(o: { head: string; title: string; gist: string; items: string[] }): Page {
  const rows = Math.min(3, o.items.length);
  const bottom = HEIGHT - rows * ROW;
  const total = linesBetween(HEAD_H, bottom, 2);
  const titleLines = Math.min(2, lineCount(o.title) || 1, total - 1);
  const gistLines = Math.max(1, total - titleLines);
  return {
    boxes: [
      head(o.head),
      text("title", HEAD_H, titleLines, o.title),
      text("gist", HEAD_H + linesHeight(titleLines), gistLines, o.gist, 3),
      list(o.items, rows),
    ],
  };
}

/** The opening page when there is something to tell: a line of greeting, then the list right under it. */
export function menu(o: { head: string; items: string[] }): Page {
  const rows = Math.min(6, o.items.length);
  return { boxes: [head(o.head), { kind: "list", name: "list", x: 0, y: HEIGHT - 6 * ROW, w: WIDTH, h: rows * ROW, items: o.items.map(item) }] };
}

/** A few words in the middle of an otherwise empty screen. Taps go to the main text. */
export function words(o: { head?: string; main: string; foot?: string; footLines?: number; footBright?: boolean }): Page {
  const footLines = o.foot ? (o.footLines ?? Math.min(2, lineCount(o.foot))) : 0;
  const footTop = HEIGHT - linesHeight(footLines);
  const mainLines = Math.min(Math.max(1, lineCount(o.main)), linesBetween(HEAD_H, o.foot ? footTop : HEIGHT));
  // Sit the words a little above the middle, where the eye rests.
  const free = (o.foot ? footTop : HEIGHT) - HEAD_H - linesHeight(mainLines);
  const top = HEAD_H + Math.max(0, Math.floor(free * 0.4));
  const boxes: Box[] = [];
  if (o.head) boxes.push(head(o.head));
  boxes.push({ ...text("main", top, mainLines, o.main), capture: true });
  if (o.foot) boxes.push(text("foot", footTop, footLines, o.foot, o.footBright ? 4 : 2));
  return { boxes };
}

/** While the author talks: a clock, ink, one line of reassurance. Optionally the question being answered. */
export function listening(o: { clock: string; ink: string; foot: string; question?: string }): Page {
  const footTop = HEIGHT - HEAD_H;
  if (o.question) {
    const qLines = Math.min(3, lineCount(o.question));
    const inkTop = HEAD_H + linesHeight(qLines);
    const inkLines = linesBetween(inkTop, footTop);
    return {
      boxes: [
        text("clock", 0, 1, o.clock),
        text("question", HEAD_H, qLines, o.question, 3),
        { kind: "text", name: "ink", x: 0, y: inkTop, w: WIDTH, h: linesHeight(inkLines), text: o.ink, capture: true },
        text("foot", footTop, 1, o.foot, 2),
      ],
    };
  }
  const inkLines = linesBetween(HEAD_H, footTop);
  return {
    boxes: [
      text("clock", 0, 1, o.clock),
      { kind: "text", name: "ink", x: 0, y: HEAD_H, w: WIDTH, h: linesHeight(inkLines), text: o.ink, capture: true },
      text("foot", footTop, 1, o.foot, 2),
    ],
  };
}

/** How many lines of ink fit on the listening screen. */
export const inkRows = (withQuestionLines = 0) =>
  linesBetween(withQuestionLines ? HEAD_H + linesHeight(withQuestionLines) : HEAD_H, HEIGHT - HEAD_H);

/** Lines of body text on a reading page. */
export const PAGE_LINES = linesBetween(0, HEIGHT - HEAD_H);

/** One page of reading, with a dim footer that says where you are and how to move. */
export function reading(o: { body: string; foot: string }): Page {
  return {
    boxes: [
      { kind: "text", name: "body", x: 0, y: 0, w: WIDTH, h: linesHeight(PAGE_LINES), text: o.body, capture: true },
      text("foot", HEIGHT - HEAD_H, 1, o.foot, 2),
    ],
  };
}
