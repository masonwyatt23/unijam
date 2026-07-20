import { expect, test } from "@playwright/test";

async function stubAccount(page: import("@playwright/test").Page, recentPasskey = true): Promise<void> {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: { accountId: "acct_1", displayName: "Listener", recentPasskey }, error: null, requestId: "req_me" }),
  }));
}

async function stubStatus(page: import("@playwright/test").Page, provider: "spotify" | "apple-music", connected: boolean): Promise<void> {
  await page.route(`**/api/v1/providers/${provider}/status`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: { connected, enabled: true, publishingEnabled: true, storefront: "us" }, error: null, requestId: `req_${provider}` }),
  }));
}

test("Spotify keeps a validated room return and shows callback cancellation", async ({ page }) => {
  await stubAccount(page);
  await stubStatus(page, "spotify", false);
  await page.goto("/connections/spotify?returnTo=%2Froom%2FROOM1234&providerResult=cancelled");

  await expect(page.getByText("Spotify connection cancelled")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/room/ROOM1234");
  await expect(page.getByRole("link", { name: "Connect Spotify" })).toHaveAttribute(
    "href",
    "/api/v1/providers/spotify/connect?returnTo=%2Froom%2FROOM1234",
  );
});

test("passkey confirmation returns to each provider screen without losing its validated room destination", async ({ page }) => {
  await stubAccount(page, false);
  await stubStatus(page, "spotify", false);
  await stubStatus(page, "apple-music", false);

  await page.goto("/connections/spotify?returnTo=%2Froom%2FROOM1234");
  await expect(page.getByRole("link", { name: "Confirm passkey" })).toHaveAttribute(
    "href",
    "/host/sign-in?returnTo=%2Fconnections%2Fspotify%3FreturnTo%3D%252Froom%252FROOM1234",
  );

  await page.goto("/connections/apple-music?returnTo=%2Froom%2FROOM1234");
  await expect(page.getByRole("link", { name: "Confirm passkey" })).toHaveAttribute(
    "href",
    "/host/sign-in?returnTo=%2Fconnections%2Fapple-music%3FreturnTo%3D%252Froom%252FROOM1234",
  );
});

test("connections gives an expired session one clear passkey recovery action", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ data: null, error: { code: "UNAUTHENTICATED", message: "Host session is missing or expired" }, requestId: "req_unauthenticated" }),
  }));

  await page.goto("/connections");
  await expect(page.getByRole("heading", { name: "Sign in to connect your music" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with a passkey" })).toHaveAttribute(
    "href",
    "/host/sign-in?returnTo=%2Fconnections",
  );
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});

test("Apple Music purges the server connection before clearing MusicKit authorization", async ({ page }) => {
  await page.addInitScript(() => {
    const state = { purged: false, unauthorized: false };
    Object.assign(window, {
      __providerTestState: state,
      MusicKit: {
        configure: () => undefined,
        getInstance: () => ({
          authorize: async () => "music-user-token",
          unauthorize: async () => {
            if (!state.purged) throw new Error("server purge must happen first");
            state.unauthorized = true;
          },
        }),
      },
    });
  });
  await stubAccount(page);
  await stubStatus(page, "apple-music", true);
  await page.route("**/api/v1/providers/apple-music/disconnect", async (route) => {
    await page.evaluate(() => { (window as unknown as { __providerTestState: { purged: boolean } }).__providerTestState.purged = true; });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { disconnected: true }, error: null, requestId: "req_disconnect" }) });
  });
  await page.route("**/api/v1/providers/apple-music/developer-token", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: { developerToken: "public-musickit-developer-token", expiresAtMs: Date.now() + 60_000 }, error: null, requestId: "req_token" }),
  }));

  await page.goto("/connections/apple-music");
  await page.getByRole("button", { name: "Disconnect Apple Music" }).click();

  await expect(page.getByText("Apple Music was disconnected.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __providerTestState: { unauthorized: boolean } }).__providerTestState.unauthorized)).toBe(true);
});
