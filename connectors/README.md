# UniJam connector Worker

This directory is the isolated provider boundary. It performs real Spotify and
Apple Music HTTP requests, but contains no credentials or simulated success
paths. The application Worker must call it through a private service binding
and authenticate every non-health request with `CONNECTOR_SHARED_SECRET`.
`workers.dev` and version preview URLs are explicitly disabled in every
environment. Do not add a public route to the connector Worker.

## Required bindings

- D1 binding `CONNECTOR_DB`, initialized from `connectors/migrations`.
- Queue binding `PUBLISH_QUEUE` plus a consumer for publish and reconciliation messages shaped as
  `{ version: 1, type: "publish_destination" | "reconcile_destination",
  operationId }`.
- Secrets: `CONNECTOR_SHARED_SECRET`, `CONNECTOR_OPERATOR_SECRET`,
  `TOKEN_ENCRYPTION_KEY_B64URL` (exactly 32
  random bytes, base64url), `TOKEN_KEY_VERSION`, `SPOTIFY_CLIENT_ID`,
  `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY_JWK` (private P-256
  JWK). Spotify uses Authorization Code with PKCE and therefore sends the
  client ID, code verifier, and exact redirect URI without a client secret.
- Variables: `PUBLIC_APP_ORIGIN` (`https://unijam.ashlr.ai` in production),
  `PILOT_ACCOUNT_ALLOWLIST` (comma-separated internal account IDs), and the
  four explicit flags `SPOTIFY_ENABLED`, `APPLE_MUSIC_ENABLED`,
  `SPOTIFY_PUBLISHING_ENABLED`, `APPLE_MUSIC_PUBLISHING_ENABLED`.

Every feature flag defaults closed. Production and staging need separate D1,
Queue, secrets, OAuth registrations, and Apple keys. The exact Spotify callback
is `https://unijam.ashlr.ai/api/v1/providers/spotify/callback`; the application
route forwards the callback code, state, and exact callback URL to the private
connector route.

For Apple Music, the trusted web service first calls
`POST /v1/apple-music/developer-token` with `{ accountId, origin }`. The
connector returns a 15-minute ES256 developer token and expiry, never the
private JWK. The browser uses that token with MusicKit authorization, and the
web service forwards the resulting Music User Token to
`POST /v1/connections/apple-music` with
`{ accountId, connectionId, musicUserToken, origin }` for live US-storefront
validation and encrypted storage.

## Internal HTTP contract

Except for `GET /health`, every route requires
`Authorization: Bearer <CONNECTOR_SHARED_SECRET>` and `application/json`. The
connector has no browser CORS contract. The trusted web service derives the
host account, room, recent-passkey requirement, and connection identifier; it
must never forward client-asserted authority fields directly.

| Method and path | JSON body |
| --- | --- |
| `POST /v1/oauth/spotify/authorize` | `{ accountId, connectionId, origin }` |
| `POST /v1/oauth/spotify/callback` | `{ code, state, callbackUrl }` |
| `POST /v1/apple-music/developer-token` | `{ accountId, origin }` |
| `POST /v1/connections/apple-music` | `{ accountId, connectionId, musicUserToken, origin }` |
| `POST /v1/connections/status` | `{ accountId, connectionId, provider }` |
| `DELETE /v1/connections/{spotify\|apple-music}` | `{ accountId, connectionId }` |
| `POST /v1/accounts/purge` | `{ accountId }` |
| `POST /v1/catalog/query` | `{ accountId, connectionId, provider, mode, ... }` |
| `POST /v1/publish/preview` | `{ accountId, connectionId, roomId, roomRevision, provider, playlistName, playlistDescription?, items }` |
| `POST /v1/publish/confirm` | `{ accountId, previewId, payloadFingerprint, confirmedAtMs }` |
| `POST /v1/publish/operation` | `{ accountId, operationId }` |
| `POST /v1/publish/retry` | `{ accountId, operationId }` |
| `POST /v1/publish/cancel` | `{ accountId, operationId }` |
| `POST /v1/operator/publish/recover-playlist` | `{ operationId, expectedRecoveryMarker, destinationPlaylistId }` |

`provider` is `spotify` or `apple_music`. Catalog `mode` is `recording_id`,
`isrc`, or `search`. Preview `items` contain only
`{ canonicalRecordingId, providerRecordingId }`. Confirmation loads the
connector-persisted preview and compares its fingerprint; the caller cannot
replace the approved destination or item list. Confirm and retry enqueue work,
while operation status and cancel affect only that provider destination.
Operation status includes `destinationUrl` only when the provider returned a
validated official HTTPS URL. Spotify create responses normally provide one;
Apple Music private library-playlist responses do not guarantee a share URL,
so callers must support `null` and must never construct an Apple Music slug.

Operator recovery additionally requires
`X-UniJam-Operator-Authorization: Bearer <CONNECTOR_OPERATOR_SECRET>`. The
operator must supply the exact persisted recovery marker. The connector reads
the candidate playlist with the operation's encrypted provider connection,
requires exact name, embedded recovery marker, private/editable ownership, and
zero raw items before atomically attaching it. Resolution evidence retains only
a destination hash and nonreversible operator-credential fingerprint. The
same request is idempotent; a different marker or playlist is rejected.
The connector route remains service-bound and is never called directly from an
operator shell. A separately deployed operator ingress must be protected by
Cloudflare Access, validate the Access assertion, hold its own matching
`CONNECTOR_SHARED_SECRET`, and invoke the connector through a service binding.
Provisioning and validating that ingress is an external release gate.

## Operational boundaries

- OAuth state is stored only as a SHA-256 hash and consumed once. PKCE verifiers
  expire after five minutes.
- Provider tokens are AES-256-GCM encrypted with account, connection, provider,
  and key version in additional authenticated data.
- Every external playlist mutation requires an atomic D1 lease bound to the
  connection generation. Concurrent deliveries receive the existing lease;
  only its fencing token can persist the response. The generation is checked
  immediately before the provider request and again after its response.
- An expired append lease is treated as a crash-after-commit and must reconcile
  the provider playlist before another append. An expired playlist-creation
  lease is never replayed: it records `PLAYLIST_CREATION_OUTCOME_UNKNOWN` with
  a deterministic marker for operator recovery.
- Disconnect atomically revokes the connection generation and deletes its
  encrypted token, OAuth attempts, previews, and publish jobs. Stale refreshes
  cannot reactivate the revoked generation. Account purge applies the same
  deletion across every connection, and the hourly cron removes expired OAuth
  attempts/previews plus terminal operations older than 30 days.
- A partial append or timeout-after-write enters reconciliation before another
  append. An ambiguous initial playlist creation is deliberately not retried
  automatically because neither provider supplies a mutation idempotency key;
  it remains visible for operator reconciliation and rejects ordinary retries.
- Provider response bodies and credentials are never logged, analyzed, or sent
  to an AI/ML system.

`wrangler.connectors.jsonc` defines closed-by-default development, staging, and
production environments. Its sentinel D1 IDs must be replaced during resource
provisioning; staging and production must receive different secrets and queues.
