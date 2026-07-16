# UniJam pilot release runbook

This runbook is the release authority for the invite-only US pilot at
`https://unijam.ashlr.ai`. It intentionally separates code readiness from
external activation. Do not describe the pilot as deployed until the strict
configuration checks, staging acceptance, load gates, provider checks, and DNS
verification below all pass.

## Current release status — 2026-07-15

The repository is not currently deployable to Cloudflare. This is expected and
enforced:

- `wrangler.jsonc` and `wrangler.connectors.jsonc` still contain four
  non-routable D1 sentinel IDs. `npm run validate:release-config` reports them;
  either strict deploy validator exits nonzero until they are replaced.
- The current automation session is not authenticated to Cloudflare, so zones,
  D1 databases, Queues, DLQs, Worker services, custom domains, and nameservers
  have not been created or verified.
- Cloudflare has not supplied nameservers for a `unijam.ashlr.ai` child zone.
  No Vercel DNS record has been changed.
- Production and staging connector secrets, Spotify app registrations, Apple
  Music identifiers/keys, Music User Tokens, and pilot account IDs are absent.
- Spotify extended-quota approval remains the public-launch gate. The pilot is
  limited to at most five allowlisted Spotify hosts and five Apple Music
  subscribers.
- The temporary authenticated Sites export endpoint and a real Sites export
  fixture are external migration prerequisites. The existing Sites deployment
  must remain private and read-only.
- The 10-room load smoke and 60-minute soak have not run because Cloudflare
  resources and authenticated load sessions do not exist yet.

None of these blockers should be replaced with test credentials, placeholder
secrets, a simulated provider connection, or an unverified deployment claim.

## Non-negotiable environment boundaries

| Boundary | Staging | Production |
| --- | --- | --- |
| Web Worker | `unijam-web-staging` | `unijam-web-production` |
| Connector Worker | `unijam-connectors-staging` | `unijam-connectors-production` |
| Origin | `https://staging.unijam.ashlr.ai` | `https://unijam.ashlr.ai` |
| WebAuthn RP ID | `staging.unijam.ashlr.ai` | `unijam.ashlr.ai` |
| Web D1 | `unijam-staging` | `unijam-production` |
| Connector D1 | `unijam-connectors-staging` | `unijam-connectors-production` |
| Projection Queue | `unijam-room-projection-staging` | `unijam-room-projection-production` |
| Projection DLQ | `unijam-room-projection-staging-dlq` | `unijam-room-projection-production-dlq` |
| Publish Queue | `unijam-publishing-staging` | `unijam-publishing-production` |
| Publish DLQ | `unijam-publishing-staging-dlq` | `unijam-publishing-production-dlq` |

Every D1 ID, Worker service, Durable Object namespace, Queue, DLQ, secret,
provider registration, passkey, pilot account, and load fixture must remain
environment-specific. Never copy a production token database into staging.

Provider secrets are connector-only. The web Worker receives only
`CONNECTOR_SERVICE_TOKEN`; the connector Worker receives the matching
`CONNECTOR_SHARED_SECRET` plus provider and encryption secrets. Use a different
service token and encryption key in each environment.

## 1. Preflight and evidence capture

Use Node 24 and a clean, reviewed commit. Capture command output in the private
release record, never in a public issue when it can contain account or resource
identifiers.

```bash
node --version
npm ci
npm run lint
npm test
npm run test:e2e
npm run validate:release-config
npm run preflight:staging
```

`preflight:staging` is read-only. It combines strict configuration validation
with Cloudflare authentication, D1/Queue inventory, Worker deployment,
secret-name (never value), and HTTPS-origin checks. Before provisioning it must
fail with explicit blockers. After staging activation, save its output in the
private release record. Run `npm run preflight:production` before DNS delegation
and again after production deployment. Use `-- --json` for machine-readable
evidence; `--offline` is only for testing the local report contract and never
satisfies a release gate.

Repository validation may report only the four known D1 sentinel warnings
before provisioning. Any other warning or any error blocks provisioning.

Before touching DNS, export or screenshot all Vercel-managed `ashlr.ai` records
and record the apex resolution:

