import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CATALOG_RESOLUTION_PARTICIPANT_LIMIT,
  CATALOG_RESOLUTION_ROOM_LIMIT,
  catalogResolutionRateLimitResponse,
  withCatalogResolutionBudget,
} from "../../lib/server/catalog-resolution-rate-limit.ts";

function database(): D1Database {
  if (!env.DB) throw new Error("DB test binding is missing");
  return env.DB;
}

async function allow(
  identity: { roomId: string; participantId: string; sessionId: string },
  counters: { connector: number; canonicalWrite: number; registrationWrite: number },
  now = 1_784_220_000_000,
) {
  return withCatalogResolutionBudget(database(), { ...identity, now }, async () => {
    counters.connector += 1;
    counters.canonicalWrite += 1;
    counters.registrationWrite += 1;
    return "resolved";
  });
}

describe.sequential("catalog resolution budgets", () => {
  beforeAll(async () => {
    await database().prepare(`CREATE TABLE IF NOT EXISTS room_rate_buckets (
      scope TEXT NOT NULL,
      bucket_start_ms INTEGER NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      expires_at_ms INTEGER NOT NULL
    )`).run();
    await database().prepare(`CREATE UNIQUE INDEX IF NOT EXISTS room_rate_buckets_scope_window_idx
      ON room_rate_buckets (scope, bucket_start_ms)`).run();
  });

  it("stops connector and persistence work at the participant limit without affecting another participant or room", async () => {
    const suffix = crypto.randomUUID();
    const identity = { roomId: `ROOMA-${suffix}`, participantId: "participant-a", sessionId: "session-a" };
    const counters = { connector: 0, canonicalWrite: 0, registrationWrite: 0 };
    for (let index = 0; index < CATALOG_RESOLUTION_PARTICIPANT_LIMIT; index += 1) {
      expect(await allow(identity, counters)).toEqual({ allowed: true, value: "resolved" });
    }

    const beforeDenied = { ...counters };
    const denied = await allow(identity, counters);
    expect(denied).toMatchObject({
      allowed: false,
      scope: "participant",
      limit: CATALOG_RESOLUTION_PARTICIPANT_LIMIT,
    });
    expect(counters).toEqual(beforeDenied);
    if (denied.allowed) throw new Error("expected participant budget denial");
    const response = catalogResolutionRateLimitResponse(denied);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(String(denied.retryAfterSeconds));
    expect(await response.json()).toMatchObject({
      data: null,
      error: { code: "RESOLUTION_RATE_LIMITED", retryable: true },
    });

    // A limited session cannot burn through the room-wide budget by retrying.
    for (let index = 0; index < CATALOG_RESOLUTION_ROOM_LIMIT; index += 1) {
      expect((await allow(identity, counters)).allowed).toBe(false);
    }
    expect(counters).toEqual(beforeDenied);

    expect(await allow({ ...identity, participantId: "participant-b", sessionId: "session-b" }, counters))
      .toEqual({ allowed: true, value: "resolved" });
    expect(await allow({ ...identity, roomId: `ROOMB-${suffix}` }, counters))
      .toEqual({ allowed: true, value: "resolved" });
  });

  it("stops all downstream work at the aggregate room limit while leaving another room independent", async () => {
    const suffix = crypto.randomUUID();
    const roomId = `ROOMC-${suffix}`;
    const counters = { connector: 0, canonicalWrite: 0, registrationWrite: 0 };
    for (let index = 0; index < CATALOG_RESOLUTION_ROOM_LIMIT; index += 1) {
      const participant = Math.floor(index / CATALOG_RESOLUTION_PARTICIPANT_LIMIT);
      const identity = {
        roomId,
        participantId: `participant-${participant}`,
        sessionId: `session-${participant}`,
      };
      expect((await allow(identity, counters)).allowed).toBe(true);
    }

    const beforeDenied = { ...counters };
    const denied = await allow({ roomId, participantId: "participant-new", sessionId: "session-new" }, counters);
    expect(denied).toMatchObject({
      allowed: false,
      scope: "room",
      limit: CATALOG_RESOLUTION_ROOM_LIMIT,
    });
    expect(counters).toEqual(beforeDenied);

    expect(await allow({ roomId: `ROOMD-${suffix}`, participantId: "participant-new", sessionId: "session-new" }, counters))
      .toEqual({ allowed: true, value: "resolved" });
  });
});
