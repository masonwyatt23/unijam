## What changed

Describe the user or system problem and the focused solution.

## Why

Explain why this belongs in UniJam now.

## Verification

- [ ] `npm run lint`
- [ ] `npm test`
- [ ] Tests cover new or changed behavior
- [ ] UI changes include screenshots or a recording
- [ ] Documentation reflects any architecture or provider-boundary change

## Safety checklist

- [ ] No credentials, private room links, or user data are included
- [ ] Event and provider operations remain idempotent
- [ ] Actor identity and role come from the server session
- [ ] Provider-facing claims match `docs/CONNECTOR_BOUNDARIES.md`
