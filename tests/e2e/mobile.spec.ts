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
  await mockHostWorkspace(page);
  await page.goto("/host");
  await expect(page.getByRole("heading", { name: "Connect your music" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect Apple Music or Spotify" })).toBeVisible();
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

test("mobile recap keeps real recording artwork, metadata, and actions readable", async ({ page }) => {
  await mockArtworkRoom(page);
  await page.goto("/room/mobile-room/recap");
  await expect(page.getByRole("heading", { name: "The night’s set" })).toBeVisible();
  await expect(page.getByText("The Test Artists · A Real Album")).toBeVisible();
  await expect(page.locator("img.recap-artwork")).toBeVisible();
  await expect(page.getByRole("link", { name: "Save the setlist" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
