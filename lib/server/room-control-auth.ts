import { authenticateHost, isRecentPasskey, type HostSession } from "./host-session.ts";
import { getRoomRegistry, type RoomAuthorityEnv } from "./room-authority.ts";
import { roomStub } from "./room-authority.ts";

export async function authorizeRoomOwner(
  env: RoomAuthorityEnv,
  request: Request,
  roomId: string,
  recentPasskey = false,
): Promise<HostSession | null> {
  const host = await authenticateHost(env.DB, request);
  if (!host || recentPasskey && !isRecentPasskey(host)) return null;
  const registry = await getRoomRegistry(env.DB, roomId);
  return registry?.owner_account_id === host.account_id ? host : null;
}

export async function canonicalRoomSnapshot(env: RoomAuthorityEnv, roomId: string): Promise<Record<string, unknown>> {
  const response = await roomStub(env, roomId).fetch(new Request("https://room.internal/state?after=0"));
  if (!response.ok) throw new Error("Canonical room state is unavailable");
  const body = await response.json() as { snapshot?: Record<string, unknown> };
  if (!body.snapshot) throw new Error("Canonical room state is unavailable");
  return body.snapshot;
}
