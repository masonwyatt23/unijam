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
