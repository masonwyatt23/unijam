const HOST_DESTINATION = /^\/(?:host|rooms\/new|connections(?:\/(?:spotify|apple-music))?|room\/[A-Za-z0-9]{6,16}(?:\/(?:review|publish|recap|handoff\/(?:spotify|apple-music)))?)$/;
const PROVIDER_CONNECTION_DESTINATION = /^\/connections\/(?:spotify|apple-music)$/;
const ROOM_DESTINATION = /^\/room\/[A-Za-z0-9]{6,16}$/;
const RETURN_ORIGIN = "https://unijam.invalid";

/** Only permits known authenticated product routes; never accepts a URL or protocol-relative path. */
export function safeHostReturnTo(value: string | null | undefined): string {
  const candidate = value?.trim() ?? "";
  if (HOST_DESTINATION.test(candidate)) return candidate;

  // A provider screen may carry one independently validated live-room return.
  // Keeping that value through a passkey ceremony lets the person confirm
  // their identity, finish provider authorization, and then return to the room.
  try {
    const parsed = new URL(candidate, RETURN_ORIGIN);
    const keys = [...parsed.searchParams.keys()];
    const providerReturnTo = parsed.searchParams.get("returnTo")?.trim() ?? "";
    if (
      parsed.origin === RETURN_ORIGIN
      && candidate.startsWith("/")
      && !candidate.startsWith("//")
      && !parsed.hash
      && PROVIDER_CONNECTION_DESTINATION.test(parsed.pathname)
      && keys.length === 1
      && keys[0] === "returnTo"
      && ROOM_DESTINATION.test(providerReturnTo)
    ) {
      return `${parsed.pathname}?returnTo=${encodeURIComponent(providerReturnTo)}`;
    }
  } catch { /* malformed destinations fall back to the host workspace */ }
  return "/host";
}

export function hostSignInPath(returnTo: string): string {
  return `/host/sign-in?returnTo=${encodeURIComponent(safeHostReturnTo(returnTo))}`;
}

export function providerConnectionReturnTo(
  provider: "spotify" | "apple-music",
  returnTo: string | null,
): string {
  return returnTo && ROOM_DESTINATION.test(returnTo)
    ? `/connections/${provider}?returnTo=${encodeURIComponent(returnTo)}`
    : `/connections/${provider}`;
}
