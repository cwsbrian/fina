import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import {
  addScheduledSpendService,
  listScheduledSpendsService,
  dismissScheduledSpendService,
  removeScheduledSpendService,
  ScheduledSpendError,
} from "../src/schedules/service.js";

const env = {
  NODE_ENV: "test" as const, PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  STRIPE_PRICE_LITE_MONTHLY: "price_lite_test",
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup(email: string): Promise<{ wsId: string; userId: string; categoryId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: `Cat-${email}` } });
  return { wsId, userId: u.userId, categoryId: cat.id };
}

describe("addScheduledSpendService", () => {
  it("happy: creates schedule with all fields", async () => {
    const { wsId, categoryId } = await setup("ss-add@t.co");
    const r = await addScheduledSpendService({
      workspaceId: wsId,
      categoryId,
      amount: 100,
      scheduledDate: "2026-05-25",
      note: "dental",
    });
    expect(r.schedule.id).toMatch(/^c/); // cuid prefix
    expect(r.schedule.categoryId).toBe(categoryId);
    expect(r.schedule.amount).toBe("100");
    expect(r.schedule.scheduledDate).toBe("2026-05-25");
    expect(r.schedule.note).toBe("dental");
  });

  it("rejects amount 0.005 → invalid_amount", async () => {
    const { wsId, categoryId } = await setup("ss-amt@t.co");
    await expect(
      addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 0.005, scheduledDate: "2026-05-25" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });

  it("rejects amount 0 → invalid_amount", async () => {
    const { wsId, categoryId } = await setup("ss-amt0@t.co");
    await expect(
      addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 0, scheduledDate: "2026-05-25" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });

  it("rejects invalid date 2026-13-01 → invalid_date", async () => {
    const { wsId, categoryId } = await setup("ss-date@t.co");
    await expect(
      addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2026-13-01" }),
    ).rejects.toMatchObject({ code: "invalid_date" });
  });

  it("rejects archived category → category_not_found", async () => {
    const { wsId } = await setup("ss-arch@t.co");
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Arch", archivedAt: new Date() },
    });
    await expect(
      addScheduledSpendService({ workspaceId: wsId, categoryId: cat.id, amount: 50, scheduledDate: "2026-05-25" }),
    ).rejects.toMatchObject({ code: "category_not_found" });
  });

  it("rejects category in different workspace → category_not_found", async () => {
    const { wsId } = await setup("ss-xws@t.co");
    const otherWs = await prisma.workspace.create({ data: { name: "other" } });
    const otherCat = await prisma.category.create({ data: { workspaceId: otherWs.id, name: "Other" } });
    await expect(
      addScheduledSpendService({ workspaceId: wsId, categoryId: otherCat.id, amount: 50, scheduledDate: "2026-05-25" }),
    ).rejects.toMatchObject({ code: "category_not_found" });
  });

  it("accepts past scheduledDate (backfill use case)", async () => {
    const { wsId, categoryId } = await setup("ss-past@t.co");
    const r = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2025-01-01",
    });
    expect(r.schedule.scheduledDate).toBe("2025-01-01");
  });

  it("rejects 1001-char note → invalid_note", async () => {
    const { wsId, categoryId } = await setup("ss-note@t.co");
    await expect(
      addScheduledSpendService({
        workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2026-05-25",
        note: "x".repeat(1001),
      }),
    ).rejects.toMatchObject({ code: "invalid_note" });
  });
});

