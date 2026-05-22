import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { findTransactions } from "../src/chat/tools/find-transactions.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("findTransactions tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let userId: string;
  let acctId: string;
  let acctOtherId: string;
  let foodCatId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `ft-${Date.now()}`, email: `ft-${Date.now()}@t.co`, name: "FT" } });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "ft-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId };

    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chequing", type: "depository" } });
    acctId = acct.id;
    const acctOther = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Savings", type: "depository" } });
    acctOtherId = acctOther.id;
    const foodCat = await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } });
    foodCatId = foodCat.id;

    // Seed transactions across April 2026 in Chequing, plus 1 Savings, plus 1 soft-deleted.
    const ftData: Array<{
      workspaceId: string; accountId: string; plaidTransactionId: string; amount: string;
      merchantRaw: string; merchantNormalized: string; occurredAt: Date; rawData: object;
      allocCategoryId: string | null; removedAt?: Date;
    }> = [
      { workspaceId: wsId, accountId: acctId, plaidTransactionId: "ft-1", amount: "5.00",   merchantRaw: "Starbucks Downtown",  merchantNormalized: "starbucks",       occurredAt: new Date("2026-04-02T12:00:00Z"), rawData: {}, allocCategoryId: foodCatId },
      { workspaceId: wsId, accountId: acctId, plaidTransactionId: "ft-2", amount: "8.50",   merchantRaw: "Starbucks Pike",       merchantNormalized: "starbucks",       occurredAt: new Date("2026-04-10T12:00:00Z"), rawData: {}, allocCategoryId: foodCatId },
      { workspaceId: wsId, accountId: acctId, plaidTransactionId: "ft-3", amount: "120.00", merchantRaw: "Whole Foods Market",   merchantNormalized: "whole foods",     occurredAt: new Date("2026-04-15T12:00:00Z"), rawData: {}, allocCategoryId: foodCatId },
      { workspaceId: wsId, accountId: acctId, plaidTransactionId: "ft-4", amount: "-50.00", merchantRaw: "Refund Inc",           merchantNormalized: "refund inc",      occurredAt: new Date("2026-04-20T12:00:00Z"), rawData: {}, allocCategoryId: null },
      { workspaceId: wsId, accountId: acctId, plaidTransactionId: "ft-5", amount: "1000.00",merchantRaw: "Rent April",           merchantNormalized: "rent",            occurredAt: new Date("2026-04-25T12:00:00Z"), rawData: {}, allocCategoryId: null },
      { workspaceId: wsId, accountId: acctId, plaidTransactionId: "ft-6", amount: "9.99",   merchantRaw: "Foreign Coffee",       merchantNormalized: "foreign coffee",  occurredAt: new Date("2026-04-12T12:00:00Z"), rawData: {}, allocCategoryId: null },
      { workspaceId: wsId, accountId: acctOtherId, plaidTransactionId: "ft-7", amount: "30.00", merchantRaw: "Subway",          merchantNormalized: "subway",          occurredAt: new Date("2026-04-18T12:00:00Z"), rawData: {}, allocCategoryId: foodCatId },
      { workspaceId: wsId, accountId: acctId, plaidTransactionId: "ft-8", amount: "2.00",   merchantRaw: "Deleted Latte",        merchantNormalized: "deleted latte",   occurredAt: new Date("2026-04-22T12:00:00Z"), rawData: {}, allocCategoryId: null, removedAt: new Date() },
    ];
    for (const d of ftData) {
      const { allocCategoryId, ...txData } = d;
      const tx = await prisma.transaction.create({ data: txData });
      await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
      await prisma.transactionAllocation.create({
        data: { transactionId: tx.id, categoryId: allocCategoryId, amount: d.amount, source: null },
      });
    }
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("no filters: returns up to 20 most recent active transactions in workspace", async () => {
    const r = await findTransactions.run(ctx, {});
    // 7 active transactions (ft-1..7); ft-8 soft-deleted.
    expect(r.transactions).toHaveLength(7);
    expect(r.totalCount).toBe(7);
    expect(r.hasMore).toBe(false);
    expect(r.filtersApplied.limit).toBe(20);
  });

  it("results sorted by occurredAt desc, id desc", async () => {
    const r = await findTransactions.run(ctx, {});
    const occurred = r.transactions.map((t) => t.occurredAt);
    const sorted = [...occurred].sort().reverse();
    expect(occurred).toEqual(sorted);
  });

  it("merchant_query matches on merchantRaw (case-insensitive)", async () => {
    const r = await findTransactions.run(ctx, { merchant_query: "STARBUCKS" });
    expect(r.transactions.map((t) => t.merchantRaw).sort()).toEqual(["Starbucks Downtown", "Starbucks Pike"]);
    expect(r.totalCount).toBe(2);
  });

  it("merchant_query matches on merchantNormalized when raw doesn't contain the query", async () => {
    // Seed a row with an asymmetric raw/normalized pair: the search term lives in
    // normalized only. Proves the OR clause actually searches the normalized column.
    await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acctId,
        plaidTransactionId: "ft-asym",
        amount: "4.00",
        merchantRaw: "Espresso Bar",
        merchantNormalized: "coffeehouse",
        occurredAt: new Date("2026-04-08T12:00:00Z"),
        rawData: {},
      },
    });
    const r = await findTransactions.run(ctx, { merchant_query: "coffeehouse" });
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]!.merchantRaw).toBe("Espresso Bar");
    expect(r.transactions[0]!.merchantNormalized).toBe("coffeehouse");
  });

  it("start_date and end_date are inclusive (YYYY-MM-DD)", async () => {
    const r = await findTransactions.run(ctx, { start_date: "2026-04-10", end_date: "2026-04-20" });
    const ids = r.transactions.map((t) => t.id).sort();
    // ft-2 (Apr 10), ft-6 (Apr 12), ft-3 (Apr 15), ft-7 (Apr 18), ft-4 (Apr 20)
    expect(ids.length).toBe(5);
  });

  it("amount_min and amount_max match abs(amount) for expenses AND refunds", async () => {
    // 5..100 absolute range. Matches ft-1 (5), ft-2 (8.50), ft-6 (9.99), ft-4 (50 abs), ft-7 (30).
    // Excludes ft-3 (120) and ft-5 (1000).
    const r = await findTransactions.run(ctx, { amount_min: 5, amount_max: 100 });
    const ids = r.transactions.map((t) => t.id).sort();
    expect(ids.length).toBe(5);
  });

  it("category_name resolves case-insensitively and filters by IN ids", async () => {
    const r = await findTransactions.run(ctx, { category_name: "food" });
    // ft-1, ft-2, ft-3, ft-7 are in Food. ft-4 (null), ft-5 (null), ft-6 (null), ft-8 (deleted) excluded.
    expect(r.transactions).toHaveLength(4);
  });

  it("account_name 'Chequing' resolves and filters out Savings transactions", async () => {
    const r = await findTransactions.run(ctx, { account_name: "chequing" });
    // ft-1..6 are in Chequing (not ft-7 Savings, ft-8 deleted).
    expect(r.transactions).toHaveLength(6);
    for (const t of r.transactions) expect(t.accountName).toBe("Chequing");
  });

  it("account_name resolves multiple accounts with the same name (in: ids)", async () => {
    const extraChequing = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chequing", type: "depository" } });
    await prisma.transaction.create({ data: { workspaceId: wsId, accountId: extraChequing.id, plaidTransactionId: "ft-extra", amount: "7.00", merchantRaw: "Other Chequing Tx", occurredAt: new Date("2026-04-28T12:00:00Z"), rawData: {} } });
    const r = await findTransactions.run(ctx, { account_name: "Chequing" });
    // 6 existing Chequing transactions + 1 in the extra Chequing = 7.
    expect(r.transactions).toHaveLength(7);
  });

  it("combined filters AND together correctly", async () => {
    const r = await findTransactions.run(ctx, {
      merchant_query: "starbucks",
      category_name: "Food",
      account_name: "Chequing",
      start_date: "2026-04-01",
      end_date: "2026-04-30",
      amount_min: 1,
      amount_max: 1000,
    });
    expect(r.transactions).toHaveLength(2); // ft-1 and ft-2
    expect(r.filtersApplied.merchantQuery).toBe("starbucks");
    expect(r.filtersApplied.categoryName).toBe("Food");
    expect(r.filtersApplied.accountName).toBe("Chequing");
  });

  it("limit=2 returns 2 rows, hasMore=true, totalCount reflects full match", async () => {
    const r = await findTransactions.run(ctx, { limit: 2 });
    expect(r.transactions).toHaveLength(2);
    expect(r.totalCount).toBe(7);
    expect(r.hasMore).toBe(true);
  });

  it("unknown category_name returns empty result, no throw, totalCount=0", async () => {
    const r = await findTransactions.run(ctx, { category_name: "NopeNotACat" });
    expect(r.transactions).toHaveLength(0);
    expect(r.totalCount).toBe(0);
    expect(r.hasMore).toBe(false);
    expect(r.filtersApplied.categoryName).toBe("NopeNotACat");
  });

  it("unknown account_name returns empty result, no throw, totalCount=0", async () => {
    const r = await findTransactions.run(ctx, { account_name: "Crypto Wallet" });
    expect(r.transactions).toHaveLength(0);
    expect(r.totalCount).toBe(0);
  });

  it("workspace isolation: cross-workspace transactions not returned", async () => {
    const otherWs = await prisma.workspace.create({ data: { name: "other" } });
    const otherAcct = await prisma.bankAccount.create({ data: { workspaceId: otherWs.id, name: "Chequing", type: "depository" } });
    await prisma.transaction.create({ data: { workspaceId: otherWs.id, accountId: otherAcct.id, plaidTransactionId: "x-1", amount: "999.00", merchantRaw: "Other Workspace Tx", occurredAt: new Date(), rawData: {} } });
    const r = await findTransactions.run(ctx, {});
    expect(r.transactions.find((t) => t.merchantRaw === "Other Workspace Tx")).toBeUndefined();
    await prisma.workspace.delete({ where: { id: otherWs.id } });
  });

  it("soft-deleted transactions excluded from results and totalCount", async () => {
    const r = await findTransactions.run(ctx, {});
    expect(r.transactions.find((t) => t.merchantRaw === "Deleted Latte")).toBeUndefined();
    expect(r.totalCount).toBe(7);
  });

  it("invalid_date: malformed dates rejected after Zod (round-trip mismatch)", async () => {
    await expect(findTransactions.run(ctx, { start_date: "2026-02-31" })).rejects.toThrow("invalid_date");
  });

  it("invalid_date_range: end_date < start_date is rejected", async () => {
    await expect(
      findTransactions.run(ctx, { start_date: "2026-04-15", end_date: "2026-04-01" }),
    ).rejects.toThrow("invalid_date_range");
  });

  it("invalid_amount_range: amount_max < amount_min is rejected", async () => {
    await expect(findTransactions.run(ctx, { amount_min: 100, amount_max: 50 })).rejects.toThrow("invalid_amount_range");
  });

  it("category_name filter matches split tx when one of its allocations has the category", async () => {
    // Seed a split tx: $60 Food + $40 Coffee. The tx total is $100.
    const coffeeCat = await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } });
    const splitTx = await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acctId,
        plaidTransactionId: "ft-split",
        amount: "100.00",
        merchantRaw: "Costco",
        merchantNormalized: "costco",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
        rawData: {},
      },
    });
    await prisma.transactionAllocation.deleteMany({ where: { transactionId: splitTx.id } });
    await prisma.transactionAllocation.createMany({
      data: [
        { transactionId: splitTx.id, categoryId: foodCatId, amount: "60.00", source: null },
        { transactionId: splitTx.id, categoryId: coffeeCat.id, amount: "40.00", source: null },
      ],
    });
    // Filter by Food — the split tx should be returned because one allocation is Food.
    const r = await findTransactions.run(ctx, { category_name: "Food" });
    const ids = r.transactions.map((t) => t.id);
    expect(ids).toContain(splitTx.id);
  });
});

