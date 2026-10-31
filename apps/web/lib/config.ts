// The only two values the browser is given about the backend (TH-7). No key ever reaches the client.
// These must be literal `process.env.NEXT_PUBLIC_*` reads so Next can inline them.
export const GATEWAY_ORIGIN = process.env.NEXT_PUBLIC_GATEWAY_ORIGIN ?? "";
export const CDN_ORIGIN = process.env.NEXT_PUBLIC_CDN_ORIGIN ?? "";

// Replay bundles come from the CDN when one is configured, else straight from the gateway (§24.1).
const REPLAYS_BASE = CDN_ORIGIN !== "" ? CDN_ORIGIN : `${GATEWAY_ORIGIN}/replays`;

export const indexUrl = `${REPLAYS_BASE}/index.json`;

export function bundleBase(runId: string): string {
  return `${REPLAYS_BASE}/${encodeURIComponent(runId)}`;
}
