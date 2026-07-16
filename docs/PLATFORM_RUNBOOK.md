# UniJam Cloudflare platform runbook

## Environment boundary

Production is `https://unijam.ashlr.ai` with WebAuthn RP ID
`unijam.ashlr.ai`. Staging is `https://staging.unijam.ashlr.ai` with a distinct
RP ID and therefore distinct passkeys. Each environment has its own Worker,
D1 database, Durable Object namespace, projection queue, and dead-letter queue.

`wrangler.jsonc` contains non-routable D1 sentinel IDs. Provision both databases
and replace those IDs before the first deployment. Provider secrets belong only
on the connector Worker; the web Worker must never receive them.
The connector has `workers_dev=false` and `preview_urls=false` in every
environment and receives HTTP only through service bindings. Dashboard changes
must never re-enable either public route.

## Provisioning order

1. Create the staging and production D1 databases, queues, and DLQs named in
   `wrangler.jsonc`; replace the sentinel D1 IDs.
   Set the same high-entropy service credential as `CONNECTOR_SERVICE_TOKEN` on
   the web Worker and `CONNECTOR_SHARED_SECRET` on the connector Worker. This
   credential is only for service authentication; all provider credentials stay
   exclusively on the connector Worker.
   Generate each pilot enrollment credential with
   `node scripts/create-enrollment-code.mjs`, insert only its `codeHash` into
   `host_enrollment_codes` with a label and expiry, then deliver the plaintext
   code once through a separate secure channel.
2. Apply checked-in D1 migrations to staging, then production. Migration 0006
   creates account/session data, the room registry and idempotent projections.
3. Follow `docs/PILOT_RELEASE.md` for deployment. The Cloudflare Vite plugin
   selects staging or production at build time, so use the checked-in
   `npm run deploy:cloudflare -- --env ...` wrapper; never build the default
   environment and add `--env` only at deploy time. Exercise passkey creation,
   guest fragment exchange, HTTP commands, WebSocket reconnect, and projection
   lag in staging before production.
4. Select the DNS architecture in `docs/PILOT_RELEASE.md`. A delegated
   `unijam.ashlr.ai` child zone requires Cloudflare Enterprise. Without that
   entitlement, use the owner-approved full-zone migration: reproduce every
   existing record in Cloudflare, keep all Vercel destinations hosted on
   Vercel, verify parity and DNSSEC, and only then change registrar
   nameservers. Never delegate `staging` separately or improvise a
   `workers.dev`/external-rewrite substitute.
5. Keep `ENABLE_LEGACY_ROOM_API=false`. A migration operator may temporarily set
   it to `true` only with a Wrangler secret named `LEGACY_MIGRATION_SECRET`; every
   compatibility request must also carry that value in
   `X-UniJam-Migration-Secret`.

The authenticated migration import stores a canonical export hash and immutable
raw export before claim. Claim requires both a recently verified host passkey and
the legacy host capability. Legacy guest bearer exchange closes after 30 days;
host claim closes after 90 days, when unclaimed imports transition to read-only
export state. Claim creates a new room authority, invalidates legacy participant
identity, and returns a rotated fragment invite. Because Sites data is not
available to this repository, import/claim/exchange endpoints are the verifiable
compatibility scaffold; an operator must feed the authenticated Sites export.
The claim transaction verifies the export hash again and imports the complete
versioned payload into room-local SQLite, including dedicated snapshot, events,
settings, and history columns plus the lossless raw export. A claim is not marked
complete unless that authority import succeeds. The imported legacy state is
preserved for export and later replay, but it is not projected into the v1 live
room reducer until an actual Sites export fixture defines a safe field mapping.
API responses distinguish `fullExportImportedIntoAuthority` from reducer replay.

## Security and operations

- Passkey challenges expire after five minutes and are single use. Bootstrap
  registration requires a hashed, unexpired, single-use pilot enrollment code,
  is rate-limited by hashed network/account scopes, and always receives a
  server-generated account ID. Adding a passkey
  requires a host session authenticated in the previous five minutes.
- Host and guest sessions are opaque, hashed at rest, Secure, HttpOnly, and
  SameSite=Lax. Guest capabilities are accepted only by the join exchange and
  should arrive from a URL fragment that the client clears immediately.
- Each room Durable Object is its only command writer. Commands are actor-scoped,
  sequence-aware, and idempotent; command-ID reuse with different intent fails.
- Durable Object commits include events, snapshot, result, and local outbox.
  Queue delivery is at least once; D1 receipts and monotonic sequences deduplicate
  projections.
- Cron removes expired challenges/sessions and projection receipts after 30 days.
  Derived recap retention and host deletion are handled separately from room
  authority.

## Stop and rollback

Stop rollout on capability/token exposure, command divergence, duplicate provider
mutation, or any provider failure affecting room commands. After Durable Object
writes begin, roll back only to a release that continues routing the same room IDs
to the same Durable Object class and namespace. Never reactivate the public legacy
D1 writer as a general rollback.
