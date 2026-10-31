import { GATEWAY_ORIGIN } from "./config.ts";

// The one aggregate the browser reports (DESIGN §29.2): how long a replay took to draw its first mask.
// It carries a scenario id and a number and nothing else. sendBeacon sends text/plain, which the gateway
// accepts without a preflight; a failure is dropped, since a missing data point is not worth a retry.
export function reportFirstMask(scenarioId: string, ms: number): void {
  if (GATEWAY_ORIGIN === "" || typeof navigator.sendBeacon !== "function") return;
  const body = JSON.stringify({ metric: "replay_first_mask", scenarioId, seconds: Math.round(ms) / 1000 });
  navigator.sendBeacon(`${GATEWAY_ORIGIN}/api/beacons`, new Blob([body], { type: "text/plain" }));
}
