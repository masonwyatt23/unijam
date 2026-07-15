# Security policy

## Supported versions

UniJam is currently pre-1.0. Security fixes are applied to the latest commit on
`main`; older commits and deployments are not supported.

## Reporting a vulnerability

Please use GitHub's **Security → Report a vulnerability** flow for this
repository. Do not disclose the issue in a public issue, discussion, or pull
request.

Include, when possible:

- The affected route, component, or commit
- Reproduction steps or a minimal proof of concept
- Expected and observed behavior
- Potential impact
- Any suggested mitigation

You should receive an acknowledgment within five business days. We will share a
status update after triage and coordinate disclosure when a fix is available.

## Sensitive areas

Please take extra care around:

- Host and guest capabilities
- Participant-session issuance and rotation
- Event idempotency and authorization
- Room snapshot convergence
- Rate-limit atomicity
- Provider OAuth tokens and MusicKit keys
- Deep-link validation and catalog provenance

Never include real credentials, private room links, or user data in a report.
