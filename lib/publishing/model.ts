import type { MusicProvider } from "../provider-state-engine.ts";

export interface PublishPreviewItemInput {
  readonly canonicalRecordingId: string;
  readonly providerRecordingId: string;
}

export interface PublishPreviewItem extends PublishPreviewItemInput {
  readonly position: number;
  readonly itemKey: string;
}

export interface PublishDestinationPreview {
  readonly kind: "new_private_playlist";
  readonly name: string;
  readonly description: string;
}

export interface PublishPreview {
  readonly previewId: string;
  readonly payloadFingerprint: string;
  readonly roomId: string;
  readonly roomRevision: number;
  readonly ownerAccountId: string;
  readonly provider: MusicProvider;
  readonly destination: PublishDestinationPreview;
  readonly items: readonly PublishPreviewItem[];
  readonly createdAtMs: number;
}

export interface CreatePublishPreviewInput {
  readonly roomId: string;
  readonly roomRevision: number;
  readonly ownerAccountId: string;
  readonly provider: MusicProvider;
  readonly playlistName: string;
  readonly playlistDescription?: string;
  readonly items: readonly PublishPreviewItemInput[];
  readonly createdAtMs: number;
}

export interface PublishConfirmation {
  readonly previewId: string;
  readonly payloadFingerprint: string;
  readonly confirmedByAccountId: string;
  readonly confirmedAtMs: number;
}

export interface ConfirmedPublishOperation {
  readonly operationId: string;
  readonly preview: PublishPreview;
  readonly confirmedAtMs: number;
}

export type PublishOperationPhase =
  | "confirmed"
  | "in_flight"
  | "reconcile_before_retry"
  | "waiting_retry"
  | "reconnect"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface DestinationPublishState {
  readonly operation: ConfirmedPublishOperation;
  readonly phase: PublishOperationPhase;
  readonly attempt: number;
  readonly appliedItemKeys: readonly string[];
  readonly pendingItemKeys: readonly string[];
  readonly retryAtMs?: number;
  readonly safeError?: string;
  readonly receiptId?: string;
}

export type PublishAttemptOutcome =
  | { readonly kind: "succeeded"; readonly receiptId?: string }
  | { readonly kind: "partial"; readonly appliedItemKeys: readonly string[] }
  | { readonly kind: "ambiguous_timeout"; readonly safeError: string }
  | { readonly kind: "rate_limited"; readonly retryAtMs: number }
  | { readonly kind: "authorization_expired"; readonly safeError: string }
  | { readonly kind: "retryable_failure"; readonly retryAtMs: number; readonly safeError: string }
  | { readonly kind: "permanent_failure"; readonly safeError: string };

