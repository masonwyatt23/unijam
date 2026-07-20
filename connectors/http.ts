import type { MusicProvider } from "../lib/provider-state-engine.ts";
import { failureForResponse, failureForThrown, invalidProviderResponse } from "./errors.ts";

const MAX_PROVIDER_JSON_BYTES = 1_048_576;

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
    response = await (options.fetcher ?? fetch)(input, {
      ...init,
      // Provider requests must never carry credentials to a redirected origin.
      redirect: "error",
      signal: controller.signal,
    });
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

async function readBoundedProviderJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || Number(declared) > MAX_PROVIDER_JSON_BYTES) {
      throw new Error("provider response is too large");
    }
  }
  if (!response.body) throw new Error("provider response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROVIDER_JSON_BYTES) {
        await reader.cancel("provider response is too large");
        throw new Error("provider response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
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
    body = await readBoundedProviderJson(response);
  } catch {
    throw invalidProviderResponse(options.provider, options.mutation ?? false);
  }
  if (!validate(body)) throw invalidProviderResponse(options.provider, options.mutation ?? false);
  return body;
}
