# UniJam architecture

This document describes the current room platform and the implementation
boundary for Spotify and Apple Music connectors.

## System responsibility

UniJam is the collaboration authority. It owns:

- Room identity and policy
- Participant identity, role, and presence
- Suggestions, approvals, votes, and fair ordering
- Playback handoff state
- Activity history
- Match and publishing decisions

Provider playlists are projections. They may lag, disconnect, or fail without
changing the canonical room.

## Request flow

```mermaid
sequenceDiagram
    participant C as Client
    participant A as Room API
    participant R as Room Durable Object
    participant Q as Projection Queue
    participant D as D1

    C->>A: Exchange invite for participant session
    A->>D: Bind opaque identity, role, and expiry
    C->>A: Submit event with stable event ID
    A->>R: Authorize and forward derived actor + command
    R->>R: Atomically validate, event, snapshot, result, outbox
    R-->>Q: Deliver projection at least once
    Q->>D: Deduplicate and project monotonically
    A-->>C: Return canonical snapshot and cursor
```

Clients may render optimistic feedback, but the server snapshot wins. A rejected
action rolls back to canonical state with a user-visible reason.

## Capability and session model

1. A host creates an opaque room ID, a host capability, and a guest capability.
2. Only capability hashes are persisted.
3. A guest capability is delivered in the URL fragment so it is not sent in
   ordinary HTTP referrers.
4. The capability is exchanged for a short-lived participant session.
5. The server binds nickname, room role, participant role, preferred service,
   session epoch, and expiry to that identity.
6. Invite rotation increments the security boundary and invalidates sessions.

The API never trusts actor name, role, or participant ID supplied by an event
body. Those values come from the authenticated participant session.

## Event model

Room changes are immutable Durable Object events. Commands are keyed by stable
`commandId`; exact actor-scoped intent returns the original acknowledgement,
while different intent returns `COMMAND_ID_CONFLICT`.

The ordered reducer builds a compact canonical snapshot containing participants,
suggestions, votes, readiness, reactions, playback phase, and queue position.
Snapshot writes use compare-and-swap semantics so concurrent projectors converge.

Important event properties:

- Payloads are normalized and size bounded.
- Commands are role scoped.
- Duplicate delivery is a no-op.
- Out-of-order or stale sequences cannot roll state backward.
- Track-scoped actions are rejected after the current track changes.
- Votes are participant sets, not increment-only counters.

## Presence and rate limiting

Participant sessions carry `last_seen_at_ms`. Presence is active only while a
session is unexpired and its heartbeat is recent.

Rate limits use atomic D1 buckets at three scopes:

- Entire room
- Participant across all actions
- Participant for the specific action type

This prevents a concurrent request burst from bypassing an application-level
count.

## Provider connector boundary

The connector layer will use a durable outbox per destination:

```mermaid
flowchart TD
    Snapshot["Approved UniJam snapshot"] --> Resolve["Storefront-aware resolver"]
    Resolve --> Preview["Destination-specific preview"]
    Preview --> Outbox["Idempotent publishing outbox"]
    Outbox --> Spotify
    Outbox --> Apple["Apple Music"]
```

Each destination progresses independently through validation, authorization,
publishing, retry, reconnect, and reconciliation. A failure at Apple must not
block Spotify or the room itself.

The pure domain boundary is split into three modules:

- `lib/catalog` parses provider references and neutral text, then scores
  synthetic/connector-supplied candidates for the US storefront. It has no
  network client and never uses embeddings or other ML-derived evidence.
- `lib/providers` defines catalog/publishing adapter contracts, generates only
  allowlisted handoff URLs, and provides the versioned AES-256-GCM token
  envelope used by the connector Worker.
- `lib/publishing` creates immutable destination previews and owner-confirmed,
  item-idempotent operations. Partial or timeout-ambiguous writes enter a
  reconciliation-required phase before another append is allowed.

Provider credentials are referenced by opaque connection IDs across the
application boundary. Only the connector Worker may resolve those references,
decrypt token envelopes, or invoke a provider adapter. Room code receives safe
catalog observations and operation state, never provider tokens.

See [`CONNECTOR_BOUNDARIES.md`](CONNECTOR_BOUNDARIES.md) for verified API
capabilities and policy constraints.

## Matching contract

Matching starts with identifiers and neutral metadata:

1. Exact ISRC candidate lookup
2. Artist, title, album, duration, and version scoring
3. Storefront availability verification
4. Ambiguity hold and user confirmation
5. Persisted user correction with provenance

Live, remix, clean, explicit, deluxe, and regional recordings remain distinct
unless evidence supports equivalence. One provider match never proves that a
track exists in another listener's storefront.

The pilot resolver accepts only storefront `US`. A missing storefront result,
an unavailable US result, a material version/explicit/duration conflict, or a
winner/runner-up margin below the deterministic threshold produces a hold.
User confirmation is a later audited command; the resolver never silently
promotes a held candidate.

## Deployment shape

- Next.js and React application compiled by Vinext
- Cloudflare Worker request runtime with isolated production and staging
- One SQLite-backed `RoomDurableObject` per room with hibernating WebSockets
- D1 account, registry, catalog, audit, operation, and projection persistence
- Queue-backed, at-least-once room projection with stable event receipts
- Drizzle schema and checked-in migrations
- Static assets bundled with the worker artifact

## Known limitations

- Cloudflare resource IDs and child-zone DNS delegation require operator provisioning.
- Spotify public launch remains gated by provider quota approval.
- Provider authorization requires operator-supplied credentials and feature flags.
