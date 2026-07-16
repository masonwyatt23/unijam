# Notes: Seamless Membership and Provider Join

## Starting State
- Branch `codex/pilot-ready-production` at `267dbcec0c23fbbb7843954086be0c1f956e8473`.
- Exact-commit staging web and connector Workers are live with both provider flags closed.
- Guests already join without accounts through fragment capability exchange and room-scoped cookies.
- Hosts use passkeys; provider connections are isolated to the host account and connector Worker.

## Research Log
- Spotify OAuth is per end user; Authorization Code with PKCE grants refreshable user access without a client secret in the browser flow. Exact redirect matching and state remain required.
  - https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
- Spotify development mode currently requires a Premium app owner, supports at most five allowlisted authenticated users, and returns 403 for non-allowlisted access. Extended quota is the broad-audience path, but current published requirements include an established organization, launched service, and at least 250k MAU.
  - https://developer.spotify.com/documentation/web-api/concepts/quota-modes
- Spotify's current profile response exposes `account_id` as the immutable pseudoanonymous account-linking field and explicitly warns not to use email as verified identity.
  - https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile
- Spotify's current policy prohibits non-interactive broadcast, integrating Spotify streams/content with another service, synchronizing/mixing audio, and replacing a core Spotify experience. UniJam must remain a provider-neutral collaborative setlist with independent native handoff unless Spotify grants written approval for more.
  - https://developer.spotify.com/policy
- Apple Music uses one UniJam developer token plus a Music User Token authorized by each subscriber. MusicKit on the Web manages the user token for personalized requests.
  - https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit
- Apple Music personalized endpoints can read libraries and create private playlists after user authorization, but Music User Tokens are app/device scoped and do not expose a stable identity profile for UniJam account login.
  - https://developer.apple.com/musickit/
- Cloudflare's current guidance continues to favor service bindings, Durable Objects for WebSockets, streamed/bounded bodies, Web Crypto, generated binding types, and explicit async handling.
  - https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- Latest retrieved Workers types: `@cloudflare/workers-types@5.20260716.1`.

## Architecture Findings
- `accounts` currently has no host/member permission column. Any authenticated passkey account can already create rooms and connect providers; pilot enrollment is the only thing preventing open membership.
- `host_sessions` is semantically named for the pilot but functions as an authenticated account session joined to `accounts`.
- Guests exchange a URL-fragment capability once for a room-scoped `guest_sessions` cookie and already contribute without provider authorization.
- Provider routes require the authenticated account cookie and isolate tokens by `account_id` in the connector Worker. This is already the correct persistent-member boundary.
- The smallest safe open-membership slice is self-service passkey registration into the existing account/session model, not provider-token identity.
- A signed-in member can join as a guest while retaining both cookies. A nullable `account_id` on `guest_sessions` plus a `room_memberships` table can link participation/history without changing DO participant authority.
- Direct synchronized playback or a true cross-service playback queue is not currently an acceptable implementation target. The canonical UniJam setlist plus user-confirmed native handoff is the compliant product boundary.

## Implementation Evidence
- `00c9c86` adds distinct, rate-limited public passkey registration while preserving pilot enrollment.
- `01a0e26` makes invite entry name-only and adds a real in-room listening preference and upgrade prompt.
- `46c0e38` adds migration `0009`, account-linked guest sessions, and non-authoritative joined-room history.
- `3959971` and `fb8888f` split app-scoped Apple catalog reads from listener-scoped Spotify reads and prove guests cannot borrow the room owner's token.
- Post-review hardening links a guest who signs in after joining without changing participant/role, revokes linked room authority on logout, keeps history from implying rejoin authority, and removes host navigation during unresolved room loading.
- Targeted connector, room-membership, typecheck, UI-contract, and Chromium contribution tests pass during integration.
