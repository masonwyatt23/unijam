# UniJam connector boundaries

Verified against the public Spotify and Apple Music documentation on 2026-07-15.

## Product contract

UniJam is the realtime collaboration authority. It owns room membership, roles, the queue, suggestions, votes, fairness, readiness, presence, history, and conflict decisions. Spotify and Apple Music are playback and optional publish destinations; neither provider playlist is the collaboration database.

The defensible flagship promise is:

> One room. Every guest. Their preferred music app. One host speaker.

Guests can join without provider OAuth, shape the same authoritative queue, and open a resolved track in their chosen music app. A native handoff is recorded as opened or requested, never as verified playback until the host confirms it.

## Public API reality

| Capability | Spotify | Apple Music |
| --- | --- | --- |
| Create a user playlist | Yes | Yes |
| Append tracks | Yes, up to 100 per request | Yes, append-only public operation |
| Insert, remove, reorder, or replace | Supported for Spotify playlists | No documented public endpoints |
| Playlist revision token | `snapshot_id` | None documented |
| Playlist mutation webhook | None documented | None documented |
| Collaborator role management | None documented | None documented |
| Verified playback after a deep link | No callback | No callback |

Sources: Spotify playlist [create](https://developer.spotify.com/documentation/web-api/reference/create-playlist), [items](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items), [add](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist), [reorder/replace](https://developer.spotify.com/documentation/web-api/reference/reorder-or-replace-playlists-items), and [remove](https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist) operations; Apple Music playlist [create](https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist), [append](https://developer.apple.com/documentation/applemusicapi/add-tracks-to-a-library-playlist), and [playlist API collection](https://developer.apple.com/documentation/applemusicapi/playlists-api).

## Connector architecture

1. Accept a user command into UniJam with an idempotency key.
2. Resolve the canonical recording separately for each destination storefront.
3. Show a destination-specific preview and require explicit owner approval.
4. Write through a durable per-destination outbox.
5. On timeout, read before retrying because neither provider documents mutation idempotency keys.
6. Use Spotify `snapshot_id` for optimistic reconciliation.
7. Treat Apple publishing as append-only and reconcile after its documented propagation delay.
8. Keep failures isolated: one destination can pause or reconnect without blocking the room.

### Code and credential boundary

- Application and room code may construct a provider request with an opaque
  `credentialRef`; it must not receive access tokens, refresh tokens, Music
  User Tokens, client secrets, or Apple signing keys.
- The connector Worker resolves the credential reference, decrypts a versioned
  AES-256-GCM envelope, invokes the matching adapter, and returns normalized
  catalog observations or safe operation outcomes. AES-GCM additional data is
  bound to provider, account, connection, and key version so ciphertext cannot
  be moved between connections.
- Catalog adapters expose ID lookup, ISRC lookup, and neutral metadata search.
  Publishing adapters expose private-playlist creation, playlist reads, and
  append operations. Provider-specific wire payloads do not cross the adapter
  boundary.
- Spotify development-mode compatibility follows the February 2026 contract:
  search requests are capped at 10 results, playlist contents use the current
  `/items` endpoints, and playlist summaries read `items.total` rather than the
  retired `tracks.total` field. OAuth requests only private-playlist access and
  `user-read-private`, which is required to compare the current user with a
  candidate playlist owner during fail-closed operator recovery.
- The short-lived Apple developer token exposed to MusicKit on the Web carries
  an exact `origin` claim for the active UniJam environment. Connector-only
  developer tokens are generated separately and never exposed to the browser.
- Disconnect deletes the encrypted envelope and cancels pending work for that
  destination. The other destination state and the room remain unchanged.

### Retry contract

Publish previews are immutable and destination-specific. Confirmation must
echo the preview ID and exact payload fingerprint and must come from the owner.
Operation IDs and item keys are stable for the room revision.

An authorization failure pauses only that destination for reconnect. A 429
honors its retry time. A definite retryable failure may retry when due. A
partial result or timeout-after-write is ambiguous and **must** read and diff
the destination before retrying; only still-missing item keys may be appended.
Permanent failures remain visible and cancelable rather than affecting the
canonical room.

Native-app edits are eventual. Spotify changes require polling its snapshot and then fetching items. Apple changes require fetching and diffing the ordered relationship because no public revision token is documented.

## Matching policy

Start with deterministic identifiers and neutral metadata:

- Spotify search supports an ISRC filter.
- Apple provides a catalog lookup for up to 25 ISRC values and may return multiple songs for one ISRC.
- Resolve against each listener's market/storefront; a match on one provider does not prove availability on the other.
- Preserve recording/version distinctions and route ambiguity to user confirmation.
- The pilot resolves only the US market/storefront. Provider URLs for another
  storefront are not silently rewritten into US evidence.
- Matching is deterministic: provider recording ID, then normalized ISRC, then
  weighted title/artist/album/duration/explicit/version/edition evidence. A
  duration difference over five seconds, explicit mismatch, version or deluxe
  edition mismatch, unknown availability, US unavailability, or close runner-up
  produces a review hold.
- Apple catalog lookup and search use a short-lived developer token only; they
  never require or load a host's Music User Token. Personalized Apple library
  and publishing calls still require that host's encrypted connection.
- For an Apple Music link resolved into Spotify, the connector reads complete
  Apple catalog metadata and searches only through the room owner's Spotify
  connection. For a Spotify link resolved into Apple Music, UniJam uses only
  Spotify's documented [oEmbed API](https://developer.spotify.com/documentation/embeds/reference/oembed).
  oEmbed exposes a title but not artist, ISRC, duration, or version, so every
  resulting Apple candidate remains held until the submitting participant
  explicitly chooses one through a short-lived, participant-bound resolution
  grant. Title-only metadata can never auto-stage a recording.
- Cross-provider catalog resolution never grants publishing authority. A room
  can publish only with its owner's independently connected provider token.

Do not send Spotify content, metadata, artwork, audio features, or playlist contents into an ML or AI model. Spotify's [Developer Policy](https://developer.spotify.com/policy) prohibits using Spotify Content to train or otherwise ingest into AI/ML models. Any learned matcher must use separately licensed neutral data and user corrections.

The production matching contract contains no `embedding` method. Synthetic
fixtures are used for automated tests; no real user-library data or provider
credentials belong in the repository.

## Launch constraints

- Spotify development mode currently permits five allowlisted authenticated users, and its published extended-quota criteria require an established organization, a launched service, and at least 250,000 MAU. See [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).
- Apple personalized requests need a developer token plus a Music User Token. MusicKit authorization is not UniJam account identity. See [developer tokens](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens) and [user authentication](https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit).
- Cross-service synchronized audio, invisible native collaboration, and perfect bidirectional Apple playlist sync are out of scope without new documented APIs and written partner/legal clearance.

## Copy rules

Use: `room synced`, `opened in Spotify`, `opened in Apple Music`, `host-confirmed start`, `publish preview`, `append`, and `eventual native reconciliation`.

Do not use: `playing` after a deep link, `instant native sync`, `perfect two-way Apple sync`, `native collaborator roles synced`, or `cross-service listening synchronized`.