```bash
npx vercel dns list ashlr.ai --scope Evero
dig +short NS ashlr.ai
dig +short A ashlr.ai
dig +short AAAA ashlr.ai
```

The release operator must confirm that the current apex, email, verification,
and unrelated subdomain records remain represented in the evidence. The only
permitted Vercel DNS mutation is adding NS records at the `unijam` label.

## 2. Create the Cloudflare child zone and resources

Authenticate the operator and confirm the intended Cloudflare account before
creating anything:

```bash
npx wrangler login
npx wrangler whoami
```

Create a Cloudflare zone whose exact zone name is `unijam.ashlr.ai`. Do not add
or transfer the `ashlr.ai` apex zone. `staging.unijam.ashlr.ai` is a hostname
inside this one delegated child zone; it does not need a second delegation.
Record both nameservers assigned by Cloudflare, but do not add them at Vercel
yet.

Create the four isolated D1 databases:

```bash
npx wrangler d1 create unijam-staging
npx wrangler d1 create unijam-production
npx wrangler d1 create unijam-connectors-staging
npx wrangler d1 create unijam-connectors-production
```

Replace only the matching sentinel `database_id` fields in the two Wrangler
files. Never reuse an ID across environments or between web and connectors.

Create each Queue and its actual DLQ:

```bash
npx wrangler queues create unijam-room-projection-staging
npx wrangler queues create unijam-room-projection-staging-dlq
npx wrangler queues create unijam-publishing-staging
npx wrangler queues create unijam-publishing-staging-dlq
npx wrangler queues create unijam-room-projection-production
npx wrangler queues create unijam-room-projection-production-dlq
npx wrangler queues create unijam-publishing-production
npx wrangler queues create unijam-publishing-production-dlq
```

Run strict validation immediately. It checks sentinel removal, exact names,
origins, RP IDs, D1/Queue separation, service bindings, closed flags, migration
ordering, secret boundaries, and pinned Actions.

```bash
npm run validate:deploy:staging
npm run validate:deploy:production
```

Both commands must exit zero before any remote migration or deployment.

## 3. Install secrets without crossing the connector boundary

Generate and install a different high-entropy internal service credential for
each environment. Keep it in a shell variable only long enough to write the two
matching Worker secrets, then unset it:

```bash
read -r -s CONNECTOR_SERVICE_CREDENTIAL
printf %s "$CONNECTOR_SERVICE_CREDENTIAL" | npx wrangler secret put CONNECTOR_SHARED_SECRET --config wrangler.connectors.jsonc --env staging
printf %s "$CONNECTOR_SERVICE_CREDENTIAL" | npx wrangler secret put CONNECTOR_SERVICE_TOKEN --config wrangler.jsonc --env staging
unset CONNECTOR_SERVICE_CREDENTIAL
```

Repeat with a newly generated value and `--env production`.

Generate a separate operator-only credential per environment and install it
only on the connector Worker as `CONNECTOR_OPERATOR_SECRET`. Never install or
expose this credential on the web Worker; it gates the manual ambiguous-create
recovery route in addition to the connector service credential.

Install the following on `unijam-connectors-staging`, then install independent
production values on `unijam-connectors-production`:

- `TOKEN_ENCRYPTION_KEY_B64URL`: exactly 32 random bytes encoded as unpadded
  base64url. A suitable source value is
  `openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'`.
- `TOKEN_KEY_VERSION`: a non-secret-looking but secret-bound immutable version
  label such as `staging-2026-07-k1`; changing it without a re-encryption plan
  makes existing envelopes unreadable.
- `SPOTIFY_CLIENT_ID`: the client ID for that environment's Spotify app. PKCE
  does not use a Spotify client secret.
- `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY_JWK`: the Apple Music
  identity values and the private P-256 key represented as a JWK. The private
  JWK never belongs in a file, GitHub secret output, web Worker, or browser.

Use `npx wrangler secret put NAME --config wrangler.connectors.jsonc --env ENV`
for each connector secret. Verify names with `wrangler secret list`; do not print
values.

`PILOT_ACCOUNT_ALLOWLIST` contains comma-separated internal UniJam account IDs,
not email addresses or provider IDs. Start empty. Add at most five explicitly
approved pilot hosts per environment after they enroll passkeys. Keep all four
provider flags `false` for the baseline deployment.

