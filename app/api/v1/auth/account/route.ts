import { env } from "cloudflare:workers";

import {
  ACCOUNT_DELETION_CONFIRMATION,
  AccountDeletionStepError,
  accountDeletionKeyHash,
  beginAccountDeletion,
  deletionByKey,
  finalizeAccountDeletion,
  markOwnedRoomPurged,
  markAccountDeletionFailure,
  normalizeAccountDeletionKey,
  ownedRooms,
  runAccountDeletion,
  setAccountDeletionStage,
} from "@/lib/server/account-deletion";
import { apiError, apiResponse } from "@/lib/server/api-response";
import { connectorJsonRequest, type ConnectorProxyEnv } from "@/lib/server/connector-proxy";
import { authenticateHost, isRecentPasskey } from "@/lib/server/host-session";
import { actorHeaders, roomStub, type RoomAuthorityEnv } from "@/lib/server/room-authority";
import { clearSessionCookie, HOST_SESSION_COOKIE } from "@/lib/server/session-cookie";

const completedResponse = (duplicate: boolean) => apiResponse(
  { deleted: true, duplicate },
  { headers: { "Set-Cookie": clearSessionCookie(HOST_SESSION_COOKIE) } },
);

export async function DELETE(request: Request): Promise<Response> {
  const db = env.DB;
  if (!db || !env.ROOM_OBJECTS || !env.CONNECTORS) {
    return apiError("ACCOUNT_DELETION_UNAVAILABLE", "Account deletion is temporarily unavailable", 503, true);
  }
  let confirmation: unknown;
  let key: string;
  try {
    const body = await request.json() as { confirmation?: unknown };
    confirmation = body.confirmation;
    key = normalizeAccountDeletionKey(request.headers.get("Idempotency-Key"));
  } catch {
    return apiError("ACCOUNT_DELETION_REQUEST_INVALID", "A valid confirmation and idempotency key are required", 400);
  }
  if (confirmation !== ACCOUNT_DELETION_CONFIRMATION) {
    return apiError("ACCOUNT_DELETION_CONFIRMATION_REQUIRED", `Type ${ACCOUNT_DELETION_CONFIRMATION} to delete this account`, 400);
  }

  const keyHash = await accountDeletionKeyHash(key);
  let deletion = await deletionByKey(db, keyHash);
  if (deletion?.status === "completed") return completedResponse(true);

  const host = await authenticateHost(db, request, { allowDeletionPending: true });
  if (!host || !isRecentPasskey(host) || (deletion && deletion.account_id !== host.account_id)) {
    return apiError("RECENT_PASSKEY_REQUIRED", "Confirm a passkey before deleting this account", 403);
  }
  if (!deletion) {
    try { deletion = await beginAccountDeletion(db, host.account_id, keyHash); }
    catch {
      return apiError("ACCOUNT_DELETION_IN_PROGRESS", "A different account deletion request is already in progress", 409, true);
    }
  }

  const runtime = env as RoomAuthorityEnv & ConnectorProxyEnv;
  try {
    const status = await runAccountDeletion(deletion, {
      purgeProviderData: async (accountId) => {
        const response = await connectorJsonRequest(runtime, "/v1/accounts/purge", { accountId });
        if (!response.ok) throw new Error("Provider purge failed");
      },
      purgeOwnedRooms: async (accountId) => {
        for (const room of await ownedRooms(db, accountId)) {
          const headers = actorHeaders({ participantId: accountId, role: "host", nickname: "Account owner" }, room.room_id);
          headers.set("X-UniJam-Account-Deletion", "true");
          const response = await roomStub(runtime, room.room_id).fetch(new Request("https://room.internal/internal/account-delete", {
            method: "POST",
            headers,
          }));
          if (!response.ok) throw new Error("Room purge failed");
          await markOwnedRoomPurged(db, accountId, room.room_id);
        }
      },
      setStage: (accountId, from, to) => setAccountDeletionStage(db, accountId, from, to),
      finalize: (accountId) => finalizeAccountDeletion(db, accountId, keyHash),
    });
    if (status !== "completed") throw new AccountDeletionStepError("finalize");
    return completedResponse(false);
  } catch (error) {
    const step = error instanceof AccountDeletionStepError ? error.step : "finalize";
    const code = step === "provider" ? "ACCOUNT_DELETION_PROVIDER_PURGE_FAILED"
      : step === "rooms" ? "ACCOUNT_DELETION_ROOM_PURGE_FAILED"
        : "ACCOUNT_DELETION_FINALIZATION_FAILED";
    await markAccountDeletionFailure(db, host.account_id, code).catch(() => undefined);
    return apiError(code, "Account deletion could not finish safely; retry with the same idempotency key", 503, true);
  }
}
