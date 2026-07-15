import { apiError } from "@/lib/server/api-response";

// The outer Worker intercepts upgrades before Vinext. Keeping this route makes
// unsupported HTTP access explicit and documents the public endpoint.
export async function GET(): Promise<Response> {
  return apiError("WEBSOCKET_UPGRADE_REQUIRED", "Open this endpoint with a WebSocket upgrade", 426, true);
}
