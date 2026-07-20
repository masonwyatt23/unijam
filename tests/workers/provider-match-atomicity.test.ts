import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { stableRecordingIdentity } from "../../lib/server/catalog-resolution.ts";
import {
  persistCanonicalRecordingMatches,
  ProviderMatchConflictError,
} from "../../lib/server/provider-match.ts";

type CapturedStatement = {
  readonly sql: string;
  readonly bindings: readonly unknown[];
};

function database(): D1Database {
  if (!env.DB) throw new Error("DB test binding is missing");
  return env.DB;
}

async function resetSchema(): Promise<D1Database> {
  const db = database();
  await db.batch([
    db.prepare("DROP TABLE IF EXISTS provider_match_reviews"),
    db.prepare("DROP TABLE IF EXISTS provider_matches"),
    db.prepare("DROP TABLE IF EXISTS canonical_recordings"),
    db.prepare(`CREATE TABLE canonical_recordings (
  recording_id TEXT PRIMARY KEY NOT NULL,
  isrc TEXT,
  normalized_title TEXT NOT NULL,
  normalized_artist TEXT NOT NULL,
  album TEXT,
  duration_ms INTEGER,
  explicit INTEGER,
  version_label TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
)`),
    db.prepare(`CREATE TABLE provider_matches (
  match_id TEXT PRIMARY KEY NOT NULL,
  recording_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  storefront TEXT DEFAULT 'us' NOT NULL,
  provider_recording_id TEXT NOT NULL,
  method TEXT NOT NULL,
  confidence_basis_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
)`),
    db.prepare(`CREATE UNIQUE INDEX provider_matches_recording_provider_idx
  ON provider_matches (recording_id, provider, storefront)`),
    db.prepare(`CREATE TABLE provider_match_reviews (
  review_id TEXT PRIMARY KEY NOT NULL,
  match_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
)`),
  ]);
  return db;
}

/**
 * Hides an already-committed slot winner until batch execution. This models a
 * competing writer winning after the preflight reads while retaining real D1
 * transactional behavior for the batch itself.
 */
function providerSlotRaceDatabase(real: D1Database): D1Database {
  let batchStarted = false;
  return {
    prepare(sql: string) {
      let bindings: readonly unknown[] = [];
      const statement = {
        sql,
        get bindings() { return bindings; },
        bind(...values: unknown[]) { bindings = values; return statement; },
        async first<T>() {
          if (!batchStarted && sql.includes("FROM provider_matches")) return null;
          return real.prepare(sql).bind(...bindings).first<T>();
        },
      };
      return statement;
    },
    async batch<T>(statements: D1PreparedStatement[]) {
      batchStarted = true;
      return real.batch<T>(statements.map((statement) => {
        const captured = statement as unknown as CapturedStatement;
        return real.prepare(captured.sql).bind(...captured.bindings);
      }));
    },
  } as unknown as D1Database;
}

describe.sequential("provider-match D1 atomicity", () => {
  beforeEach(async () => { await resetSchema(); });

  it("rolls canonical metadata back when another provider ID wins the slot race", async () => {
    const db = database();
    const candidate = {
      provider: "apple_music" as const,
      providerRecordingId: "new-apple-recording",
      title: "Losing Metadata",
      artists: ["Race Artist"],
      isrc: "USABC2600001",
      storefronts: ["US"],
    };
    const { recordingId } = await stableRecordingIdentity(candidate);
    const now = Date.now();
    await db.batch([
      db.prepare(
        `INSERT INTO canonical_recordings
         (recording_id, isrc, normalized_title, normalized_artist, album, duration_ms, explicit, version_label, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'winning metadata', 'race artist', NULL, NULL, NULL, NULL, ?, ?)`,
      ).bind(recordingId, candidate.isrc, now, now),
      db.prepare(
        `INSERT INTO provider_matches
         (match_id, recording_id, provider, storefront, provider_recording_id, method, confidence_basis_json, status, created_at_ms, updated_at_ms)
         VALUES ('match_existing_winner', ?, 'apple_music', 'us', 'winning-apple-recording', 'metadata', '{}', 'matched', ?, ?)`,
      ).bind(recordingId, now, now),
    ]);

    await expect(persistCanonicalRecordingMatches({
      db: providerSlotRaceDatabase(db),
      candidate,
      primary: { method: "metadata", evidence: ["metadata_score"], deterministic: true },
    })).rejects.toBeInstanceOf(ProviderMatchConflictError);

    const canonical = await db.prepare(
      "SELECT normalized_title, normalized_artist, updated_at_ms FROM canonical_recordings WHERE recording_id = ?",
    ).bind(recordingId).first<{ normalized_title: string; normalized_artist: string; updated_at_ms: number }>();
    expect(canonical).toEqual({
      normalized_title: "winning metadata",
      normalized_artist: "race artist",
      updated_at_ms: now,
    });
    const edge = await db.prepare(
      "SELECT provider_recording_id FROM provider_matches WHERE recording_id = ? AND provider = 'apple_music'",
    ).bind(recordingId).first<{ provider_recording_id: string }>();
    expect(edge?.provider_recording_id).toBe("winning-apple-recording");
  });
});
