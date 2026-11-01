import type { NextRequest } from "next/server";

// The glasses' page (DESIGN §26.1). A plain document, not a React page: 600x600, one stylesheet, one script, no
// framework. The script is built by scripts/build-hud.mjs into public/hud/hud.js and carries this request's nonce so
// the CSP from proxy.ts admits it. The gateway origin rides in a data attribute; no key is ever in the page.

export const dynamic = "force-dynamic";

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function GET(request: NextRequest): Response {
  const nonce = request.headers.get("x-nonce") ?? "";
  const gateway = process.env.NEXT_PUBLIC_GATEWAY_ORIGIN ?? "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=600, initial-scale=1">
<meta name="robots" content="noindex">
<title>ChronoSight HUD</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/hud/hud.css">
</head>
<body data-gateway="${esc(gateway)}">
<main id="hud"></main>
<noscript>ChronoSight needs scripts to show the glasses view.</noscript>
<script nonce="${esc(nonce)}" src="/hud/hud.js" defer></script>
</body>
</html>
`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
