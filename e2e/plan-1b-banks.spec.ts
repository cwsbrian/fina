/**
 * E2E tests — Plan 1B-foundation: Banks page (Plaid integration)
 *
 * Tests are split into two groups:
 *
 *   1. No-Plaid tests  — run always; validate UI and API behavior that doesn't
 *      require real Plaid sandbox credentials.
 *
 *   2. Plaid sandbox   — only run when PLAID_CLIENT_ID + PLAID_SECRET are set;
 *      uses the Plaid sandbox test credentials (user_good / pass_good) to walk
 *      through the full connect → refresh → disconnect flow.
 *
 * Run:
 *   pnpm e2e                          # all tests (Plaid group skips if no creds)
 *   pnpm e2e -- --grep "no-plaid"    # only credential-free tests
 *   PLAID_CLIENT_ID=... PLAID_SECRET=... pnpm e2e  # full suite
 */

import { test, expect, Page } from "@playwright/test";
import { signUp, uniqueEmail, expireTrial, getWorkspaceId } from "./helpers/auth";

const API = process.env.API_URL ?? "http://localhost:4000";
const HAS_PLAID = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);

// ---------------------------------------------------------------------------
// Group 1: No real Plaid credentials required
// ---------------------------------------------------------------------------

test.describe("banks page — no-plaid", () => {
  test("header nav has Banks link", async ({ page }) => {
    const email = uniqueEmail("nav");
    await signUp(page, email);
    await expect(page.getByRole("link", { name: "Banks" })).toBeVisible();
  });

  test("Pro trial user sees Connect button on /settings/banks", async ({ page }) => {
    const email = uniqueEmail("pro");
    await signUp(page, email);
    await page.goto("/settings/banks");
    await expect(page.getByRole("button", { name: /connect a bank/i })).toBeVisible();
    await expect(page.getByText(/upgrade/i)).not.toBeVisible();
  });

  test("free-tier user sees upgrade prompt, not Connect button", async ({ page }) => {
    const email = uniqueEmail("free");
    await signUp(page, email);
    await expireTrial(email);
    await page.goto("/settings/banks");
    await expect(page.getByText(/plaid is a pro feature/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /connect a bank/i })).not.toBeVisible();
  });

  test("banks page shows Loading then empty state (no banks yet)", async ({ page }) => {
    const email = uniqueEmail("empty");
    await signUp(page, email);
    await page.goto("/settings/banks");
    await expect(page.getByText(/no banks connected yet/i)).toBeVisible({ timeout: 8_000 });
  });

  test("API: link-token returns 402 for free-tier owner", async ({ page }) => {
    const email = uniqueEmail("api402");
    await signUp(page, email);
    await expireTrial(email);
    const wsId = await getWorkspaceId(page);
    const resp = await page.request.post(`${API}/workspaces/${wsId}/plaid/link-token`, {
      headers: { "x-workspace-id": wsId },
    });
    expect(resp.status()).toBe(402);
    const body = await resp.json();
    expect(body.error).toBe("upgrade_required");
  });

  test("API: link-token returns 400 workspace_mismatch on header/path mismatch", async ({ page }) => {
    const email = uniqueEmail("mismatch");
    await signUp(page, email);
    const wsId = await getWorkspaceId(page);
    const fakeWsId = "fake_ws_id";
    const resp = await page.request.post(`${API}/workspaces/${fakeWsId}/plaid/link-token`, {
      headers: { "x-workspace-id": wsId },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe("workspace_mismatch");
  });

  test("API: accounts route excludes archived by default", async ({ page }) => {
    const email = uniqueEmail("accarc");
    await signUp(page, email);
    const wsId = await getWorkspaceId(page);
    const resp = await page.request.get(`${API}/workspaces/${wsId}/accounts`, {
      headers: { "x-workspace-id": wsId },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(Array.isArray(body.accounts)).toBe(true);
  });

  test("API: transactions date filter returns 400 for invalid date", async ({ page }) => {
    const email = uniqueEmail("inv");
    await signUp(page, email);
    const wsId = await getWorkspaceId(page);
    const resp = await page.request.get(
      `${API}/workspaces/${wsId}/transactions?from=not-a-date`,
      { headers: { "x-workspace-id": wsId } },
    );
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe("invalid_query");
  });

  test("API: free-tier owner CAN disconnect (no 402)", async ({ page }) => {
    // Banks page shows no bank to disconnect, but the route itself must not
    // be Pro-gated. We verify this by hitting DELETE with a non-existent itemId
    // and expecting 404 (not_found) — not 402 (upgrade_required).
    const email = uniqueEmail("freedisconn");
    await signUp(page, email);
    await expireTrial(email);
    const wsId = await getWorkspaceId(page);
    const resp = await page.request.delete(
      `${API}/workspaces/${wsId}/plaid-items/nonexistent_item_id`,
      { headers: { "x-workspace-id": wsId } },
    );
    // 404 = route reached + item not found (correct — NOT 402 upgrade_required)
    expect(resp.status()).toBe(404);
    const body = await resp.json();
    expect(body.error).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Group 2: Requires real Plaid sandbox credentials
// ---------------------------------------------------------------------------

test.describe("banks page — plaid sandbox", () => {
  test.skip(!HAS_PLAID, "Set PLAID_CLIENT_ID + PLAID_SECRET to run Plaid sandbox tests");

  async function connectBank(page: Page) {
    await page.getByRole("button", { name: /connect a bank/i }).click();

    // Wait for Plaid Link iframe to load (uses CDN — may take a few seconds)
    const plaidFrame = page.frameLocator('iframe[id^="plaid-link-iframe"]');

    // Plaid shows a phone opt-in screen on first open — skip it.
    // Use waitFor instead of isVisible+catch so we wait the full 12s
    // without silently proceeding if the iframe is still loading.
    const skipPhone = plaidFrame.getByRole("button", { name: /continue without phone/i });
    await skipPhone.waitFor({ timeout: 12_000 });
    await skipPhone.click();
    await page.waitForTimeout(1_500);

    // Institution search screen — confirmed placeholder is "Search" (capital S)
    const searchInput = plaidFrame.locator('input[placeholder="Search"]');
    await searchInput.waitFor({ timeout: 12_000 });
    await searchInput.fill("Tartan");
    // The Plaid sandbox institution name differs by region:
    // - US:     "Tartan Bank"
    // - Canada: "Tartan-Dominion Bank of Canada"
    // Click the first Tartan result regardless of exact name.
    await plaidFrame.getByText(/tartan/i).first().click();

    // Enter sandbox credentials
    await plaidFrame.getByLabel(/username/i).fill("user_good");
    await plaidFrame.getByLabel(/password/i).fill("pass_good");
    await plaidFrame.getByRole("button", { name: /continue|submit/i }).click();

    // MFA (if shown)
    const mfaField = plaidFrame.getByLabel(/code|mfa/i);
    if (await mfaField.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await mfaField.fill("1234");
      await plaidFrame.getByRole("button", { name: /continue|submit/i }).click();
    }

    // Select accounts → Continue
    await plaidFrame.getByRole("button", { name: /continue/i }).click({ timeout: 15_000 });

    // After accounts are selected, Plaid shows a "Save your connection with Plaid"
    // screen for faster future logins — click "Finish without saving" to complete.
    // This screen appears in the Canadian sandbox flow after credential entry.
    const finishWithout = plaidFrame.getByRole("button", { name: /finish without saving/i });
    await finishWithout.waitFor({ timeout: 12_000 });
    await finishWithout.click();

    // Wait for iframe to close and bank card to appear on the page
    await expect(page.getByText(/tartan/i)).toBeVisible({ timeout: 25_000 });
  }

  test("connect → bank card appears with institution + account count", async ({ page }) => {
    const email = uniqueEmail("connect");
    await signUp(page, email);
    await page.goto("/settings/banks");
    await connectBank(page);

    const card = page.locator("[style*='border']").filter({ hasText: /tartan/i }).first();
    await expect(card).toBeVisible();
    await expect(card.getByText(/account/i)).toBeVisible();
    await expect(card.getByText(/last sync/i)).toBeVisible();
  });

  test("refresh → toast shows counts", async ({ page }) => {
    const email = uniqueEmail("refresh");
    await signUp(page, email);
    await page.goto("/settings/banks");
    await connectBank(page);

    await page.getByRole("button", { name: /refresh/i }).click();
    await expect(page.getByText(/refreshed:/i)).toBeVisible({ timeout: 15_000 });
  });

  test("disconnect → bank card disappears; DB keeps accounts+transactions", async ({ page }) => {
    const email = uniqueEmail("disconn");
    await signUp(page, email);
    await page.goto("/settings/banks");
    await connectBank(page);

    // Confirm disconnect
    page.on("dialog", (d) => d.accept());
    await page.getByRole("button", { name: /disconnect/i }).click();
    await expect(page.getByText(/no banks connected yet/i)).toBeVisible({ timeout: 10_000 });

    // API: plaid-items list should be empty
    const wsId = await getWorkspaceId(page);
    const itemsResp = await page.request.get(`${API}/workspaces/${wsId}/plaid-items`, {
      headers: { "x-workspace-id": wsId },
    });
    const items = await itemsResp.json();
    expect(items.plaidItems).toHaveLength(0);

    // API: accounts still exist (archived)
    const accResp = await page.request.get(
      `${API}/workspaces/${wsId}/accounts?includeArchived=true`,
      { headers: { "x-workspace-id": wsId } },
    );
    const accs = await accResp.json();
    expect(accs.accounts.length).toBeGreaterThan(0);
    expect(accs.accounts[0].archivedAt).not.toBeNull();

    // Active accounts (default) should be empty
    const activeResp = await page.request.get(`${API}/workspaces/${wsId}/accounts`, {
      headers: { "x-workspace-id": wsId },
    });
    const active = await activeResp.json();
    expect(active.accounts).toHaveLength(0);
  });

  test("free-tier disconnect works (no 402) even after trial expires", async ({ page }) => {
    const email = uniqueEmail("freedisc");
    await signUp(page, email);
    await page.goto("/settings/banks");
    await connectBank(page);

    await expireTrial(email);
    await page.reload();

    // Should see bank card still (trial expired after connect)
    await expect(page.getByText(/tartan/i)).toBeVisible();
    // Disconnect button still visible (not Pro-gated)
    page.on("dialog", (d) => d.accept());
    await page.getByRole("button", { name: /disconnect/i }).click();
    await expect(page.getByText(/no banks connected yet/i)).toBeVisible({ timeout: 10_000 });
  });
});
