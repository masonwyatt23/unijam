import assert from "node:assert/strict";
import test from "node:test";

import { rateLimitWindow } from "./rate-limit.ts";

test("rate-limit windows are stable and return a bounded retry delay", () => {
  assert.deepEqual(rateLimitWindow(61_250, 60_000), {
    bucketStartMs: 60_000,
    expiresAtMs: 180_000,
    retryAfterSeconds: 59,
  });
  assert.equal(rateLimitWindow(119_999, 60_000).retryAfterSeconds, 1);
});
