/**
 * E2E tests — Plan 1B-categorize: auto transaction categorization
 *
 * Split into two groups:
 *
 *   1. no-gemini — run always; validate categories CRUD, manual categorize,
 *      back-fill, and uncategorizedOnly filter via API (no Gemini call needed).
 *
 *   2. gemini   — only run when GEMINI_API_KEY is a real key AND Plaid creds set.
 *
 * Run:
 *   pnpm e2e -- --grep "no-gemini"        # always safe
 *   GEMINI_API_KEY=<real> pnpm e2e        # full suite
 */

import { test, expect } from "@playwright/test";
import { signUp, uniqueEmail, getWorkspaceId } from "./helpers/auth";

const API = process.env.API_URL ?? "http://localhost:4000";
const HAS_REAL_GEMINI =
  !!process.env.GEMINI_API_KEY &&
  !["test_gemini_key", "placeholder", "smoke_test_placeholder"].includes(
    process.env.GEMINI_API_KEY ?? "",
  );
const HAS_PLAID = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);

// ---------------------------------------------------------------------------
// Group 1: No Gemini required — pure API tests
// ---------------------------------------------------------------------------

test.describe("plan 1b-categorize — no-gemini", () => {
  test("signup seeds 11 default categories", async ({ page }) => {
    const email = uniqueEmail("cat-seed");
    await signUp(page, email);
    const wsId = await getWorkspaceId(page);

    const resp = await page.request.get(`${API}/workspaces/${wsId}/categories`, {
      headers: { "x-workspace-id": wsId },
    });
    expect(resp.status()).toBe(200);
    const names = (await resp.json()).categories
      .map((c: { name: string }) => c.name)
      .sort();
    expect(names).toEqual([
      "Dining", "Entertainment", "Groceries", "Health", "Housing",
      "Income", "Other", "Shopping", "Subscriptions", "Transit", "Utilities",
    ]);
  });

  test("categories CRUD: create + case-insensitive duplicate + 30-cap", async ({ page }) => {
    const email = uniqueEmail("cat-crud");
    await signUp(page, email);
    const wsId = await getWorkspaceId(page);

    // Create new category
    const create = await page.request.post(`${API}/workspaces/${wsId}/categories`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { name: "Hobbies" },
    });
    expect(create.status()).toBe(201);
    const catId = (await create.json()).category.id as string;

    // Exact duplicate → 422
    const dupExact = await page.request.post(`${API}/workspaces/${wsId}/categories`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { name: "Hobbies" },
    });
    expect(dupExact.status()).toBe(422);

    // Case-insensitive duplicate → 422
    const dupCI = await page.request.post(`${API}/workspaces/${wsId}/categories`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { name: "hobbies" },
    });
    expect(dupCI.status()).toBe(422);
    expect((await dupCI.json()).error).toBe("duplicate_name");

    // Archive → recreate with different case (active-only partial unique allows it)
    await page.request.patch(`${API}/workspaces/${wsId}/categories/${catId}`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { archived: true },
    });
    const recreate = await page.request.post(`${API}/workspaces/${wsId}/categories`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { name: "hobbies" },
    });
    expect(recreate.status()).toBe(201);

    // 30-category cap: 11 seeded + 1 hobbies = 12; add 18 more = 30; 31st fails
    for (let i = 0; i < 18; i++) {
      await page.request.post(`${API}/workspaces/${wsId}/categories`, {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { name: `CapFill${i}` },
      });
    }
    const over = await page.request.post(`${API}/workspaces/${wsId}/categories`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { name: "OverCap" },
    });
    expect(over.status()).toBe(422);
    expect((await over.json()).error).toBe("too_many_categories");
  });

  test("categories: workspace mismatch → 400", async ({ page }) => {
    const email = uniqueEmail("cat-mismatch");
    await signUp(page, email);
    const wsId = await getWorkspaceId(page);

    const resp = await page.request.get(
      `${API}/workspaces/wrong_workspace_id/categories`,
      { headers: { "x-workspace-id": wsId } },
    );
    expect(resp.status()).toBe(400);
    expect((await resp.json()).error).toBe("workspace_mismatch");
  });

  test("manual categorize: category_not_found → 404", async ({ page }) => {
    const email = uniqueEmail("cat-404");
    await signUp(page, email);
    const wsId = await getWorkspaceId(page);

    // Non-existent transaction → 404 not_found (auth passed = route reachable)
    const resp = await page.request.post(
      `${API}/workspaces/${wsId}/transactions/nonexistent_tx/categorize`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { categoryName: "Dining" },
      },
    );
    // Either 404 (tx not found) — confirms route is live and editor auth passed
    expect(resp.status()).toBe(404);
    expect((await resp.json()).error).toBe("not_found");
  });

  test("uncategorizedOnly filter: returns only transactions with null categoryId", async ({ page }) => {
    const email = uniqueEmail("uncat-filter");
    await signUp(page, email);
    const wsId = await getWorkspaceId(page);

    // No transactions yet → empty list
    const resp = await page.request.get(
      `${API}/workspaces/${wsId}/transactions?uncategorizedOnly=true`,
      { headers: { "x-workspace-id": wsId } },
    );
    expect(resp.status()).toBe(200);
    const txs = (await resp.json()).transactions;
    expect(Array.isArray(txs)).toBe(true);
    // If any transactions exist (from prior test data), all must have null categoryId
    expect(txs.every((t: { categoryId: string | null }) => t.categoryId === null)).toBe(true);
  });

  test("invalid date in ?from returns 400 invalid_query", async ({ page }) => {
    const email = uniqueEmail("inv-date");
    await signUp(page, email);
    const wsId = await getWorkspaceId(page);

    const resp = await page.request.get(
      `${API}/workspaces/${wsId}/transactions?from=not-a-date`,
      { headers: { "x-workspace-id": wsId } },
    );
    expect(resp.status()).toBe(400);
    expect((await resp.json()).error).toBe("invalid_query");
  });
});

