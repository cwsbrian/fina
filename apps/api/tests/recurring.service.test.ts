import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  addRecurringService,
  listRecurringService,
  removeRecurringByIdService,
  removeRecurringByNameService,
} from "../src/recurring/service.js";

describe("addRecurringService", () => {
  let workspaceId: string;
  let categoryId: string;
  let userId: string;

  beforeEach(async () => {
    const stamp = `re-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "RE", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "re-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
    categoryId = (await prisma.category.create({ data: { workspaceId, name: "Streaming" } })).id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("creates a row with currency=CAD by default and computes nameNormalized", async () => {
    const r = await addRecurringService(
      { workspaceId },
      { name: "Netflix", amount: 19.99, cadence: "monthly", nextOccurrenceDate: "2026-06-01" },
    );
    expect(r.recurring.name).toBe("Netflix");
    expect(r.recurring.currency).toBe("CAD");
    expect(r.recurring.amount).toBe("19.99");
    expect(r.recurring.nextOccurrenceDate).toBe("2026-06-01");
    const row = await prisma.recurringExpense.findFirst({ where: { workspaceId } });
    expect(row?.nameNormalized).toBe("netflix");
  });

  it("upserts on (workspaceId, nameNormalized) — same name different case replaces row", async () => {
    await addRecurringService(
      { workspaceId },
      { name: "Netflix", amount: 19.99, cadence: "monthly", nextOccurrenceDate: "2026-06-01" },
    );
    const r = await addRecurringService(
      { workspaceId },
      { name: "netflix", amount: 22.99, cadence: "monthly", nextOccurrenceDate: "2026-07-01" },
    );
    expect(r.recurring.amount).toBe("22.99");
    expect(r.recurring.name).toBe("netflix");
    expect(r.recurring.nextOccurrenceDate).toBe("2026-07-01");
    const all = await prisma.recurringExpense.findMany({ where: { workspaceId } });
    expect(all).toHaveLength(1);
  });

  it("rejects amount = 0 with invalid_amount", async () => {
    await expect(
      addRecurringService(
        { workspaceId },
        { name: "X", amount: 0, cadence: "monthly", nextOccurrenceDate: "2026-06-01" },
      ),
    ).rejects.toThrow("invalid_amount");
  });

  it("rejects amount over Decimal(10,2) cap with invalid_amount", async () => {
    await expect(
      addRecurringService(
        { workspaceId },
        { name: "X", amount: 100_000_000, cadence: "monthly", nextOccurrenceDate: "2026-06-01" },
      ),
    ).rejects.toThrow("invalid_amount");
  });

  it("rejects bogus month nextOccurrenceDate with invalid_next_date", async () => {
    await expect(
      addRecurringService(
        { workspaceId },
        { name: "X", amount: 10, cadence: "monthly", nextOccurrenceDate: "2026-13-01" },
      ),
    ).rejects.toThrow("invalid_next_date");
  });

  it("rejects non-real date like 2026-02-30 with invalid_next_date", async () => {
    await expect(
      addRecurringService(
        { workspaceId },
        { name: "X", amount: 10, cadence: "monthly", nextOccurrenceDate: "2026-02-30" },
      ),
    ).rejects.toThrow("invalid_next_date");
  });

  it("rejects cross-workspace categoryId with category_not_found", async () => {
    const otherWs = await prisma.workspace.create({ data: { name: "other-re-ws" } });
    const otherCat = await prisma.category.create({ data: { workspaceId: otherWs.id, name: "Y" } });
    await expect(
      addRecurringService(
        { workspaceId },
        {
          name: "X",
          amount: 10,
          cadence: "monthly",
          nextOccurrenceDate: "2026-06-01",
          categoryId: otherCat.id,
        },
      ),
    ).rejects.toThrow("category_not_found");
    await prisma.workspace.delete({ where: { id: otherWs.id } });
  });

  it("rejects archived categoryId with category_not_found", async () => {
    await prisma.category.update({ where: { id: categoryId }, data: { archivedAt: new Date() } });
    await expect(
      addRecurringService(
        { workspaceId },
        {
          name: "X",
          amount: 10,
          cadence: "monthly",
          nextOccurrenceDate: "2026-06-01",
          categoryId,
        },
      ),
    ).rejects.toThrow("category_not_found");
  });

  it("rejects whitespace-only merchant with invalid_merchant", async () => {
    await expect(
      addRecurringService(
        { workspaceId },
        {
          name: "X",
          amount: 10,
          cadence: "monthly",
          nextOccurrenceDate: "2026-06-01",
          merchant: "   ",
        },
      ),
    ).rejects.toThrow("invalid_merchant");
  });

  it("normalizes raw merchant input via normalizeMerchant", async () => {
    const r = await addRecurringService(
      { workspaceId },
      {
        name: "Netflix",
        amount: 19.99,
        cadence: "monthly",
        nextOccurrenceDate: "2026-06-01",
        merchant: "STARBUCKS #1234 TORONTO ON",
      },
    );
    expect(r.recurring.merchantNormalized).toBe("starbucks");
  });

  it("accepts semimonthly cadence and persists it", async () => {
    const r = await addRecurringService(
      { workspaceId },
      { name: "Hydro", amount: 90, cadence: "semimonthly", nextOccurrenceDate: "2026-06-15" },
    );
    expect(r.recurring.cadence).toBe("semimonthly");
  });
});

describe("listRecurringService", () => {
  let workspaceId: string;
  let userId: string;

  beforeEach(async () => {
    const stamp = `rl-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "RL", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "rl-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("returns rows ordered by nextOccurrenceDate ASC then name ASC", async () => {
    await addRecurringService({ workspaceId }, { name: "Zeta", amount: 10, cadence: "monthly", nextOccurrenceDate: "2026-06-01" });
    await addRecurringService({ workspaceId }, { name: "Alpha", amount: 10, cadence: "monthly", nextOccurrenceDate: "2026-06-01" });
    await addRecurringService({ workspaceId }, { name: "Beta", amount: 10, cadence: "monthly", nextOccurrenceDate: "2026-05-15" });
    const r = await listRecurringService({ workspaceId });
    const names = r.recurring.map((row) => row.name);
    expect(names).toEqual(["Beta", "Alpha", "Zeta"]);
  });
});

