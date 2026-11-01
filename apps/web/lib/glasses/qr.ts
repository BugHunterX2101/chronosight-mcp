import qrcode from "qrcode-generator";

// A QR code for the link-first pairing URL (DESIGN §26.5), drawn as one SVG path so the page needs no inline
// style and no innerHTML. The code is made in the browser; the URL never leaves the page.

export interface QrPath {
  /** Modules per side, quiet zone included. */
  size: number;
  /** Dark modules as horizontal runs, in module units. */
  d: string;
}

export const QUIET = 4;

export function qrMatrix(text: string): boolean[][] {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}

export function qrPath(text: string): QrPath {
  const m = qrMatrix(text);
  const parts: string[] = [];
  m.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      if (!row[c]) {
        c += 1;
        continue;
      }
      const start = c;
      while (c < row.length && row[c]) c += 1;
      parts.push(`M${start + QUIET} ${r + QUIET}h${c - start}v1h-${c - start}z`);
    }
  });
  return { size: m.length + QUIET * 2, d: parts.join("") };
}
