import {
  recordPublishAttemptOutcome,
  recordPublishReconciliation,
  publishRecoveryMarker,
  startPublishAttempt,
  type DestinationPublishState,
  type PublishAttemptOutcome,
} from "../lib/publishing/model.ts";
import type { ProviderAdapter } from "../lib/providers/contracts.ts";
import { ConnectorProviderError } from "./errors.ts";
import { adapterFor, providerEnabled } from "./router.ts";
import { D1ConnectorStore } from "./storage.ts";
import type {
  ConnectorEnv,
  ConnectorQueueMessage,
  ConnectorStore,
  PublishJobRecord,
  PublishLeaseResult,
  PublishMutationStage,
  QueueBatchLike,
} from "./types.ts";

const MUTATION_LEASE_MS = 30_000;

export interface PublishQueueDependencies {
  readonly store?: ConnectorStore;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly adapter?: ProviderAdapter;
  readonly randomToken?: () => string;
  /** Test-only crash boundary: runs after provider commit and before local persistence. */
  readonly afterProviderMutation?: (stage: PublishMutationStage) => Promise<void> | void;
}

export type JobDisposition =
  | { readonly kind: "ack" }
  | { readonly kind: "retry"; readonly delaySeconds: number };

function outcomeForFailure(error: ConnectorProviderError, nowMs: number): PublishAttemptOutcome {
  const { failure } = error;
  switch (failure.kind) {
    case "authorization": return { kind: "authorization_expired", safeError: failure.safeMessage };
    case "rate_limit": return { kind: "rate_limited", retryAtMs: failure.retryAtMs ?? nowMs + 60_000 };
    case "ambiguous_write": return { kind: "ambiguous_timeout", safeError: failure.safeMessage };
    case "retryable":
    case "invalid_response": return { kind: "retryable_failure", retryAtMs: nowMs + 60_000, safeError: failure.safeMessage };
    case "permanent": return { kind: "permanent_failure", safeError: failure.safeMessage };
  }
}

function disposition(state: DestinationPublishState, nowMs: number): JobDisposition {
  if (state.phase === "waiting_retry") {
    return { kind: "retry", delaySeconds: Math.max(1, Math.ceil(((state.retryAtMs ?? nowMs) - nowMs) / 1_000)) };
  }
  if (state.phase === "reconcile_before_retry") return { kind: "retry", delaySeconds: 5 };
  return { kind: "ack" };
}

function markerFor(job: PublishJobRecord, stage: PublishMutationStage): string {
  return stage === "create_playlist"
    ? publishRecoveryMarker(job.operationId)
    : `unijam:v1:${stage}:${job.operationId}`;
}

async function saveAndReload(store: ConnectorStore, job: PublishJobRecord): Promise<PublishJobRecord | null> {
  if (!(await store.savePublishJob(job))) return null;
  return store.getPublishJob(job.operationId);
}

async function recoverOrphanedMutation(
  store: ConnectorStore,
  job: PublishJobRecord,
  nowMs: number,
): Promise<JobDisposition> {
  const lease = job.mutationLease;
  if (lease?.expiresAtMs !== undefined && lease.expiresAtMs > nowMs) {
    return { kind: "retry", delaySeconds: Math.max(1, Math.ceil((lease.expiresAtMs - nowMs) / 1_000)) };
  }
  const stage = lease?.stage ?? (job.destinationPlaylistId ? "append_items" : "create_playlist");
  if (stage === "create_playlist" || !job.destinationPlaylistId) {
    const recoveryRequired = {
      code: "PLAYLIST_CREATION_OUTCOME_UNKNOWN" as const,
      marker: lease?.marker ?? markerFor(job, "create_playlist"),
      detectedAtMs: nowMs,
    };
    if (lease) {
      await store.completePublishMutation({ ...job, recoveryRequired, updatedAtMs: nowMs }, lease.token);
    } else {
      await store.savePublishJob({ ...job, recoveryRequired, updatedAtMs: nowMs });
    }
    // Creating another playlist is never an automatic recovery strategy. The
    // persisted marker is surfaced for an operator to locate/attach the result.
    return { kind: "ack" };
  }
  const state = job.state.phase === "in_flight"
    ? recordPublishAttemptOutcome(job.state, { kind: "ambiguous_timeout", safeError: "The previous append outcome is unknown; reconciling before retry" })
    : job.state;
  if (lease) {
    await store.completePublishMutation({ ...job, state, updatedAtMs: nowMs }, lease.token);
  } else {
    await store.savePublishJob({ ...job, state, updatedAtMs: nowMs });
  }
  return { kind: "retry", delaySeconds: 1 };
}

