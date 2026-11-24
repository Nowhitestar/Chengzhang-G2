/**
 * While the author talks, the glasses show no words, only ink: a short stroke
 * for every moment of speech, longer when louder, a new line after a pause.
 * It says "I'm listening" without giving the author text to go back and fix.
 */
import { getTextWidth } from "@evenrealities/pretext";
import { VOICE_LEVEL } from "../audio.ts";
import { innerWidth } from "./layout.ts";

const STROKE = "━";
/** About two seconds of quiet (at one sample every 700 ms) starts a new line, like a new paragraph. */
const QUIET_TICKS = 3;

export class Ink {
  private rows: string[] = [""];
  private quiet = 0;

  constructor(private readonly maxRows: number) {}

  /** Record the loudest level of the last tick. Returns true when the picture changed. */
  add(level: number): boolean {
    if (level < VOICE_LEVEL) {
      if (++this.quiet === QUIET_TICKS && this.rows[this.rows.length - 1]) {
        this.rows.push("");
        this.trim();
        return true;
      }
      return false;
    }
    this.quiet = 0;
    // Soft, normal, loud: one, two or three strokes joined into one mark.
    const stroke = STROKE.repeat(level < 0.5 ? 1 : level < 0.68 ? 2 : 3);
    const last = this.rows[this.rows.length - 1]!;
    const next = last ? `${last} ${stroke}` : stroke;
    if (getTextWidth(next) > innerWidth()) {
      this.rows.push(stroke);
      this.trim();
    } else {
      this.rows[this.rows.length - 1] = next;
    }
    return true;
  }

  private trim(): void {
    while (this.rows.length > this.maxRows) this.rows.shift();
  }

  get text(): string {
    return this.rows.join("\n");
  }

  /** The strokes as numbers (1..3 per stroke, 0 for a line break), for the phone-side picture. */
  get strokes(): number[] {
    return this.rows.flatMap((row, i) => [...(i ? [0] : []), ...row.split(" ").filter(Boolean).map((s) => s.length)]);
  }
}