describe("removeRecurringByIdService", () => {
  let workspaceId: string;
  let userId: string;
  let recurringId: string;

  beforeEach(async () => {
    const stamp = `rid-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "RID", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "rid-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
    const r = await addRecurringService(
      { workspaceId },
      { name: "Netflix", amount: 19.99, cadence: "monthly", nextOccurrenceDate: "2026-06-01" },
    );
    recurringId = r.recurring.id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("deletes and returns true for own row", async () => {
    expect(await removeRecurringByIdService({ workspaceId }, { id: recurringId })).toBe(true);
    expect(await prisma.recurringExpense.findUnique({ where: { id: recurringId } })).toBeNull();
  });

  it("returns false for cross-workspace id", async () => {
    expect(await removeRecurringByIdService({ workspaceId: "other-ws" }, { id: recurringId })).toBe(false);
    expect(await prisma.recurringExpense.findUnique({ where: { id: recurringId } })).not.toBeNull();
  });
});

describe("removeRecurringByNameService", () => {
  let workspaceId: string;
  let userId: string;

  beforeEach(async () => {
    const stamp = `rnm-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "RNM", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "rnm-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
    await addRecurringService(
      { workspaceId },
      { name: "Netflix", amount: 19.99, cadence: "monthly", nextOccurrenceDate: "2026-06-01" },
    );
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("case-insensitive resolve + delete returns true", async () => {
    expect(await removeRecurringByNameService({ workspaceId }, { name: "NETFLIX" })).toBe(true);
    expect(await prisma.recurringExpense.count({ where: { workspaceId } })).toBe(0);
  });

  it("returns false for nonexistent name", async () => {
    expect(await removeRecurringByNameService({ workspaceId }, { name: "DoesNotExist" })).toBe(false);
  });

  it("returns false for whitespace-only name", async () => {
    expect(await removeRecurringByNameService({ workspaceId }, { name: "   " })).toBe(false);
    expect(await prisma.recurringExpense.count({ where: { workspaceId } })).toBe(1);
  });
});
