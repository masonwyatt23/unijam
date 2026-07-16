import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  type D1Migration,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createDestinationPublishState, createPublishPreview, confirmPublishPreview } from "../../lib/publishing/model.ts";
import type { ProviderAdapter } from "../../lib/providers/contracts.ts";
import { handlePublishQueue, processPublishJob } from "../../connectors/queue.ts";
import { D1ConnectorStore } from "../../connectors/storage.ts";
import type { ConnectorEnv, ConnectorQueueMessage, PublishJobRecord } from "../../connectors/types.ts";

interface ConnectorTestEnv extends ConnectorEnv {
  readonly TEST_CONNECTOR_MIGRATIONS: D1Migration[];
}

function testEnv(): ConnectorTestEnv {
  return env as unknown as ConnectorTestEnv;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function queueBatch(operationId: string, attempt: number) {
  return createMessageBatch<ConnectorQueueMessage>("unijam-publishing-test", [{
    id: `delivery-${operationId}-${attempt}`,
    timestamp: new Date(3_000 + attempt),
    attempts: attempt,
    body: { version: 1, type: "publish_destination", operationId },
  }]);
}

function confirmedJob(operationIdSuffix: string): PublishJobRecord {
  const preview = createPublishPreview({
    roomId: `ROOM-${operationIdSuffix}`,
    roomRevision: 1,
    ownerAccountId: "allowed-account",
    provider: "spotify",
    playlistName: "D1 integration",
    items: [{ canonicalRecordingId: "recording-1", providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC" }],
    createdAtMs: 1_000,
  });
  const operation = confirmPublishPreview(preview, {
    previewId: preview.previewId,
    payloadFingerprint: preview.payloadFingerprint,
    confirmedByAccountId: preview.ownerAccountId,
    confirmedAtMs: 2_000,
  });
  return {
    operationId: `${operation.operationId}:${operationIdSuffix}`,
    accountId: preview.ownerAccountId,
    connectionId: "spotify-connection",
    provider: "spotify",
    connectionGeneration: 1,
    revision: 0,
    state: createDestinationPublishState(operation),
    updatedAtMs: 2_000,
  };
}

async function seedJob(suffix: string): Promise<{ store: D1ConnectorStore; job: PublishJobRecord }> {
  const store = new D1ConnectorStore(testEnv().CONNECTOR_DB);
  const initial = confirmedJob(suffix);
  const generation = await store.reserveConnection(initial.accountId, initial.connectionId, initial.provider, 1_500);
  expect(generation).toBeGreaterThan(0);
  const job = { ...initial, connectionGeneration: generation };
  await store.savePublishJob(job);
  expect(await store.getPublishJob(job.operationId)).not.toBeNull();
  return { store, job };
}

beforeEach(async () => {
  await applyD1Migrations(testEnv().CONNECTOR_DB, testEnv().TEST_CONNECTOR_MIGRATIONS);
});

describe("D1-backed connector queue assurance", () => {
  it("serializes concurrent deliveries with one mutation lease and persists the provider URL", async () => {
    const { store, job } = await seedJob("concurrent");
    const entered = deferred();
    const release = deferred();
    let creates = 0;
    let appends = 0;
    const adapter = {
      provider: "spotify",
      async createPrivatePlaylist() {
        creates += 1;
        entered.resolve();
        await release.promise;
        return {
          provider: "spotify",
          playlistId: "playlist-d1-concurrent",
          destinationUrl: "https://open.spotify.com/playlist/playlist-d1-concurrent",
          items: [],
          observedAtMs: 3_000,
        };
      },
      async appendItems() {
        appends += 1;
        return { provider: "spotify", playlistId: "playlist-d1-concurrent", acceptedCount: 1 };
      },
    } as unknown as ProviderAdapter;

    const first = processPublishJob(testEnv(), job.operationId, {
      store,
      adapter,
      now: () => 3_000,
      randomToken: () => "d1-primary-lease",
    });
    await entered.promise;
    const duplicate = await processPublishJob(testEnv(), job.operationId, {
      store,
      adapter,
      now: () => 3_001,
      randomToken: () => "d1-duplicate-lease",
    });
    expect(duplicate).toEqual({ kind: "retry", delaySeconds: 30 });
    expect(creates).toBe(1);
    release.resolve();
    expect(await first).toEqual({ kind: "ack" });
    expect({ creates, appends }).toEqual({ creates: 1, appends: 1 });
    const persisted = await store.getPublishJob(job.operationId);
    expect(persisted?.state.phase).toBe("succeeded");
    expect(persisted?.destinationUrl).toBe("https://open.spotify.com/playlist/playlist-d1-concurrent");
  });

  it("uses real Queue message ack/retry state and never duplicates a create after crash redelivery", async () => {
    const { store, job } = await seedJob("redelivery");
    const providerItems: string[] = [];
    let creates = 0;
    let appends = 0;
    const adapter = {
      provider: "spotify",
      async createPrivatePlaylist() {
        creates += 1;
        return { provider: "spotify", playlistId: "playlist-after-crash", items: [], observedAtMs: 3_000 };
      },
      async readPlaylist() {
        return {
          provider: "spotify",
          playlistId: "playlist-after-crash",
          items: providerItems.map((providerRecordingId, position) => ({ providerRecordingId, position })),
          observedAtMs: 34_001,
        };
      },
      async appendItems(_context: unknown, request: { providerRecordingIds: string[] }) {
        appends += 1;
        providerItems.push(...request.providerRecordingIds);
        return { provider: "spotify", playlistId: "playlist-after-crash", acceptedCount: request.providerRecordingIds.length };
      },
    } as unknown as ProviderAdapter;

    const crashed = queueBatch(job.operationId, 1);
    const crashedContext = createExecutionContext();
    await handlePublishQueue(crashed, testEnv(), {
      store,
      adapter,
      now: () => 3_000,
      randomToken: () => "d1-crashed-create-lease",
      afterProviderMutation: () => { throw new Error("simulated isolate termination"); },
    });
    expect((await getQueueResult(crashed, crashedContext)).retryMessages).toEqual([{ msgId: `delivery-${job.operationId}-1` }]);
    expect(creates).toBe(1);

    const parked = queueBatch(job.operationId, 2);
    const parkedContext = createExecutionContext();
    await handlePublishQueue(parked, testEnv(), { store, adapter, now: () => 34_000 });
    expect((await getQueueResult(parked, parkedContext)).explicitAcks).toEqual([`delivery-${job.operationId}-2`]);
    const recovery = (await store.getPublishJob(job.operationId))?.recoveryRequired;
    expect(recovery?.code).toBe("PLAYLIST_CREATION_OUTCOME_UNKNOWN");
    expect(creates).toBe(1);

    const resolved = await store.recoverPublishPlaylist({
      operationId: job.operationId,
      expectedMarker: recovery!.marker,
      destinationPlaylistId: "playlist-after-crash",
      destinationUrl: "https://open.spotify.com/playlist/playlist-after-crash",
      destinationPlaylistHash: "test-playlist-hash",
      resolvedBy: "integration-test",
      resolvedAtMs: 34_001,
    });
    expect(resolved.kind).toBe("recovered");
    expect((await store.recoverPublishPlaylist({
      operationId: job.operationId,
      expectedMarker: recovery!.marker,
      destinationPlaylistId: "playlist-after-crash",
      destinationUrl: "https://open.spotify.com/playlist/playlist-after-crash",
      destinationPlaylistHash: "test-playlist-hash",
      resolvedBy: "integration-test",
      resolvedAtMs: 34_002,
    })).kind).toBe("already_recovered");

    const reconcileFence = queueBatch(job.operationId, 3);
    const reconcileFenceContext = createExecutionContext();
    await handlePublishQueue(reconcileFence, testEnv(), { store, adapter, now: () => 34_003 });
    expect((await getQueueResult(reconcileFence, reconcileFenceContext)).retryMessages).toEqual([{ msgId: `delivery-${job.operationId}-3` }]);

    const resumed = queueBatch(job.operationId, 4);
    const resumedContext = createExecutionContext();
    await handlePublishQueue(resumed, testEnv(), { store, adapter, now: () => 34_004 });
    expect((await getQueueResult(resumed, resumedContext)).explicitAcks).toEqual([`delivery-${job.operationId}-4`]);
    expect({ creates, appends }).toEqual({ creates: 1, appends: 1 });
    expect((await store.getPublishJob(job.operationId))?.state.phase).toBe("succeeded");
  });

  it("revokes the generation during an in-flight provider write and rejects every stale persistence", async () => {
    const { store, job } = await seedJob("disconnect-fence");
    const entered = deferred();
    const release = deferred();
    let creates = 0;
    const adapter = {
      provider: "spotify",
      async createPrivatePlaylist() {
        creates += 1;
        entered.resolve();
        await release.promise;
        return { provider: "spotify", playlistId: "playlist-revoked", items: [], observedAtMs: 3_000 };
      },
    } as unknown as ProviderAdapter;

    const running = processPublishJob(testEnv(), job.operationId, {
      store,
      adapter,
      now: () => 3_000,
      randomToken: () => "d1-disconnect-lease",
    });
    await entered.promise;
    await store.purgeProviderData(job.accountId, job.connectionId, job.provider, 3_001);
    release.resolve();
    expect(await running).toEqual({ kind: "ack" });
    expect(await store.getPublishJob(job.operationId)).toBeNull();
    expect(await store.getConnectionGeneration(job.accountId, job.connectionId, job.provider)).toBeNull();
    expect(await store.reserveConnection(job.accountId, job.connectionId, job.provider, 3_002)).toBe(3);
    await store.savePublishJob(job);
    expect(await store.getPublishJob(job.operationId)).toBeNull();
    expect(creates).toBe(1);
  });

  it("reports a lost compare-and-swap instead of claiming retry or cancellation was persisted", async () => {
    const { store, job } = await seedJob("control-cas");
    const acquired = await store.acquirePublishMutation({
      operationId: job.operationId,
      expectedRevision: job.revision,
      connectionGeneration: job.connectionGeneration,
      lease: {
        token: "d1-control-lease",
        stage: "create_playlist",
        acquiredAtMs: 3_000,
        expiresAtMs: 33_000,
        marker: "unijam:v1:create_playlist:0123456789abcdef",
      },
      state: job.state,
      updatedAtMs: 3_000,
    });
    expect(acquired.kind).toBe("acquired");
    expect(await store.savePublishJob({ ...job, updatedAtMs: 3_001 })).toBe(false);
    expect((await store.getPublishJob(job.operationId))?.mutationLease?.token).toBe("d1-control-lease");
  });
});