Set `LEGACY_MIGRATION_SECRET` on the web Worker only when an authenticated Sites
migration is scheduled. `ENABLE_LEGACY_ROOM_API` must stay `false` except for
the bounded import window; unset the secret and redeploy the closed config when
that window ends.

## 4. Apply D1 migrations

Migrate staging connector D1 before staging web D1. Review the pending list and
backup metadata in the release record, then apply:

```bash
npx wrangler d1 migrations list unijam-connectors-staging --config wrangler.connectors.jsonc --env staging --remote
npx wrangler d1 migrations apply unijam-connectors-staging --config wrangler.connectors.jsonc --env staging --remote
npx wrangler d1 migrations list unijam-staging --config wrangler.jsonc --env staging --remote
npx wrangler d1 migrations apply unijam-staging --config wrangler.jsonc --env staging --remote
```

Inspect the migration list again and verify there are no pending files. Apply
production only after the staging deployment and migration tests pass:

```bash
npx wrangler d1 migrations list unijam-connectors-production --config wrangler.connectors.jsonc --env production --remote
npx wrangler d1 migrations apply unijam-connectors-production --config wrangler.connectors.jsonc --env production --remote
npx wrangler d1 migrations list unijam-production --config wrangler.jsonc --env production --remote
npx wrangler d1 migrations apply unijam-production --config wrangler.jsonc --env production --remote
```

D1 backups do not roll back a Durable Object schema or room event stream. Save
the pre-migration D1 backup identifiers, but never treat a D1 restore as a
complete application rollback.

## 5. Build and deploy without environment flattening

The Cloudflare Vite plugin selects an environment at **build time**. The only
safe staging or production build sets `CLOUDFLARE_ENV` before `vite build`.
Running a default build and later adding `wrangler deploy --env staging` or
`--env production` can deploy a flattened development artifact with the wrong
origin, RP ID, D1, queues, and missing connector binding.

The checked-in release script enforces this contract. It builds with the exact
`CLOUDFLARE_ENV`, validates `dist/server/wrangler.json`, rejects development
bindings and D1 sentinels, and deploys the already-flattened artifact without a
second `--env` override.

Deploy the connector first because the web Worker has a private service binding
to its exact service name:

```bash
npx wrangler deploy --config wrangler.connectors.jsonc --env staging
npm run dry-run:cloudflare -- --env staging
npm run deploy:cloudflare -- --env staging
```

Do not run `wrangler deploy` directly for the web Worker. For production, repeat
the connector-first sequence and require the explicit confirmation phrase:

```bash
npx wrangler deploy --config wrangler.connectors.jsonc --env production
npm run dry-run:cloudflare -- --env production
npm run deploy:cloudflare -- --env production --production-confirmation I_UNDERSTAND_THIS_DEPLOYS_PRODUCTION
```

The first environment-specific web deployment creates that service's Durable
Object namespace and applies the SQLite class migration. Confirm deployments,
bindings, and tail logs before adding traffic. A healthy baseline has all
provider flags closed; provider routes must return an honest unavailable/closed
state rather than simulated success.

## 6. Configure provider registrations

Use separate staging and production Spotify app registrations where the
provider permits it. Register exact redirect URIs—no wildcard, alternate host,
path variation, trailing slash, or HTTP production callback:

- `https://staging.unijam.ashlr.ai/api/v1/providers/spotify/callback`
- `https://unijam.ashlr.ai/api/v1/providers/spotify/callback`

Spotify uses Authorization Code with PKCE. Verify the returned state is
single-use, expires after five minutes, and the connector sends the exact origin
callback. Keep the production allowlist at five or fewer hosts until Spotify
quota approval is recorded.

Configure Apple Music/MusicKit identifiers for the exact HTTPS staging and
production origins. The connector creates 15-minute ES256 developer tokens;
the browser obtains a Music User Token through MusicKit, and only the connector
stores it encrypted. Verify the US storefront, private playlist creation, and
that the private JWK never crosses into the web Worker or client bundle.

Provider disconnect testing is mandatory: it must delete encrypted tokens,
cancel outstanding work, and prevent a queued job from regaining credentials.

