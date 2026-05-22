import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildBriefContext } from "../src/chat/brief-context.js";

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await disconnect();
});

describe("buildBriefContext", () => {
  it("returns 0 workspaces when user has no memberships", async () => {
    const u = await prisma.user.create({
      data: {
        id: `bc-empty-${Date.now()}`,
        email: `bc-${Date.now()}@t.co`,
        name: "BC",
      },
    });
    const ctx = await buildBriefContext(u.id, "daily");
    expect(ctx.workspaces).toHaveLength(0);
    expect(ctx.briefType).toBe("daily");
  });

  it("returns per-workspace data for a user with 2 memberships", async () => {
    const u = await prisma.user.create({
      data: {
        id: `bc-multi-${Date.now()}`,
        email: `bcm-${Date.now()}@t.co`,
        name: "BCM",
      },
    });
    const ws1 = await prisma.workspace.create({ data: { name: "Personal" } });
    const ws2 = await prisma.workspace.create({ data: { name: "Family" } });
    await prisma.membership.create({
      data: { userId: u.id, workspaceId: ws1.id, role: "owner" },
    });
    await prisma.membership.create({
      data: { userId: u.id, workspaceId: ws2.id, role: "editor" },
    });

    const ctx = await buildBriefContext(u.id, "daily");
    expect(ctx.workspaces).toHaveLength(2);
    const names = ctx.workspaces.map((w) => w.name).sort();
    expect(names).toEqual(["Family", "Personal"]);
  });

  it("daily brief includes yesterday's transactions in newTransactions", async () => {
    const u = await prisma.user.create({
      data: {
        id: `bc-tx-${Date.now()}`,
        email: `bctx-${Date.now()}@t.co`,
        name: "BCTX",
      },
    });
    const ws = await prisma.workspace.create({ data: { name: "Personal" } });
    await prisma.membership.create({
      data: { userId: u.id, workspaceId: ws.id, role: "owner" },
    });
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: ws.id, name: "Chequing", type: "depository" },
    });

    // Tx from yesterday — should be in window.
    const yesterday = new Date(Date.now() - 12 * 60 * 60 * 1000);
    await prisma.transaction.create({
      data: {
        workspaceId: ws.id,
        accountId: acct.id,
        plaidTransactionId: "y-1",
        amount: "10.00",
        merchantRaw: "Starbucks",
        occurredAt: yesterday,
        rawData: {},
      },
    });

    // Tx from 3 days ago — should NOT be in daily window.
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await prisma.transaction.create({
      data: {
        workspaceId: ws.id,
        accountId: acct.id,
        plaidTransactionId: "old-1",
        amount: "100.00",
        merchantRaw: "Costco",
        occurredAt: threeDaysAgo,
        rawData: {},
      },
    });

    const ctx = await buildBriefContext(u.id, "daily");
    expect(ctx.workspaces[0]?.newTransactions.count).toBe(1);
    expect(ctx.workspaces[0]?.newTransactions.sample[0]?.merchant).toBe(
      "Starbucks",
    );
  });
});
