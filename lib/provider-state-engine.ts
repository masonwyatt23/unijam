/**
 * Pure provider orchestration primitives for UniJam.
 *
 * Spotify and Apple Music deliberately run as independent state machines. A
 * provider outage, expired grant, or rate limit can therefore never erase or
 * block progress made against the other destination.
 */

export const MUSIC_PROVIDERS = ["spotify", "apple_music"] as const;

export type MusicProvider = (typeof MUSIC_PROVIDERS)[number];

export type DestinationStatus =
  | "disconnected"
  | "ready"
  | "validating"
  | "publishing"
  | "succeeded"
  | "reconnect"
  | "rate_limited"
  | "partial"
  | "unavailable";

export interface ProviderConnection {
  readonly connectionId: string;
  readonly destinationId: string;
  readonly storefront?: string;
  readonly connectedAtMs: number;
}

export interface PublishItemInput {
  readonly canonicalTrackId: string;
  readonly providerTrackId: string;
}

export interface RetrySafePublishItem extends PublishItemInput {
  readonly position: number;
  readonly idempotencyKey: string;
}

export interface RetrySafePublishOperation {
  readonly operationId: string;
  readonly payloadFingerprint: string;
  readonly provider: MusicProvider;
  readonly roomId: string;
  readonly destinationId: string;
  readonly roomRevision: number;
  readonly items: readonly RetrySafePublishItem[];
}

export type PublishProgressStatus =
  | "publishing"
  | "partial"
  | "succeeded"
  | "rate_limited"
  | "reconnect"
  | "unavailable";

export interface PublishOperationProgress {
  readonly operation: RetrySafePublishOperation;
  readonly status: PublishProgressStatus;
  readonly attempt: number;
  readonly appliedItemKeys: readonly string[];
  readonly pendingItemKeys: readonly string[];
}

export type DestinationPhase =
  | { readonly status: "disconnected"; readonly resumeOperationId?: string }
  | { readonly status: "ready" }
  | { readonly status: "validating"; readonly validationId: string }
  | {
      readonly status: "publishing";
      readonly operationId: string;
      readonly attempt: number;
    }
  | {
      readonly status: "succeeded";
      readonly operationId: string;
      readonly publishedCount: number;
      readonly receiptId?: string;
    }
  | {
      readonly status: "reconnect";
      readonly reason: string;
      readonly resumeOperationId?: string;
    }
  | {
      readonly status: "rate_limited";
      readonly retryAtMs: number;
      readonly resumeOperationId?: string;
    }
  | {
      readonly status: "partial";
      readonly operationId: string;
      readonly appliedCount: number;
      readonly remainingCount: number;
      readonly attempt: number;
    }
  | {
      readonly status: "unavailable";
      readonly reason: string;
      readonly retryAtMs?: number;
      readonly resumeOperationId?: string;
    };

export interface HandledDestinationEvent {
  readonly eventId: string;
  readonly signature: string;
}

export interface DestinationMachine {
  readonly provider: MusicProvider;
  readonly revision: number;
  readonly phase: DestinationPhase;
  readonly connection?: ProviderConnection;
  readonly operations: readonly PublishOperationProgress[];
  readonly handledEvents: readonly HandledDestinationEvent[];
}

interface DestinationEventBase {
  readonly eventId: string;
  readonly atMs: number;
}

export type DestinationEvent =
  | (DestinationEventBase & {
      readonly type: "connected";
      readonly connection: ProviderConnection;
    })
  | (DestinationEventBase & {
      readonly type: "validation_started";
      readonly validationId: string;
    })
  | (DestinationEventBase & {
      readonly type: "validation_succeeded";
      readonly validationId: string;
    })
  | (DestinationEventBase & {
      readonly type: "publish_started";
      readonly operation: RetrySafePublishOperation;
    })
  | (DestinationEventBase & {
      readonly type: "publish_succeeded";
      readonly operationId: string;
      readonly receiptId?: string;
    })
  | (DestinationEventBase & {
      readonly type: "publish_partial";
      readonly operationId: string;
      readonly appliedItemKeys: readonly string[];
    })
  | (DestinationEventBase & {
      readonly type: "authorization_expired";
      readonly reason: string;
    })
  | (DestinationEventBase & {
      readonly type: "rate_limited";
      readonly retryAtMs: number;
      readonly operationId?: string;
    })
  | (DestinationEventBase & {
      readonly type: "provider_unavailable";
      readonly reason: string;
      readonly retryAtMs?: number;
    })
  | (DestinationEventBase & { readonly type: "retry_requested" })
  | (DestinationEventBase & { readonly type: "disconnected" });