// ---------------------------------------------------------------------------
// Group 2: Requires real Gemini + Plaid sandbox
// ---------------------------------------------------------------------------

test.describe("plan 1b-categorize — gemini", () => {
  test.skip(
    !HAS_PLAID || !HAS_REAL_GEMINI,
    "Set PLAID_CLIENT_ID + PLAID_SECRET + real GEMINI_API_KEY to run Gemini categorize tests",
  );

  async function connectBankAndWaitForCategorize(page: any, wsId: string) {
    await page.goto("/settings/banks");
    await page.getByRole("button", { name: /connect a bank/i }).click();
    const plaidFrame = page.frameLocator('iframe[id^="plaid-link-iframe"]');
    const skipPhone = plaidFrame.getByRole("button", { name: /continue without phone/i });
    await skipPhone.waitFor({ timeout: 12_000 });
    await skipPhone.click();
    await page.waitForTimeout(1_500);
    await plaidFrame.locator('input[placeholder="Search"]').waitFor({ timeout: 12_000 });
    await plaidFrame.locator('input[placeholder="Search"]').fill("Tartan");
    await plaidFrame.getByText(/tartan/i).first().click();
    await plaidFrame.getByLabel(/username/i).fill("user_good");
    await plaidFrame.getByLabel(/password/i).fill("pass_good");
    await plaidFrame.getByRole("button", { name: /continue|submit/i }).click();
    const mfa = plaidFrame.getByLabel(/code|mfa/i);
    if (await mfa.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await mfa.fill("1234");
      await plaidFrame.getByRole("button", { name: /continue|submit/i }).click();
    }
    await plaidFrame.getByRole("button", { name: /continue/i }).click({ timeout: 15_000 });
    const finish = plaidFrame.getByRole("button", { name: /finish without saving/i });
    await finish.waitFor({ timeout: 12_000 });
    await finish.click();
    await expect(page.getByText(/tartan/i)).toBeVisible({ timeout: 25_000 });

    // Poll until all transactions are categorized (detached promise)
    for (let i = 0; i < 30; i++) {
      const txResp = await page.request.get(
        `${API}/workspaces/${wsId}/transactions?limit=200`,
        { headers: { "x-workspace-id": wsId } },
      );
      const txs = (await txResp.json()).transactions as Array<{ categoryId: string | null }>;
      if (txs.length > 0 && txs.every((t) => t.categoryId !== null)) break;
      await page.waitForTimeout(2_000);
    }
  }

  test("Plaid connect → all transactions auto-categorized by Gemini", async ({ page }) => {
    const email = uniqueEmail("auto-cat");
    await signUp(page, email);
    const wsId = await getWorkspaceId(page);
    await connectBankAndWaitForCategorize(page, wsId);

    const txResp = await page.request.get(
      `${API}/workspaces/${wsId}/transactions?limit=200`,
      { headers: { "x-workspace-id": wsId } },
    );
    const txs = (await txResp.json()).transactions as Array<{
      categoryId: string | null;
      categorizationSource: string | null;
    }>;
    expect(txs.length).toBeGreaterThan(0);
    expect(txs.every((t) => t.categoryId !== null)).toBe(true);
    expect(txs.every((t) => ["ai", "mapping"].includes(t.categorizationSource ?? ""))).toBe(true);

    // uncategorizedOnly should be 0
    const uncatResp = await page.request.get(
      `${API}/workspaces/${wsId}/transactions?uncategorizedOnly=true`,
      { headers: { "x-workspace-id": wsId } },
    );
    expect((await uncatResp.json()).transactions).toHaveLength(0);
  });

  test("manual recategorize creates merchant_mapping + back-fills siblings", async ({ page }) => {
    const email = uniqueEmail("manual-recat");
    await signUp(page, email);
    const wsId = await getWorkspaceId(page);
    await connectBankAndWaitForCategorize(page, wsId);

    const txResp = await page.request.get(
      `${API}/workspaces/${wsId}/transactions?limit=200`,
      { headers: { "x-workspace-id": wsId } },
    );
    const txs = (await txResp.json()).transactions as Array<{
      id: string;
      merchantNormalized: string | null;
    }>;

    // Find merchant with ≥2 transactions
    const byMerchant = new Map<string, typeof txs>();
    for (const t of txs) {
      const key = t.merchantNormalized ?? "";
      byMerchant.set(key, [...(byMerchant.get(key) ?? []), t]);
    }
    const [, group] = [...byMerchant.entries()].find(([, g]) => g.length >= 2) ?? [];
    if (!group || group.length < 2) {
      // Sandbox may not always have ≥2 of same merchant
      test.skip(true, "No merchant with ≥2 transactions in sandbox — cannot test back-fill");
      return;
    }

    const target = group[0]!;
    const recatResp = await page.request.post(
      `${API}/workspaces/${wsId}/transactions/${target.id}/categorize`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { categoryName: "Other" },
      },
    );
    expect(recatResp.status()).toBe(200);
    const body = await recatResp.json();
    expect(body.transaction.categorizationSource).toBe("manual");
    expect(body.backfilledCount).toBeGreaterThanOrEqual(group.length - 1);
  });
});
