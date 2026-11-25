/**
 * One motion language for the phone page.
 *
 * The page is re-rendered as HTML whenever something changes. Instead of
 * swapping that HTML in (everything would jump), `transition()` works out what
 * actually happened to each element and shows it:
 *
 *   still here, moved        → it glides to its new place
 *   still here, new words    → the old words fade out, then the new ones settle in
 *   new                      → it rises into place
 *   gone                     → it fades where it stood
 *   its box grew or shrank   → the edge moves, and what is below follows
 *
 * Old and new are never legible on top of each other: whatever leaves is gone
 * in `T.fast`, and whatever arrives in its place waits that long before it
 * starts (out, then in).
 *
 * Every kind of change has one duration and one curve, defined once here and
 * mirrored in style.css as custom properties. Nothing animates layout except
 * the size of the few boxes marked `data-size` (height, or width with
 * `data-size="w"`); everything else is transform and opacity, so it stays on
 * the compositor.
 *
 * It is interruptible by construction: positions are measured as they look on
 * screen at that instant (mid-flight included), so a change that arrives while
 * another is still playing simply continues from there.
 *
 * With "reduce motion" on, nothing moves: content cross-fades briefly and
 * boxes take their new size at once.
 */

/** Milliseconds. Keep in step with --t-* in style.css. */
export const T = {
  /** Feedback for a touch, and anything leaving. */
  fast: 120,
  /** Something arriving, or words changing in place. */
  base: 260,
  /** Something that stays on screen changing place or size. */
  slow: 420,
} as const;

/** Keep in step with --ease-* in style.css. */
export const EASE = {
  /** Arrivals: quick off the mark, long soft landing. */
  out: "cubic-bezier(0.22, 1, 0.36, 1)",
  /**
   * Things that stay, changing place or size. Starts from rest, covers most of the way early and
   * settles for a long time, like a spring with no bounce: two thirds done after the first 120 ms
   * of 420, so the room is there by the time something arrives in it.
   */
  move: "cubic-bezier(0.2, 0, 0, 1)",
  /** Departures: accelerate away. */
  in: "cubic-bezier(0.4, 0, 1, 1)",
} as const;

const reduce = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
export const motionOK = () => !reduce?.matches;

const RISE = 8; // px an arriving element travels
const NEAR = 320; // px outside the viewport that still counts as "on screen"

const onScreen = (r: DOMRect) => r.bottom > -NEAR && r.top < innerHeight + NEAR && r.width > 0;

/** Animations this module started, so an interrupted one can be cancelled before measuring. */
const moving = new WeakMap<Element, Animation>();
const sizing = new WeakMap<Element, Animation>();

interface Context {
  entered: Element[];
  exited: Element[];
  swapped: Array<{ el: HTMLElement; ghost: HTMLElement | null }>;
  before: Map<string, DOMRect>;
}
/** Where an element sat inside the box it is positioned against. */
interface Spot {
  left: number;
  top: number;
  width: number;
  height: number;
}
let ctx: Context | null = null;

const isGhost = (n: Node) => n instanceof Element && n.hasAttribute("data-exiting");
const live = (parent: Node) => Array.from(parent.childNodes).filter((n) => !isGhost(n));

// ---------- bringing the DOM up to date without replacing what has not changed ----------

/** True when two subtrees have the same elements and the same words; only attributes may differ. */
function sameShape(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType === Node.TEXT_NODE) return a.nodeValue === b.nodeValue;
  if (!(a instanceof Element) || !(b instanceof Element) || a.tagName !== b.tagName) return false;
  const x = live(a);
  const y = Array.from(b.childNodes);
  return x.length === y.length && x.every((n, i) => sameShape(n, y[i]!));
}

function syncAttributes(old: Element, next: Element): void {
  for (const { name } of Array.from(old.attributes)) {
    if (!next.hasAttribute(name) && name !== "style") old.removeAttribute(name);
  }
  for (const { name, value } of Array.from(next.attributes)) {
    if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  }
}

function patch(old: Element, next: Element): void {
  syncAttributes(old, next);
  // A static element owns its own contents (the clock and the ink, updated many times a second).
  if (old.hasAttribute("data-static")) return;
  if (old.hasAttribute("data-swap") && !sameShape(old, next)) {
    // New words in the same place: keep a copy of the old ones to fade out over the new.
    let ghost: HTMLElement | null = null;
    const rect = ctx?.before.get(old.getAttribute("data-key") ?? "");
    if (ctx && motionOK() && rect && onScreen(rect) && old.textContent?.trim()) {
      ghost = old.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("data-key");
      ghost.querySelectorAll("[data-key]").forEach((n) => n.removeAttribute("data-key"));
    }
    old.replaceChildren(...Array.from(next.childNodes).map((n) => n.cloneNode(true)));
    ctx?.swapped.push({ el: old as HTMLElement, ghost });
    return;
  }
  reconcile(old, next);
}

