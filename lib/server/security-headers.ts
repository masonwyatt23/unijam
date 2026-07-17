export type SecurityEnvironment = "development" | "staging" | "production";

export function createScriptNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function isDocumentRequest(request: Request): boolean {
  if (!new Set(["GET", "HEAD"]).has(request.method.toUpperCase())) return false;
  const destination = request.headers.get("Sec-Fetch-Dest");
  if (destination) return destination === "document";
  const accept = request.headers.get("Accept") ?? "*/*";
  if (request.headers.get("RSC") === "1" || accept.includes("text/x-component")) return false;
  if (accept.includes("text/html")) return true;
  if (!accept.includes("*/*")) return false;
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith("/api/") || pathname.startsWith("/_vinext/") || pathname.startsWith("/assets/")) return false;
  return !/\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(pathname);
}

export function securityHeaders(environment: SecurityEnvironment, scriptNonce?: string): Record<string, string> {
  const connectHosts = environment === "staging"
    ? "'self' wss://staging.unijam.ashlr.ai https://api.music.apple.com https://cloudflareinsights.com"
    : "'self' wss://unijam.ashlr.ai https://api.music.apple.com https://cloudflareinsights.com";
  const nonceSource = scriptNonce ? ` 'nonce-${scriptNonce}'` : "";
  const scriptSources = `'self'${nonceSource} https://js-cdn.music.apple.com https://static.cloudflareinsights.com`;
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'self'",
      `connect-src ${connectHosts}`,
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "frame-src https://embed.music.apple.com",
      "img-src 'self' data: https://i.scdn.co https://*.mzstatic.com https://marketing.services.apple",
      "object-src 'none'",
      `script-src ${scriptSources}`,
      "script-src-attr 'none'",
      "style-src 'self' 'unsafe-inline'",
      ...(environment === "development" ? [] : ["upgrade-insecure-requests"]),
    ].join("; "),
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...(environment === "production"
      ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }
      : environment === "staging"
        ? { "Strict-Transport-Security": "max-age=31536000" }
        : {}),
  };
}

export function withSecurityRequestHeaders(
  request: Request,
  environment: SecurityEnvironment,
  scriptNonce: string,
  appOrigin: string,
): Request {
  const headers = new Headers(request.headers);
  // Vinext reads the request CSP and applies its nonce to every bootstrap and
  // streamed RSC script. Always overwrite inbound CSP so a client cannot
  // choose a nonce that the response will trust.
  headers.set("Content-Security-Policy", securityHeaders(environment, scriptNonce)["Content-Security-Policy"]);
  headers.delete("Content-Security-Policy-Report-Only");
  // Metadata is rendered inside Vinext, where Cloudflare bindings are not
  // available in every runtime. These values come from the Worker binding and
  // are always overwritten here so request headers cannot spoof canonical URLs.
  headers.set("X-UniJam-App-Environment", environment);
  headers.set("X-UniJam-App-Origin", appOrigin);
  return new Request(request, { headers });
}

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function isExactSameOriginRequest(request: Request, expectedOrigin: string): boolean {
  if (safeMethods.has(request.method.toUpperCase())) return true;
  const url = new URL(request.url);
  // The authenticated migration exporter is a server-to-server compatibility
  // bridge. It has its own secret and never uses browser cookies.
  if (url.pathname === "/api/v1/migration/import") return true;
  return request.headers.get("Origin") === expectedOrigin && request.headers.get("Sec-Fetch-Site") === "same-origin";
}

export function isExactSameOriginWebSocket(request: Request, expectedOrigin: string): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
    request.headers.get("Origin") === expectedOrigin &&
    request.headers.get("Sec-Fetch-Site") === "same-origin";
}

export function withSecurityHeaders(response: Response, environment: SecurityEnvironment, scriptNonce?: string): Response {
  if (response.status === 101) return response;
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(securityHeaders(environment, scriptNonce))) secured.headers.set(name, value);
  if (scriptNonce && /^text\/html\b/i.test(secured.headers.get("Content-Type") ?? "")) {
    secured.headers.set("Cache-Control", "private, no-store");
  }
  return secured;
}