async function acquire(
  store: ConnectorStore,
  job: PublishJobRecord,
  stage: PublishMutationStage,
  state: DestinationPublishState,
  nowMs: number,
  randomToken: () => string,
): Promise<PublishLeaseResult> {
  return store.acquirePublishMutation({
    operationId: job.operationId,
    expectedRevision: job.revision,
    connectionGeneration: job.connectionGeneration,
    lease: {
      token: randomToken(),
      stage,
      acquiredAtMs: nowMs,
      expiresAtMs: nowMs + MUTATION_LEASE_MS,
      marker: markerFor(job, stage),
    },
    state,
    updatedAtMs: nowMs,
  });
}

async function adapterForJob(
  env: ConnectorEnv,
  store: ConnectorStore,
  job: PublishJobRecord,
  dependencies: PublishQueueDependencies,
  now: () => number,
): Promise<ProviderAdapter> {
  return dependencies.adapter ?? adapterFor({
    env,
    store,
    provider: job.provider,
    accountId: job.accountId,
    connectionId: job.connectionId,
    fetcher: dependencies.fetcher,
    now,
  });
}

/** Processes one destination only; mutation leases fence concurrent/redelivered jobs. */
export async function processPublishJob(
  env: ConnectorEnv,
  operationId: string,
  dependencies: PublishQueueDependencies = {},
): Promise<JobDisposition> {
  const now = dependencies.now ?? Date.now;
  const nowMs = now();
  const randomToken = dependencies.randomToken ?? (() => crypto.randomUUID());
  const store = dependencies.store ?? new D1ConnectorStore(env.CONNECTOR_DB);
  let job = await store.getPublishJob(operationId);
  if (!job) return { kind: "ack" };
  if (!providerEnabled(env, job.provider, true)) return { kind: "retry", delaySeconds: 300 };
  if (job.recoveryRequired) return { kind: "ack" };
  if (job.mutationLease || job.state.phase === "in_flight") {
    return recoverOrphanedMutation(store, job, nowMs);
  }

  const context = {
    requestId: `queue:${job.operationId}`,
    provider: job.provider,
    credentialRef: job.connectionId,
    storefront: "US" as const,
  };

  if (!job.destinationPlaylistId) {
    let started = job.state;
    if (started.phase === "confirmed" || started.phase === "waiting_retry") {
      try {
        started = startPublishAttempt(started, nowMs);
      } catch {
        return disposition(started, nowMs);
      }
    }
    if (started.phase !== "in_flight") return disposition(started, nowMs);
    const acquired = await acquire(store, job, "create_playlist", started, nowMs, randomToken);
    if (acquired.kind === "busy") {
      return { kind: "retry", delaySeconds: Math.max(1, Math.ceil((acquired.retryAtMs - nowMs) / 1_000)) };
    }
    if (acquired.kind === "orphaned") return recoverOrphanedMutation(store, acquired.job, nowMs);
    if (acquired.kind !== "acquired") return { kind: "ack" };
    job = acquired.job;
    const lease = job.mutationLease!;
    if (!(await store.validatePublishMutation(job.operationId, lease.token, job.connectionGeneration, now()))) return { kind: "ack" };
    const adapter = await adapterForJob(env, store, job, dependencies, now);
    if (!(await store.validatePublishMutation(job.operationId, lease.token, job.connectionGeneration, now()))) return { kind: "ack" };
    let playlist: Awaited<ReturnType<ProviderAdapter["createPrivatePlaylist"]>>;
    try {
      playlist = await adapter.createPrivatePlaylist(context, job.state.operation.preview.destination);
    } catch (error) {
      const providerError = error instanceof ConnectorProviderError
        ? error
        : new ConnectorProviderError({ kind: "permanent", provider: job.provider, safeMessage: "Playlist creation could not be completed" }, { cause: error });
      if (!(await store.validatePublishMutation(job.operationId, lease.token, job.connectionGeneration, now()))) return { kind: "ack" };
      const state = recordPublishAttemptOutcome(job.state, outcomeForFailure(providerError, now()));
      const recoveryRequired = providerError.failure.kind === "ambiguous_write"
        ? { code: "PLAYLIST_CREATION_OUTCOME_UNKNOWN" as const, marker: lease.marker, detectedAtMs: now() }
        : undefined;
      await store.completePublishMutation({ ...job, state, ...(recoveryRequired ? { recoveryRequired } : {}), updatedAtMs: now() }, lease.token);
      return recoveryRequired ? { kind: "ack" } : disposition(state, now());
    }
    await dependencies.afterProviderMutation?.("create_playlist");
    if (!(await store.validatePublishMutation(job.operationId, lease.token, job.connectionGeneration, now()))) return { kind: "ack" };
    const completed = {
      ...job,
      destinationPlaylistId: playlist.playlistId,
      ...(playlist.destinationUrl ? { destinationUrl: playlist.destinationUrl } : {}),
      updatedAtMs: now(),
    };
    if (!(await store.completePublishMutation(completed, lease.token))) return { kind: "ack" };
    job = (await store.getPublishJob(job.operationId)) ?? completed;
  }

  if (!job.destinationPlaylistId) return { kind: "ack" };
  const destinationPlaylistId = job.destinationPlaylistId;
  let state = job.state;
  let adapter: ProviderAdapter | undefined;
  if (state.phase === "reconcile_before_retry") {
    if (job.reconciliationNotBeforeMs !== undefined && nowMs < job.reconciliationNotBeforeMs) {
      return { kind: "retry", delaySeconds: Math.max(1, Math.ceil((job.reconciliationNotBeforeMs - nowMs) / 1_000)) };
    }
    try {
      adapter = await adapterForJob(env, store, job, dependencies, now);
      const snapshot = await adapter.readPlaylist(context, destinationPlaylistId);
      const observedIds = snapshot.items.map(({ providerRecordingId }) => providerRecordingId);
      if (job.provider === "apple_music") {
        const previous = JSON.stringify(job.lastObservedProviderRecordingIds ?? null);
        const current = JSON.stringify(observedIds);
        if (previous !== current) {
          const saved = await saveAndReload(store, {
            ...job,
            reconciliationAttempts: (job.reconciliationAttempts ?? 0) + 1,
            reconciliationNotBeforeMs: nowMs + 30_000,
            lastObservedProviderRecordingIds: observedIds,
            updatedAtMs: nowMs,
          });
          if (saved) job = saved;
          return { kind: "retry", delaySeconds: 30 };
        }
      }
      state = recordPublishReconciliation(state, observedIds, nowMs);
      const saved = await saveAndReload(store, {
        ...job,
        state,
        reconciliationAttempts: 0,
        reconciliationNotBeforeMs: undefined,
        lastObservedProviderRecordingIds: [],
        updatedAtMs: nowMs,
      });
      if (!saved) return { kind: "ack" };
      job = saved;
      state = job.state;
      if (state.phase === "succeeded") return { kind: "ack" };
    } catch (error) {
      if ((await store.getConnectionGeneration(job.accountId, job.connectionId, job.provider)) !== job.connectionGeneration) {
        return { kind: "ack" };
      }
      if (error instanceof ConnectorProviderError && error.failure.kind === "authorization") {
        const saved = await saveAndReload(store, {
          ...job,
          state: Object.freeze({ ...state, phase: "reconnect", safeError: error.failure.safeMessage }),
          updatedAtMs: now(),
        });
        return saved ? { kind: "ack" } : { kind: "retry", delaySeconds: 1 };
      }
      if (error instanceof ConnectorProviderError && error.failure.kind === "rate_limit") {
        const retryAtMs = error.failure.retryAtMs ?? nowMs + 60_000;
        const saved = await saveAndReload(store, {
          ...job,
          reconciliationNotBeforeMs: retryAtMs,
          updatedAtMs: now(),
        });
        return saved
          ? { kind: "retry", delaySeconds: Math.max(1, Math.ceil((retryAtMs - nowMs) / 1_000)) }
          : { kind: "retry", delaySeconds: 1 };
      }
      if (error instanceof ConnectorProviderError && error.failure.kind === "permanent") {
        const saved = await saveAndReload(store, {
          ...job,
          state: Object.freeze({ ...state, phase: "failed", safeError: error.failure.safeMessage }),
          updatedAtMs: now(),
        });
        return saved ? { kind: "ack" } : { kind: "retry", delaySeconds: 1 };
      }
      return { kind: "retry", delaySeconds: 60 };
    }
  }

  if (state.phase === "confirmed" || state.phase === "waiting_retry") {
    try {
      state = startPublishAttempt(state, nowMs);
    } catch {
      return disposition(state, nowMs);
    }
  } else if (state.phase !== "in_flight") {
    return disposition(state, nowMs);
  }

  const acquired = await acquire(store, job, "append_items", state, nowMs, randomToken);
  if (acquired.kind === "busy") {
    return { kind: "retry", delaySeconds: Math.max(1, Math.ceil((acquired.retryAtMs - nowMs) / 1_000)) };
  }
  if (acquired.kind === "orphaned") return recoverOrphanedMutation(store, acquired.job, nowMs);
  if (acquired.kind !== "acquired") return { kind: "ack" };
  job = acquired.job;
  state = job.state;
  const lease = job.mutationLease!;
  if (!(await store.validatePublishMutation(job.operationId, lease.token, job.connectionGeneration, now()))) return { kind: "ack" };
  adapter ??= await adapterForJob(env, store, job, dependencies, now);
  if (!(await store.validatePublishMutation(job.operationId, lease.token, job.connectionGeneration, now()))) return { kind: "ack" };
  const pending = new Set(state.pendingItemKeys);
  const items = state.operation.preview.items.filter(({ itemKey }) => pending.has(itemKey)).slice(0, 100);
  let receipt: Awaited<ReturnType<ProviderAdapter["appendItems"]>>;
  try {
    receipt = await adapter.appendItems(context, {
      playlistId: destinationPlaylistId,
      providerRecordingIds: items.map(({ providerRecordingId }) => providerRecordingId),
    });
  } catch (error) {
    const providerError = error instanceof ConnectorProviderError
      ? error
      : new ConnectorProviderError({ kind: "permanent", provider: job.provider, safeMessage: "Publishing could not be completed" }, { cause: error });
    if (!(await store.validatePublishMutation(job.operationId, lease.token, job.connectionGeneration, now()))) return { kind: "ack" };
    state = recordPublishAttemptOutcome(state, outcomeForFailure(providerError, now()));
    if (!(await store.completePublishMutation({ ...job, state, updatedAtMs: now() }, lease.token))) return { kind: "ack" };
    return disposition(state, now());
  }
  await dependencies.afterProviderMutation?.("append_items");
  if (!(await store.validatePublishMutation(job.operationId, lease.token, job.connectionGeneration, now()))) return { kind: "ack" };
  state = recordPublishAttemptOutcome(
    state,
    items.length === state.pendingItemKeys.length
      ? { kind: "succeeded", ...(receipt.revisionToken ? { receiptId: receipt.revisionToken } : {}) }
      : { kind: "partial", appliedItemKeys: items.map(({ itemKey }) => itemKey) },
  );
  if (!(await store.completePublishMutation({ ...job, state, updatedAtMs: now() }, lease.token))) return { kind: "ack" };
  return disposition(state, now());
}

export async function handlePublishQueue(
  batch: QueueBatchLike<ConnectorQueueMessage>,
  env: ConnectorEnv,
  dependencies: PublishQueueDependencies = {},
): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    if (message.body.version !== 1 || (message.body.type !== "publish_destination" && message.body.type !== "reconcile_destination")) {
      message.ack();
      return;
    }
    try {
      const result = await processPublishJob(env, message.body.operationId, dependencies);
      if (result.kind === "ack") message.ack();
      else message.retry({ delaySeconds: result.delaySeconds });
    } catch {
      message.retry({ delaySeconds: 60 });
    }
  }));
}
