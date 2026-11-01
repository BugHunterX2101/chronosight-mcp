// The pairing QR (DESIGN §26.5): the path must redraw exactly the modules the encoder marked dark, inside a quiet zone.
import { describe, expect, it } from "vitest";
import { QUIET, qrMatrix, qrPath } from "./qr.ts";

/** Reads the path back into a grid of the same size as the quiet-zone-padded code. */
function paint(d: string, size: number): boolean[][] {
  const g = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let i = 0; i < w; i += 1) g[y]![x + i] = true;
  }
  return g;
}

describe("qrPath", () => {
  const url = "http://localhost:3000/hud?code=K7Q2MX";

  it("redraws exactly the dark modules of the code", () => {
    const m = qrMatrix(url);
    const { size, d } = qrPath(url);
    expect(size).toBe(m.length + QUIET * 2);
    const g = paint(d, size);
    for (let r = 0; r < m.length; r += 1) for (let c = 0; c < m.length; c += 1) expect(g[r + QUIET]![c + QUIET]).toBe(m[r]![c]);
  });

  it("leaves the quiet zone blank", () => {
    const { size, d } = qrPath(url);
    const g = paint(d, size);
    for (let i = 0; i < size; i += 1) for (let k = 0; k < QUIET; k += 1) {
      expect(g[k]![i]).toBe(false);
      expect(g[size - 1 - k]![i]).toBe(false);
      expect(g[i]![k]).toBe(false);
      expect(g[i]![size - 1 - k]).toBe(false);
    }
  });

  it("has the three finder squares: dark corners 7 modules wide", () => {
    const m = qrMatrix(url);
    const n = m.length;
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
      for (let i = 0; i < 7; i += 1) {
        expect(m[r]![c + i]).toBe(true);
        expect(m[r + 6]![c + i]).toBe(true);
        expect(m[r + i]![c]).toBe(true);
        expect(m[r + i]![c + 6]).toBe(true);
      }
    }
  });

  it("makes a longer code for a longer link", () => {
    expect(qrMatrix(`${url}&x=${"a".repeat(80)}`).length).toBeGreaterThan(qrMatrix(url).length);
  });
});
