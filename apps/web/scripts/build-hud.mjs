// Builds the HUD page's script (DESIGN §26.1, FR-HUD-1): lib/hud/main.ts and what it imports, as one minified
// browser script at public/hud/hud.js. The glasses' budget is 60 KB gzipped (PRD NFR); the build fails above it.
//   node apps/web/scripts/build-hud.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { rolldown } from "rolldown";

export const BUDGET_GZ_BYTES = 60 * 1024;

const entry = fileURLToPath(new URL("../lib/hud/main.ts", import.meta.url));
const outFile = fileURLToPath(new URL("../public/hud/hud.js", import.meta.url));

/** The bundled script and its gzipped size, in memory. */
export async function bundleHud() {
  const bundle = await rolldown({ input: entry, platform: "browser", logLevel: "warn" });
  const { output } = await bundle.generate({ format: "iife", minify: true });
  await bundle.close();
  const chunk = output.find((o) => o.type === "chunk");
  if (!chunk) throw new Error("the HUD bundle produced no chunk");
  return { code: chunk.code, gzipBytes: gzipSync(chunk.code, { level: 9 }).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, gzipBytes } = await bundleHud();
  if (gzipBytes > BUDGET_GZ_BYTES) {
    console.error(`hud.js is ${gzipBytes} bytes gzipped; the budget is ${BUDGET_GZ_BYTES}`);
    process.exit(1);
  }
  mkdirSync(fileURLToPath(new URL("../public/hud/", import.meta.url)), { recursive: true });
  writeFileSync(outFile, code);
  console.log(`hud.js ${code.length} bytes, ${gzipBytes} gzipped (budget ${BUDGET_GZ_BYTES})`);
}
