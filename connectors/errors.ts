import type { MusicProvider } from "../lib/provider-state-engine.ts";
import type { ProviderFailure, ProviderFailureKind } from "../lib/providers/contracts.ts";

export class ConnectorProviderError extends Error {
  readonly failure: ProviderFailure;

  constructor(failure: ProviderFailure, options?: ErrorOptions) {
    super(failure.safeMessage, options);
    this.name = "ConnectorProviderError";
    this.failure = failure;
  }
}

function retryAtFromHeader(value: string | null, nowMs: number): number {
  if (!value) return nowMs + 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return nowMs + Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) && date > nowMs ? date : nowMs + 60_000;
}

export function failureForResponse(
  provider: MusicProvider,
  response: Response,
  nowMs: number,
  mutation: boolean,
): ConnectorProviderError {
  let kind: ProviderFailureKind;
  let safeMessage: string;
  let retryAtMs: number | undefined;
  if (response.status === 401 || response.status === 403) {
    kind = "authorization";
    safeMessage = `Reconnect ${provider === "spotify" ? "Spotify" : "Apple Music"}`;
  } else if (response.status === 429) {
    kind = "rate_limit";
    safeMessage = "The provider asked UniJam to wait before retrying";
    retryAtMs = retryAtFromHeader(response.headers.get("Retry-After"), nowMs);
  } else if (response.status >= 500) {
    kind = mutation ? "ambiguous_write" : "retryable";
    safeMessage = mutation
      ? "The provider may have accepted the change; UniJam will reconcile before retrying"
      : "The provider is temporarily unavailable";
  } else {
    kind = "permanent";
    safeMessage = "The provider rejected this request";
  }
  return new ConnectorProviderError({
    kind,
    provider,
    ...(retryAtMs === undefined ? {} : { retryAtMs }),
    safeMessage,
  });
}

export function failureForThrown(
  provider: MusicProvider,
  error: unknown,
  mutation: boolean,
): ConnectorProviderError {
  if (error instanceof ConnectorProviderError) return error;
  return new ConnectorProviderError(
    {
      kind: mutation ? "ambiguous_write" : "retryable",
      provider,
      safeMessage: mutation
        ? "The provider outcome is unknown; UniJam will reconcile before retrying"
        : "The provider request did not complete",
    },
    { cause: error },
  );
}

export function invalidProviderResponse(
  provider: MusicProvider,
  mutation = false,
): ConnectorProviderError {
  return new ConnectorProviderError({
    kind: mutation ? "ambiguous_write" : "invalid_response",
    provider,
    safeMessage: mutation
      ? "The provider may have accepted the change; UniJam will reconcile before retrying"
      : "The provider returned an invalid response",
  });
}
