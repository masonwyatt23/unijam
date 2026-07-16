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

async function mockRoom(page: Page, role: "host" | "cohost" | "guest" = "host", roomSnapshot: unknown = snapshot) {
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
            nickname: role === "host" ? "Room Host" : role === "cohost" ? "Room Co-host" : "Room Guest",
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
    payload: { suggestionId: string; resolutionId: string };
  } | null = null;
  await page.route("**/api/v1/rooms/ROOM1234/resolve", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: {
        status: "matched",
        resolutionId: "res_canonical123",
        recordingId: "rec_canonical123",
        title: "Canonical Pick",
        artists: ["Room Artist"],
        album: "Room Album",
        explicit: false,
        version: "original",
        provider: "spotify",
        providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC",
        providerUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
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
  await page.getByLabel(/song link, title, or artist/i).fill("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
  await page.getByRole("button", { name: /find and add song/i }).click();
  await expect(page.getByRole("status").filter({ hasText: "Canonical Pick by Room Artist was added" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Canonical Pick on Spotify" })).toHaveAttribute("href", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
  await expect(page.getByRole("link", { name: /sign in or create an account/i })).toHaveAttribute("href", "/host/sign-in?returnTo=%2Froom%2FROOM1234");
  expect(command).not.toBeNull();
  expect(command!.commandId).toMatch(/^cmd_/);
  expect(command!.action).toBe("suggestion.stage");
  expect(command!.payload).toEqual(expect.objectContaining({ resolutionId: "res_canonical123" }));
  expect(command!.payload).not.toHaveProperty("recordingId");
  expect(command!.payload).not.toHaveProperty("title");
  expect(command!.payload.suggestionId).toMatch(/^sug_/);
});

test("held provider candidates keep official linked attribution", async ({ page }) => {
  await mockRoom(page, "guest");
  await page.route("**/api/v1/rooms/ROOM1234/resolve", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: {
        status: "hold",
        reasons: ["ambiguous_candidates"],
        candidates: [{
          candidate: {
            title: "Candidate Pick",
            artists: ["Room Artist"],
            provider: "spotify",
            providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC",
            providerUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
          },
          score: 0.91,
        }],
      },
      error: null,
      requestId: "req_hold",
    }),
  }));

  await gotoReady(page, "/room/ROOM1234");
  await page.getByLabel(/song link, title, or artist/i).fill("Candidate Pick — Room Artist");
  await page.getByRole("button", { name: /find and add song/i }).click();
  await expect(page.getByRole("link", { name: "Open a held candidate on Spotify" })).toHaveAttribute("href", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
  await expect(page.getByRole("link", { name: /Candidate Pick/ })).toHaveAttribute("href", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
  await expect(page.getByText(/91% metadata score/i)).toHaveCount(0);
  await expect(page.getByText(/Listen to the choices and pick the exact recording/i)).toBeVisible();
});

test("Spotify title-only metadata reaches explicit Apple Music selection and stages only the selected grant", async ({ page }) => {
  await mockRoom(page, "guest");
  let command: { action: string; payload: { resolutionId: string } } | null = null;
  await page.route("**/api/v1/rooms/ROOM1234/resolve", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: {
        status: "hold",
        storefront: "US",
        reasons: ["source_metadata_incomplete"],
        sourceAttribution: {
          provider: "spotify",
          title: "Never Gonna Give You Up",
          providerUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
        },
        candidates: [{
          resolutionId: "res_manual_apple_01",
          candidate: {
            title: "Never Gonna Give You Up",
            artists: ["Rick Astley"],
            provider: "apple_music",
            providerRecordingId: "1559523357",
            providerUrl: "https://music.apple.com/us/song/1559523357",
          },
          score: 1,
        }],
      },
      error: null,
      requestId: "req_manual_review",
    }),
  }));
  await page.route("**/api/v1/rooms/ROOM1234/commands", (route) => {
    command = route.request().postDataJSON() as typeof command;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { type: "ack", seq: 5 }, error: null, requestId: "req_manual_stage" }),
    });
  });

  await gotoReady(page, "/room/ROOM1234");
  await page.getByLabel(/search in/i).selectOption("apple-music");
  await page.getByLabel(/song link, title, or artist/i).fill("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
  await page.getByRole("button", { name: /find and add song/i }).click();
  await expect(page.getByRole("link", { name: /open never gonna give you up on spotify/i })).toHaveAttribute("href", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
  await expect(page.locator(".provider-brand")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /choose this version/i })).toBeVisible();
  expect(command).toBeNull();
  await page.getByRole("button", { name: /choose this version/i }).click();
  await expect(page.getByRole("status").filter({ hasText: /was added to the room/i })).toBeVisible();
  expect(command).toEqual(expect.objectContaining({ action: "suggestion.stage", payload: expect.objectContaining({ resolutionId: "res_manual_apple_01" }) }));
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
  await expect(page.getByRole("status").filter({ hasText: "Confirmed Pick moved to Played" })).toBeVisible();
  expect(command).toEqual(expect.objectContaining({ action: "queue.advance", payload: { occurrenceId: "occ_now12345" } }));
});

