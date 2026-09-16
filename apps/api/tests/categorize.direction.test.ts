import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { editTransactionService } from "../src/transactions/edit.js";
import { applyManualCategorize } from "../src/categorize/manual-categorize.js";
import { mapMerchantToCategoryService } from "../src/categorize/map-merchant.js";
import { categorizeNewTransactions } from "../src/categorize/service.js";
import { findHistoryHints } from "../src/categorize/history-lookup.js";
import { maybeAutoPromote } from "../src/categorize/auto-promote.js";
import { testEnv } from "./helpers/test-env.js";

vi.mock("../src/categorize/llm.js", () => ({ callLlmCategorize: vi.fn(async () => []) }));

let workspaceId: string;
let accountId: string;
let expenseId: string;
let incomeId: string;

beforeEach(async () => {
  workspaceId = (await prisma.workspace.create({ data: { name: "Direction regression" } })).id;
  accountId = (await prisma.bankAccount.create({ data: { workspaceId, name: "Checking", type: "depository" } })).id;
  expenseId = (await prisma.category.create({ data: { workspaceId, name: "Shopping", type: "expense" } })).id;
  incomeId = (await prisma.category.create({ data: { workspaceId, name: "Refund", type: "income" } })).id;
});
afterEach(async () => { await prisma.workspace.delete({ where: { id: workspaceId } }); });

async function seed(amount: number, categoryId: string | null = null, needsConfirmation = false) {
  return prisma.transaction.create({
    data: {
      workspaceId, accountId, merchantRaw: "Store", merchantNormalized: "store",
      amount, occurredAt: new Date(), source: "manual", rawData: {},
      budgetImpact: amount >= 0 ? "expense" : "income",
      allocations: { create: { amount, categoryId, source: categoryId ? "ai" : null, needsConfirmation } },
    },
  });
}
async function categoryOf(id: string) {
  return (await prisma.transactionAllocation.findFirstOrThrow({ where: { transactionId: id } })).categoryId;
}

describe("merchant category direction", () => {
  it.each(["picker", "manual", "mapping"] as const)("%s keeps refund and expense rules separate, including siblings and future imports", async (path) => {
    const expense = await seed(20);
    const refund = await seed(-20, incomeId, true);
    const change = async (id: string, categoryId: string, categoryName: string) => {
      if (path === "picker") {
        await editTransactionService({ workspaceId }, id, { categoryId }, { categoryIdProvided: true });
      } else if (path === "manual") {
        await applyManualCategorize({ workspaceId, txId: id, categoryName });
      } else {
        await mapMerchantToCategoryService({ workspaceId }, { merchant: "Store", categoryId });
      }
    };
    await change(expense.id, expenseId, "Shopping");
    expect(await categoryOf(refund.id)).toBe(incomeId);
    const reviewExpense = await seed(25, expenseId, true);
    const uncategorizedExpense = await seed(25);
    await change(refund.id, incomeId, "Refund");
    expect(await categoryOf(expense.id)).toBe(expenseId);
    expect(await categoryOf(reviewExpense.id)).toBe(expenseId);
    expect(await categoryOf(uncategorizedExpense.id)).toBeNull();
    expect(await prisma.merchantMapping.count({ where: { workspaceId } })).toBe(2);

    const nextExpense = await seed(30);
    const nextRefund = await seed(-30);
    await categorizeNewTransactions(testEnv(), workspaceId, [nextRefund.id, nextExpense.id]);
    expect(await categoryOf(nextExpense.id)).toBe(expenseId);
    expect(await categoryOf(nextRefund.id)).toBe(incomeId);
  });

  it("history independently remembers each direction and ignores previously mismatched categories", async () => {
    const expense = await seed(10, expenseId);
    await prisma.transaction.update({ where: { id: expense.id }, data: { occurredAt: new Date("2026-01-01") } });
    await seed(-10, incomeId);
    await seed(10, incomeId); // Legacy bad assignment must not teach future expenses.
    expect((await findHistoryHints(workspaceId, ["store"], "expense")).get("store")?.categoryId).toBe(expenseId);
    expect((await findHistoryHints(workspaceId, ["store"], "income")).get("store")?.categoryId).toBe(incomeId);
    const nextExpense = await seed(20);
    const nextRefund = await seed(-20);
    await categorizeNewTransactions(testEnv(), workspaceId, [nextExpense.id, nextRefund.id]);
    expect(await categoryOf(nextExpense.id)).toBe(expenseId);
    expect(await categoryOf(nextRefund.id)).toBe(incomeId);
  });

  it("automatic promotion counts matching directions and preserves both rules", async () => {
    for (let i = 0; i < 3; i++) {
      await seed(10, expenseId);
      await seed(-10, incomeId);
    }
    expect((await maybeAutoPromote(workspaceId, "store", expenseId)).promoted).toBe(true);
    expect((await maybeAutoPromote(workspaceId, "store", incomeId)).promoted).toBe(true);
    expect(await prisma.merchantMapping.count({ where: { workspaceId } })).toBe(2);
  });
});