function reconcile(oldParent: Element, newParent: ParentNode): void {
  const olds = live(oldParent);
  const keyed = new Map<string, Element>();
  for (const n of olds) {
    if (n instanceof Element && n.hasAttribute("data-key")) keyed.set(n.getAttribute("data-key")!, n);
  }
  const used = new Set<Node>();
  const order: Node[] = [];
  let cursor = 0;
  for (const next of Array.from(newParent.childNodes)) {
    let match: Node | undefined;
    if (next instanceof Element && next.hasAttribute("data-key")) {
      match = keyed.get(next.getAttribute("data-key")!);
    } else {
      // Unkeyed nodes pair up in order with the next unkeyed node of the same kind.
      while (cursor < olds.length && (used.has(olds[cursor]!) || (olds[cursor] instanceof Element && (olds[cursor] as Element).hasAttribute("data-key")))) cursor++;
      const candidate = olds[cursor];
      if (candidate && candidate.nodeType === next.nodeType && (!(next instanceof Element) || (candidate as Element).tagName === next.tagName)) {
        match = candidate;
        cursor++;
      }
    }
    if (match && !used.has(match)) {
      used.add(match);
      if (match instanceof Element && next instanceof Element) {
        if (!match.isEqualNode(next)) patch(match, next);
      } else if (match.nodeValue !== next.nodeValue) match.nodeValue = next.nodeValue;
      order.push(match);
    } else {
      const fresh = next.cloneNode(true);
      if (fresh instanceof Element) ctx?.entered.push(fresh);
      order.push(fresh);
    }
  }
  for (const n of olds) {
    if (used.has(n)) continue;
    const rect = n instanceof Element ? ctx?.before.get(n.getAttribute("data-key") ?? "") : undefined;
    if (ctx && n instanceof HTMLElement && rect && onScreen(rect) && motionOK()) {
      // Leave it in place, out of the flow, to fade where it stood.
      n.setAttribute("data-exiting", "");
      n.setAttribute("aria-hidden", "true");
      ctx.exited.push(n);
    } else n.remove();
  }
  // Put the survivors and the newcomers in their new order.
  let at: ChildNode | null = oldParent.firstChild;
  for (const node of order) {
    while (at && isGhost(at)) at = at.nextSibling;
    if (node === at) at = at.nextSibling;
    else oldParent.insertBefore(node, at);
  }
}

/** Make `parent` contain `html`, reusing every element that is still there. */
export function morph(parent: Element, html: string): void {
  const template = document.createElement("template");
  template.innerHTML = html;
  reconcile(parent, template.content);
}

// ---------- showing what changed ----------

const keyOf = (el: Element) => el.getAttribute("data-key")!;

function measure(root: Element): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>();
  for (const el of root.querySelectorAll("[data-key]:not([data-exiting])")) rects.set(keyOf(el), el.getBoundingClientRect());
  return rects;
}

/**
 * Where every keyed element sits inside the box it is positioned against. A ghost is held at this
 * spot, so that when its container glides or resizes the ghost is carried along instead of being
 * left behind (or moved twice).
 */
function spots(root: Element, rects: Map<string, DOMRect>): Map<string, Spot> {
  const out = new Map<string, Spot>();
  const bases = new Map<Element, DOMRect>();
  for (const el of root.querySelectorAll<HTMLElement>("[data-key]:not([data-exiting])")) {
    const rect = rects.get(keyOf(el));
    const parent = el.offsetParent;
    if (!rect || !parent) continue;
    let base = bases.get(parent);
    if (!base) bases.set(parent, (base = parent.getBoundingClientRect()));
    out.set(keyOf(el), {
      left: rect.left - base.left - parent.clientLeft + parent.scrollLeft,
      top: rect.top - base.top - parent.clientTop + parent.scrollTop,
      width: rect.width,
      height: rect.height,
    });
  }
  return out;
}

/** Take a removed element out of the flow at the spot it occupied, so it can fade there. */
function pin(el: HTMLElement, spot: Spot | undefined): void {
  if (!spot) return el.remove();
  Object.assign(el.style, {
    position: "absolute",
    left: `${spot.left}px`,
    top: `${spot.top}px`,
    width: `${spot.width}px`,
    height: `${spot.height}px`,
    margin: "0",
    pointerEvents: "none",
  });
}

function fadeAway(el: HTMLElement): void {
  const from = getComputedStyle(el).opacity;
  el.animate([{ opacity: from }, { opacity: 0 }], { duration: T.fast, easing: EASE.in, fill: "forwards" }).finished.then(
    () => el.remove(),
    () => el.remove(),
  );
}

/**
 * Change the page with `update`, then animate from how it looked to how it looks.
 * `update` must do its work synchronously, through morph().
 */
