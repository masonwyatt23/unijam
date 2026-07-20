# Task Plan: Seamless UniJam Membership and Provider Join

## Goal
Let anyone enter a shared room instantly, optionally connect Spotify or Apple Music, optionally become a persistent UniJam member, and later host their own room without weakening provider-token or room-authority boundaries.

## Phases
- [x] Phase 1: Verify current provider policies and map the existing identity/join/provider architecture
- [x] Phase 2: Define the guest, connected listener, member, and host state model plus migration/API contracts
- [x] Phase 3: Implement the largest safe end-to-end membership and seamless join milestone
- [ ] Phase 4: Integrate provider connection, room contribution, and upgrade-to-host UX
- [ ] Phase 5: Audit security/accessibility, run full tests, document external activation gates, and deploy staging

## Key Questions
1. Which provider capabilities are available to public users under current Spotify quota rules and Apple MusicKit terms?
2. How can a room-scoped guest connect a provider without accidentally becoming a host or leaking a reusable provider token?
3. Which persistent community features add value now without expanding into public discovery, billing, or synchronized playback?

## Decisions Made
- Developer credentials belong only to UniJam's provider applications; every listener authorizes their own provider account.
- A guest link must work before provider authorization or account creation.
- Provider authorization, UniJam membership, and room authority remain three separate concepts.
- Existing passkeys remain the durable UniJam identity anchor unless verified provider constraints support an equally secure portable identity.
- No embedded or synchronized audio is implied; handoff and playback remain user/host confirmed.
- Spotify-backed public authorization remains gated by Extended Quota approval; Apple Music and provider-neutral guest participation can advance independently.
- The first implementation release opens self-service passkey membership, links signed-in members to room participation/history, simplifies guest entry, and removes guest borrowing of the room owner's Spotify credential.

## Errors Encountered
- `wrangler d1 migrations list unijam-staging --remote --config wrangler.jsonc` used the database name without the staging environment, so Wrangler could not resolve the binding. Retry with the `DB` binding and `--env staging`.
- The installed Gitleaks CLI does not support `--exclude-path`; generated `dist` and `.sites-runtime` files produced false positives. Re-scanned an rsync source-only copy plus full Git history with zero leaks.
- Semgrep flagged the missing npm package quarantine window. Added `min-release-age=7d` to `.npmrc` and re-run the scan before release.

## Status
**Currently in Phase 4** - integrating safe room-context provider connection/reconnection, provider consent outcomes, and actionable contribution recovery before the full staging hardening pass.
