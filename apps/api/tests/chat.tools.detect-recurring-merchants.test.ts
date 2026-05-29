import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { detectRecurringMerchants } from "../src/chat/tools/detect-recurring-merchants.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("detectRecurringMerchants tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let acctId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `rec-${Date.now()}`, email: `rec-${Date.now()}@t.co`, name: "REC" } });
    const ws = await prisma.workspace.create({ data: { name: "rec-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id };
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });
    acctId = acct.id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function addTx(merchantNormalized: string, amount: string, occurredAt: Date) {
    await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acctId,
        plaidTransactionId: `r-${merchantNormalized}-${occurredAt.toISOString()}`,
        amount,
        merchantRaw: merchantNormalized,
        merchantNormalized,
        occurredAt,
        rawData: {},
      },
    });
  }

  it("detects monthly cadence with high confidence", async () => {
    const base = new Date();
    for (let i = 0; i < 5; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 15);
      await addTx("netflix", "15.99", d);
    }
    const res = await detectRecurringMerchants.run(ctx, {});
    const netflix = res.candidates.find((c) => c.merchantNormalized === "netflix");
    expect(netflix?.cadence).toBe("monthly");
    expect(netflix?.confidence).toBeGreaterThan(0.6);
    expect(netflix?.medianAmount).toBe("15.99");
  });

  it("excludes negative amounts", async () => {
    const base = new Date();
    for (let i = 0; i < 4; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 20);
      await addTx("refund-vendor", "-10.00", d);
    }
    const res = await detectRecurringMerchants.run(ctx, {});
    expect(res.candidates.find((c) => c.merchantNormalized === "refund-vendor")).toBeUndefined();
  });

  it("respects min_occurrences", async () => {
    const base = new Date();
    for (let i = 0; i < 2; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
      await addTx("twice", "5.00", d);
    }
    const res = await detectRecurringMerchants.run(ctx, { min_occurrences: 3 });
    expect(res.candidates.find((c) => c.merchantNormalized === "twice")).toBeUndefined();
  });

  it("falls back to normalizeMerchant when merchantNormalized is null", async () => {
    const base = new Date();
    for (let i = 0; i < 4; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 12);
      await prisma.transaction.create({
        data: {
          workspaceId: wsId,
          accountId: acctId,
          plaidTransactionId: `fb-${i}`,
          amount: "9.99",
          merchantRaw: "Spotify   ON",
          merchantNormalized: null,
          occurredAt: d,
          rawData: {},
        },
      });
    }
    const res = await detectRecurringMerchants.run(ctx, {});
    expect(res.candidates.some((c) => c.merchantNormalized === "spotify")).toBe(true);
  });

  it("groups by merchant key and uses workspace currency", async () => {
    const base = new Date();
    for (let i = 0; i < 4; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
      await addTx("gym", "20.00", d);
    }
    const res = await detectRecurringMerchants.run(ctx, {});
    const gym = res.candidates.find((c) => c.merchantNormalized === "gym");
    expect(gym).toBeDefined();
    expect(gym?.currency).toBe("CAD");
    expect(gym?.occurrences).toBe(4);
  });

  it("returns recurring_candidates with a consumable add_form_intent and excludes irregular", async () => {
    const base = new Date();
    for (let i = 0; i < 4; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 10);
      await addTx("disney", "13.99", d);
    }
    const r = await detectRecurringMerchants.run(ctx, {});
    if (!r.block) throw new Error("no block — ensure the suite seeds a detectable monthly merchant");
    if (r.block.type !== "recurring_candidates") throw new Error("wrong block");
    const row = r.block.rows[0]!;
    expect(["monthly", "biweekly", "weekly", "semimonthly", "yearly"]).toContain(row.cadence);
    expect(typeof row.add_form_intent).toBe("string");
    expect(row.defaults.next_occurrence_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const { consumeIntentService } = await import("../src/intents/service.js");
    const out = await consumeIntentService(
      { workspaceId: wsId, userId: ctx.userId, role: "owner", env: {} as never },
      row.add_form_intent,
      { next_occurrence_date: row.defaults.next_occurrence_date },
    );
    expect(out.result).toBeTruthy();
  });

  it("excludes low-confidence irregular candidates", async () => {
    const base = new Date();
    // Irregular gaps AND irregular amounts — both signals weak, so confidence < 0.45.
    await addTx("chaotic", "5.00", new Date(base.getFullYear(), base.getMonth() - 1, 1));
    await addTx("chaotic", "200.00", new Date(base.getFullYear(), base.getMonth() - 1, 23));
    await addTx("chaotic", "50.00", new Date(base.getFullYear(), base.getMonth(), 17));
    const res = await detectRecurringMerchants.run(ctx, {});
    expect(res.candidates.find((c) => c.merchantNormalized === "chaotic")).toBeUndefined();
  });
});

describe("multi-currency grouping", () => {
  it("returns separate Candidates for the same merchant in different currencies", async () => {
    const u = await prisma.user.create({
      data: { id: `mc-${Date.now()}`, email: `mc-${Date.now()}@t.co`, name: "MC" },
    });
    const ws = await prisma.workspace.create({ data: { name: "mc-ws" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    const ctx = { env: {} as never, workspaceId: ws.id, userId: u.id };

    const usdAccount = await prisma.bankAccount.create({
      data: { workspaceId: ws.id, name: "USD Acct", type: "depository", currency: "USD" },
    });
    const cadAccount = await prisma.bankAccount.create({
      data: { workspaceId: ws.id, name: "CAD Acct", type: "depository", currency: "CAD" },
    });

    // 4 USD transactions, monthly cadence (one per month, Jan-Apr 2026)
    for (let i = 0; i < 4; i++) {
      await prisma.transaction.create({
        data: {
          workspaceId: ws.id,
          accountId: usdAccount.id,
          plaidTransactionId: `mc-usd-${i}`,
          amount: "9.99",
          merchantRaw: "Netflix",
          merchantNormalized: "netflix",
          occurredAt: new Date(`2026-0${i + 1}-15T00:00:00.000Z`),
          rawData: {},
        },
      });
    }
    // 4 CAD transactions, same merchant + cadence
    for (let i = 0; i < 4; i++) {
      await prisma.transaction.create({
        data: {
          workspaceId: ws.id,
          accountId: cadAccount.id,
          plaidTransactionId: `mc-cad-${i}`,
          amount: "13.99",
          merchantRaw: "Netflix",
          merchantNormalized: "netflix",
          occurredAt: new Date(`2026-0${i + 1}-20T00:00:00.000Z`),
          rawData: {},
        },
      });
    }

    const result = await detectRecurringMerchants.run(ctx, {
      lookback_months: 6,
      min_occurrences: 3,
    });

    const netflixUsd = result.candidates.find((c) => c.currency === "USD");
    const netflixCad = result.candidates.find((c) => c.currency === "CAD");
    expect(netflixUsd).toBeDefined();
    expect(netflixCad).toBeDefined();
    expect(netflixUsd?.medianAmount).toBe("9.99");
    expect(netflixCad?.medianAmount).toBe("13.99");
    expect(netflixUsd?.transactionIds.length).toBe(4);
    expect(netflixCad?.transactionIds.length).toBe(4);

    await prisma.workspace.delete({ where: { id: ws.id } });
  });
});
