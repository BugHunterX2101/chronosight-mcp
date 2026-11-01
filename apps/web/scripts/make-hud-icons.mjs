// Draws the HUD's icons (DESIGN §26.1): 64 px PNG, white on transparent, no SVG. Run by hand when one changes:
//   node apps/web/scripts/make-hud-icons.mjs
// Each icon is a few strokes with round caps, rasterised with 4x4 supersampling and written with node:zlib.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const SIZE = 64;
const STROKE = 6;
const SS = 4;
const out = fileURLToPath(new URL("../public/hud/icons/", import.meta.url));

/** Points on a circular arc, in degrees clockwise from 3 o'clock. */
const arc = (cx, cy, r, from, to, n = 24) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = ((from + ((to - from) * i) / n) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

const lines = (...paths) => paths.flatMap((p) => p.slice(1).map((pt, i) => [p[i], pt]));

const ICONS = {
  next: lines([[24, 12], [44, 32], [24, 52]]),
  check: lines([[10, 34], [25, 49], [54, 15]]),
  cross: lines([[15, 15], [49, 49]], [[49, 15], [15, 49]]),
  warn: lines([[32, 8], [58, 54], [6, 54], [32, 8]], [[32, 24], [32, 39]], [[32, 47.5], [32, 47.6]]),
  retry: [...lines(arc(32, 32, 19, -50, 250)), ...lines([[8, 22], [14, 32], [26, 28]])],
};

function distToSegment(px, py, [[ax, ay], [bx, by]]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function raster(segments) {
  const rows = [];
  for (let y = 0; y < SIZE; y += 1) {
    const row = Buffer.alloc(1 + SIZE * 4);
    for (let x = 0; x < SIZE; x += 1) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (segments.some((s) => distToSegment(px, py, s) <= STROKE / 2)) hit += 1;
        }
      }
      const o = 1 + x * 4;
      row[o] = row[o + 1] = row[o + 2] = 255;
      row[o + 3] = Math.round((255 * hit) / (SS * SS));
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

function png(pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

mkdirSync(out, { recursive: true });
for (const [name, segments] of Object.entries(ICONS)) {
  writeFileSync(`${out}${name}.png`, png(raster(segments)));
  console.log("wrote", name);
}
