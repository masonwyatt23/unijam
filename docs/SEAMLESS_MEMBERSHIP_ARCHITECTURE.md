# Seamless membership and provider join

This document is the implementation authority for UniJam's account-free guest entry, provider-connected listeners, persistent members, and hosts.

## Product model

UniJam separates three things that must never imply one another:

1. **UniJam identity** — an optional, passkey-backed account.
2. **Room authority** — an invite- and room-scoped participant role serialized by the Room Durable Object.
3. **Provider authorization** — optional access to one person's Spotify or Apple Music account, encrypted inside the connector Worker.

The resulting states are:

| State | Account | Room access | Provider access | Can host |
|---|---|---|---|---|
| Guest | None | Invite-scoped | None | No |
| Connected listener | Optional | Invite-scoped | Participant/account scoped | Only if also a member |
| Member | Passkey | Invite still required for another person's room | Optional persistent connection | Yes |
| Room host | Passkey member | Registry owner for this room | Optional owner connection | Yes |

Creating or connecting a provider account never changes a room role. A signed-in member still needs the current room invite to join someone else's room.

## Seamless journey

```text
Open invite → Join immediately → Add/vote/co-sign
                         ├─ choose a listening preference
                         ├─ connect a provider when useful
                         └─ create a passkey profile to persist identity and host
```

Guests never need an account to join, vote, co-sign, or contribute through the Apple Music public US catalog. Spotify catalog lookup requires that listener's own passkey account, Spotify connection, and current pilot eligibility. Returning members can reuse their name and account connection, but Spotify or Apple Music may still require user-mediated consent or reconnection.

## Provider boundary

UniJam owns one Spotify application registration and one Apple Music Media ID/key set. Each listener authorizes only their own account. Developer secrets never reach the browser and provider tokens remain connector-only.

The canonical product is a shared, provider-neutral setlist with native per-listener handoff and explicit playback confirmation. It is not synchronized cross-service streaming. Spotify development mode currently limits the pilot to five allowlisted users, and Spotify's published policy restricts cross-service streaming and synchronized audio. Public Spotify authorization therefore remains independently feature-gated pending provider approval.

## Implementation sequence

1. **Implemented:** open rate-limited passkey membership while retaining operator enrollment compatibility.
2. **Implemented:** simplify the invite door and persist a real listener preference.
3. **Implemented:** link authenticated members to room-scoped participant records and history without changing DO authority, including a safe post-join account upgrade.
4. **Implemented:** replace the room-owner provider lookup with contributor-scoped Spotify authorization and app-scoped Apple Music catalog access.
5. **In progress:** preserve room context through provider consent and make connect/reconnect/cancel states actionable.
6. **Implemented for current data model:** account deletion, logout revocation, and honest non-authoritative joined-room history.
7. **External activation:** enable each provider independently only after real credentialed contract tests and provider approval.

## Current pilot constraints

- Spotify Development Mode permits only five allowlisted authenticated users; public Spotify access cannot be enabled by code alone.
- Apple Music requires an Apple Developer Media ID/key and each subscriber's Music User Token for personalized writes.
- The current guest cookie supports one active guest room per browser. Joined-room history is informational and never bypasses the current invite.
- UniJam coordinates metadata, decisions, native handoff, and explicit playback confirmation. It does not mix or synchronize provider audio.

Status: membership and room participation are implemented; provider-context UX, hardening, and staging release verification are in progress.
