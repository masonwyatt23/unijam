# UniJam roadmap

The roadmap is ordered by product risk, not by visual novelty. Each phase must
leave the room honest and useful when either provider is unavailable.

## Phase 1: Playable canonical queue

Turn accepted suggestions into stable queue occurrences.

Acceptance criteria:

- Every approved suggestion creates exactly one occurrence.
- Duplicate recordings can be co-signed without duplicating the queue entry.
- Reordering and advancing target occurrence IDs rather than demo indexes.
- Replays and concurrent approvals cannot create duplicates.
- Snapshot hydration recreates the same queue on every client.

## Phase 2: Neutral catalog resolution

Resolve user intent into storefront-aware Spotify and Apple Music candidates.

Acceptance criteria:

- ISRC-first candidate lookup with version-preserving fallback scoring.
- Regional availability tracked per destination.
- Ambiguous candidates enter a visible review hold.
- User corrections are retained with provenance.
- No restricted provider content enters an AI/ML system.

## Phase 3: Native handoff

Open the active recording in each listener's chosen native app.

Acceptance criteria:

- Safe allowlisted deep links only.
- Installed-app and storefront fallback behavior.
- UI distinguishes requested, opened, and host-confirmed states.
- A service change invalidates a stale handoff.

## Phase 4: Durable publishing

Publish approved room snapshots to provider playlists.

Acceptance criteria:

- Explicit destination preview and owner confirmation.
- Item- and operation-level idempotency keys.
- Read-before-retry after ambiguous provider timeouts.
- Spotify snapshot reconciliation.
- Apple append-only plan with post-write reconciliation.
- Independent destination retry and reconnect states.

## Phase 5: Real-world pilots

Run invite-only events with mixed-platform groups.

Primary measures:

- Median time from opening a link to first contribution
- Invite-to-contributor conversion
- Match-hold rate and correction rate
- Successful handoff rate by provider and storefront
- Host intervention rate
- Room completion and repeat-room rate

## Later opportunities

- Push-based room updates
- Rules and recurring rooms
- Curator and event workspaces
- Provider-neutral analytics
- Additional services with compatible APIs and policies

## Explicit non-goals

- Streaming provider audio through UniJam
- Claiming synchronized audio across independent provider clients
- Scraping private catalogs or bypassing provider access controls
- Silent destructive playlist synchronization
- Training AI/ML systems on restricted provider content
