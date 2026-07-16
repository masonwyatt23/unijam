const HOST_DESTINATION = /^\/(?:host|rooms\/new|connections(?:\/(?:spotify|apple-music))?|room\/[A-Za-z0-9]{6,16}(?:\/(?:review|publish|recap|handoff\/(?:spotify|apple-music)))?)$/;

/** Only permits known authenticated product routes; never accepts a URL or protocol-relative path. */
export function safeHostReturnTo(value: string | null | undefined): string {
  const candidate = value?.trim() ?? "";
  return HOST_DESTINATION.test(candidate) ? candidate : "/host";
}
