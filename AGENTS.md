# Repository guidance

## Commands

- Install: `npm ci`
- Develop: `npm run dev`
- Lint: `npm run lint`
- Type check: `npm run typecheck`
- Domain tests: `npm run test:domain`
- Full release gate: `npm test`

## Required invariants

- Treat the UniJam room as authoritative.
- Derive actor identity and role from the server session, never event input.
- Keep event application idempotent and deterministic.
- Reject stale track-scoped commands.
- Keep Spotify and Apple destination failures isolated.
- Hold ambiguous catalog matches for review.
- Never describe a deep-link open as verified playback.
- Never use Spotify content as AI/ML input.

## Change expectations

- Add focused tests for behavior changes.
- Run `npm run lint` and `npm test` before handoff.
- Do not commit environment files, credentials, provider tokens, private room
  capabilities, or real user-library data.
- Update architecture or connector docs when a boundary changes.
- Preserve `.openai/hosting.json`, the package manager, and the lockfile.
