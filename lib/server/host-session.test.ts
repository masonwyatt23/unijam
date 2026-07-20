import assert from "node:assert/strict";
import test from "node:test";

import { canEnrollRecoveryPasskey, isRecentPasskey, passkeyVerifiedAt, type HostSession } from "./host-session.ts";

const now = 1_800_000_000_000;
const session = (passkeyVerified: number | null): HostSession => ({
  session_id: "session", account_id: "account", display_name: "Host",
  authenticated_at_ms: now, passkey_verified_at_ms: passkeyVerified, expires_at_ms: now + 60_000,
  recovery_enrollment_expires_at_ms: passkeyVerified === null ? now + 60_000 : null,
  recovery_enrollment_consumed_at_ms: null,
});

test("recovery authentication never satisfies recent-passkey policy", () => {
  assert.equal(passkeyVerifiedAt("recovery", now), null);
  assert.equal(isRecentPasskey(session(null), now), false);
  assert.equal(isRecentPasskey(session(passkeyVerifiedAt("passkey", now)), now), true);
  assert.equal(canEnrollRecoveryPasskey(session(null), now), true);
  assert.equal(canEnrollRecoveryPasskey({ ...session(null), recovery_enrollment_consumed_at_ms: now }, now), false);
});