describe("listScheduledSpendsService", () => {
  it("returns all schedules with derived status", async () => {
    const { wsId, userId, categoryId } = await setup("ss-list@t.co");
    // 1 upcoming
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2099-01-01" });
    // 1 unresolved (past, not matched, not dismissed)
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 30, scheduledDate: "2020-01-01" });

    const r = await listScheduledSpendsService({ workspaceId: wsId, userId }, { status: "all" });
    expect(r.schedules).toHaveLength(2);
    const statuses = r.schedules.map((s) => s.status).sort();
    expect(statuses).toEqual(["unresolved", "upcoming"]);
  });

  it("filters by status=upcoming", async () => {
    const { wsId, userId, categoryId } = await setup("ss-upc@t.co");
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2099-01-01" });
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 30, scheduledDate: "2020-01-01" });
    const r = await listScheduledSpendsService({ workspaceId: wsId, userId }, { status: "upcoming" });
    expect(r.schedules).toHaveLength(1);
    expect(r.schedules[0]!.status).toBe("upcoming");
  });

  it("filters by status=unresolved", async () => {
    const { wsId, userId, categoryId } = await setup("ss-unr@t.co");
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2099-01-01" });
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 30, scheduledDate: "2020-01-01" });
    const r = await listScheduledSpendsService({ workspaceId: wsId, userId }, { status: "unresolved" });
    expect(r.schedules).toHaveLength(1);
    expect(r.schedules[0]!.status).toBe("unresolved");
  });

  it("filters by from/to date range", async () => {
    const { wsId, userId, categoryId } = await setup("ss-range@t.co");
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2026-05-15" });
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 30, scheduledDate: "2026-06-15" });
    const r = await listScheduledSpendsService(
      { workspaceId: wsId, userId },
      { from: new Date("2026-05-01"), to: new Date("2026-05-31"), status: "all" },
    );
    expect(r.schedules).toHaveLength(1);
    expect(r.schedules[0]!.scheduledDate).toBe("2026-05-15");
  });

  it("returns resolved-matched status when matched tx still active", async () => {
    const { wsId, userId, categoryId } = await setup("ss-rm@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Cash", type: "depository", status: "active" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        plaidTransactionId: null,
        amount: "100", merchantRaw: "T", merchantNormalized: "t",
        occurredAt: new Date("2026-05-25T12:00:00Z"),
        pending: false, source: "manual", rawData: {},
      },
    });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await prisma.scheduledSpend.update({ where: { id: schedule.id }, data: { matchedTxId: tx.id } });

    const r = await listScheduledSpendsService({ workspaceId: wsId, userId }, { status: "all" });
    expect(r.schedules[0]!.status).toBe("resolved-matched");
  });

  it("treats matched-tx-soft-removed as unresolved", async () => {
    const { wsId, userId, categoryId } = await setup("ss-rmtx@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Cash", type: "depository", status: "active" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        plaidTransactionId: null,
        amount: "100", merchantRaw: "T", merchantNormalized: "t",
        occurredAt: new Date("2020-05-25T12:00:00Z"),
        pending: false, source: "manual", rawData: {},
        removedAt: new Date(),  // soft-removed
      },
    });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2020-05-25",
    });
    await prisma.scheduledSpend.update({ where: { id: schedule.id }, data: { matchedTxId: tx.id } });

    const r = await listScheduledSpendsService({ workspaceId: wsId, userId }, { status: "all" });
    expect(r.schedules[0]!.status).toBe("unresolved");
  });
});

describe("dismissScheduledSpendService", () => {
  it("happy: sets dismissedAt", async () => {
    const { wsId, categoryId } = await setup("ss-dis@t.co");
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2026-05-25",
    });
    const r = await dismissScheduledSpendService({ workspaceId: wsId }, schedule.id);
    expect(r).toMatchObject({ schedule: { id: schedule.id } });
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.dismissedAt).not.toBeNull();
  });

  it("idempotent: already-dismissed returns alreadyDismissed=true", async () => {
    const { wsId, categoryId } = await setup("ss-disid@t.co");
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2026-05-25",
    });
    await dismissScheduledSpendService({ workspaceId: wsId }, schedule.id);
    const r = await dismissScheduledSpendService({ workspaceId: wsId }, schedule.id);
    expect(r).toEqual({ dismissed: false, alreadyDismissed: true });
  });

  it("rejects already-matched with active tx → already_matched", async () => {
    const { wsId, categoryId } = await setup("ss-dismatched@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Cash", type: "depository", status: "active" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: null,
        amount: "100", merchantRaw: "T", merchantNormalized: "t",
        occurredAt: new Date("2026-05-25T12:00:00Z"),
        pending: false, source: "manual", rawData: {},
      },
    });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await prisma.scheduledSpend.update({ where: { id: schedule.id }, data: { matchedTxId: tx.id } });
    await expect(
      dismissScheduledSpendService({ workspaceId: wsId }, schedule.id),
    ).rejects.toMatchObject({ code: "already_matched" });
  });

  it("404 not_found", async () => {
    const { wsId } = await setup("ss-dis404@t.co");
    await expect(
      dismissScheduledSpendService({ workspaceId: wsId }, "no-such-id"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("removeScheduledSpendService", () => {
  it("happy: hard delete returns removed=true", async () => {
    const { wsId, categoryId } = await setup("ss-rem@t.co");
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2026-05-25",
    });
    const r = await removeScheduledSpendService({ workspaceId: wsId }, schedule.id);
    expect(r).toEqual({ removed: true });
    const row = await prisma.scheduledSpend.findUnique({ where: { id: schedule.id } });
    expect(row).toBeNull();
  });

  it("idempotent: missing id returns alreadyRemoved=true (NOT 404)", async () => {
    const { wsId } = await setup("ss-remid@t.co");
    const r = await removeScheduledSpendService({ workspaceId: wsId }, "no-such-id");
    expect(r).toEqual({ removed: false, alreadyRemoved: true });
  });

  it("wrong-workspace returns alreadyRemoved=true (treats as missing)", async () => {
    const { wsId, categoryId } = await setup("ss-remxws@t.co");
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2026-05-25",
    });
    const otherWs = await prisma.workspace.create({ data: { name: "other-remxws" } });
    const r = await removeScheduledSpendService({ workspaceId: otherWs.id }, schedule.id);
    expect(r).toEqual({ removed: false, alreadyRemoved: true });
    // Real schedule still exists
    const row = await prisma.scheduledSpend.findUnique({ where: { id: schedule.id } });
    expect(row).not.toBeNull();
  });
});
