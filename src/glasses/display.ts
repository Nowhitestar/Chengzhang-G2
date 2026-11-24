/**
 * Everything that draws on the glasses goes through here.
 *
 * The G2 does not render HTML. A screen is a handful of text and list boxes at
 * fixed pixel positions on a 576 × 288 canvas. This file takes a description of
 * the screen we want and sends the cheapest update that gets there:
 *
 *   - same boxes, different words  → update the text in place (no flicker)
 *   - different boxes or list items → rebuild the page
 *
 * Bluetooth is slow, so writes run one at a time, and if several screens are
 * requested while one is being sent only the newest is drawn.
 */
import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";

export const WIDTH = 576;
export const HEIGHT = 288;
/** One line of text is 27 px tall in the glasses' only font. */
export const LINE = 27;
/** Padding inside every box. */
export const PAD = 4;
/** A list row is 40 px tall. */
export const ROW = 40;

/** Text brightness: 4 is full, lower is dimmer. Used for hierarchy, the only styling there is. */
export type Brightness = 1 | 2 | 3 | 4;

export interface TextBox {
  kind: "text";
  /** Unique on the page, at most 16 characters. */
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  brightness?: Brightness;
  /** Taps and swipes are delivered to exactly one box per page. */
  capture?: boolean;
}

export interface ListBox {
  kind: "list";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  items: string[];
}

export type Box = TextBox | ListBox;

export interface Page {
  boxes: Box[];
}

/** Height of a text box that shows `lines` lines. One pixel spare, or the firmware draws a scroll mark. */
export const linesHeight = (lines: number) => lines * LINE + PAD * 2 + 1;

const shape = (b: Box) =>
  b.kind === "list" ? `L:${b.name}:${b.x},${b.y},${b.w},${b.h}:${b.items.join("\u0001")}` : `T:${b.name}:${b.x},${b.y},${b.w},${b.h}:${b.capture ? 1 : 0}`;
const signature = (p: Page) => p.boxes.map(shape).join("|");

/** The firmware rejects an empty string in some places; a single space draws nothing. */
const safe = (s: string) => (s.length ? s : " ");

export class Display {
  private current: Page | null = null;
  private wanted: Page | null = null;
  private sending: Promise<void> | null = null;
  private started = false;

  constructor(private readonly bridge: EvenAppBridge) {}

  /** Ask for this screen. Returns when it (or a newer one) has been sent. */
  show(page: Page): Promise<void> {
    this.wanted = page;
    this.sending ??= this.drain().finally(() => (this.sending = null));
    return this.sending;
  }

  private async drain(): Promise<void> {
    while (this.wanted && this.wanted !== this.current) {
      const page = this.wanted;
      try {
        await this.send(page);
        this.current = page;
      } catch (err) {
        console.error("[display]", err);
        this.current = null; // unknown state: the next screen rebuilds from scratch
        if (this.wanted === page) this.wanted = null;
      }
    }
  }

  private containers(page: Page) {
    // The page needs exactly one box that receives input: the list if there is one.
    const hasList = page.boxes.some((b) => b.kind === "list");
    let captureGiven = false;
    const textObject: TextContainerProperty[] = [];
    const listObject: ListContainerProperty[] = [];
    page.boxes.forEach((b, i) => {
      const common = { xPosition: b.x, yPosition: b.y, width: b.w, height: b.h, containerID: i + 1, containerName: b.name };
      if (b.kind === "list") {
        listObject.push(
          new ListContainerProperty({
            ...common,
            isEventCapture: 1,
            itemContainer: new ListItemContainerProperty({ itemCount: b.items.length, itemName: b.items, isItemSelectBorderEn: 1 }),
          }),
        );
        captureGiven = true;
      } else {
        const capture = !hasList && !captureGiven && Boolean(b.capture);
        if (capture) captureGiven = true;
        textObject.push(
          new TextContainerProperty({
            ...common,
            paddingLength: PAD,
            content: safe(b.text),
            textColor: b.brightness ?? 4,
            isEventCapture: capture ? 1 : 0,
          }),
        );
      }
    });
    if (!captureGiven && textObject[0]) textObject[0].isEventCapture = 1;
    return { containerTotalNum: page.boxes.length, textObject, listObject };
  }

  private async send(page: Page): Promise<void> {
    const before = this.current;
    if (this.started && before && signature(before) === signature(page)) {
      // Same layout: only the words changed.
      for (let i = 0; i < page.boxes.length; i++) {
        const next = page.boxes[i]!;
        const prev = before.boxes[i]!;
        if (next.kind !== "text" || prev.kind !== "text") continue;
        if (next.text === prev.text && next.brightness === prev.brightness) continue;
        await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: i + 1,
            containerName: next.name,
            content: safe(next.text),
            ...(next.brightness !== prev.brightness ? { textColor: next.brightness ?? 4 } : {}),
          }),
        );
      }
      return;
    }
    const containers = this.containers(page);
    if (!this.started) {
      const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(containers));
      if (result !== StartUpPageCreateResult.success) throw new Error(`createStartUpPageContainer failed: ${String(result)}`);
      this.started = true;
      return;
    }
    const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer(containers));
    if (!ok) throw new Error("rebuildPageContainer failed");
  }

  /** What is on the glasses right now, for the phone-side mirror. */
  get page(): Page | null {
    return this.wanted ?? this.current;
  }
}
