/**
 * Server Components cannot fetch a relative URL. Resolve the same public origin from the
 * incoming request when no separately configured gateway origin exists.
 */
export function gatewayOrigin(configured: string, requestHeaders: Headers): string | null {
  const explicit = configured.replace(/\/+$/, "");
  if (explicit !== "") return explicit;

  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || requestHeaders.get("host")?.trim();
  // This permits DNS hostnames, IPv4 loopback and an optional port, but never a path or userinfo.
  if (!host || !/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host)) return null;
  const isLocal = host.startsWith("localhost") || host.startsWith("127.");
  const forwardedProto = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const proto = isLocal
    ? (forwardedProto === "https" ? "https" : "http")
    : "https";
  return `${proto}://${host}`;
}