## 7. Delegate only the child zone

Proceed only after staging works through a temporary Cloudflare hostname or
operator-controlled resolution and production Workers/custom domains are
healthy. In the Vercel DNS controls for `ashlr.ai`, add the two Cloudflare-
assigned NS records at the exact host label `unijam`.

Do not change the `ashlr.ai` nameservers. Do not replace, delete, import, or
recreate the apex zone. Do not add NS records at `@`. Do not separately delegate
`staging`; Cloudflare already controls it inside the delegated child zone.

Immediately verify:

```bash
dig +short NS unijam.ashlr.ai
dig +short NS ashlr.ai
dig +short HTTPS unijam.ashlr.ai
curl --fail --silent --show-error --include https://unijam.ashlr.ai/
curl --fail --silent --show-error --include https://staging.unijam.ashlr.ai/
```

The child lookup must return exactly Cloudflare's assigned nameservers. The apex
NS and all unrelated `ashlr.ai` resolution must match the preflight evidence.
Check from at least two public resolvers before inviting pilot users.

## 8. Passkey and migration activation

Create each pilot enrollment code with:

```bash
node scripts/create-enrollment-code.mjs
```

Insert only the emitted hash, label, and expiry into the matching environment's
`host_enrollment_codes` table. Deliver the plaintext once through a separate
secure channel. Verify discoverable passkey enrollment, authentication,
additional credential enrollment after recent passkey confirmation, all ten
single-use recovery codes, logout, and staging/production RP isolation.

Keep Sites private and read-only throughout migration. The temporary Sites
export must be authenticated and versioned. For each room:

1. Export settings, snapshots, ordered events, and history.
2. Compute and record the canonical export hash.
3. Import through the migration endpoint while the bounded migration flag and
   secret are active.
4. Re-import the same payload to verify idempotency; a different hash for the
   same legacy room must conflict.
5. Claim with both a recently verified passkey and the legacy host capability.
6. Verify the complete payload exists in room-local SQLite, guest sessions were
   invalidated, and the returned invite capability is rotated.
7. Compare source/export/import hashes before marking the room migrated.

Legacy guest exchange ends after 30 days. Host claim ends after 90 days;
unclaimed data becomes read-only export material before deletion. Once
Durable-Object-native writes begin, never roll back to the legacy public D1
writer. The only permissible application rollback is a reviewed
dual-authority-compatible release that preserves the same room IDs, Durable
Object class, and namespace.

## 9. Stage feature flags independently

Every step begins in staging and requires provider contract tests, live error
injection (401/403, 429 with `Retry-After`, 5xx, malformed response, ambiguous
timeout), disconnect, kill-switch, and room-independence verification.

1. Baseline: all four flags `false`.
2. Spotify resolution/handoff: `SPOTIFY_ENABLED=true`; publishing remains
   false. Verify ID/ISRC-first matching, visible holds, approved links, and only
   requested/opened/host-confirmed handoff states.
3. Apple Music resolution/handoff: `APPLE_MUSIC_ENABLED=true`; both publishing
   flags remain false. Verify MusicKit and US storefront handling independently.
4. Spotify publishing: `SPOTIFY_PUBLISHING_ENABLED=true`. Publish only to the
   immutable, explicitly confirmed private destination; test timeout-after-
   commit reconciliation and zero duplicate additions.
5. Apple Music publishing: `APPLE_MUSIC_PUBLISHING_ENABLED=true`. Verify private
   playlist creation, propagation-aware reconciliation, and partial-success
   isolation.

### Ambiguous playlist-creation recovery

If an operation reports `PLAYLIST_CREATION_OUTCOME_UNKNOWN`, ordinary retries
must remain blocked. Inspect the provider account, identify the exact empty
playlist created by the timed-out request, and record the persisted recovery
marker. Export the two staging connector credentials only in the operator shell
as `UNIJAM_CONNECTOR_SERVICE_TOKEN` and
`UNIJAM_CONNECTOR_OPERATOR_SECRET`, then run a dry validation before sending
anything:

