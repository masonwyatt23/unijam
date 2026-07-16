import assert from "node:assert/strict";
import test from "node:test";

import { catalogPrincipalForRoom } from "./catalog-principal.ts";

const registry = { owner_account_id: "room-owner" };

test("Apple Music catalog resolution is app-scoped for every room participant", () => {
  assert.deepEqual(catalogPrincipalForRoom({
    registry,
    session: { kind: "guest", accountId: null },
  }, "apple_music"), { kind: "public" });
});

test("an anonymous guest cannot borrow the room owner's Spotify connection", () => {
  assert.equal(catalogPrincipalForRoom({
    registry,
    session: { kind: "guest", accountId: null },
  }, "spotify"), null);
});

test("a linked room member uses only their own Spotify connection", () => {
  assert.deepEqual(catalogPrincipalForRoom({
    registry,
    session: { kind: "guest", accountId: "room-member" },
  }, "spotify"), { kind: "account", accountId: "room-member" });
});

test("the room host uses the owner connection", () => {
  assert.deepEqual(catalogPrincipalForRoom({
    registry,
    session: { kind: "host", accountId: "room-owner" },
  }, "spotify"), { kind: "account", accountId: "room-owner" });
});
