import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountDeletionStepError,
  normalizeAccountDeletionKey,
  runAccountDeletion,
  type AccountDeletionRow,
  type AccountDeletionStage,
} from "./account-deletion.ts";

const row = (status: AccountDeletionStage): AccountDeletionRow => ({
  account_id: status === "completed" ? null : "account_delete_test_01",
  request_key_hash: "hashed-idempotency-key",
  status,
  authorized_at_ms: 1_000,
  updated_at_ms: 1_000,
  completed_at_ms: status === "completed" ? 2_000 : null,
  failure_code: null,
});

test("account deletion accepts only bounded opaque idempotency keys", () => {
  assert.equal(normalizeAccountDeletionKey("  delete-account-key-001  "), "delete-account-key-001");
  assert.throws(() => normalizeAccountDeletionKey("too-short"));
  assert.throws(() => normalizeAccountDeletionKey("x".repeat(129)));
  assert.throws(() => normalizeAccountDeletionKey("delete account key with spaces"));
});

test("account deletion purges providers, room authorities, then identity data", async () => {
  const calls: string[] = [];
  const status = await runAccountDeletion(row("requested"), {
    purgeProviderData: async (accountId) => { calls.push(`provider:${accountId}`); },
    purgeOwnedRooms: async (accountId) => { calls.push(`rooms:${accountId}`); },
    setStage: async (accountId, _from, to) => {
      calls.push(`stage:${to}`);
      return { ...row(to), account_id: accountId };
    },
    finalize: async (accountId) => { calls.push(`finalize:${accountId}`); },
  });

  assert.equal(status, "completed");
  assert.deepEqual(calls, [
    "provider:account_delete_test_01",
    "stage:provider_purged",
    "rooms:account_delete_test_01",
    "stage:rooms_purged",
    "finalize:account_delete_test_01",
  ]);
});

test("account deletion resumes from its durable stage without replaying completed steps", async () => {
  const calls: string[] = [];
  await runAccountDeletion(row("provider_purged"), {
    purgeProviderData: async () => { calls.push("provider"); },
    purgeOwnedRooms: async () => { calls.push("rooms"); },
    setStage: async (accountId, _from, to) => ({ ...row(to), account_id: accountId }),
    finalize: async () => { calls.push("finalize"); },
  });
  assert.deepEqual(calls, ["rooms", "finalize"]);

  calls.length = 0;
  assert.equal(await runAccountDeletion(row("completed"), {
    purgeProviderData: async () => { calls.push("provider"); },
    purgeOwnedRooms: async () => { calls.push("rooms"); },
    setStage: async () => { throw new Error("not called"); },
    finalize: async () => { calls.push("finalize"); },
  }), "completed");
  assert.deepEqual(calls, []);
});

test("account deletion fails closed at provider and room boundaries", async () => {
  const afterProvider: string[] = [];
  await assert.rejects(
    runAccountDeletion(row("requested"), {
      purgeProviderData: async () => { throw new Error("provider unavailable"); },
      purgeOwnedRooms: async () => { afterProvider.push("rooms"); },
      setStage: async () => { throw new Error("not called"); },
      finalize: async () => { afterProvider.push("finalize"); },
    }),
    (error) => error instanceof AccountDeletionStepError && error.step === "provider",
  );
  assert.deepEqual(afterProvider, []);

  const afterRooms: string[] = [];
  await assert.rejects(
    runAccountDeletion(row("provider_purged"), {
      purgeProviderData: async () => { afterRooms.push("provider"); },
      purgeOwnedRooms: async () => { throw new Error("room unavailable"); },
      setStage: async () => { throw new Error("not called"); },
      finalize: async () => { afterRooms.push("finalize"); },
    }),
    (error) => error instanceof AccountDeletionStepError && error.step === "rooms",
  );
  assert.deepEqual(afterRooms, []);
});

test("an incomplete deletion receipt without an account identifier fails closed", async () => {
  await assert.rejects(
    runAccountDeletion({ ...row("rooms_purged"), account_id: null }, {
      purgeProviderData: async () => undefined,
      purgeOwnedRooms: async () => undefined,
      setStage: async () => row("rooms_purged"),
      finalize: async () => undefined,
    }),
    (error) => error instanceof AccountDeletionStepError && error.step === "finalize",
  );
});
