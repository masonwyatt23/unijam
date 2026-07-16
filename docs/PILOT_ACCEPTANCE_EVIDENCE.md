# Pilot acceptance evidence

This protocol turns the mixed Apple Music and Spotify pilot into a reproducible
release gate. It never creates fake provider sessions, bypasses the normal guest
join path, or treats a manually checked box as automated evidence. Every file in
this protocol is a private release artifact and must be mode `0600`.

## Bind staging to one commit

Both Worker versions must carry the same immutable `unijam-release:<40-char
commit>` message. The checked-in wrappers refuse a dirty worktree and add that
message without invoking a shell:

```bash
npm run deploy:connectors -- --env staging
npm run deploy:cloudflare -- --env staging
npm run capture:release-candidate -- --env staging
```

`capture:release-candidate` fails unless exactly one web version and one
connector version each serve 100% of traffic and both messages equal the current
commit. Older staging versions deployed before this policy must be redeployed;
they cannot be grandfathered into acceptance.

Capture once before testing to obtain the two version IDs used in manual
evidence. Capture again after all tests, overwriting the candidate evidence, so
the final record proves the same versions were still active at sign-off.

## Provision real room sessions

The hibernation manifest contains one disposable host cookie and one normally
joined guest cookie. The load manifest contains only sessions created through
the production join API. Never copy a passkey challenge, recovery code, invite
fragment, provider token, Music User Token, or private playlist URL into release
evidence.

Staging enforces 20 guest joins per source IP per 15-minute bucket and 40 joins
per invite capability per bucket. Consequently:

- The 10-room × 20-session smoke cannot be provisioned from one source IP in a
  single window. Use the real distributed pilot devices/networks, or schedule
  batches across at least ten rate-limit buckets. `networkCohort` is an opaque
  label for the source network, never its IP address.
- The 25-session soak needs 20 joins in one bucket and five in a later bucket
  when provisioned from one source IP.
- Do not add a test bypass, trust a forwarded client IP, reuse cookies, or write
  sessions directly into D1. The load harness rejects manifests that contradict
  the live join policy.

Run the destructive hibernation/revocation proof only against its disposable
room, then run load with D1 projection measurement required:

```bash
npm run assure:websocket:staging -- --manifest /secure/hibernation.json
npm run load:smoke -- \
  --target https://staging.unijam.ashlr.ai \
  --manifest /secure/load.json \
  --projection-database unijam-staging --wrangler-env staging \
  --projection-mode remote --require-projection
npm run load:soak -- \
  --target https://staging.unijam.ashlr.ai \
  --manifest /secure/load.json \
  --projection-database unijam-staging --wrangler-env staging \
  --projection-mode remote --require-projection
```

The release gate requires the full 60-minute soak. A shortened local diagnostic
run is useful during development but is not release evidence.

## Mixed-provider exercise

Use one Apple Music subscriber and at least one Spotify pilot account on the
same candidate. Exercise each provider independently:

1. authorize a real connection;
2. resolve a US catalog recording;
3. open its native handoff and have the host explicitly confirm playback;
4. publish to a new private playlist and reconcile its items;
5. disconnect and prove encrypted connection data and queued work are revoked;
6. exercise a controlled provider failure or kill switch while a room command
   succeeds and the other provider remains operational;
7. verify no duplicate provider mutation occurred.

A success on one provider never substitutes for the other. Do not record email,
account, room, playlist, recording, or provider-token identifiers in the
attestation. The provider evidence shape is:

```json
{
  "schemaVersion": 1,
  "kind": "unijam-mixed-provider-assurance",
  "targetOrigin": "https://staging.unijam.ashlr.ai",
  "candidate": {
    "commit": "<40-char commit>",
    "webVersionId": "<uuid>",
    "connectorVersionId": "<uuid>"
  },
  "operator": "<accountable operator name>",
  "completedAt": "<ISO timestamp>",
  "providers": {
    "spotify": {
      "connectionAuthorized": true,
      "usCatalogResolved": true,
      "nativeHandoffOpenedAndHostConfirmed": true,
      "privatePlaylistPublished": true,
      "disconnectPurged": true,
      "failureDidNotBlockRoom": true,
      "peerProviderRemainedOperational": true,
      "zeroDuplicateMutations": true
    },
    "appleMusic": {
      "connectionAuthorized": true,
      "usCatalogResolved": true,
      "nativeHandoffOpenedAndHostConfirmed": true,
      "privatePlaylistPublished": true,
      "disconnectPurged": true,
      "failureDidNotBlockRoom": true,
      "peerProviderRemainedOperational": true,
      "zeroDuplicateMutations": true
    }
  },
  "passed": true
}
```

## Manual and operational attestations

The three manual files use the same envelope:

```json
{
  "schemaVersion": 1,
  "kind": "<kind below>",
  "targetOrigin": "https://staging.unijam.ashlr.ai",
  "candidate": {
    "commit": "<40-char commit>",
    "webVersionId": "<uuid>",
    "connectorVersionId": "<uuid>"
  },
  "operator": "<accountable operator name>",
  "completedAt": "<ISO timestamp>",
  "checks": {},
  "passed": true
}
```

Required kinds and checks:

- `unijam-manual-accessibility-assurance`: `voiceOverSafari`, `nvdaChrome`,
  `keyboardCompletion`, `zoom200`, `zoom400`, `reducedMotion`, `forcedColors`,
  `touchTargets`, `zeroSeriousCriticalAxe`.
- `unijam-telemetry-assurance`: `webLogs`, `connectorLogs`,
  `queueBacklogObserved`, `dlqObserved`, `alertsConfigured`,
  `providerKillSwitchesVerified`, `secretAndCapabilityRedactionReviewed`.
- `unijam-rollback-assurance`: `priorWebVersionCaptured`,
  `priorConnectorVersionCaptured`, `stagingRollbackRehearsed`,
  `durableObjectNamespacePreserved`, `d1RestoreNotUsedAsAppRollback`,
  `dualAuthorityCompatibilityConfirmed`.

Every named check must be the JSON boolean `true`. A placeholder operator or a
record older than seven days is rejected. Rollback must preserve the existing
Durable Object namespace and class; restoring D1 is not an application rollback.

## Final gate and promotion

Create a private manifest beside the evidence files:

```json
{
  "schemaVersion": 1,
  "kind": "unijam-pilot-acceptance-manifest",
  "evidence": {
    "candidate": "candidate.json",
    "preflight": "preflight.json",
    "hibernation": "hibernation.json",
    "smoke": "smoke.json",
    "soak": "soak.json",
    "providers": "providers.json",
    "accessibility": "accessibility.json",
    "telemetry": "telemetry.json",
    "rollback": "rollback.json"
  }
}
```

Generate `preflight.json` with `npm run preflight:staging -- --json` and protect
it with `chmod 600`. Then run:

```bash
npm run verify:pilot-acceptance -- --manifest /secure/acceptance.json
```

The verifier checks file permissions, evidence freshness, exact commit and
Worker-version identity, authenticated remote preflight, migration and binding
state, hibernation/revocation, load thresholds, both providers, accessibility,
telemetry, and rollback. It outputs a redacted verdict under `test-results/`.

A passing verdict authorizes only a closed production baseline from the exact
commit. It does not authorize a public launch, production DNS mutation,
credentials in chat, or Spotify availability beyond the approved pilot quota.
Deploy production connector first and web second with the same checked-in
wrappers and explicit production confirmation. Repeat production preflight and
a non-destructive room smoke before inviting cofounders.