function requireValue(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

function keyPart(value: string): string {
  return encodeURIComponent(value);
}

function validTime(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

/** Builds a stable, immutable destination preview; confirmation cannot alter it. */
export function createPublishPreview(input: CreatePublishPreviewInput): PublishPreview {
  const roomId = requireValue(input.roomId, "roomId");
  const ownerAccountId = requireValue(input.ownerAccountId, "ownerAccountId");
  const name = requireValue(input.playlistName, "playlistName");
  validTime(input.createdAtMs, "createdAtMs");
  if (!Number.isSafeInteger(input.roomRevision) || input.roomRevision < 0) {
    throw new Error("roomRevision must be a non-negative safe integer");
  }
  if (input.items.length === 0) throw new Error("publish preview requires at least one item");

  const previewId = [
    "preview",
    input.provider,
    keyPart(roomId),
    `r${input.roomRevision}`,
    keyPart(ownerAccountId),
  ].join(":");
  const canonicalIds = new Set<string>();
  const providerIds = new Set<string>();
  const items = input.items.map((item, position): PublishPreviewItem => {
    const canonicalRecordingId = requireValue(item.canonicalRecordingId, `items[${position}].canonicalRecordingId`);
    const providerRecordingId = requireValue(item.providerRecordingId, `items[${position}].providerRecordingId`);
    if (canonicalIds.has(canonicalRecordingId)) throw new Error(`duplicate canonical recording: ${canonicalRecordingId}`);
    if (providerIds.has(providerRecordingId)) throw new Error(`duplicate provider recording: ${providerRecordingId}`);
    canonicalIds.add(canonicalRecordingId);
    providerIds.add(providerRecordingId);
    return Object.freeze({
      canonicalRecordingId,
      providerRecordingId,
      position,
      itemKey: `${previewId}:item:${position}:${keyPart(canonicalRecordingId)}:${keyPart(providerRecordingId)}`,
    });
  });
  const description = input.playlistDescription?.trim() ?? "Created by UniJam";
  const payloadFingerprint = [
    "v1",
    previewId,
    keyPart(name),
    keyPart(description),
    ...items.map((item) => `${item.position}:${keyPart(item.canonicalRecordingId)}:${keyPart(item.providerRecordingId)}`),
  ].join("|");
  return Object.freeze({
    previewId,
    payloadFingerprint,
    roomId,
    roomRevision: input.roomRevision,
    ownerAccountId,
    provider: input.provider,
    destination: Object.freeze({ kind: "new_private_playlist", name, description }),
    items: Object.freeze(items),
    createdAtMs: input.createdAtMs,
  });
}

export function confirmPublishPreview(
  preview: PublishPreview,
  confirmation: PublishConfirmation,
): ConfirmedPublishOperation {
  validTime(confirmation.confirmedAtMs, "confirmedAtMs");
  if (confirmation.confirmedAtMs < preview.createdAtMs) throw new Error("confirmation predates publish preview");
  if (confirmation.previewId !== preview.previewId) throw new Error("preview ID mismatch");
  if (confirmation.payloadFingerprint !== preview.payloadFingerprint) throw new Error("publish preview changed after review");
  if (confirmation.confirmedByAccountId !== preview.ownerAccountId) throw new Error("publish preview must be confirmed by its owner");
  return Object.freeze({
    operationId: preview.previewId.replace(/^preview:/, "publish:"),
    preview,
    confirmedAtMs: confirmation.confirmedAtMs,
  });
}

export function createDestinationPublishState(
  operation: ConfirmedPublishOperation,
): DestinationPublishState {
  return Object.freeze({
    operation,
    phase: "confirmed",
    attempt: 0,
    appliedItemKeys: Object.freeze([]),
    pendingItemKeys: Object.freeze(operation.preview.items.map(({ itemKey }) => itemKey)),
  });
}

export function startPublishAttempt(
  state: DestinationPublishState,
  atMs: number,
): DestinationPublishState {
  validTime(atMs, "atMs");
  if (atMs < state.operation.confirmedAtMs) throw new Error("publish attempt predates confirmation");
  if (state.phase !== "confirmed" && state.phase !== "waiting_retry") {
    throw new Error(`cannot start publish attempt from ${state.phase}`);
  }
  if (state.retryAtMs !== undefined && atMs < state.retryAtMs) throw new Error("publish retry is not due");
  return Object.freeze({ ...state, phase: "in_flight", attempt: state.attempt + 1, retryAtMs: undefined, safeError: undefined });
}

function validateItemKeys(state: DestinationPublishState, keys: readonly string[]): void {
  const valid = new Set(state.operation.preview.items.map(({ itemKey }) => itemKey));
  if (keys.some((key) => !valid.has(key))) throw new Error("outcome contains an unknown publish item key");
}

export function recordPublishAttemptOutcome(
  state: DestinationPublishState,
  outcome: PublishAttemptOutcome,
): DestinationPublishState {
  if (state.phase !== "in_flight") throw new Error("publish outcome requires an in-flight attempt");
  switch (outcome.kind) {
    case "succeeded": {
      const all = Object.freeze(state.operation.preview.items.map(({ itemKey }) => itemKey));
      return Object.freeze({ ...state, phase: "succeeded", appliedItemKeys: all, pendingItemKeys: Object.freeze([]), ...(outcome.receiptId ? { receiptId: outcome.receiptId } : {}) });
    }
    case "partial": {
      validateItemKeys(state, outcome.appliedItemKeys);
      const applied = new Set([...state.appliedItemKeys, ...outcome.appliedItemKeys]);
      return Object.freeze({
        ...state,
        phase: "reconcile_before_retry",
        appliedItemKeys: Object.freeze(state.operation.preview.items.map(({ itemKey }) => itemKey).filter((key) => applied.has(key))),
        pendingItemKeys: Object.freeze(state.operation.preview.items.map(({ itemKey }) => itemKey).filter((key) => !applied.has(key))),
      });
    }
    case "ambiguous_timeout":
      return Object.freeze({ ...state, phase: "reconcile_before_retry", safeError: requireValue(outcome.safeError, "safeError") });
    case "rate_limited":
      validTime(outcome.retryAtMs, "retryAtMs");
      return Object.freeze({ ...state, phase: "waiting_retry", retryAtMs: outcome.retryAtMs });
    case "authorization_expired":
      return Object.freeze({ ...state, phase: "reconnect", safeError: requireValue(outcome.safeError, "safeError") });
    case "retryable_failure":
      validTime(outcome.retryAtMs, "retryAtMs");
      return Object.freeze({ ...state, phase: "waiting_retry", retryAtMs: outcome.retryAtMs, safeError: requireValue(outcome.safeError, "safeError") });
    case "permanent_failure":
      return Object.freeze({ ...state, phase: "failed", safeError: requireValue(outcome.safeError, "safeError") });
  }
}

/** Applies a provider read after a partial/ambiguous write before any retry. */
export function recordPublishReconciliation(
  state: DestinationPublishState,
  observedProviderRecordingIds: readonly string[],
  retryAtMs: number,
): DestinationPublishState {
  if (state.phase !== "reconcile_before_retry") throw new Error("reconciliation was not required");
  validTime(retryAtMs, "retryAtMs");
  const observed = new Set(observedProviderRecordingIds);
  const appliedItemKeys = state.operation.preview.items
    .filter(({ providerRecordingId }) => observed.has(providerRecordingId))
    .map(({ itemKey }) => itemKey);
  const applied = new Set(appliedItemKeys);
  const pendingItemKeys = state.operation.preview.items
    .map(({ itemKey }) => itemKey)
    .filter((itemKey) => !applied.has(itemKey));
  if (pendingItemKeys.length === 0) {
    return Object.freeze({ ...state, phase: "succeeded", appliedItemKeys: Object.freeze(appliedItemKeys), pendingItemKeys: Object.freeze([]), safeError: undefined });
  }
  return Object.freeze({ ...state, phase: "waiting_retry", appliedItemKeys: Object.freeze(appliedItemKeys), pendingItemKeys: Object.freeze(pendingItemKeys), retryAtMs, safeError: undefined });
}

export function cancelPublishOperation(state: DestinationPublishState): DestinationPublishState {
  if (state.phase === "succeeded" || state.phase === "cancelled") return state;
  return Object.freeze({ ...state, phase: "cancelled", retryAtMs: undefined });
}

/** Records an explicit owner retry after reconnect or a visible failure. */
export function requestPublishRetry(
  state: DestinationPublishState,
  retryAtMs: number,
): DestinationPublishState {
  validTime(retryAtMs, "retryAtMs");
  if (state.phase === "succeeded" || state.phase === "cancelled") {
    throw new Error(`cannot retry publish operation from ${state.phase}`);
  }
  if (state.phase === "in_flight") throw new Error("cannot retry an in-flight publish operation");
  if (state.phase === "reconcile_before_retry") return state;
  return Object.freeze({
    ...state,
    phase: "waiting_retry",
    retryAtMs,
    safeError: undefined,
  });
}
