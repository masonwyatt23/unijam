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

For this closed candidate it also requires `unijam-operator-ingress-staging` to
be absent from the account, its public aliases disabled in configuration, its
Access audience/team values empty, and its runtime missing-Access guard intact.
An authentication or API failure is not accepted as proof that the Worker is
absent. Deploying operator ingress requires a later Access-activated candidate.

Capture once before testing to obtain the two version IDs used in manual
evidence. Capture again after all tests, overwriting the candidate evidence, so
the final record proves the same versions were still active at sign-off.

## Provision real room sessions

The hibernation manifest contains one disposable host cookie and one normally
joined guest cookie. The load manifest contains only sessions created through
the production join API. Never copy a passkey challenge, recovery code, invite
fragment, provider token, Music User Token, or private playlist URL into release
evidence.

Hibernation manifests use schema version 2 and load manifests use version 3.
Both must include the exact candidate object shown below. The harnesses compare
all three values to live Cloudflare state before opening a socket, query again
after the measured work, reject drift, and write the candidate, deployment
window, and SHA-256 of the credential-bearing manifest into the redacted report.

```json
{
  "commit": "<40-char commit>",
  "webVersionId": "<uuid>",
  "connectorVersionId": "<uuid>"
}
```

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
run is useful during development but is marked as non-release evidence. Pre/post
queries cannot detect a deployment that rolls out and rolls back entirely inside
the measurement interval, so retain Cloudflare deployment-history evidence for
the same window. If the destructive hibernation run succeeds but its post-run
Cloudflare query fails, its sessions are consumed and a fresh disposable fixture
is required; no report is emitted.

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
it with `chmod 600`. Preflight itself must name the same commit and both active
version IDs. Create the SHA-256 integrity seal only after every evidence file is
final, store that seal in the private release record, then verify:

```bash
npm run seal:pilot-evidence -- --manifest /secure/acceptance.json --output /secure/acceptance.seal.json
npm run verify:pilot-acceptance -- \
  --manifest /secure/acceptance.json \
  --seal /secure/acceptance.seal.json
```

The verifier rejects symlinks, path traversal, duplicate references, non-private
files, and any manifest/file whose exact bytes no longer match the seal. It then
checks evidence freshness, exact commit and Worker-version identity,
authenticated remote preflight, migration and binding state,
hibernation/revocation, load thresholds, both providers, accessibility,
telemetry, and rollback. Finally it re-queries both live Worker versions and the
undeployed operator-ingress state before emitting a redacted verdict.

The SHA-256 seal provides integrity detection, not signer authentication. Anyone
able to replace both evidence and seal can regenerate both; store the seal in an
immutable or independently controlled release record if stronger provenance is
required.

A passing verdict authorizes only a closed production baseline from the exact
commit. It does not authorize a public launch, production DNS mutation,
credentials in chat, or Spotify availability beyond the approved pilot quota.
Deploy production connector first and web second with the same checked-in
wrappers and explicit production confirmation. Repeat production preflight and
a non-destructive room smoke before inviting cofounders.