test("a participant can remove their existing vote by occurrence ID", async ({ page }) => {
  const votedSnapshot = {
    ...snapshot,
    occurrences: [{
      occurrenceId: "occ_now12345",
      recordingId: "rec_now12345",
      suggestionId: "sug_now12345",
      title: "Voted Pick",
      status: "now",
      position: 0,
      cosignerIds: [],
      voterIds: ["guest_12345678"],
    }],
  };
  await mockRoom(page, "guest", votedSnapshot);
  let command: { action: string; payload: { occurrenceId: string; vote: boolean } } | null = null;
  await page.route("**/api/v1/rooms/ROOM1234/commands", (route) => {
    command = route.request().postDataJSON() as typeof command;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { type: "ack", seq: 5 }, error: null, requestId: "req_vote" }),
    });
  });

  await gotoReady(page, "/room/ROOM1234");
  const removeVote = page.getByRole("button", { name: "Remove vote from Voted Pick" });
  await expect(removeVote).toHaveAttribute("aria-pressed", "true");
  await removeVote.click();
  await expect(page.getByRole("status").filter({ hasText: "Vote removed for Voted Pick" })).toBeVisible();
  expect(command).toEqual(expect.objectContaining({ action: "queue.vote", payload: { occurrenceId: "occ_now12345", vote: false } }));
});

test("host readiness, lock, and room ending controls complete without dead ends", async ({ page }) => {
  await mockRoom(page, "host");
  const actions: Array<{ action: string; payload: Record<string, unknown> }> = [];
  await page.route("**/api/v1/rooms/ROOM1234/commands", (route) => {
    actions.push(route.request().postDataJSON() as { action: string; payload: Record<string, unknown> });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { type: "ack", seq: 5 }, error: null, requestId: "req_control" }),
    });
  });
  let ended = false;
  await page.route("**/api/v1/rooms/ROOM1234/end", (route) => {
    ended = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { roomId: "ROOM1234", ended: true }, error: null, requestId: "req_end" }),
    });
  });

  await gotoReady(page, "/room/ROOM1234");
  await page.getByRole("button", { name: "Ready for the cue" }).click();
  await expect(page.getByRole("status").filter({ hasText: "no longer marked ready" })).toBeVisible();
  await page.getByRole("button", { name: "Lock room" }).click();
  await expect(page.getByRole("status").filter({ hasText: "locked to new guests" })).toBeVisible();
  await page.getByRole("button", { name: "End room" }).click();
  await expect(page.getByText(/close every guest session/i)).toBeVisible();
  await page.getByRole("button", { name: "End room now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "recap is now final" })).toBeVisible();
  expect(actions).toEqual([
    expect.objectContaining({ action: "participant.ready", payload: { ready: false } }),
    expect.objectContaining({ action: "room.rules.update", payload: { rules: { locked: true } } }),
  ]);
  expect(ended).toBe(true);
});

test("co-host recap does not lead to owner-only publishing", async ({ page }) => {
  await mockRoom(page, "cohost");
  await gotoReady(page, "/room/ROOM1234/recap");
  await expect(page.getByRole("link", { name: /review publishing/i })).toHaveCount(0);
});

test("an authority close refreshes an ended room once and stops reconnecting", async ({ page }) => {
  let stateReads = 0;
  let socketAttempts = 0;
  await page.route("**/api/v1/rooms/ROOM1234/state**", (route) => {
    stateReads += 1;
    const roomSnapshot = stateReads === 1 ? snapshot : { ...snapshot, lifecycle: "ended" as const, seq: 5 };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          type: "snapshot",
          reset: true,
          snapshot: roomSnapshot,
          latestSeq: roomSnapshot.seq,
          actor: { participantId: "host_12345678", role: "host", nickname: "Room Host" },
        },
        error: null,
        requestId: `req_state_${stateReads}`,
      }),
    });
  });
  await page.routeWebSocket("**/api/v1/rooms/ROOM1234/websocket", async (socket) => {
    socketAttempts += 1;
    await socket.close({ code: 1008, reason: "Room authority changed" });
  });

  await gotoReady(page, "/room/ROOM1234");
  await expect(page.getByText("The setlist is read-only. Open the recap to review played occurrences.")).toBeVisible();
  expect(stateReads).toBe(2);
  await expect.poll(() => socketAttempts, { timeout: 1_500 }).toBe(1);
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

