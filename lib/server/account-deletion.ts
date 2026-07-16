import { hashOpaqueToken } from "./secure-token.ts";
import { accountParticipationDeletionStatements } from "./room-membership.ts";

export const ACCOUNT_DELETION_CONFIRMATION = "DELETE MY UNIJAM ACCOUNT";
export const ACCOUNT_DELETION_RECEIPT_MS = 24 * 60 * 60_000;

export type AccountDeletionStage = "requested" | "provider_purged" | "rooms_purged" | "completed";

export type AccountDeletionRow = {
  account_id: string | null;
  request_key_hash: string;
  status: AccountDeletionStage;
  authorized_at_ms: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
  failure_code: string | null;
};

export type OwnedRoom = { room_id: string };

export class AccountDeletionStepError extends Error {
  readonly step: "provider" | "rooms" | "finalize";

  constructor(step: "provider" | "rooms" | "finalize") {
    super(`Account deletion ${step} step failed`);
    this.step = step;
  }
}

export function normalizeAccountDeletionKey(value: string | null): string {
  const key = value?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{21,127}$/.test(key)) {
    throw new Error("A 22-128 character idempotency key is required");
  }
  return key;
}

export async function accountDeletionKeyHash(key: string): Promise<string> {
  return hashOpaqueToken(`unijam-account-deletion-v1:${key}`);
}

export async function deletionByKey(db: D1Database, keyHash: string): Promise<AccountDeletionRow | null> {
  return db.prepare(
    `SELECT account_id, request_key_hash, status, authorized_at_ms, updated_at_ms, completed_at_ms, failure_code
     FROM account_deletion_requests WHERE request_key_hash = ? LIMIT 1`,
  ).bind(keyHash).first<AccountDeletionRow>();
}

