# UniJam Cloudflare platform runbook

## Environment boundary

Production is `https://unijam.ashlr.ai` with WebAuthn RP ID
`unijam.ashlr.ai`. Staging is `https://staging.unijam.ashlr.ai` with a distinct
RP ID and therefore distinct passkeys. Each environment has its own Worker,
D1 database, Durable Object namespace, projection queue, and dead-letter queue.

The development bindings retain non-routable D1 sentinel IDs. Staging and
production contain distinct provisioned D1 IDs and must never be replaced with
development sentinels or each other's IDs. Provider secrets belong only on the
connector Worker; the web Worker must never receive them.
The connector has `workers_dev=false` and `preview_urls=false` in every
environment and receives HTTP only through service bindings. Dashboard changes
must never re-enable either public route.

## Provisioning order

1. Verify the provisioned staging and production D1 databases, queues, and DLQs
   named in the Wrangler configs; preserve their environment-specific D1 IDs.
   Set the same high-entropy service credential as `CONNECTOR_SERVICE_TOKEN` on
   the web Worker and `CONNECTOR_SHARED_SECRET` on the connector Worker. This
   credential is only for service authentication; all provider credentials stay
   exclusively on the connector Worker.
   Dry-run each pilot enrollment with
   `node scripts/provision-pilot-host.mjs --env ENV --label "PERSON - PROVIDER"`,
   then repeat with `--apply` from the authenticated release workstation. The
   script inserts only the digest, label, and bounded expiry into
   `host_enrollment_codes`; deliver its one-time plaintext output through a
   separate authenticated private channel.
2. Apply checked-in D1 migrations to staging, then production. Migration 0006
   creates account/session data, the room registry and idempotent projections;
   migration 0008 adds the fail-closed account-deletion coordinator.
3. Follow `docs/PILOT_RELEASE.md` for deployment. The Cloudflare Vite plugin
   selects staging or production at build time, so use the checked-in
   `npm run deploy:cloudflare -- --env ...` wrapper; never build the default
   environment and add `--env` only at deploy time. Exercise passkey creation,
   guest fragment exchange, HTTP commands, WebSocket reconnect, and projection
   lag in staging before production.
4. Preserve the completed owner-approved full-zone `ashlr.ai` cutover described
   in `docs/PILOT_RELEASE.md`. Every Vercel destination remains hosted on
   Vercel; Cloudflare is authoritative DNS. Verify apex, mail, verification,
   Railway, wildcard, DKIM, and delegated Vercel ACME records before any DNS
   change. Never delegate `staging` separately or improvise a
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
complete unless that authority import succeeds. The room authority deterministically
hydrates supported room rules, suggestions, and canonical queue occurrences from
the imported snapshot while discarding legacy participant identities and votes.
Malformed or unsupported fields remain only in the lossless raw export. The API
reports `fullExportImportedIntoAuthority`; the import event records `rulesHydrated`
and `occurrenceCount` so operators can verify exactly what entered live authority.

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
- Account deletion requires a passkey verified in the previous five minutes, the
  exact confirmation phrase, and a 22-128 character idempotency key. The server
  stores only a hash of that key and immediately locks the account for every
  normal host action. It then purges connector-private provider data, every owned
  room authority, and finally all D1 identity, session, room, recap, and provider
  records. Completed room purges are checkpointed so a retry skips them. A failed
  stage stays locked and must be retried with the same key; a completed receipt
  contains no account ID and expires after 24 hours.
- Cron removes expired challenges/sessions and projection receipts after 30 days.
  Account deletion overrides normal room-detail and derived-recap retention
  immediately.

## Stop and rollback

Stop rollout on capability/token exposure, command divergence, duplicate provider
mutation, or any provider failure affecting room commands. After Durable Object
writes begin, roll back only to a release that continues routing the same room IDs
to the same Durable Object class and namespace. Never reactivate the public legacy
D1 writer as a general rollback.
