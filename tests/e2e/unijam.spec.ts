import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const snapshot = {
  roomId: "ROOM1234",
  seq: 4,
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
    host_12345678: {
      participantId: "host_12345678",
      nickname: "Room Host",
      role: "host",
      ready: true,
    },
    guest_1234567: {
      participantId: "guest_1234567",
      nickname: "Room Guest",
      role: "guest",
      ready: false,
    },
  },
  suggestions: {},
  occurrences: [],
  updatedAtMs: 1_700_000_000_000,
};

async function mockRoom(page: Page, role: "host" | "guest" = "host", roomSnapshot: unknown = snapshot) {
  await page.routeWebSocket("**/api/v1/rooms/ROOM1234/websocket", (socket) => {
    socket.onMessage((message) => {
      try {
        const input = JSON.parse(String(message)) as { type?: string };
        if (input.type === "hello") socket.send(JSON.stringify({ type: "events", events: [], latestSeq: 4 }));
      } catch { /* malformed client frames are irrelevant to these UI flows */ }
    });
  });
  await page.route("**/api/v1/rooms/ROOM1234/state**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          type: "snapshot",
          reset: true,
          snapshot: roomSnapshot,
          latestSeq: 4,
          actor: {
            participantId: `${role}_12345678`,
            role,
            nickname: role === "host" ? "Room Host" : "Room Guest",
          },
        },
        error: null,
        requestId: "req_e2e",
      }),
    }),
  );
}

async function gotoReady(page: Page, path: string) {
  await expect(async () => {
    const response = await page.goto(path);
    expect(response?.ok()).toBe(true);
  }).toPass({ timeout: 15_000 });
}

test("landing and guest room have no serious accessibility violations", async ({ page }) => {
  await gotoReady(page, "/");
  await expect(page.getByRole("heading", { name: /one room/i })).toBeVisible();
  let accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);

  await mockRoom(page, "guest");
  await gotoReady(page, "/room/ROOM1234");
  await expect(page.getByText("GUEST ACCESS")).toBeVisible();
  await expect(page.getByRole("link", { name: /host workspace/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /confirm playback/i })).toHaveCount(0);
  accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
});

test("a resolved guest contribution stages the canonical recording", async ({ page }) => {
  await mockRoom(page, "guest");
  let command: {
    commandId: string;
    action: string;
    payload: { suggestionId: string; recordingId: string; title: string; held: boolean };
  } | null = null;
  await page.route("**/api/v1/rooms/ROOM1234/resolve", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: {
        status: "matched",
        recordingId: "rec_canonical123",
        title: "Canonical Pick",
        artists: ["Room Artist"],
        album: "Room Album",
        explicit: false,
        version: "original",
        provider: "spotify",
        providerRecordingId: "spotify123",
        evidence: ["provider_id"],
      },
      error: null,
      requestId: "req_resolve",
    }),
  }));
  await page.route("**/api/v1/rooms/ROOM1234/commands", (route) => {
    command = route.request().postDataJSON() as typeof command;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { type: "ack", seq: 5 }, error: null, requestId: "req_stage" }),
    });
  });

  await gotoReady(page, "/room/ROOM1234");
  await page.getByLabel(/song link, title, or artist/i).fill("https://open.spotify.com/track/spotify123");
  await page.getByRole("button", { name: /resolve and add pick/i }).click();
  await expect(page.getByRole("status")).toContainText("Canonical Pick by Room Artist was added");
  expect(command).not.toBeNull();
  expect(command!.commandId).toMatch(/^cmd_/);
  expect(command!.action).toBe("suggestion.stage");
  expect(command!.payload).toMatchObject({ recordingId: "rec_canonical123", title: "Canonical Pick", held: false });
  expect(command!.payload.suggestionId).toMatch(/^sug_/);
});

test("host advances a confirmed occurrence by occurrence ID", async ({ page }) => {
  const confirmedSnapshot = {
    ...snapshot,
    suggestions: {
      sug_now12345: {
        suggestionId: "sug_now12345",
        recordingId: "rec_now12345",
        title: "Confirmed Pick",
        submittedBy: "host_12345678",
        status: "approved",
        occurrenceId: "occ_now12345",
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
      voterIds: [],
      playbackConfirmedAtMs: 1_700_000_001_000,
    }],
  };
  await mockRoom(page, "host", confirmedSnapshot);
  let command: { action: string; payload: { occurrenceId: string } } | null = null;
  await page.route("**/api/v1/rooms/ROOM1234/commands", (route) => {
    command = route.request().postDataJSON() as typeof command;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { type: "ack", seq: 5 }, error: null, requestId: "req_advance" }),
    });
  });

  await gotoReady(page, "/room/ROOM1234");
  await expect(page.getByRole("button", { name: /^advance/i })).toBeEnabled();
  await expect(page.getByRole("button", { name: /^skip$/i })).toBeEnabled();
  await page.getByRole("button", { name: /^advance/i }).click();
  await expect(page.getByRole("status")).toContainText("Confirmed Pick moved to Played");
  expect(command).toEqual(expect.objectContaining({ action: "queue.advance", payload: { occurrenceId: "occ_now12345" } }));
});

test("room creation works by keyboard and reflows at 320px", async ({ page }) => {
  await gotoReady(page, "/rooms/new");
  const hostApproval = page.getByRole("radio", { name: /host approves/i });
  const openApproval = page.getByRole("radio", { name: /add immediately/i });
  // A Vinext development page can become visible just before its client
  // boundary hydrates. Retrying a real interaction gives the test an
  // observable hydration boundary without using an arbitrary timeout.
  await expect.poll(async () => {
    await openApproval.click();
    return openApproval.getAttribute("aria-checked");
  }).toBe("true");
  await hostApproval.click();
  await expect(hostApproval).toHaveAttribute("aria-checked", "true");
  await hostApproval.focus();
  await page.keyboard.press("ArrowRight");
  await expect(openApproval).toHaveAttribute("aria-checked", "true");

  await page.setViewportSize({ width: 320, height: 800 });
  const heading = await page.evaluate(() => document.querySelector("h1")?.textContent);
  expect(heading).toMatch(/set the room rules/i);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("a failed join keeps the cleared capability available for one retry", async ({ page }) => {
  const capabilities: string[] = [];
  let attempts = 0;
  await page.route("**/api/v1/rooms/ROOM1234/join", async (route) => {
    const payload = route.request().postDataJSON() as { capability: string };
    capabilities.push(payload.capability);
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          data: null,
          error: { code: "TEMPORARILY_UNAVAILABLE", message: "Try again", retryable: true },
          requestId: "req_retry",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ data: { role: "guest" }, error: null, requestId: "req_joined" }),
    });
  });
  await mockRoom(page, "guest");

  await gotoReady(page, "/join/ROOM1234#cap=secret-capability");
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
  await page.getByRole("textbox", { name: /your name in the room/i }).fill("Room Guest");
  await page.getByRole("button", { name: /join room/i }).click();
  await expect(page.getByRole("alert")).toContainText("Try again");
  await page.getByRole("button", { name: /join room/i }).click();
  await expect(page).toHaveURL(/\/room\/ROOM1234$/);
  expect(capabilities).toEqual(["secret-capability", "secret-capability"]);
});
