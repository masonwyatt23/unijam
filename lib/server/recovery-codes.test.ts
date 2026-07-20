import assert from "node:assert/strict";
import test from "node:test";

import { RECOVERY_CODE_LOOKUP_SQL } from "./recovery-codes.ts";

test("recovery lookup targets the indexed hash without a global scan", () => {
  assert.match(RECOVERY_CODE_LOOKUP_SQL, /WHERE code_hash = \?/);
  assert.doesNotMatch(RECOVERY_CODE_LOOKUP_SQL, /LIMIT 100/);
});