export function transition(root: HTMLElement, update: () => void): { entered: Element[] } {
  const before = measure(root);
  const held = spots(root, before);
  const sized = Array.from(root.querySelectorAll<HTMLElement>("[data-size]:not([data-exiting])")).map((el) => {
    const r = el.getBoundingClientRect();
    return { el, width: r.width, height: r.height };
  });
  const ctxNow: Context = { entered: [], exited: [], swapped: [], before };
  ctx = ctxNow;
  try {
    update();
  } finally {
    ctx = null;
  }
  const animate = motionOK();

  // Whatever was still gliding from an earlier change stops here; `before` already holds where it had got to.
  for (const el of root.querySelectorAll("[data-key]")) {
    moving.get(el)?.cancel();
    sizing.get(el)?.cancel();
  }

  // Elements that are gone: hold them where they were while they fade.
  for (const el of ctxNow.exited as HTMLElement[]) {
    pin(el, held.get(keyOf(el)));
    fadeAway(el);
  }

  // Boxes whose height changed: move the edge rather than jump. Started first, so that at this
  // instant the layout still shows the old height and nothing below needs to be moved by hand.
  if (animate) {
    for (const { el, width, height } of sized) {
      if (!el.isConnected || el.hasAttribute("data-exiting")) continue;
      const rect = el.getBoundingClientRect();
      const wide = el.getAttribute("data-size") === "w";
      const [from, to, prop] = wide ? [width, rect.width, "width"] : [height, rect.height, "height"];
      if (Math.abs(to - from) < 1 || !onScreen(rect)) continue;
      el.style.overflow = "clip";
      const a = el.animate([{ [prop]: `${from}px` }, { [prop]: `${to}px` }], { duration: T.slow, easing: EASE.move });
      sizing.set(el, a);
      const done = () => {
        if (sizing.get(el) === a) el.style.overflow = "";
      };
      a.finished.then(done, done);
    }
  }

  // Elements that are still here but in a different place: glide.
  if (animate) {
    const after = measure(root);
    const delta = new Map<Element, { dx: number; dy: number }>();
    for (const el of root.querySelectorAll<HTMLElement>("[data-key]:not([data-exiting])")) {
      const a = before.get(keyOf(el));
      const b = after.get(keyOf(el));
      if (!a || !b) continue;
      let dx = a.left - b.left;
      let dy = a.top - b.top;
      delta.set(el, { dx, dy });
      // A child is carried by its parent's glide; only its own extra movement is animated.
      const carrier = el.parentElement?.closest("[data-key]");
      const carried = carrier ? delta.get(carrier) : undefined;
      if (carried) {
        dx -= carried.dx;
        dy -= carried.dy;
      }
      if ((Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) || (!onScreen(a) && !onScreen(b))) continue;
      const glide = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: T.slow, easing: EASE.move });
      moving.set(el, glide);
    }
  }

  // Words that changed in place: the old ones fade out, then the new ones settle in.
  for (const { el, ghost } of ctxNow.swapped) {
    if (!el.isConnected) continue;
    if (ghost && animate) {
      ghost.setAttribute("data-exiting", "");
      ghost.setAttribute("aria-hidden", "true");
      el.after(ghost);
      pin(ghost, held.get(keyOf(el)));
      fadeAway(ghost);
      const roll = el.getAttribute("data-swap") === "roll";
      if (roll) ghost.animate([{ transform: "none" }, { transform: "translateY(-0.4em)" }], { duration: T.fast, easing: EASE.in, fill: "forwards" });
      el.animate([{ opacity: 0, transform: `translateY(${roll ? "0.4em" : "3px"})` }, { opacity: 1, transform: "none" }], {
        duration: T.base,
        delay: T.fast,
        easing: EASE.out,
        fill: "backwards",
      });
    } else if (!animate) {
      el.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: T.fast, easing: "linear" });
    }
  }

  // Elements that are new: rise into place. Only the outermost newcomer moves; what it contains comes with it.
  const outer = ctxNow.entered.filter((el) => el.isConnected && !ctxNow.entered.some((other) => other !== el && other.contains(el)));
  const turn = new Map<Element, number>();
  // If something left in this change, what arrives waits for it to be gone.
  const lead = ctxNow.exited.length ? T.fast : 0;
  for (const el of outer) {
    if (!(el instanceof HTMLElement)) continue;
    const how = el.getAttribute("data-in") ?? (el.hasAttribute("data-key") ? "rise" : "none");
    // Marks that the element is fresh, for the few CSS effects that start from it (the highlighter stroke).
    el.setAttribute("data-fresh", "");
    requestAnimationFrame(() => requestAnimationFrame(() => el.removeAttribute("data-fresh")));
    if (how === "none" || !onScreen(el.getBoundingClientRect())) continue;
    // Siblings that arrive together follow each other closely, up to a handful; the rest arrive with the last.
    const parent = el.parentElement!;
    const n = turn.get(parent) ?? 0;
    turn.set(parent, n + 1);
    const delay = lead + (parent.hasAttribute("data-stagger") ? Math.min(n, 5) * 36 : 0);
    if (!animate) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: T.fast, easing: "linear" });
    } else if (how === "fade") {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: T.base, delay, easing: EASE.out, fill: "backwards" });
    } else {
      el.animate([{ opacity: 0, transform: `translateY(${RISE}px)` }, { opacity: 1, transform: "none" }], { duration: T.base, delay, easing: EASE.out, fill: "backwards" });
    }
  }
  return { entered: outer };
}

/** A short hash for keys that should survive as long as the words do. */
export function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