describe("findTransactions tz-aware boundaries", () => {
  let kstCtx: ToolContext;
  let kstWsId: string;
  let kstUserId: string;
  let kstAcctId: string;

  beforeEach(async () => {
    // Inline-seed a KST user + workspace + account. Pattern matches the
    // module's outer beforeEach at lines 14-27.
    const u = await prisma.user.create({
      data: {
        id: `kst-${Date.now()}`,
        email: `kst-${Date.now()}@t.co`,
        name: "KST",
        tz: "Asia/Seoul",
      },
    });
    kstUserId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "kst-ws" } });
    kstWsId = ws.id;
    await prisma.membership.create({ data: { userId: kstUserId, workspaceId: kstWsId, role: "owner" } });
    kstCtx = { env: {} as never, workspaceId: kstWsId, userId: kstUserId };

    const acct = await prisma.bankAccount.create({
      data: { workspaceId: kstWsId, name: "KRW Chequing", type: "depository", currency: "KRW" },
    });
    kstAcctId = acct.id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: kstWsId } });
  });

  it("includes a transaction at KST 00:30 on the start_date day", async () => {
    // occurredAt = 2026-03-31T15:30Z = 2026-04-01T00:30 KST (the user's
    // notion of April 1 begins here — old UTC-midnight impl missed it).
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: kstWsId,
        accountId: kstAcctId,
        plaidTransactionId: "kst-1",
        amount: "10000",
        merchantRaw: "Coffee KST",
        occurredAt: new Date("2026-03-31T15:30:00.000Z"),
        rawData: {},
      },
    });

    const result = await findTransactions.run(kstCtx, {
      start_date: "2026-04-01",
      end_date: "2026-04-01",
    });

    expect(result.transactions.some((t) => t.id === tx.id)).toBe(true);
  });

  it("excludes a transaction at KST 00:30 on the day AFTER end_date", async () => {
    // occurredAt = 2026-04-01T15:30Z = 2026-04-02T00:30 KST
    // OLD UTC impl would include (end-of-day 04-01 UTC = 23:59:59 UTC includes 15:30 UTC)
    // NEW tz impl excludes (KST day rolled to 04-02 by then)
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: kstWsId,
        accountId: kstAcctId,
        plaidTransactionId: "kst-2",
        amount: "10000",
        merchantRaw: "Coffee KST next day",
        occurredAt: new Date("2026-04-01T15:30:00.000Z"),
        rawData: {},
      },
    });

    const result = await findTransactions.run(kstCtx, {
      start_date: "2026-04-01",
      end_date: "2026-04-01",
    });

    expect(result.transactions.some((t) => t.id === tx.id)).toBe(false);
  });
});
