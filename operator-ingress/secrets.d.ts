// Wrangler generates service bindings and non-secret vars in env.d.ts. Secret
// bindings are intentionally absent from committed config and are augmented here.
declare namespace Cloudflare {
  interface Env {
    readonly ACCESS_SERVICE_TOKEN_CLIENT_ID?: string;
    readonly CONNECTOR_SERVICE_TOKEN?: string;
    readonly CONNECTOR_OPERATOR_SECRET?: string;
  }
}
