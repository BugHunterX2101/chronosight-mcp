import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Next only loads .env files from this directory, while the keys live in the repo root's gitignored
// .env.local. Forward exactly the two NEXT_PUBLIC origins (TH-7); nothing else is read from that file.
const EXPOSED = ["NEXT_PUBLIC_GATEWAY_ORIGIN", "NEXT_PUBLIC_CDN_ORIGIN"] as const;

function publicEnv(): Record<string, string> {
  const file = fileURLToPath(new URL("../../.env.local", import.meta.url));
  const out: Record<string, string> = {};
  for (const key of EXPOSED) if (process.env[key] !== undefined) out[key] = process.env[key];
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    const key = m?.[1];
    if (key === undefined || !(EXPOSED as readonly string[]).includes(key) || key in out) continue;
    out[key] = (m?.[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

// Security headers and the nonce CSP are set by proxy.ts (DL-21, TQ-1), so none are listed here.
const config: NextConfig = {
  env: publicEnv(),
  // Playwright exercises the app at 127.0.0.1 while Next's dev server can identify its own
  // origin differently. Permit that loopback host so HMR does not prevent client hydration.
  allowedDevOrigins: ["127.0.0.1"],
  // run-model ships TypeScript source; the browser entry has no node: imports.
  transpilePackages: ["@chronosight/run-model"],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