test("a signed-in invitee gets a one-tap name-prefilled join", async ({ page }) => {
  let joinedNickname = "";
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: { accountId: "account_12345678", displayName: "Mason", recentPasskey: true, recoveryEnrollmentAvailable: false }, error: null, requestId: "req_me" }),
  }));
  await page.route("**/api/v1/rooms/ROOM1234/join", (route) => {
    joinedNickname = (route.request().postDataJSON() as { nickname: string }).nickname;
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ data: { role: "guest" }, error: null, requestId: "req_joined" }),
    });
  });
  await mockRoom(page, "guest");

  await gotoReady(page, "/join/ROOM1234#cap=secret-capability");
  const name = page.getByRole("textbox", { name: /your name in the room/i });
  await expect(name).toHaveValue("Mason");
  await expect(page.getByText(/what do you listen with/i)).toHaveCount(0);
  await page.getByRole("button", { name: /join room/i }).click();
  await expect(page).toHaveURL(/\/room\/ROOM1234$/);
  expect(joinedNickname).toBe("Mason");
});

test("listening preference is local, explicit, and drives the next catalog search", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("unijam.listening-preference", "apple-music"));
  await mockRoom(page, "guest");
  let requestedProvider = "";
  await page.route("**/api/v1/rooms/ROOM1234/resolve", (route) => {
    requestedProvider = (route.request().postDataJSON() as { provider: string }).provider;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { status: "no_match" }, error: null, requestId: "req_no_match" }),
    });
  });

  await gotoReady(page, "/room/ROOM1234");
  await expect(page.getByRole("radio", { name: "Apple Music" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/does not sign you in or connect a music account/i)).toBeVisible();
  await expect(page.getByLabel(/search in/i)).toHaveValue("apple-music");
  await page.getByLabel(/song link, title, or artist/i).fill("Massive Attack — Teardrop");
  await page.getByRole("button", { name: /find and add song/i }).click();
  await expect(page.getByText(/No reliable US recording matched/i)).toBeVisible();
  expect(requestedProvider).toBe("apple-music");
});

test("host workspace lists active rooms and ended recaps from the registry", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: { accountId: "account_12345678", displayName: "Room Host", recentPasskey: true, recoveryEnrollmentAvailable: false }, error: null, requestId: "req_host" }),
  }));
  await page.route("**/api/v1/rooms", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: { rooms: [
      { roomId: "ROOM1234", lifecycle: "active", inviteEpoch: 2, createdAtMs: 1_700_000_000_000, updatedAtMs: 1_700_000_001_000, endedAtMs: null },
      { roomId: "ENDED123", lifecycle: "ended", inviteEpoch: 1, createdAtMs: 1_699_000_000_000, updatedAtMs: 1_700_000_002_000, endedAtMs: 1_700_000_002_000 },
    ] }, error: null, requestId: "req_rooms" }),
  }));

  await gotoReady(page, "/host");
  await expect(page.getByRole("link", { name: /Room ROOM1234/ })).toHaveAttribute("href", "/room/ROOM1234");
  await expect(page.getByRole("link", { name: /Room ENDED123/ })).toHaveAttribute("href", "/room/ENDED123/recap");
});

test("host can replace and copy the live room invite with an explicit warning", async ({ page }) => {
  await mockRoom(page, "host");
  await page.route("**/api/v1/rooms/ROOM1234/invite/rotate", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: { roomId: "ROOM1234", inviteEpoch: 2, guestInvite: "https://staging.unijam.ashlr.ai/join/ROOM1234#cap=replaced-capability" }, error: null, requestId: "req_rotate" }),
  }));

  await gotoReady(page, "/room/ROOM1234");
  await page.getByRole("button", { name: "Replace invite" }).click();
  await expect(page.getByText(/closes every current guest session/i)).toBeVisible();
  await page.getByRole("button", { name: "Replace invite", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Copy new invite" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Previous guest sessions were closed" })).toBeVisible();
});

