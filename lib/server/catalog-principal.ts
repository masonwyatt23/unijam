import type { MusicProvider } from "../provider-state-engine.ts";

export type CatalogRoomAccess = {
  readonly registry: { readonly owner_account_id: string };
  readonly session: {
    readonly kind: "host" | "guest";
    readonly accountId: string | null;
  };
};

export type CatalogPrincipal =
  | { readonly kind: "public" }
  | { readonly kind: "account"; readonly accountId: string };

/**
 * Apple Music catalog reads use UniJam's developer token and contain no
 * listener-private data. Spotify catalog reads use only the current room
 * participant's connection; a guest can never inherit the room owner's token.
 */
export function catalogPrincipalForRoom(
  access: CatalogRoomAccess,
  provider: MusicProvider,
): CatalogPrincipal | null {
  if (provider === "apple_music") return { kind: "public" };
  if (access.session.kind === "host") {
    return { kind: "account", accountId: access.registry.owner_account_id };
  }
  return access.session.accountId
    ? { kind: "account", accountId: access.session.accountId }
    : null;
}
