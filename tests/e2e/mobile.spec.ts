import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function mockHostWorkspace(page: Page) {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: { accountId: "account_12345678", displayName: "Room Host", recentPasskey: true, recoveryEnrollmentAvailable: false }, error: null, requestId: "req_mobile_host" }),
  }));
  for (const endpoint of ["rooms", "rooms/joined"]) {
    await page.route(`**/api/v1/${endpoint}`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { rooms: [] }, error: null, requestId: `req_mobile_${endpoint.replace("/", "_")}` }),
    }));
  }
  for (const provider of ["spotify", "apple-music"]) {
    await page.route(`**/api/v1/providers/${provider}/status`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { connected: provider === "spotify", enabled: true, publishingEnabled: false, storefront: "us" }, error: null, requestId: `req_mobile_${provider}` }),
    }));
  }
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function mockArtworkRoom(page: Page) {
  const display = {
    artists: ["The Test Artists"], album: "A Real Album", durationMs: 214_000,
    explicit: false, provider: "spotify", providerUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
    artwork: { url: "/brand/spotify/Full_Logo_Black_RGB.svg", width: 640, height: 640 },
  };
  const snapshot = {
    roomId: "mobile-room", seq: 8, lifecycle: "ended",
    rules: { contributionLimit: 3, approvalMode: "host", explicitContent: "allow", versionPreference: "original", locked: false, speakerDuty: "host" },
    participants: { host_1: { participantId: "host_1", nickname: "Room Host", role: "host", ready: true } },
    suggestions: { sug_1: { suggestionId: "sug_1", recordingId: "rec_1", title: "A Great Song", submittedBy: "host_1", status: "approved", occurrenceId: "occ_1", display } },
    occurrences: [{ occurrenceId: "occ_1", recordingId: "rec_1", suggestionId: "sug_1", title: "A Great Song", status: "played", position: 0, cosignerIds: [], voterIds: ["host_1"], playbackConfirmedAtMs: 1, display }],
    updatedAtMs: Date.now(),
  };
  await page.route("**/api/v1/rooms/mobile-room/state*", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: { actor: { participantId: "host_1", nickname: "Room Host", role: "host" }, state: { type: "snapshot", snapshot } }, error: null, requestId: "req_mobile_artwork" }),
  }));
}

test("mobile landing and join reflow without horizontal overflow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "One room. Every listener." })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.goto("/join");
  await expect(page.getByRole("heading", { name: "Open your invite" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  expect(results.violations).toEqual([]);
});

test("mobile workspace makes music connection obvious and contains navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockHostWorkspace(page);
  await page.goto("/host");
  await expect(page.getByRole("heading", { name: "Ready the room" })).toBeVisible();
  await expect(page.getByText("Spotify connected")).toBeVisible();
  await expect(page.getByText("Recommended settings take one tap")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const menu = page.getByRole("button", { name: "Open navigation" });
  await menu.click();
  const dialog = page.getByRole("dialog", { name: "UniJam navigation" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".nav-scrim")).toBeVisible();
  await page.locator(".nav-scrim").click();
  await expect(dialog).toBeHidden();
  await expect(menu).toBeFocused();
  const undersized = await page.locator("button:visible, a:visible").evaluateAll((elements) => elements
    .filter((element) => { const bounds = element.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0; })
    .map((element) => ({ label: (element.getAttribute("aria-label") || element.textContent || "").trim(), height: element.getBoundingClientRect().height }))
    .filter(({ height }) => height < 44));
  expect(undersized).toEqual([]);
});

test("mobile quick-start shares the exact private invite without stripping its fragment", async ({ page }) => {
  const invite = "https://staging.unijam.ashlr.ai/join/mobile-room#cap=private-test-capability";
  let submittedRules: unknown = null;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (payload: ShareData) => { (window as unknown as { __sharePayload: ShareData }).__sharePayload = payload; },
    });
  });
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: { accountId: "account_12345678", displayName: "Room Host", recentPasskey: true, recoveryEnrollmentAvailable: false }, error: null, requestId: "req_create_host" }),
  }));
  await page.route("**/api/v1/rooms", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    submittedRules = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ data: { roomId: "mobile-room", roomUrl: "/room/mobile-room", guestInvite: invite }, error: null, requestId: "req_create_room" }) });
  });

  await page.goto("/rooms/new");
  await expect(page.getByRole("heading", { name: "A smooth first jam" })).toBeVisible();
  await page.getByRole("button", { name: "Start with recommended settings" }).click();
  await expect(page.getByRole("heading", { name: "Room mobile-room" })).toBeVisible();
  await page.getByRole("button", { name: "Share guest invite" }).click();

  expect(submittedRules).toEqual({ rules: { contributionLimit: 3, approvalMode: "host", explicitContent: "hold", versionPreference: "original" } });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sharePayload?: ShareData }).__sharePayload?.url)).toBe(invite);
  await expectNoHorizontalOverflow(page);
});

test("mobile recap keeps real recording artwork, metadata, and actions readable", async ({ page }) => {
  await mockArtworkRoom(page);
  await page.goto("/room/mobile-room/recap");
  await expect(page.getByRole("heading", { name: "The night’s set" })).toBeVisible();
  await expect(page.getByText("The Test Artists · A Real Album")).toBeVisible();
  await expect(page.locator("img.recap-artwork")).toBeVisible();
  await expect(page.getByRole("link", { name: "Save the setlist" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("mobile publishing preview shows artwork and human track details", async ({ page }) => {
  await mockArtworkRoom(page);
  await page.route("**/api/v1/rooms/mobile-room/publish-preview", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: {
      previewId: "preview_mobile", payloadFingerprint: "fingerprint_mobile", roomRevision: 8, provider: "spotify",
      destination: { kind: "new_private_playlist", name: "UniJam mobile-room", description: "Created from a live UniJam room" },
      items: [{ canonicalRecordingId: "rec_1", providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC", position: 0, itemKey: "item_mobile" }],
      createdAtMs: Date.now(),
    }, error: null, requestId: "req_mobile_publish" }),
  }));
  await page.goto("/room/mobile-room/publish");
  await page.getByRole("button", { name: "Review immutable preview" }).click();
  await expect(page.getByText("The Test Artists · A Real Album")).toBeVisible();
  await expect(page.locator("img.publish-track-artwork")).toBeVisible();
  await expect(page.getByText("3:34")).toBeVisible();
  await expect(page.getByText("4uLU6hMCjMI75M1A2tKUQC")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
