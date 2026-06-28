// Pin BEFORE any Date() call in this module — Node reads TZ on each Date
// construction; setting it here makes server-local math deterministic across
// CI hosts. We save+restore the original value because apps/api/vitest.config.ts
// uses poolOptions.forks.singleFork, so all API test files share one process
// and a leaked TZ would make downstream tests order-dependent.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "UTC";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { listTransactions } from "../src/chat/tools/list-transactions.js";
import { getSpendingSummary } from "../src/chat/tools/get-spending-summary.js";
import type { ToolContext } from "../src/chat/tools/types.js";

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("[plan 1e-time] tz anchor + tool migration", () => {
  let ctx: ToolContext;
  let wsId: string;
  let acctId: string;

  beforeEach(async () => {
    const stamp = `tz-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "TZ", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "tz-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });
    acctId = acct.id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function seed(id: string, occurredAt: Date, amount = "10.00"): Promise<void> {
    await prisma.transaction.create({
      data: {
        id,
        workspaceId: wsId,
        accountId: acctId,
        plaidTransactionId: `${id}-pt`,
        amount,
        merchantRaw: "M",
        occurredAt,
        rawData: {},
      },
    });
  }

  it("listTransactions: rows at the Toronto/UTC day boundary classify by user-tz", async () => {
    // Pin now to mid-April so this_month = April.
    vi.setSystemTime(new Date("2026-04-15T12:00:00Z"));
    // tx-A: 2026-05-01T02:00:00Z = Apr 30 22:00 local Toronto → IN April locally.
    // tx-B: 2026-04-01T03:00:00Z = Mar 31 23:00 local Toronto → NOT in April locally.
    await seed("tx-A", new Date("2026-05-01T02:00:00Z"));
    await seed("tx-B", new Date("2026-04-01T03:00:00Z"));

    const result = await listTransactions.run(ctx, { period: "this_month", limit: 50 });
    const ids = result.transactions.map((t) => t.id);
    expect(ids).toContain("tx-A");
    expect(ids).not.toContain("tx-B");
  });

  it("getSpendingSummary: day-bucket key renders in user tz, not UTC", async () => {
    vi.setSystemTime(new Date("2026-04-15T12:00:00Z"));
    // 2026-05-01T02:00:00Z = Apr 30 22:00 local Toronto.
    // dateKeyInTz → '2026-04-30'.
    // toISOString().slice(0, 10) (pre-fix) → '2026-05-01'.
    await seed("tx-dk", new Date("2026-05-01T02:00:00Z"));

    const result = await getSpendingSummary.run(ctx, {
      since: "2026-04-01",
      until: "2026-05-01",
      group_by: "day",
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.key).toBe("2026-04-30");
  });

  it("listTransactions: 'today' period uses user-tz day boundary", async () => {
    // 2026-05-02T03:00:00Z = May 1 23:00 local Toronto, so 'today' = May 1 local.
    vi.setSystemTime(new Date("2026-05-02T03:00:00Z"));
    // tx-today: 2026-05-01T15:00:00Z = May 1 11:00 local — in range.
    // tx-tomorrow: 2026-05-02T05:00:00Z = May 2 01:00 local — out of range.
    await seed("tx-today", new Date("2026-05-01T15:00:00Z"));
    await seed("tx-tomorrow", new Date("2026-05-02T05:00:00Z"));

    const result = await listTransactions.run(ctx, { period: "today", limit: 50 });
    expect(result.transactions.map((t) => t.id)).toEqual(["tx-today"]);
  });
});
