/**
 * Draws the 24 × 24 store icon: the Chengzhang mark (lines of writing over a
 * seal) reduced to the 12 × 12 grid of 2 × 2 blocks that Even Hub requires.
 * Every lit pixel is opaque #F4F4F4; everything else is transparent.
 *
 *   npx tsx scripts/icon.ts
 */
import { writeFileSync } from "node:fs";
import { encode } from "./png.ts";

const GRID = [
  ".....XX.....",
  "............",
  ".XXXXXXXXXX.",
  "............",
  "...XXXXXX...",
  "............",
  "...XXXXXX...",
  "............",
  "...XXXXXX...",
  "...XXXXXX...",
  "...XXXXXX...",
  "............",
];

const size = 24;
const rgba = Buffer.alloc(size * size * 4);
GRID.forEach((row, gy) =>
  [...row].forEach((cell, gx) => {
    if (cell !== "X") return;
    for (const dy of [0, 1]) {
      for (const dx of [0, 1]) rgba.set([0xf4, 0xf4, 0xf4, 0xff], ((gy * 2 + dy) * size + gx * 2 + dx) * 4);
    }
  }),
);
writeFileSync("public/icon.png", encode(size, size, rgba));
console.log("public/icon.png written");
