declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    ROOM_OBJECTS?: DurableObjectNamespace;
    ROOM_PROJECTION_QUEUE?: Queue;
    CONNECTORS?: Fetcher;
    CONNECTOR_SERVICE_TOKEN?: string;
    APP_ENV?: "development" | "staging" | "production";
    APP_ORIGIN?: string;
    WEBAUTHN_RP_ID?: string;
    ENABLE_LEGACY_ROOM_API?: string;
    LEGACY_MIGRATION_SECRET?: string;
  }
}
