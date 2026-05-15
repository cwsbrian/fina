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

  async function addTx(merchantNormalized: string, amount: string, occurredAt: Date, currency = "CAD") {
    await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acctId,
        plaidTransactionId: `r-${merchantNormalized}-${currency}-${occurredAt.toISOString()}`,
        amount,
        currency,
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
          currency: "CAD",
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

  it("groups by (merchant, currency) separately", async () => {
    const base = new Date();
    for (let i = 0; i < 4; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
      await addTx("gym", "20.00", d, "CAD");
      await addTx("gym", "15.00", d, "USD");
    }
    const res = await detectRecurringMerchants.run(ctx, {});
    const cad = res.candidates.find((c) => c.key === "gym::CAD");
    const usd = res.candidates.find((c) => c.key === "gym::USD");
    expect(cad?.currency).toBe("CAD");
    expect(usd?.currency).toBe("USD");
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