test("native handoff records request and host confirmation around an exact provider link", async ({ page }) => {
  const nowSnapshot = { ...snapshot, occurrences: [{ occurrenceId: "occ_now12345", recordingId: "rec_now12345", suggestionId: "sug_now12345", title: "Confirmed Pick", status: "now", position: 0, cosignerIds: [], voterIds: [] }] };
  await mockRoom(page, "host", nowSnapshot);
  const actions: string[] = [];
  await page.route("**/api/v1/rooms/ROOM1234/handoff/spotify", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: { occurrenceId: "occ_now12345", recordingId: "rec_now12345", title: "Confirmed Pick", provider: "spotify", links: { universalUrl: "https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh", nativeUri: "spotify:track:4iV5W9uYEdYUVa79Axb7Rh", storefront: "US" } }, error: null, requestId: "req_handoff" }),
  }));
  await page.route("**/api/v1/rooms/ROOM1234/commands", (route) => {
    actions.push((route.request().postDataJSON() as { action: string }).action);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { type: "ack", seq: 5 }, error: null, requestId: "req_command" }) });
  });

  await gotoReady(page, "/room/ROOM1234/handoff/spotify");
  await page.getByRole("button", { name: "Prepare Spotify handoff" }).click();
  await expect(page.getByRole("link", { name: /Open Confirmed Pick on Spotify/ })).toHaveAttribute("href", "https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh");
  await page.getByRole("button", { name: "Confirm handoff opened" }).click();
  await expect(page.getByRole("button", { name: "Handoff confirmed" })).toBeDisabled();
  expect(actions).toEqual(["handoff.request", "handoff.confirm"]);
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(accessibility.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
});

test("immutable publishing completes through preview, owner confirmation, and status", async ({ page }) => {
  const publishSnapshot = { ...snapshot, occurrences: [{ occurrenceId: "occ_now12345", recordingId: "rec_now12345", suggestionId: "sug_now12345", title: "Confirmed Pick", status: "played", position: 0, cosignerIds: [], voterIds: [], playbackConfirmedAtMs: 1_700_000_001_000 }] };
  const immutablePreview = { previewId: "preview:spotify:ROOM1234:r4:account", payloadFingerprint: "fingerprint-v1", roomRevision: 4, provider: "spotify", destination: { kind: "new_private_playlist", name: "UniJam ROOM1234", description: "Created from a live UniJam room\n[UniJam recovery unijam:v1:create_playlist:0123456789abcdef]" }, items: [{ canonicalRecordingId: "rec_now12345", providerRecordingId: "4iV5W9uYEdYUVa79Axb7Rh", position: 0, itemKey: "item-1" }], createdAtMs: 1_700_000_002_000 };
  await mockRoom(page, "host", publishSnapshot);
  await page.route("**/api/v1/rooms/ROOM1234/publish-preview", (route) => route.fulfill({
    status: 201, contentType: "application/json",
    body: JSON.stringify({ data: immutablePreview, error: null, requestId: "req_preview" }),
  }));
  await page.route("**/api/v1/rooms/ROOM1234/publish-confirmation", (route) => route.fulfill({
    status: 202, contentType: "application/json",
    body: JSON.stringify({ data: { operationId: "publish:spotify:ROOM1234:r4:account" }, error: null, requestId: "req_confirm" }),
  }));
  await page.route(/\/api\/v1\/rooms\/ROOM1234\/publish\/operations\/publish%3Aspotify%3AROOM1234%3Ar4%3Aaccount$/, (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: { operationId: "publish:spotify:ROOM1234:r4:account", provider: "spotify", destinationPlaylistId: "3cEYpjA9oz9GiPac4AsH4n", destinationUrl: "https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n", state: { operation: { preview: immutablePreview }, phase: "succeeded", attempt: 1, appliedItemKeys: ["item-1"], pendingItemKeys: [] }, recoveryRequired: null, updatedAtMs: 1_700_000_003_000 }, error: null, requestId: "req_operation" }),
  }));

  await gotoReady(page, "/room/ROOM1234/publish");
  await page.getByRole("button", { name: "Review immutable preview" }).click();
  await expect(page.getByText("Fingerprint locked")).toBeVisible();
  await page.getByRole("checkbox", { name: /Create this exact private playlist/ }).check();
  await page.getByRole("button", { name: "Confirm and publish" }).click();
  await expect(page.getByRole("heading", { name: "Published" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Open UniJam ROOM1234 on Spotify/ })).toHaveAttribute("href", "https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Published" })).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(accessibility.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
});
