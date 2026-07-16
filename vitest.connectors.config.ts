import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const connectorMigrations = await readD1Migrations("./connectors/migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./connectors/index.ts",
      wrangler: { configPath: "./wrangler.connectors.jsonc" },
      miniflare: {
        bindings: {
          CONNECTOR_SHARED_SECRET: "connector-worker-test-secret",
          CONNECTOR_OPERATOR_SECRET: "connector-operator-test-secret",
          TOKEN_ENCRYPTION_KEY_B64URL: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
          TOKEN_KEY_VERSION: "test-v1",
          SPOTIFY_CLIENT_ID: "spotify-test-client",
          APPLE_TEAM_ID: "APPLE_TEST_TEAM",
          APPLE_KEY_ID: "APPLE_TEST_KEY",
          APPLE_PRIVATE_KEY_JWK: "{}",
          SPOTIFY_ENABLED: "true",
          SPOTIFY_PUBLISHING_ENABLED: "true",
          APPLE_MUSIC_ENABLED: "true",
          APPLE_MUSIC_PUBLISHING_ENABLED: "true",
          TEST_CONNECTOR_MIGRATIONS: connectorMigrations,
        },
      },
    }),
  ],
  test: {
    include: ["tests/connectors-workers/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
