/**
 * Turns the SDK's event envelopes into the handful of things a person can do
 * on the temple touchpad or the R1 ring.
 *
 * Two traps this file exists to hide:
 *  - A single tap has event type 0, and zero values are dropped on the wire, so
 *    a tap arrives as an envelope with no type at all. The same goes for the
 *    first row of a list (index 0).
 *  - Taps arrive in different envelopes depending on what is capturing input:
 *    `sysEvent` for a text box, `listEvent` for a list. Swipes on a text box
 *    arrive as `textEvent`.
 */
import { OsEventTypeList, type EvenHubEvent } from "@evenrealities/even_hub_sdk";

export type Input =
  | { type: "tap"; index: number }
  | { type: "double" }
  | { type: "up" }
  | { type: "down" }
  | { type: "hold" }
  | { type: "release" }
  /** The glasses' own menu or another overlay covered the app, then went away. */
  | { type: "covered" }
  | { type: "uncovered" }
  /** The app is being closed. */
  | { type: "exit" };

/** The type of one envelope; an envelope without a type is a tap. */
function typeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null;
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT;
}

export function readInput(event: EvenHubEvent): Input | null {
  const types = [typeOf(event.sysEvent), typeOf(event.textEvent), typeOf(event.listEvent)];
  const has = (t: OsEventTypeList) => types.includes(t);
  // Explicit types first; "tap" is what is left when nothing else matched.
  if (has(OsEventTypeList.DOUBLE_CLICK_EVENT)) return { type: "double" };
  if (has(OsEventTypeList.LONG_PRESS_EVENT)) return { type: "hold" };
  if (has(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) return { type: "release" };
  if (has(OsEventTypeList.SCROLL_TOP_EVENT)) return { type: "up" };
  if (has(OsEventTypeList.SCROLL_BOTTOM_EVENT)) return { type: "down" };
  if (has(OsEventTypeList.SYSTEM_EXIT_EVENT) || has(OsEventTypeList.ABNORMAL_EXIT_EVENT)) return { type: "exit" };
  if (has(OsEventTypeList.FOREGROUND_ENTER_EVENT)) return { type: "covered" };
  if (has(OsEventTypeList.FOREGROUND_EXIT_EVENT)) return { type: "uncovered" };
  if (has(OsEventTypeList.CLICK_EVENT)) return { type: "tap", index: event.listEvent?.currentSelectItemIndex ?? 0 };
  return null;
}
