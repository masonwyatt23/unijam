# Contributing to UniJam

Thank you for helping make mixed-platform music collaboration less painful.
UniJam is early, so the best contributions strengthen its core guarantees rather
than adding surface area that the provider APIs cannot support.

## Before you start

- Search existing issues and discussions.
- For a substantial feature or architecture change, open a discussion first.
- For security issues, follow [`SECURITY.md`](SECURITY.md) instead of opening a
  public issue.
- Read [`docs/CONNECTOR_BOUNDARIES.md`](docs/CONNECTOR_BOUNDARIES.md) before
  changing provider-facing behavior or copy.

## Development setup

Requirements: Node.js 24+, npm, and Linux or WSL.

```bash
npm ci
npm run dev
```

Before submitting a pull request:

```bash
npm run lint
npm test
```

## Good first contributions

- Accessibility and keyboard behavior
- Focused domain tests for queue, event, and session edge cases
- Clearer errors and recovery paths
- Documentation corrections
- Performance improvements with before/after evidence
- Neutral catalog adapters that use legally compatible data

## Pull request expectations

- Keep the change focused and explain the user problem it solves.
- Add or update tests for behavior changes.
- Preserve idempotency, capability boundaries, and canonical snapshot rules.
- Include screenshots for visible UI changes.
- Document new environment variables without committing their values.
- Avoid unrelated formatting or dependency churn.
- Confirm `npm run lint` and `npm test` pass.

## Provider and data rules

- Never commit provider credentials, user tokens, invite capabilities, or real
  user-library exports.
- Do not claim playback is verified after opening a provider deep link.
- Do not silently publish an ambiguous match.
- Do not use Spotify content as AI/ML input.
- Treat storefront and regional availability as part of track identity.

## Commit style

Use a short imperative subject that describes the outcome, for example:

```text
Reject stale speaker handoffs
Add storefront-aware match holds
Improve room join keyboard flow
```

## Conduct

Be direct, kind, and specific. Critique ideas and code, not people. Harassment,
discrimination, doxxing, and abusive behavior are not tolerated. Maintainers may
remove content or participation that makes the project unsafe or unproductive.

By contributing, you agree that your contribution is licensed under the
Apache License 2.0.