export type TransitionDisposition =
  | "applied"
  | "duplicate_event"
  | "duplicate_operation"
  | "rejected";

export type TransitionRejection =
  | "event_id_conflict"
  | "invalid_transition"
  | "missing_connection"
  | "provider_mismatch"
  | "destination_mismatch"
  | "operation_conflict"
  | "operation_not_found"
  | "operation_mismatch"
  | "unfinished_operation"
  | "unknown_item_key"
  | "retry_not_due";

export interface DestinationTransition {
  readonly machine: DestinationMachine;
  readonly disposition: TransitionDisposition;
  readonly rejection?: TransitionRejection;
}

export interface CreatePublishOperationInput {
  readonly provider: MusicProvider;
  readonly roomId: string;
  readonly destinationId: string;
  readonly roomRevision: number;
  readonly items: readonly PublishItemInput[];
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must not be empty`);
  }
  return normalized;
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Creates stable operation and per-item keys. Rebuilding the same room revision
 * after a timeout produces byte-for-byte identical keys.
 */
export function createRetrySafePublishOperation(
  input: CreatePublishOperationInput,
): RetrySafePublishOperation {
  const roomId = requireNonEmpty(input.roomId, "roomId");
  const destinationId = requireNonEmpty(input.destinationId, "destinationId");
  if (!Number.isSafeInteger(input.roomRevision) || input.roomRevision < 0) {
    throw new Error("roomRevision must be a non-negative safe integer");
  }
  if (input.items.length === 0) {
    throw new Error("publish operation must contain at least one item");
  }

  const canonicalIds = new Set<string>();
  const providerIds = new Set<string>();
  const operationId = [
    "publish",
    input.provider,
    encodeKeyPart(destinationId),
    encodeKeyPart(roomId),
    `r${input.roomRevision}`,
  ].join(":");

  const items = input.items.map((item, position): RetrySafePublishItem => {
    const canonicalTrackId = requireNonEmpty(
      item.canonicalTrackId,
      `items[${position}].canonicalTrackId`,
    );
    const providerTrackId = requireNonEmpty(
      item.providerTrackId,
      `items[${position}].providerTrackId`,
    );
    if (canonicalIds.has(canonicalTrackId)) {
      throw new Error(`duplicate canonicalTrackId: ${canonicalTrackId}`);
    }
    if (providerIds.has(providerTrackId)) {
      throw new Error(`duplicate providerTrackId: ${providerTrackId}`);
    }
    canonicalIds.add(canonicalTrackId);
    providerIds.add(providerTrackId);
    return Object.freeze({
      canonicalTrackId,
      providerTrackId,
      position,
      idempotencyKey: [
        operationId,
        "add",
        String(position),
        encodeKeyPart(canonicalTrackId),
        encodeKeyPart(providerTrackId),
      ].join(":"),
    });
  });

  const payloadFingerprint = [
    "v1",
    input.provider,
    encodeKeyPart(destinationId),
    encodeKeyPart(roomId),
    String(input.roomRevision),
    ...items.map(
      ({ canonicalTrackId, providerTrackId, position }) =>
        `${position}:${encodeKeyPart(canonicalTrackId)}:${encodeKeyPart(providerTrackId)}`,
    ),
  ].join("|");

  return Object.freeze({
    operationId,
    payloadFingerprint,
    provider: input.provider,
    roomId,
    destinationId,
    roomRevision: input.roomRevision,
    items: Object.freeze(items),
  });
}

export function pendingPublishItems(
  operation: RetrySafePublishOperation,
  appliedItemKeys: readonly string[],
): readonly RetrySafePublishItem[] {
  const validKeys = new Set(operation.items.map(({ idempotencyKey }) => idempotencyKey));
  const applied = new Set<string>();
  for (const key of appliedItemKeys) {
    if (!validKeys.has(key)) {
      throw new Error(`unknown publish item key: ${key}`);
    }
    applied.add(key);
  }
  return operation.items.filter(({ idempotencyKey }) => !applied.has(idempotencyKey));
}

export function createDestinationMachine(provider: MusicProvider): DestinationMachine {
  return Object.freeze({
    provider,
    revision: 0,
    phase: Object.freeze({ status: "disconnected" }),
    operations: Object.freeze([]),
    handledEvents: Object.freeze([]),
  });
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

function reject(
  machine: DestinationMachine,
  rejection: TransitionRejection,
): DestinationTransition {
  return { machine, disposition: "rejected", rejection };
}

function commit(
  machine: DestinationMachine,
  event: DestinationEvent,
  changes: Partial<
    Pick<DestinationMachine, "phase" | "connection" | "operations">
  >,
): DestinationTransition {
  const next: DestinationMachine = Object.freeze({
    ...machine,
    ...changes,
    revision: machine.revision + 1,
    handledEvents: Object.freeze([
      ...machine.handledEvents,
      Object.freeze({ eventId: event.eventId, signature: stableSerialize(event) }),
    ]),
  });
  return { machine: next, disposition: "applied" };
}

function findProgress(
  machine: DestinationMachine,
  operationId: string,
): PublishOperationProgress | undefined {
  return machine.operations.find(
    ({ operation }) => operation.operationId === operationId,
  );
}

function replaceProgress(
  machine: DestinationMachine,
  progress: PublishOperationProgress,
): readonly PublishOperationProgress[] {
  const index = machine.operations.findIndex(
    ({ operation }) => operation.operationId === progress.operation.operationId,
  );
  if (index === -1) {
    return Object.freeze([...machine.operations, Object.freeze(progress)]);
  }
  return Object.freeze(
    machine.operations.map((entry, entryIndex) =>
      entryIndex === index ? Object.freeze(progress) : entry,
    ),
  );
}

function resumableOperationId(machine: DestinationMachine): string | undefined {
  if (
    machine.phase.status === "publishing" ||
    machine.phase.status === "partial"
  ) {
    return machine.phase.operationId;
  }
  if (
    machine.phase.status === "disconnected" ||
    machine.phase.status === "rate_limited" ||
    machine.phase.status === "reconnect" ||
    machine.phase.status === "unavailable"
  ) {
    return machine.phase.resumeOperationId;
  }
  return undefined;
}

function progressWithStatus(
  progress: PublishOperationProgress,
  status: PublishProgressStatus,
): PublishOperationProgress {
  return { ...progress, status };
}

function resumePhase(
  machine: DestinationMachine,
  operationId: string | undefined,
): {
  readonly phase: DestinationPhase;
  readonly operations: readonly PublishOperationProgress[];
} {
  if (!operationId) {
    return { phase: { status: "ready" }, operations: machine.operations };
  }
  const progress = findProgress(machine, operationId);
  if (!progress || progress.pendingItemKeys.length === 0) {
    return { phase: { status: "ready" }, operations: machine.operations };
  }
  const resumed = progressWithStatus(progress, "partial");
  return {
    phase: {
      status: "partial",
      operationId,
      appliedCount: progress.appliedItemKeys.length,
      remainingCount: progress.pendingItemKeys.length,
      attempt: progress.attempt,
    },
    operations: replaceProgress(machine, resumed),
  };
}

/** Applies one replay-safe event to exactly one provider machine. */
export function transitionDestination(
  machine: DestinationMachine,
  event: DestinationEvent,
): DestinationTransition {
  requireNonEmpty(event.eventId, "eventId");
  if (!Number.isFinite(event.atMs) || event.atMs < 0) {
    throw new Error("event atMs must be a non-negative finite number");
  }

  const priorEvent = machine.handledEvents.find(
    ({ eventId }) => eventId === event.eventId,
  );
  if (priorEvent) {
    return priorEvent.signature === stableSerialize(event)
      ? { machine, disposition: "duplicate_event" }
      : reject(machine, "event_id_conflict");
  }

  switch (event.type) {
    case "connected": {
      if (
        machine.phase.status !== "disconnected" &&
        machine.phase.status !== "reconnect" &&
        machine.phase.status !== "unavailable"
      ) {
        return reject(machine, "invalid_transition");
      }
      const connectionId = requireNonEmpty(event.connection.connectionId, "connectionId");
      const destinationId = requireNonEmpty(event.connection.destinationId, "destinationId");
      if (!Number.isFinite(event.connection.connectedAtMs) || event.connection.connectedAtMs < 0) {
        throw new Error("connectedAtMs must be a non-negative finite number");
      }
      const candidateResumeId = resumableOperationId(machine);
      const candidateProgress = candidateResumeId ? findProgress(machine, candidateResumeId) : undefined;
      const resumeOperationId = candidateProgress?.operation.destinationId === destinationId ? candidateResumeId : undefined;
      const resumed = resumePhase(machine, resumeOperationId);
      return commit(machine, event, {
        connection: Object.freeze({ ...event.connection, connectionId, destinationId }),
        phase: Object.freeze(resumed.phase),
        operations: resumed.operations,
      });
    }

    case "validation_started": {
      if (!machine.connection) return reject(machine, "missing_connection");
      if (
        machine.phase.status !== "ready" &&
        machine.phase.status !== "succeeded"
      ) {
        return reject(machine, "invalid_transition");
      }
      return commit(machine, event, {
        phase: Object.freeze({
          status: "validating",
          validationId: requireNonEmpty(event.validationId, "validationId"),
        }),
      });
    }

    case "validation_succeeded": {
      if (
        machine.phase.status !== "validating" ||
        machine.phase.validationId !== event.validationId
      ) {
        return reject(machine, "invalid_transition");
      }
      return commit(machine, event, {
        phase: Object.freeze({ status: "ready" }),
      });
    }

    case "publish_started": {
      if (!machine.connection) return reject(machine, "missing_connection");
      if (event.operation.provider !== machine.provider) {
        return reject(machine, "provider_mismatch");
      }
      if (event.operation.destinationId !== machine.connection.destinationId) {
        return reject(machine, "destination_mismatch");
      }

      const existing = findProgress(machine, event.operation.operationId);
      if (
        existing &&
        existing.operation.payloadFingerprint !== event.operation.payloadFingerprint
      ) {
        return reject(machine, "operation_conflict");
      }
      if (existing?.status === "succeeded") {
        return { machine, disposition: "duplicate_operation" };
      }
      if (
        machine.phase.status === "publishing" &&
        machine.phase.operationId === event.operation.operationId
      ) {
        return { machine, disposition: "duplicate_operation" };
      }
      if (
        machine.phase.status === "rate_limited" &&
        event.atMs < machine.phase.retryAtMs
      ) {
        return reject(machine, "retry_not_due");
      }

      const allowedFresh =
        machine.phase.status === "ready" || machine.phase.status === "succeeded";
      const allowedResume =
        (machine.phase.status === "partial" &&
          machine.phase.operationId === event.operation.operationId) ||
        (machine.phase.status === "rate_limited" &&
          machine.phase.resumeOperationId === event.operation.operationId);
      if (!allowedFresh && !allowedResume) {
        return reject(machine, "invalid_transition");
      }
      if (
        machine.phase.status === "partial" &&
        machine.phase.operationId !== event.operation.operationId
      ) {
        return reject(machine, "unfinished_operation");
      }

      const attempt = (existing?.attempt ?? 0) + 1;
      const progress: PublishOperationProgress = existing
        ? { ...existing, status: "publishing", attempt }
        : {
            operation: event.operation,
            status: "publishing",
            attempt,
            appliedItemKeys: Object.freeze([]),
            pendingItemKeys: Object.freeze(
              event.operation.items.map(({ idempotencyKey }) => idempotencyKey),
            ),
          };
      return commit(machine, event, {
        phase: Object.freeze({
          status: "publishing",
          operationId: event.operation.operationId,
          attempt,
        }),
        operations: replaceProgress(machine, progress),
      });
    }

    case "publish_partial": {
      if (
        machine.phase.status !== "publishing" ||
        machine.phase.operationId !== event.operationId
      ) {
        return reject(machine, "operation_mismatch");
      }
      const progress = findProgress(machine, event.operationId);
      if (!progress) return reject(machine, "operation_not_found");
      const allKeys = new Set(
        progress.operation.items.map(({ idempotencyKey }) => idempotencyKey),
      );
      if (event.appliedItemKeys.some((key) => !allKeys.has(key))) {
        return reject(machine, "unknown_item_key");
      }
      const applied = new Set([
        ...progress.appliedItemKeys,
        ...event.appliedItemKeys,
      ]);
      const appliedItemKeys = Object.freeze(
        progress.operation.items
          .map(({ idempotencyKey }) => idempotencyKey)
          .filter((key) => applied.has(key)),
      );
      const pendingItemKeys = Object.freeze(
        progress.operation.items
          .map(({ idempotencyKey }) => idempotencyKey)
          .filter((key) => !applied.has(key)),
      );
      const succeeded = pendingItemKeys.length === 0;
      const updated: PublishOperationProgress = {
        ...progress,
        status: succeeded ? "succeeded" : "partial",
        appliedItemKeys,
        pendingItemKeys,
      };
      const phase: DestinationPhase = succeeded
        ? {
            status: "succeeded",
            operationId: event.operationId,
            publishedCount: appliedItemKeys.length,
          }
        : {
            status: "partial",
            operationId: event.operationId,
            appliedCount: appliedItemKeys.length,
            remainingCount: pendingItemKeys.length,
            attempt: progress.attempt,
          };
      return commit(machine, event, {
        phase: Object.freeze(phase),
        operations: replaceProgress(machine, updated),
      });
    }

    case "publish_succeeded": {
      const progress = findProgress(machine, event.operationId);
      if (progress?.status === "succeeded") {
        return { machine, disposition: "duplicate_operation" };
      }
      if (
        machine.phase.status !== "publishing" ||
        machine.phase.operationId !== event.operationId ||
        !progress
      ) {
        return reject(machine, "operation_mismatch");
      }
      const appliedItemKeys = Object.freeze(
        progress.operation.items.map(({ idempotencyKey }) => idempotencyKey),
      );
      const updated: PublishOperationProgress = {
        ...progress,
        status: "succeeded",
        appliedItemKeys,
        pendingItemKeys: Object.freeze([]),
      };
      return commit(machine, event, {
        phase: Object.freeze({
          status: "succeeded",
          operationId: event.operationId,
          publishedCount: appliedItemKeys.length,
          ...(event.receiptId ? { receiptId: event.receiptId } : {}),
        }),
        operations: replaceProgress(machine, updated),
      });
    }

    case "authorization_expired": {
      if (machine.phase.status === "disconnected") {
        return reject(machine, "invalid_transition");
      }
      const operationId = resumableOperationId(machine);
      const progress = operationId ? findProgress(machine, operationId) : undefined;
      return commit(machine, event, {
        phase: Object.freeze({
          status: "reconnect",
          reason: requireNonEmpty(event.reason, "reason"),
          ...(operationId ? { resumeOperationId: operationId } : {}),
        }),
        ...(progress
          ? {
              operations: replaceProgress(
                machine,
                progressWithStatus(progress, "reconnect"),
              ),
            }
          : {}),
      });
    }

    case "rate_limited": {
      if (machine.phase.status === "disconnected") {
        return reject(machine, "invalid_transition");
      }
      if (!Number.isFinite(event.retryAtMs) || event.retryAtMs < event.atMs) {
        return reject(machine, "retry_not_due");
      }
      const operationId = event.operationId ?? resumableOperationId(machine);
      const progress = operationId ? findProgress(machine, operationId) : undefined;
      if (operationId && !progress) return reject(machine, "operation_not_found");
      if (progress?.status === "succeeded") return reject(machine, "invalid_transition");
      return commit(machine, event, {
        phase: Object.freeze({
          status: "rate_limited",
          retryAtMs: event.retryAtMs,
          ...(operationId ? { resumeOperationId: operationId } : {}),
        }),
        ...(progress
          ? {
              operations: replaceProgress(
                machine,
                progressWithStatus(progress, "rate_limited"),
              ),
            }
          : {}),
      });
    }

    case "provider_unavailable": {
      if (machine.phase.status === "disconnected") {
        return reject(machine, "invalid_transition");
      }
      if (event.retryAtMs !== undefined && (!Number.isFinite(event.retryAtMs) || event.retryAtMs < event.atMs)) {
        return reject(machine, "retry_not_due");
      }
      const operationId = resumableOperationId(machine);
      const progress = operationId ? findProgress(machine, operationId) : undefined;
      return commit(machine, event, {
        phase: Object.freeze({
          status: "unavailable",
          reason: requireNonEmpty(event.reason, "reason"),
          ...(event.retryAtMs === undefined
            ? {}
            : { retryAtMs: event.retryAtMs }),
          ...(operationId ? { resumeOperationId: operationId } : {}),
        }),
        ...(progress
          ? {
              operations: replaceProgress(
                machine,
                progressWithStatus(progress, "unavailable"),
              ),
            }
          : {}),
      });
    }

    case "retry_requested": {
      if (
        machine.phase.status !== "rate_limited" &&
        machine.phase.status !== "unavailable"
      ) {
        return reject(machine, "invalid_transition");
      }
      if (
        machine.phase.retryAtMs !== undefined &&
        event.atMs < machine.phase.retryAtMs
      ) {
        return reject(machine, "retry_not_due");
      }
      const resumed = resumePhase(machine, machine.phase.resumeOperationId);
      return commit(machine, event, {
        phase: Object.freeze(resumed.phase),
        operations: resumed.operations,
      });
    }

    case "disconnected": {
      const operationId = resumableOperationId(machine);
      const progress = operationId ? findProgress(machine, operationId) : undefined;
      return commit(machine, event, {
        phase: Object.freeze({ status: "disconnected", ...(operationId ? { resumeOperationId: operationId } : {}) }),
        connection: undefined,
        ...(progress
          ? {
              operations: replaceProgress(
                machine,
                progressWithStatus(progress, "reconnect"),
              ),
            }
          : {}),
      });
    }
  }
}

export type ClientSurface = "ios" | "android" | "desktop" | "web";
export type AppInstallation = "installed" | "not_installed" | "unknown";

export interface ProviderHandoffTarget {
  readonly provider: MusicProvider;
  readonly available: boolean;
  /** Custom-scheme URL. It is used only when the app is known to be installed. */
  readonly appUrl?: string;
  /** HTTPS URL that may hand off to a native app on supported devices. */
  readonly universalUrl?: string;
  readonly webUrl?: string;
}

export interface DeepLinkHandoffInput {
  readonly surface: ClientSurface;
  readonly targets: readonly ProviderHandoffTarget[];
  readonly preferredProvider?: MusicProvider;
  readonly roomDefaultProvider?: MusicProvider;
  readonly appInstallation?: Partial<Record<MusicProvider, AppInstallation>>;
  readonly fallbackOrder?: readonly MusicProvider[];
}

export type HandoffSelectionReason =
  | "preferred_provider"
  | "room_default"
  | "only_available_provider"
  | "fallback_order"
  | "no_available_provider";

export type DeepLinkHandoffChoice =
  | {
      readonly available: true;
      readonly provider: MusicProvider;
      readonly url: string;
      readonly mode: "native_app" | "universal_link" | "web";
      readonly reason: Exclude<HandoffSelectionReason, "no_available_provider">;
      readonly alternateProviders: readonly MusicProvider[];
    }
  | {
      readonly available: false;
      readonly reason: "no_available_provider";
      readonly alternateProviders: readonly [];
    };

interface ResolvedHandoffTarget {
  readonly target: ProviderHandoffTarget;
  readonly url: string;
  readonly mode: "native_app" | "universal_link" | "web";
}

function isAllowedHandoffUrl(
  provider: MusicProvider,
  url: string | undefined,
  kind: "app" | "web",
): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (kind === "web") return parsed.protocol === "https:";
    return provider === "spotify"
      ? parsed.protocol === "spotify:"
      : parsed.protocol === "music:" || parsed.protocol === "musics:";
  } catch {
    return false;
  }
}

function resolveHandoffTarget(
  input: DeepLinkHandoffInput,
  target: ProviderHandoffTarget,
): ResolvedHandoffTarget | undefined {
  if (!target.available) return undefined;
  const installation = input.appInstallation?.[target.provider] ?? "unknown";
  if (
    input.surface !== "web" &&
    installation === "installed" &&
    isAllowedHandoffUrl(target.provider, target.appUrl, "app")
  ) {
    return { target, url: target.appUrl, mode: "native_app" };
  }
  if (
    (input.surface === "ios" || input.surface === "android") &&
    isAllowedHandoffUrl(target.provider, target.universalUrl, "web")
  ) {
    return { target, url: target.universalUrl, mode: "universal_link" };
  }
  if (isAllowedHandoffUrl(target.provider, target.webUrl, "web")) {
    return { target, url: target.webUrl, mode: "web" };
  }
  if (isAllowedHandoffUrl(target.provider, target.universalUrl, "web")) {
    return { target, url: target.universalUrl, mode: "universal_link" };
  }
  if (
    input.surface !== "web" &&
    installation !== "not_installed" &&
    isAllowedHandoffUrl(target.provider, target.appUrl, "app")
  ) {
    return { target, url: target.appUrl, mode: "native_app" };
  }
  return undefined;
}

/** Chooses a single explicit handoff without pretending UniJam streams audio. */
export function chooseDeepLinkHandoff(
  input: DeepLinkHandoffInput,
): DeepLinkHandoffChoice {
  const providerCount = new Set(input.targets.map(({ provider }) => provider));
  if (providerCount.size !== input.targets.length) {
    throw new Error("handoff targets must contain at most one entry per provider");
  }
  const byProvider = new Map(
    input.targets
      .map((target) => resolveHandoffTarget(input, target))
      .filter((target): target is ResolvedHandoffTarget => Boolean(target))
      .map((resolved) => [resolved.target.provider, resolved] as const),
  );
  if (byProvider.size === 0) {
    return {
      available: false,
      reason: "no_available_provider",
      alternateProviders: [],
    };
  }

  let provider: MusicProvider | undefined;
  let reason: Exclude<HandoffSelectionReason, "no_available_provider">;
  if (input.preferredProvider && byProvider.has(input.preferredProvider)) {
    provider = input.preferredProvider;
    reason = "preferred_provider";
  } else if (
    input.roomDefaultProvider &&
    byProvider.has(input.roomDefaultProvider)
  ) {
    provider = input.roomDefaultProvider;
    reason = "room_default";
  } else if (byProvider.size === 1) {
    provider = byProvider.keys().next().value as MusicProvider;
    reason = "only_available_provider";
  } else {
    const order = input.fallbackOrder ?? MUSIC_PROVIDERS;
    provider = order.find((candidate) => byProvider.has(candidate));
    provider ??= MUSIC_PROVIDERS.find((candidate) => byProvider.has(candidate));
    reason = "fallback_order";
  }

  if (!provider) {
    return {
      available: false,
      reason: "no_available_provider",
      alternateProviders: [],
    };
  }
  const resolved = byProvider.get(provider)!;

  return {
    available: true,
    provider,
    url: resolved.url,
    mode: resolved.mode,
    reason,
    alternateProviders: Object.freeze(
      MUSIC_PROVIDERS.filter(
        (candidate) => candidate !== provider && byProvider.has(candidate),
      ),
    ),
  };
}

export type ProviderCapability =
  | "connect"
  | "publish_now"
  | "in_progress"
  | "resume"
  | "wait"
  | "reconnect"
  | "unavailable";

export type RoomReadinessState =
  | "fully_ready"
  | "partially_ready"
  | "publishing"
  | "waiting"
  | "action_required"
  | "unavailable";

export type RoomReadinessAction =
  | { readonly type: "none" }
  | { readonly type: "connect"; readonly provider: MusicProvider }
  | { readonly type: "reconnect"; readonly provider: MusicProvider }
  | { readonly type: "retry"; readonly provider: MusicProvider }
  | {
      readonly type: "wait";
      readonly provider: MusicProvider;
      readonly retryAtMs: number;
    };

export interface RoomReadinessSummary {
  readonly state: RoomReadinessState;
  /** Rooms accept guest suggestions even while both provider outputs recover. */
  readonly canAcceptContributions: true;
  readonly canPublishNow: boolean;
  readonly providers: Readonly<Record<MusicProvider, ProviderCapability>>;
  readonly publishableProviders: readonly MusicProvider[];
  readonly inProgressProviders: readonly MusicProvider[];
  readonly blockedProviders: readonly MusicProvider[];
  readonly nextAction: RoomReadinessAction;
}

export function getProviderCapability(
  machine: DestinationMachine,
  nowMs: number,
): ProviderCapability {
  switch (machine.phase.status) {
    case "disconnected":
      return "connect";
    case "ready":
    case "succeeded":
      return "publish_now";
    case "validating":
    case "publishing":
      return "in_progress";
    case "partial":
      return "resume";
    case "reconnect":
      return "reconnect";
    case "rate_limited":
      return nowMs >= machine.phase.retryAtMs ? "resume" : "wait";
    case "unavailable":
      return machine.phase.retryAtMs !== undefined &&
        nowMs >= machine.phase.retryAtMs
        ? "resume"
        : "unavailable";
  }
}

/** Combines provider health without coupling the two state transitions. */
export function summarizeRoomReadiness(
  spotify: DestinationMachine,
  appleMusic: DestinationMachine,
  nowMs: number,
): RoomReadinessSummary {
  if (spotify.provider !== "spotify" || appleMusic.provider !== "apple_music") {
    throw new Error("readiness requires Spotify then Apple Music machines");
  }
  const providers: Readonly<Record<MusicProvider, ProviderCapability>> =
    Object.freeze({
      spotify: getProviderCapability(spotify, nowMs),
      apple_music: getProviderCapability(appleMusic, nowMs),
    });
  const select = (capabilities: readonly ProviderCapability[]) =>
    MUSIC_PROVIDERS.filter((provider) => capabilities.includes(providers[provider]));
  const publishableProviders = Object.freeze(select(["publish_now", "resume"]));
  const inProgressProviders = Object.freeze(select(["in_progress"]));
  const blockedProviders = Object.freeze(
    select(["connect", "wait", "reconnect", "unavailable"]),
  );

  let state: RoomReadinessState;
  if (inProgressProviders.length > 0) {
    state = "publishing";
  } else if (
    providers.spotify === "publish_now" &&
    providers.apple_music === "publish_now"
  ) {
    state = "fully_ready";
  } else if (publishableProviders.length > 0) {
    state = "partially_ready";
  } else if (select(["wait"]).length > 0) {
    state = "waiting";
  } else if (select(["connect", "reconnect"]).length > 0) {
    state = "action_required";
  } else {
    state = "unavailable";
  }

  const reconnectProvider = MUSIC_PROVIDERS.find(
    (provider) => providers[provider] === "reconnect",
  );
  const connectProvider = MUSIC_PROVIDERS.find(
    (provider) => providers[provider] === "connect",
  );
  const retryProvider = MUSIC_PROVIDERS.find(
    (provider) => providers[provider] === "resume",
  );
  const waitProvider = MUSIC_PROVIDERS.find(
    (provider) => providers[provider] === "wait",
  );
  let nextAction: RoomReadinessAction = { type: "none" };
  if (reconnectProvider) {
    nextAction = { type: "reconnect", provider: reconnectProvider };
  } else if (connectProvider) {
    nextAction = { type: "connect", provider: connectProvider };
  } else if (retryProvider) {
    nextAction = { type: "retry", provider: retryProvider };
  } else if (waitProvider) {
    const waitingMachine =
      waitProvider === "spotify" ? spotify : appleMusic;
    if (waitingMachine.phase.status === "rate_limited") {
      nextAction = {
        type: "wait",
        provider: waitProvider,
        retryAtMs: waitingMachine.phase.retryAtMs,
      };
    }
  }

  return Object.freeze({
    state,
    canAcceptContributions: true,
    canPublishNow: publishableProviders.length > 0,
    providers,
    publishableProviders,
    inProgressProviders,
    blockedProviders,
    nextAction: Object.freeze(nextAction),
  });
}
