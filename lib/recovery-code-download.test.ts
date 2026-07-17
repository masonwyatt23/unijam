import assert from "node:assert/strict";
import test from "node:test";

import { formatRecoveryCodeFile, RECOVERY_CODE_FILENAME } from "./recovery-code-download.ts";

test("formats every recovery code once in a generic plain-text download", () => {
  const codes = Array.from({ length: 10 }, (_, index) => `TEST-CODE-${index}`);
  const file = formatRecoveryCodeFile(codes);

  assert.equal(RECOVERY_CODE_FILENAME, "unijam-recovery-codes.txt");
  assert.match(file, /^UNIJAM RECOVERY CODES\n\n/);
  assert.match(file, /01\. TEST-CODE-0/);
  assert.match(file, /10\. TEST-CODE-9/);
  for (const code of codes) assert.equal(file.split(code).length - 1, 1);
  assert.doesNotMatch(file, /Mason|@/i);
});
