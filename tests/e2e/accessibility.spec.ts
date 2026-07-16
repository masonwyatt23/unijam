import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const baseSnapshot = {
  roomId: "ROOM1234",
  seq: 12,
  lifecycle: "active",
  rules: {
    contributionLimit: 3,
    approvalMode: "host",
    explicitContent: "hold",
    versionPreference: "original",
    locked: false,
    speakerDuty: "host",
  },
  participants: {
    host_12345678: { participantId: "host_12345678", nickname: "Room Host", role: "host", ready: true },
    guest_1234567: { participantId: "guest_1234567", nickname: "Room Guest", role: "guest", ready: true },
  },
  suggestions: {
    sug_now12345: {
      suggestionId: "sug_now12345",
      recordingId: "rec_now12345",
      title: "Confirmed Pick",
      submittedBy: "host_12345678",
      status: "approved",
      occurrenceId: "occ_now12345",
    },
    sug_pending12: {
      suggestionId: "sug_pending12",
      recordingId: "rec_pending12",
      title: "Pending Pick",
      submittedBy: "guest_1234567",
      status: "pending",
    },
  },
  occurrences: [{
    occurrenceId: "occ_now12345",
    recordingId: "rec_now12345",
    suggestionId: "sug_now12345",
    title: "Confirmed Pick",
    status: "now",
    position: 0,
    cosignerIds: [],
    voterIds: ["guest_1234567"],
    playbackConfirmedAtMs: 1_700_000_001_000,
  }],
  updatedAtMs: 1_700_000_002_000,
};

async function gotoReady(page: Page, path: string) {
  await expect(async () => {
    const response = await page.goto(path);
    expect(response?.ok()).toBe(true);
  }).toPass({ timeout: 15_000 });
}

async function mockRoom(page: Page, snapshot: unknown = baseSnapshot) {
  await page.routeWebSocket("**/api/v1/rooms/ROOM1234/websocket", (socket) => {
    socket.onMessage((message) => {
      try {
        const input = JSON.parse(String(message)) as { type?: string };
        if (input.type === "hello") socket.send(JSON.stringify({ type: "events", events: [], latestSeq: 12 }));
      } catch { /* malformed client frames do not affect the accessibility surface */ }
    });
  });
  await page.route("**/api/v1/rooms/ROOM1234/state**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: {
        type: "snapshot",
        reset: true,
        snapshot,
        latestSeq: 12,
        actor: { participantId: "host_12345678", role: "host", nickname: "Room Host" },
      },
      error: null,
      requestId: "req_accessibility",
    }),
  }));
}

async function mockHost(page: Page, recentPasskey = true) {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: { accountId: "account_12345678", displayName: "Room Host", recentPasskey, recoveryEnrollmentAvailable: false },
      error: null,
      requestId: "req_host",
    }),
  }));
}

async function mockProviderStatuses(page: Page) {
  await page.route(/\/api\/v1\/providers\/(spotify|apple-music)\/status$/, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: { connected: false, enabled: true, publishingEnabled: true, storefront: "us" },
      error: null,
      requestId: "req_provider",
    }),
  }));
}

async function mockHandoffs(page: Page) {
  await page.route(/\/api\/v1\/rooms\/ROOM1234\/handoff\/(spotify|apple-music)$/, (route) => {
    const provider = route.request().url().endsWith("spotify") ? "spotify" : "apple_music";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          occurrenceId: "occ_now12345",
          recordingId: "rec_now12345",
          title: "Confirmed Pick",
          provider,
          links: {
            universalUrl: provider === "spotify" ? "https://open.spotify.com/track/0123456789ABCDEFGHIJKL" : "https://music.apple.com/us/song/123456789",
            nativeUri: provider === "spotify" ? "spotify:track:0123456789ABCDEFGHIJKL" : "music://music.apple.com/us/song/123456789",
            storefront: "US",
          },
        },
        error: null,
        requestId: "req_handoff",
      }),
    });
  });
}

async function expectNoSeriousAxeViolations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectMinimumTextAndTargets(page: Page) {
  const undersizedText = await page.locator("body").evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("body *"))
    .filter((element) => Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()))
    .filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && Number.parseFloat(style.fontSize) < 14;
    })
    .map((element) => `${element.tagName.toLowerCase()}.${element.className}: ${getComputedStyle(element).fontSize}`));
  expect(undersizedText).toEqual([]);

  const undersizedTargets = await page.locator("body").evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("a, button, input:not([type=hidden]), select, textarea"))
    .filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const intersectsViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      return style.display !== "none" && style.visibility !== "hidden" && intersectsViewport && (rect.width < 44 || rect.height < 44);
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return `${element.tagName.toLowerCase()}.${element.className}: ${Math.round(rect.width)}x${Math.round(rect.height)}`;
    }));
  expect(undersizedTargets).toEqual([]);
}

