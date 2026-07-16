# UniJam operator ingress

This Worker is the only public route allowed to reach connector operator
recovery. It is safe to keep undeployed: `workers.dev` and preview URLs are
disabled, and the runtime fails closed unless the Access team domain, Access
application audience, expected service-token Client ID, connector service
credential, and connector operator credential are all installed.

## Required Access resources

Do not deploy until Cloudflare Zero Trust is active and all of the following
exist in the matching environment:

1. A self-hosted Access application for exactly
   `operator-staging.unijam.ashlr.ai/v1/operator/publish/recover-playlist` or
   `operator.unijam.ashlr.ai/v1/operator/publish/recover-playlist`.
2. A dedicated, short-duration service token and a Service Auth policy that
   includes only that token. Do not use **Any Access Service Token** or Bypass.
3. The application's audience tag and exact team origin, such as
   `https://team-name.cloudflareaccess.com`.

The caller sends the one-time-displayed `CF-Access-Client-Id` and
`CF-Access-Client-Secret` to Access. Access injects
`Cf-Access-Jwt-Assertion`. This Worker verifies the RS256 signature against the
team JWKS, issuer, audience, lifetime, `type=app`, empty service-token `sub`, and
exact `common_name` Client ID. Merely possessing a syntactically valid JWT or a
different account service token is insufficient.

## Bindings

Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` as non-secret environment variables
after the Access application exists. Install these secrets on the ingress only:

- `ACCESS_SERVICE_TOKEN_CLIENT_ID`: the exact `.access` Client ID allowed by the
  Access policy. The Client Secret remains only with the operator client.
- `CONNECTOR_SERVICE_TOKEN`: matches the connector's internal shared secret.
- `CONNECTOR_OPERATOR_SECRET`: matches the connector's operator credential.

The public caller never receives either connector credential. The ingress adds
them only to the in-process `CONNECTORS` service-binding request and forwards
only the exact recovery route and a normalized, bounded body.

After configuration, run `npm run test:operator-ingress`, a Wrangler dry run,
and four live probes: missing Access credentials, wrong service token, valid
service token with invalid body, and valid recovery. The first two must be
blocked by Access; the third must return a stable `INVALID_BODY`; only the last
may reach the connector. Inspect Access and Worker logs without recording
credentials, playlist IDs, operation IDs, or response bodies.