```bash
npm run recover:publish -- \
  --env staging \
  --endpoint https://unijam-connectors-staging.ACCOUNT.workers.dev/v1/operator/publish/recover-playlist \
  --workers-subdomain ACCOUNT \
  --operation-id OPERATION_ID \
  --marker RECOVERY_MARKER \
  --playlist-id PROVIDER_PLAYLIST_ID \
  --dry-run
```

Remove `--dry-run` only after a second operator verifies the operation, marker,
provider, and that the destination is empty. The connector independently reads
the playlist, checks its exact name, embedded marker, private/editable ownership,
raw item count, and active connection generation before atomically attaching it.
It stores only hashed destination and operator-credential evidence, then queues
reconciliation. The script never prints the operation, marker, playlist
ID, or credentials. Production additionally requires
`--production-confirmation I_UNDERSTAND_THIS_RESUMES_A_PROVIDER_MUTATION`.
Unset both shell credentials immediately after the drill.

Promote one flag at a time to production and observe a controlled cohort before
opening the next. A failure in one provider must never block room commands,
handoff to the other provider, or the other publish destination.

## 10. Load smoke and 60-minute soak

The harness uses real authenticated WebSockets and HTTP state, never an internal
actor header or capability bypass. Its private manifest has this shape:

```json
{
  "version": 1,
  "smokeRooms": [
    {
      "roomId": "ROOM1234",
      "sessions": [
        { "label": "guest-01", "cookie": "__Host-unijam_guest=opaque-value" }
      ]
    }
  ],
  "soakRoom": {
    "roomId": "SOAK1234",
    "sessions": [
      { "label": "guest-01", "cookie": "__Host-unijam_guest=opaque-value" }
    ]
  }
}
```

The actual smoke manifest must have exactly 10 rooms × 20 distinct active
sessions; the soak room must have exactly 25 distinct active sessions. Obtain
them through normal controlled joins from the staging cohort. The harness does
not mint sessions or bypass the per-IP join limit. Store the file outside Git or
as ignored `load-manifest*.json`, permission it to the operator only, and delete
it immediately after the test. Reports contain no cookie values and are written
with owner-only permissions under `test-results/load/`.

Run the staging smoke with D1 projection measurement:

```bash
npm run load:smoke -- \
  --manifest ./load-manifest.staging.json \
  --target https://staging.unijam.ashlr.ai \
  --projection-database unijam-staging \
  --wrangler-env staging \
  --projection-mode remote \
  --require-projection
```

Run the required 60-minute, 25-participant soak:

```bash
npm run load:soak -- \
  --manifest ./load-manifest.staging.json \
  --target https://staging.unijam.ashlr.ai \
  --duration-minutes 60 \
  --projection-database unijam-staging \
  --wrangler-env staging \
  --projection-mode remote \
  --require-projection
```

The commands fail unless all applicable gates pass: command acknowledgement p95
under 250 ms, reconnect p95 under 2 seconds, D1 projection p95 under 5 seconds,
zero acknowledged/canonical sequence divergence, zero command errors, zero
malformed messages, zero conflicting canonical event IDs, and zero duplicate
event deliveries. Attach the JSON reports to the private release record.

The default target is `http://127.0.0.1:8787`. Production is blocked unless the
operator supplies both `--allow-production` and
`--production-confirmation I_UNDERSTAND_THIS_MUTATES_LIVE_ROOMS`; a production
soak cannot be shortened below 60 minutes. Production load is not part of the
initial pilot gate unless separately approved.

### Staging WebSocket hibernation and revocation assurance