test("critical host routes meet automated accessibility, text, and target gates", async ({ page }) => {
  await mockRoom(page);
  await mockHost(page);
  await mockProviderStatuses(page);
  await mockHandoffs(page);

  for (const path of ["/room/ROOM1234", "/room/ROOM1234/review", "/room/ROOM1234/recap", "/room/ROOM1234/publish", "/room/ROOM1234/handoff/spotify", "/room/ROOM1234/handoff/apple-music", "/connections", "/connections/spotify", "/connections/apple-music"]) {
    await gotoReady(page, path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoSeriousAxeViolations(page);
    await expectMinimumTextAndTargets(page);
  }
});

test("authentication, room creation, and guest entry meet automated accessibility gates", async ({ page }) => {
  for (const path of ["/host/sign-in", "/rooms/new", "/join", "/join/ROOM1234#cap=synthetic-capability"]) {
    await gotoReady(page, path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoSeriousAxeViolations(page);
    await expectMinimumTextAndTargets(page);
  }
});

test("critical room and provider routes reflow at 200 and 400 percent equivalents", async ({ page }) => {
  await mockRoom(page);
  await mockHost(page);
  await mockProviderStatuses(page);
  await mockHandoffs(page);

  // A 1280 CSS-pixel baseline reduced to 640 and 320 CSS pixels exercises the
  // layout space available at 200% and 400% browser zoom respectively.
  for (const width of [640, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/room/ROOM1234", "/room/ROOM1234/review", "/room/ROOM1234/recap", "/room/ROOM1234/publish", "/room/ROOM1234/handoff/spotify", "/room/ROOM1234/handoff/apple-music", "/connections", "/connections/spotify", "/connections/apple-music"]) {
      await gotoReady(page, path);
      await expectNoHorizontalOverflow(page);
    }
  }
});

test("mobile navigation is removed from focus order while closed and returns focus on Escape", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mockRoom(page);
  await gotoReady(page, "/room/ROOM1234");

  const roomsLink = page.getByRole("link", { name: "Rooms" });
  await expect(roomsLink).toBeHidden();
  const menu = page.locator(".mobile-bar .icon-button");
  await expect(menu).toHaveAccessibleName("Open navigation");
  // The Vinext development shell can paint before the client boundary is
  // hydrated. A retried real interaction establishes the usable boundary.
  await expect.poll(async () => {
    if (await menu.getAttribute("aria-expanded") !== "true") await menu.click();
    return await menu.getAttribute("aria-expanded");
  }).toBe("true");
  await expect(roomsLink).toBeVisible();
  await roomsLink.focus();
  await page.keyboard.press("Escape");
  await expect(roomsLink).toBeHidden();
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
});

test("reduced motion suppresses the active cue animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockRoom(page);
  await gotoReady(page, "/room/ROOM1234");
  const animationDuration = await page.locator(".cue-lamp.is-on").evaluate((element) => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(animationDuration)).toBeLessThanOrEqual(0.00001);
});

test("forced colors preserve focus and the confirmed cue state", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Playwright forced-colors emulation is Chromium-only.");
  await page.emulateMedia({ forcedColors: "active" });
  await mockRoom(page);
  await gotoReady(page, "/room/ROOM1234");

  const advanceButton = page.getByRole("button", { name: "Advance", exact: true });
  await advanceButton.focus();
  const focusStyle = await advanceButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(3);
  await expect(page.locator(".cue-lamp.is-on")).toHaveCSS("forced-color-adjust", "none");
});

test("a provider status failure has an operable retry without blocking the other provider", async ({ page }) => {
  await mockHost(page);
  let spotifyAttempts = 0;
  await page.route("**/api/v1/providers/spotify/status", (route) => {
    spotifyAttempts += 1;
    return route.fulfill({
      status: spotifyAttempts === 1 ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(spotifyAttempts === 1
        ? { data: null, error: { code: "CONNECTOR_UNAVAILABLE", message: "Spotify status is temporarily unavailable.", retryable: true }, requestId: "req_failed" }
        : { data: { connected: false, enabled: true, publishingEnabled: true, storefront: "us" }, error: null, requestId: "req_recovered" }),
    });
  });
  await page.route("**/api/v1/providers/apple-music/status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: { connected: false, enabled: true, publishingEnabled: true, storefront: "us" }, error: null, requestId: "req_apple" }),
  }));

  await gotoReady(page, "/connections");
  await expect(page.getByRole("link", { name: "Manage Apple Music" })).toBeVisible();
  await page.getByRole("button", { name: "Retry Spotify status" }).click();
  await expect(page.getByRole("link", { name: "Manage Spotify" })).toBeVisible();
  expect(spotifyAttempts).toBe(2);
});

test("a failed provider disconnect is exposed as an alert with recovery copy", async ({ page }) => {
  await mockHost(page);
  await page.route("**/api/v1/providers/spotify/status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: { connected: true, enabled: true, publishingEnabled: true, storefront: "us" }, error: null, requestId: "req_spotify" }),
  }));
  await page.route("**/api/v1/providers/apple-music/status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: { connected: false, enabled: true, publishingEnabled: true, storefront: "us" }, error: null, requestId: "req_apple" }),
  }));
  await page.route("**/api/v1/providers/spotify/disconnect", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ data: null, error: { code: "CONNECTOR_UNAVAILABLE", message: "Spotify disconnect is temporarily unavailable.", retryable: true }, requestId: "req_disconnect" }),
  }));

  await gotoReady(page, "/connections/spotify");
  await page.getByRole("button", { name: "Disconnect Spotify" }).click();
  await expect(page.getByRole("alert")).toHaveText("Spotify disconnect is temporarily unavailable.");
});
