# Cofounder pilot onboarding

This is the operator checklist for a five-host US pilot: Mason on Apple Music
and up to four additional Spotify hosts. Every person owns an independent
UniJam account, passkeys, recovery codes, provider connection, and private
playlist destination. Do not share host accounts, passkeys, recovery codes,
provider tokens, or enrollment codes.

## 1. Provision exactly one invite per person

Mason's existing invite remains separate. Validate a four-person staging batch
without creating credentials or touching Cloudflare:

```bash
node scripts/provision-cofounder-cohort.mjs \
  --env staging \
  --host "FULL NAME 1 - Spotify" \
  --host "FULL NAME 2 - Spotify" \
  --host "FULL NAME 3 - Spotify" \
  --host "FULL NAME 4 - Spotify"
```

After verifying that each label identifies exactly one intended person, repeat
with `--apply`. The command creates four independent 24-hour, single-use
credentials in one remote D1 operation and prints each plaintext code once.
The database receives only SHA-256 digests. Deliver each code through a
different authenticated private conversation; never paste a code into GitHub,
an issue tracker, analytics, screenshots, or a shared group channel.

If a code was exposed or sent to the wrong person, repeat with `--rotate` using
the exact same four labels. Rotation expires only unused live credentials with
those labels; it never rewrites a used enrollment record. Production requires
the explicit confirmation phrase printed by the command.

For a single replacement invite, dry-run and then apply:

```bash
node scripts/provision-pilot-host.mjs \
  --env staging \
  --label "FULL NAME - Spotify" \
  --rotate
```

## 2. Instructions for each cofounder

1. Open the exact environment URL on a personal device. Staging and production
   are different WebAuthn relying parties and intentionally use different
   passkeys.
2. Choose **I have a pilot invite**, enter the code, an account name, and the
   display name. The account name is used only during the passkey ceremony.
3. Create a discoverable, user-verified passkey. The invite is consumed only
   after verification succeeds, so cancelling Touch ID does not burn the code.
4. Save all ten single-use recovery codes in a personal password manager before
   leaving the page. They are never shown again.
5. From the host workspace, use **Add another passkey** to register that same
   person's second device or hardware key. This is not a way to add another
   cofounder.
6. Create a disposable room and send its guest link to another pilot member.
   A guest needs no account and must never receive a host credential.

The operator can map an enrolled label to its server-generated account ID
without storing an email address:

```sql
SELECT e.label, e.used_by_account_id AS account_id, a.display_name, e.used_at_ms
FROM host_enrollment_codes e
JOIN accounts a ON a.account_id = e.used_by_account_id
WHERE e.used_at_ms IS NOT NULL
ORDER BY e.used_at_ms DESC;
```

Record only the internal account IDs in the restricted pilot release record.

## 3. Admit hosts to only their provider

Provider admission is separate from host enrollment. Populate the
provider-specific connector allowlists only after each person has completed
passkey enrollment and the label-to-account query above has been reviewed:

- `APPLE_MUSIC_PILOT_ACCOUNT_ALLOWLIST`: Mason's internal account ID, plus only
  any other explicitly approved Apple Music tester IDs.
- `SPOTIFY_PILOT_ACCOUNT_ALLOWLIST`: the internal IDs of the Spotify testers,
  never emails or Spotify account IDs, with at most five entries under the
  current pilot constraint.

Do not use one combined allowlist. Being admitted to Apple Music must not grant
Spotify connector access and vice versa. Keep all provider feature flags false
until the corresponding provider credentials, exact callbacks/origins, live
contract tests, and disconnect test pass. Enable resolution/handoff before
publishing, and enable each provider independently.

## 4. Expected closed states

- A disabled provider says **Pilot not active**. Rooms continue to work.
- An enabled provider for a host outside that provider's allowlist remains in
  the closed **Pilot not active** state and never offers an operable connect
  control.
- Provider status failure exposes Retry for that provider without blocking the
  other card or any room operation.
- A host removed from a provider pilot can still disconnect and delete the
  encrypted provider connection. Removal must not trap private tokens.
- Apple Music failure cannot block Spotify publishing, and Spotify failure
  cannot block Apple Music publishing.

## 5. Mixed-provider acceptance session

Run this first in staging with synthetic/non-sensitive track choices:

1. Mason hosts, connects Apple Music, and creates a room.
2. At least one Spotify cofounder joins account-free as a guest; another signs
   in independently and verifies the Spotify connection screen.
3. Resolve one Apple Music URL, one Spotify URL, and one plain-text choice.
   Confirm duplicates become co-signatures and ambiguity goes to Held.
4. Approve, vote, reorder, mark ready, perform native handoff, and explicitly
   confirm playback. Never infer playback from an opened link.
5. End the room and verify the recap.
6. Publish independently to new private Apple Music and Spotify playlists.
   Confirm one provider's injected failure does not alter the other result and
   a retry creates no duplicate playlist items.
7. Disconnect both providers. Confirm encrypted tokens, pending previews, OAuth
   attempts, and provider jobs are removed and stale callbacks cannot restore a
   connection.

Stop immediately for any capability/token exposure, cross-account provider
access, canonical room divergence, duplicate provider mutation, or publication
without immutable preview confirmation.
