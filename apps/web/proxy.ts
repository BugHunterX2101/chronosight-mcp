import { NextResponse, type NextRequest } from "next/server";

// Per-request nonce CSP plus the baseline security headers (DL-21, TQ-1, TH-7).
// Only the two public origins are known to the browser; connect-src also needs the ws form of the
// gateway origin for the HUD stream. Pages carry no inline style attributes, so style-src has no
// 'unsafe-inline' in production.

function csp(nonce: string): string {
  const gateway = process.env.NEXT_PUBLIC_GATEWAY_ORIGIN ?? "";
  const cdn = process.env.NEXT_PUBLIC_CDN_ORIGIN ?? "";
  const ws = gateway.replace(/^http/, "ws");
  const dev = process.env.NODE_ENV !== "production";
  const list = (...xs: string[]) => xs.filter((x) => x !== "").join(" ");
  return [
    "default-src 'self'",
    // React refresh needs eval in development only.
    `script-src ${list("'self'", `'nonce-${nonce}'`, "'strict-dynamic'", dev ? "'unsafe-eval'" : "")}`,
    `style-src ${list("'self'", dev ? "'unsafe-inline'" : `'nonce-${nonce}'`)}`,
    `connect-src ${list("'self'", gateway, cdn, ws)}`,
    `img-src ${list("'self'", "blob:", "data:", gateway, cdn)}`,
    `media-src ${list("'self'", "blob:", gateway, cdn)}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function proxy(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const policy = csp(nonce);

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", policy);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", policy);
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set("permissions-policy", "camera=(), microphone=(self), geolocation=()");
  response.headers.set("cross-origin-opener-policy", "same-origin");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
