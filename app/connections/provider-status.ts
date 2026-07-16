"use client";

import { useCallback, useEffect, useState } from "react";

export type Provider = "spotify" | "apple-music";
export type ConnectionStatus = { connected: boolean; enabled: boolean; publishingEnabled: boolean; storefront: string | null };
export type ApiError = { code?: string; message?: string; retryable?: boolean };
export type Envelope<T> = { data?: T | null; error?: ApiError | null };
type Resource = { state: "loading" | "ready" | "error"; data: ConnectionStatus | null; message: string };

export function providerName(provider: Provider): "Spotify" | "Apple Music" {
  return provider === "spotify" ? "Spotify" : "Apple Music";
}

export async function apiMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.clone().json().catch(() => null) as Envelope<unknown> | null;
  return body?.error?.message ?? fallback;
}

export function useProviderStatus(provider: Provider) {
  const [version, setVersion] = useState(0);
  const [resource, setResource] = useState<Resource>({ state: "loading", data: null, message: "" });
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v1/providers/${provider}/status`, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as Envelope<ConnectionStatus>;
        if (!response.ok || body.error || !body.data) throw new Error(body.error?.message ?? "Connection status is unavailable.");
        setResource({ state: "ready", data: body.data, message: "" });
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setResource({ state: "error", data: null, message: cause instanceof Error ? cause.message : "Connection status is unavailable." });
      });
    return () => controller.abort();
  }, [provider, version]);
  return {
    ...resource,
    refresh: useCallback(() => {
      setResource({ state: "loading", data: null, message: "" });
      setVersion((value) => value + 1);
    }, []),
  };
}
