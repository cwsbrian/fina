/**
 * E2E — Plan 1E-next. Real Gemini API call, verifies each of the 7 new
 * read-only chat tools is selected by the LLM for a representative prompt.
 *
 * Each test:
 *  1) signs up a fresh user, activates trial (Pro tier),
 *  2) seeds minimal data the tool can return (account/transactions/categories),
 *  3) sends a chat prompt that should trigger the tool,
 *  4) asserts the tool name appears in `toolCalls`.
 *
 * Run:
 *   GEMINI_API_KEY=... DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1e-next"
 *
 * Skipped without DB + GEMINI_API_KEY.
 */

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";

const API = process.env.API_URL ?? "http://localhost:4000";

const HAS_DB = (() => {
  try {
    execSync(`docker exec fina-postgres-dev psql -U fina -d fina -tAc "SELECT 1"`, {
      encoding: "utf8",
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
})();
const HAS_GEMINI = !!process.env.GEMINI_API_KEY;

function psql(sql: string): string {
  return execSync(
    `docker exec fina-postgres-dev psql -q -U fina -d fina -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf8" },
  ).trim();
}

type ChatResponse = {
  assistantMessage: { blocks: Array<{ markdown: string }> };
  toolCalls: Array<{ toolName: string }>;
};

async function signUpAndActivateTrial(
  page: import("@playwright/test").Page,
  email: string,
): Promise<{ userId: string; wsId: string }> {
  const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
    data: { email, password: "password-e2e-1234", name: "E2E Next" },
    headers: { "content-type": "application/json" },
  });
  expect(sign.ok()).toBe(true);
  const { user } = (await sign.json()) as { user: { id: string } };

  const wsRes = await page.request.get(`${API}/workspaces`);
  const { workspaces } = (await wsRes.json()) as { workspaces: { id: string }[] };
  const wsId = workspaces[0]!.id;

  psql(
    `UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${user.id}'`,
  );
  return { userId: user.id, wsId };
}

function seedAccount(wsId: string, name = "Chequing"): string {
  const id = `acct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  psql(
    `INSERT INTO bank_accounts (id, "workspaceId", name, type, currency, status, "createdAt") VALUES ('${id}', '${wsId}', '${name}', 'depository', 'CAD', 'active', NOW())`,
  );
  return id;
}

function seedCategory(wsId: string, name: string): string {
  const id = `cat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  psql(
    `INSERT INTO categories (id, "workspaceId", name, "createdAt") VALUES ('${id}', '${wsId}', '${name}', NOW())`,
  );
  return id;
}

function seedTransaction(
  wsId: string,
  accountId: string,
  opts: {
    amount: string;
    merchant: string;
    merchantNormalized?: string;
    occurredAt?: string; // ISO
    categoryId?: string | null;
    categorizationSource?: "manual" | "ai" | "mapping" | null;
  },
): string {
  const id = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const occurredAt = opts.occurredAt ?? new Date().toISOString();
  const cat = opts.categoryId ? `'${opts.categoryId}'` : "NULL";
  const merchantNormalized = opts.merchantNormalized
    ? `'${opts.merchantNormalized}'`
    : "NULL";
  const catSource = opts.categorizationSource
    ? `'${opts.categorizationSource}'`
    : "NULL";
  const plaidTx = `${id}-plaid`;
  psql(
    `INSERT INTO transactions (id, "workspaceId", "accountId", "plaidTransactionId", amount, currency, "merchantRaw", "merchantNormalized", "occurredAt", source, "rawData", "categoryId", "categorizationSource", "createdAt", "updatedAt") VALUES ('${id}', '${wsId}', '${accountId}', '${plaidTx}', ${opts.amount}, 'CAD', '${opts.merchant}', ${merchantNormalized}, '${occurredAt}', 'plaid', '{}'::jsonb, ${cat}, ${catSource}, NOW(), NOW())`,
  );
  return id;
}

async function chat(
  page: import("@playwright/test").Page,
  wsId: string,
  text: string,
): Promise<ChatResponse> {
  const res = await page.request.post(`${API}/workspaces/${wsId}/chat/message`, {
    headers: { "x-workspace-id": wsId, "content-type": "application/json" },
    data: { text },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as ChatResponse;
}

test.describe.configure({ mode: "serial" });

test.describe("plan 1e-next — real Gemini, 7 read-only tools", () => {
  test.skip(!HAS_DB || !HAS_GEMINI, "Requires DB + GEMINI_API_KEY");

  // Each turn fires up to 2 LLM calls (tool call + final synthesis). Gemini's
  // free tier caps generate_content at 10 req/min, so pace the suite enough
  // to stay under the limit when running back-to-back tests.
  const GEMINI_PACE_MS = Number(process.env.E2E_GEMINI_PACE_MS ?? 13_000);
  test.beforeEach(async () => {
    await new Promise((r) => setTimeout(r, GEMINI_PACE_MS));
  });

  // Each test makes one chat call (timeouts default to 30s). Bump per-test
  // timeout to account for the leading pacing wait.
  test.setTimeout(60_000);

  test.afterEach(async ({ page }) => {
    try {
      psql(`DELETE FROM workspaces WHERE name LIKE '%E2E Next%'`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-next.test'`);
    } catch {
      /* ignore */
    }
    await page.request.post(`${API}/api/auth/sign-out`).catch(() => {});
  });

  test("listAccounts: 'show my accounts' triggers listAccounts", async ({ page }) => {
    const email = `acc-${Date.now()}@e2e-next.test`;
    const { wsId } = await signUpAndActivateTrial(page, email);
    seedAccount(wsId, "Chequing");
    seedAccount(wsId, "Savings");

    const body = await chat(page, wsId, "Which bank accounts do I have connected?");
    expect(body.toolCalls.map((t) => t.toolName)).toContain("listAccounts");
    expect(body.assistantMessage.blocks[0]!.markdown.length).toBeGreaterThan(0);
  });

  test("getTransactionDetails: 'tell me about that transaction' triggers detail lookup", async ({
    page,
  }) => {
    const email = `det-${Date.now()}@e2e-next.test`;
    const { wsId } = await signUpAndActivateTrial(page, email);
    const acctId = seedAccount(wsId);
    const txId = seedTransaction(wsId, acctId, {
      amount: "42.50",
      merchant: "Starbucks Downtown",
      merchantNormalized: "starbucks",
    });

    const body = await chat(
      page,
      wsId,
      `Give me full details for transaction ${txId}`,
    );
    expect(body.toolCalls.map((t) => t.toolName)).toContain("getTransactionDetails");
  });

  test("findUncategorizedTransactions: 'what still needs categorizing' triggers tool", async ({
    page,
  }) => {
    const email = `unc-${Date.now()}@e2e-next.test`;
    const { wsId } = await signUpAndActivateTrial(page, email);
    const acctId = seedAccount(wsId);
    seedTransaction(wsId, acctId, { amount: "9.99", merchant: "Coffee" });
    seedTransaction(wsId, acctId, { amount: "12.00", merchant: "Lunch" });

    const body = await chat(page, wsId, "What transactions still need to be categorized?");
    expect(body.toolCalls.map((t) => t.toolName)).toContain(
      "findUncategorizedTransactions",
    );
  });

  test("getCategoryBreakdown: 'spending by category' triggers breakdown", async ({
    page,
  }) => {
    const email = `cat-${Date.now()}@e2e-next.test`;
    const { wsId } = await signUpAndActivateTrial(page, email);
    const acctId = seedAccount(wsId);
    const food = seedCategory(wsId, "Food");
    seedTransaction(wsId, acctId, {
      amount: "30.00",
      merchant: "Subway",
      categoryId: food,
    });

    const body = await chat(
      page,
      wsId,
      "Where did my money go by category this month?",
    );
    expect(body.toolCalls.map((t) => t.toolName)).toContain("getCategoryBreakdown");
  });

  test("compareSpendingPeriods: 'this month vs last month' triggers compare", async ({
    page,
  }) => {
    const email = `cmp-${Date.now()}@e2e-next.test`;
    const { wsId } = await signUpAndActivateTrial(page, email);
    const acctId = seedAccount(wsId);
    const food = seedCategory(wsId, "Food");
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5).toISOString();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 10).toISOString();
    seedTransaction(wsId, acctId, {
      amount: "20.00",
      merchant: "Subway",
      categoryId: food,
      occurredAt: thisMonth,
    });
    seedTransaction(wsId, acctId, {
      amount: "50.00",
      merchant: "Subway",
      categoryId: food,
      occurredAt: lastMonth,
    });

    const body = await chat(
      page,
      wsId,
      "Compare my spending this month with last month by category",
    );
    expect(body.toolCalls.map((t) => t.toolName)).toContain("compareSpendingPeriods");
  });

  test("detectRecurringMerchants: 'what subscriptions' triggers recurring detection", async ({
    page,
  }) => {
    const email = `rec-${Date.now()}@e2e-next.test`;
    const { wsId } = await signUpAndActivateTrial(page, email);
    const acctId = seedAccount(wsId);
    const base = new Date();
    for (let i = 0; i < 4; i++) {
      const occurredAt = new Date(base.getFullYear(), base.getMonth() - i, 15).toISOString();
      seedTransaction(wsId, acctId, {
        amount: "15.99",
        merchant: "Netflix",
        merchantNormalized: "netflix",
        occurredAt,
      });
    }

    const body = await chat(page, wsId, "What recurring subscriptions do I have?");
    expect(body.toolCalls.map((t) => t.toolName)).toContain("detectRecurringMerchants");
  });

  test("getCashflowSummary: 'income and expenses this month' triggers cashflow", async ({
    page,
  }) => {
    const email = `cf-${Date.now()}@e2e-next.test`;
    const { wsId } = await signUpAndActivateTrial(page, email);
    const acctId = seedAccount(wsId);
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 3).toISOString();
    seedTransaction(wsId, acctId, {
      amount: "-1000.00",
      merchant: "Payroll",
      occurredAt: thisMonth,
    });
    seedTransaction(wsId, acctId, {
      amount: "150.00",
      merchant: "Rent",
      occurredAt: thisMonth,
    });

    const body = await chat(
      page,
      wsId,
      "How much money came in and went out this month?",
    );
    expect(body.toolCalls.map((t) => t.toolName)).toContain("getCashflowSummary");
  });
});