export async function beginAccountDeletion(
  db: D1Database,
  accountId: string,
  keyHash: string,
  now = Date.now(),
): Promise<AccountDeletionRow> {
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO account_deletion_requests
       (account_id, request_key_hash, status, authorized_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'requested', ?, ?, ?)`,
    ).bind(accountId, keyHash, now, now, now),
    db.prepare(
      `UPDATE accounts SET deletion_pending_at_ms = COALESCE(deletion_pending_at_ms, ?), updated_at_ms = ?
       WHERE account_id = ? AND deleted_at_ms IS NULL`,
    ).bind(now, now, accountId),
  ]);
  const row = await db.prepare(
    `SELECT account_id, request_key_hash, status, authorized_at_ms, updated_at_ms, completed_at_ms, failure_code
     FROM account_deletion_requests WHERE account_id = ? LIMIT 1`,
  ).bind(accountId).first<AccountDeletionRow>();
  if (!row || row.request_key_hash !== keyHash) throw new Error("A different account deletion request is already active");
  return row;
}

export async function setAccountDeletionStage(
  db: D1Database,
  accountId: string,
  from: AccountDeletionStage,
  to: AccountDeletionStage,
  now = Date.now(),
): Promise<AccountDeletionRow> {
  await db.prepare(
    `UPDATE account_deletion_requests SET status = ?, updated_at_ms = ?, failure_code = NULL
     WHERE account_id = ? AND status = ?`,
  ).bind(to, now, accountId, from).run();
  const row = await db.prepare(
    `SELECT account_id, request_key_hash, status, authorized_at_ms, updated_at_ms, completed_at_ms, failure_code
     FROM account_deletion_requests WHERE account_id = ? LIMIT 1`,
  ).bind(accountId).first<AccountDeletionRow>();
  if (!row) throw new Error("Account deletion request is missing");
  return row;
}

export async function markAccountDeletionFailure(
  db: D1Database,
  accountId: string,
  failureCode: string,
  now = Date.now(),
): Promise<void> {
  await db.prepare(
    "UPDATE account_deletion_requests SET failure_code = ?, updated_at_ms = ? WHERE account_id = ? AND status != 'completed'",
  ).bind(failureCode, now, accountId).run();
}

export async function ownedRooms(db: D1Database, accountId: string): Promise<OwnedRoom[]> {
  const result = await db.prepare(
    "SELECT room_id FROM room_registry WHERE owner_account_id = ? AND deletion_purged_at_ms IS NULL ORDER BY room_id",
  ).bind(accountId).all<OwnedRoom>();
  return result.results ?? [];
}

export async function markOwnedRoomPurged(
  db: D1Database,
  accountId: string,
  roomId: string,
  now = Date.now(),
): Promise<void> {
  await db.prepare(
    "UPDATE room_registry SET deletion_purged_at_ms = ?, updated_at_ms = ? WHERE room_id = ? AND owner_account_id = ?",
  ).bind(now, now, roomId, accountId).run();
}

export async function finalizeAccountDeletion(
  db: D1Database,
  accountId: string,
  keyHash: string,
  now = Date.now(),
): Promise<void> {
  await db.batch([
    ...accountParticipationDeletionStatements(db, accountId),
    db.prepare("DELETE FROM publish_items WHERE operation_id IN (SELECT operation_id FROM publish_operations WHERE account_id = ?)").bind(accountId),
    db.prepare("DELETE FROM publish_operations WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM provider_match_reviews WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM provider_connections WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM audit_records WHERE account_id = ? OR room_id IN (SELECT room_id FROM room_registry WHERE owner_account_id = ?)").bind(accountId, accountId),
    db.prepare("DELETE FROM room_projection_receipts WHERE room_id IN (SELECT room_id FROM room_registry WHERE owner_account_id = ?)").bind(accountId),
    db.prepare("DELETE FROM room_projections WHERE room_id IN (SELECT room_id FROM room_registry WHERE owner_account_id = ?)").bind(accountId),
    db.prepare("DELETE FROM legacy_room_imports WHERE owner_account_id = ?").bind(accountId),
    db.prepare("DELETE FROM passkey_challenges WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM recovery_codes WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM passkeys WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM host_sessions WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM host_enrollment_codes WHERE used_by_account_id = ?").bind(accountId),
    db.prepare("DELETE FROM room_registry WHERE owner_account_id = ?").bind(accountId),
    db.prepare("DELETE FROM accounts WHERE account_id = ?").bind(accountId),
    db.prepare(
      `UPDATE account_deletion_requests
       SET account_id = NULL, status = 'completed', completed_at_ms = ?, updated_at_ms = ?, failure_code = NULL
       WHERE account_id = ? AND request_key_hash = ? AND status = 'rooms_purged'`,
    ).bind(now, now, accountId, keyHash),
  ]);
  const completed = await db.prepare(
    "SELECT status, account_id FROM account_deletion_requests WHERE request_key_hash = ? LIMIT 1",
  ).bind(keyHash).first<{ status: string; account_id: string | null }>();
  if (completed?.status !== "completed" || completed.account_id !== null) throw new Error("Account deletion did not finalize");
}

export interface AccountDeletionDependencies {
  purgeProviderData(accountId: string): Promise<void>;
  purgeOwnedRooms(accountId: string): Promise<void>;
  setStage(accountId: string, from: AccountDeletionStage, to: AccountDeletionStage): Promise<AccountDeletionRow>;
  finalize(accountId: string): Promise<void>;
}

export async function runAccountDeletion(
  initial: AccountDeletionRow,
  dependencies: AccountDeletionDependencies,
): Promise<AccountDeletionStage> {
  let current = initial;
  if (current.status !== "completed" && !current.account_id) throw new AccountDeletionStepError("finalize");
  const accountId = current.account_id;
  if (!accountId) return "completed";
  if (current.status === "requested") {
    try { await dependencies.purgeProviderData(accountId); }
    catch { throw new AccountDeletionStepError("provider"); }
    current = await dependencies.setStage(accountId, "requested", "provider_purged");
  }
  if (current.status === "provider_purged") {
    try { await dependencies.purgeOwnedRooms(accountId); }
    catch { throw new AccountDeletionStepError("rooms"); }
    current = await dependencies.setStage(accountId, "provider_purged", "rooms_purged");
  }
  if (current.status === "rooms_purged") {
    try { await dependencies.finalize(accountId); }
    catch { throw new AccountDeletionStepError("finalize"); }
    return "completed";
  }
  return current.status;
}
