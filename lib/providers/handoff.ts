import type { MusicProvider } from "../provider-state-engine.ts";

const SPOTIFY_TRACK_ID = /^[0-9A-Za-z]{22}$/;
const APPLE_MUSIC_ID = /^[0-9]+$/;

export interface ProviderHandoffLinks {
  readonly provider: MusicProvider;
  readonly providerRecordingId: string;
  readonly storefront: "US";
  readonly universalUrl: string;
  readonly nativeUri: string;
}

export type HandoffStatus = "requested" | "opened" | "host_confirmed";

export interface HandoffObservation {
  readonly handoffId: string;
  readonly occurrenceId: string;
  readonly participantId: string;
  readonly provider: MusicProvider;
  readonly status: HandoffStatus;
  readonly observedAtMs: number;
}

function assertRecordingId(provider: MusicProvider, id: string): void {
  const valid = provider === "spotify"
    ? SPOTIFY_TRACK_ID.test(id)
    : APPLE_MUSIC_ID.test(id);
  if (!valid) throw new Error(`invalid ${provider} recording ID`);
}

/** Generates links from validated IDs rather than accepting redirect URLs. */
export function createProviderHandoffLinks(
  provider: MusicProvider,
  providerRecordingId: string,
): ProviderHandoffLinks {
  assertRecordingId(provider, providerRecordingId);
  if (provider === "spotify") {
    return Object.freeze({
      provider,
      providerRecordingId,
      storefront: "US",
      universalUrl: `https://open.spotify.com/track/${providerRecordingId}`,
      nativeUri: `spotify:track:${providerRecordingId}`,
    });
  }
  const universalUrl = `https://music.apple.com/us/song/${providerRecordingId}`;
  return Object.freeze({
    provider,
    providerRecordingId,
    storefront: "US",
    universalUrl,
    nativeUri: `music://music.apple.com/us/song/${providerRecordingId}`,
  });
}

export function isAllowlistedHandoffUrl(value: string): boolean {
  if (/^spotify:track:[0-9A-Za-z]{22}$/.test(value)) return true;
  if (/^music:\/\/music\.apple\.com\/us\/song\/[0-9]+$/.test(value)) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  if (url.hostname === "open.spotify.com") {
    return /^\/track\/[0-9A-Za-z]{22}$/.test(url.pathname) && !url.search && !url.hash;
  }
  if (url.hostname === "music.apple.com") {
    return /^\/us\/song\/[0-9]+$/.test(url.pathname) && !url.search && !url.hash;
  }
  return false;
}
