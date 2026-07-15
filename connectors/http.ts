import type { MusicProvider } from "../lib/provider-state-engine.ts";
import { failureForResponse, failureForThrown, invalidProviderResponse } from "./errors.ts";

export interface ProviderFetchOptions {
  readonly provider: MusicProvider;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly mutation?: boolean;
  readonly now?: () => number;
}

export async function providerFetch(
  input: RequestInfo | URL,
  init: RequestInit,
  options: ProviderFetchOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("provider timeout"), options.timeoutMs ?? 10_000);
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(input, { ...init, signal: controller.signal });
  } catch (error) {
    throw failureForThrown(options.provider, error, options.mutation ?? false);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw failureForResponse(options.provider, response, (options.now ?? Date.now)(), options.mutation ?? false);
  }
  return response;
}

export async function providerJson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  options: ProviderFetchOptions,
  validate: (value: unknown) => value is T,
): Promise<T> {
  const response = await providerFetch(input, init, options);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw invalidProviderResponse(options.provider, options.mutation ?? false);
  }
  if (!validate(body)) throw invalidProviderResponse(options.provider, options.mutation ?? false);
  return body;
}