Run the dedicated lifecycle check after the staging custom domain, D1, and
Durable Object namespace are live. Cloudflare's hibernation lifecycle currently
transitions an eligible Durable Object after 10 seconds without an event; the
harness leaves both sockets completely idle for 15 seconds by default, then
sends `hello` on the same host and guest connections. See Cloudflare's
[Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
and [hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
documentation for the platform contract.

This check is intentionally destructive to its fixture: it rotates the guest
invite and logs out the host session. Create a disposable staging room, join one
guest normally, and run within five minutes of the host's passkey confirmation.
Store this manifest outside Git with owner-only permissions:

```json
{
  "version": 1,
  "origin": "https://staging.unijam.ashlr.ai",
  "disposable": true,
  "roomId": "STAGE123",
  "hostCookie": "__Host-unijam_host=opaque-session-token-from-browser",
  "guestCookie": "__Host-unijam_guest=opaque-session-token-from-browser"
}
```

Run:

```bash
chmod 600 ./hibernation-manifest.staging.json
npm run assure:websocket:staging -- \
  --manifest ./hibernation-manifest.staging.json \
  --output ./test-results/assurance/staging-hibernation.json
rm ./hibernation-manifest.staging.json
```

The command refuses every origin except the exact staging origin, and it
validates that boundary before reading the manifest. It records only redacted
evidence: the idle interval, initial and resumed sequence cursors, same-socket
resume status for both actors, guest close code `1008` plus rejected stale-cookie
upgrade `401`, host close code `1008` after logout plus rejected stale-cookie
upgrade `401`, and pass/fail. It never records room/participant identity,
cookies, invite capabilities, response bodies, or new invite links. A passing
local WebSocket test is not a substitute for this deployed lifecycle evidence.

## 11. Pilot acceptance and observability

Before each feature promotion, verify the complete room loop with Chromium and
WebKit, keyboard-only operation, VoiceOver/Safari, NVDA/Chrome, 200% and 400%
zoom, reduced motion, forced colors, 320 px reflow, and zero serious/critical
axe findings.

Record and alert on:

- command acknowledgement latency and rejection codes;
- WebSocket reconnect duration and snapshot-reset frequency;
- Durable Object event/command sequence divergence;
- Queue attempts, oldest-message age, DLQ depth, and redelivery deduplication;
- D1 projection lag;
- connector 401/403 reconnect requirements, 429 delay, 5xx, and kill-switch
  state;
- publish operation/item status, reconciliation state, and ambiguous mutations;
- passkey, recovery, invite rotation, provider/destructive recent-passkey, and
  migration audit events.

Do not log cookies, capabilities, OAuth codes/state, PKCE verifiers, Music User
Tokens, provider access/refresh tokens, Apple private JWKs, decrypted envelopes,
or provider response bodies that contain private content.

## Stop conditions and incident actions

Stop immediately on any of the following:

- token, cookie, invite capability, recovery code, provider secret, or private
  provider data exposure;
- canonical room/event divergence, silently discarded accepted command, or
  duplicate event mutation;
- publication without the immutable preview and explicit owner confirmation;
- duplicate provider mutation or an ambiguous mutation being retried without
  reconciliation;
- one provider failure blocking room operation or the other provider;
- production/staging resource crossover, wrong RP ID/origin, development binding
  in a deploy artifact, or unexpected apex DNS change.

Contain provider incidents without stopping rooms: set the affected connection
and publishing flags to `false`, deploy the connector, and pause its Queue if
necessary with `wrangler queues pause-delivery QUEUE_NAME`. Preserve DLQ and
operation evidence; do not purge until reconciliation is complete. Disconnect
exposed accounts so encrypted tokens are deleted and queued jobs lose access.

For a room-authority incident, stop inviting/creating rooms and deploy only a
known compatible Worker version that retains the same Durable Object class,
namespace, room ID routing, and command/event schema. Do not restore the legacy
writer. For a DNS incident, remove only the two child-zone NS records added at
the `unijam` label; verify the `ashlr.ai` apex and unrelated records remain
unchanged.

## Release sign-off

The pilot is ready only when the private release record contains:

- reviewed commit SHA and green lint/test/build/Playwright/security CI;
- strict staging and production config-validator output;
- environment-specific artifact-validator and Wrangler dry-run output;
- D1 migration/backup IDs and zero pending migrations;
- Worker version IDs, resource inventory, Queue/DLQ bindings, and custom domains;
- provider registration evidence and secret-name inventory (never values);
- DNS before/after evidence proving child-only delegation;
- migration source/export/import hash reconciliation;
- passing staging WebSocket hibernation/revocation assurance evidence;
- passing 10 × 20 smoke and 60-minute 25-participant soak reports;
- accessibility scripts/results and provider failure-injection results;
- named pilot accounts, feature-flag sequence, stop owner, and rollback owner;
- Spotify quota status explicitly marked pilot-only or public-approved.

If any item is missing, the honest state is “release candidate” or “blocked,”
not “production complete.”
