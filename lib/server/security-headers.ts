export type SecurityEnvironment = "development" | "staging" | "production";

export function securityHeaders(environment: SecurityEnvironment): Record<string, string> {
  const connectHosts = environment === "staging"
    ? "'self' wss://staging.unijam.ashlr.ai https://api.music.apple.com"
    : "'self' wss://unijam.ashlr.ai https://api.music.apple.com";
  const scriptSources = environment === "development"
    ? "'self' 'unsafe-inline' https://js-cdn.music.apple.com"
    : "'self' https://js-cdn.music.apple.com";
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'self'",
      `connect-src ${connectHosts}`,
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "frame-src https://embed.music.apple.com",
      "img-src 'self' data: https://*.mzstatic.com",
      "object-src 'none'",
      `script-src ${scriptSources}`,
      "style-src 'self' 'unsafe-inline'",
      ...(environment === "development" ? [] : ["upgrade-insecure-requests"]),
    ].join("; "),
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...(environment === "production" ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
  };
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

export function withSecurityHeaders(response: Response, environment: SecurityEnvironment): Response {
  if (response.status === 101) return response;
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(securityHeaders(environment))) secured.headers.set(name, value);
  return secured;
}
