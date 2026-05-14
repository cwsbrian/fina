import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { dispatchItemEvent } from "../src/plaid/webhook-item.js";

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await disconnect(); });

async function seedItem(
  status: "active" | "error" | "relink_required" | "disconnected" = "active",
) {
  const ws = await prisma.workspace.create({ data: { name: "W" } });
  const item = await prisma.plaidItem.create({
    data: {
      workspaceId: ws.id,
      accessTokenCiphertext: Buffer.from([1]),
      accessTokenIv: Buffer.from([2]),
      itemId: `pi_${Math.random()}`,
      institutionId: "ins_1",
      institutionName: "Bank",
      status,
    },
  });
  return { itemId: item.id };
}

describe("dispatchItemEvent", () => {
  it("ERROR + error_code → status='error', errorCode set", async () => {
    const { itemId } = await seedItem();
    await dispatchItemEvent(
      { id: itemId },
      { webhook_code: "ERROR", error: { error_code: "ITEM_LOGIN_REQUIRED" } },
    );
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe("ITEM_LOGIN_REQUIRED");
  });

  it("ERROR without error_code → status='error', errorCode='unknown'", async () => {
    const { itemId } = await seedItem();
    await dispatchItemEvent({ id: itemId }, { webhook_code: "ERROR" });
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe("unknown");
  });

  it("PENDING_EXPIRATION → status='relink_required', clears prior errorCode", async () => {
    const { itemId } = await seedItem("error");
    await prisma.plaidItem.update({ where: { id: itemId }, data: { errorCode: "SOME_ERROR" } });
    await dispatchItemEvent({ id: itemId }, { webhook_code: "PENDING_EXPIRATION" });
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("relink_required");
    expect(row.errorCode).toBeNull();
  });

  it("USER_PERMISSION_REVOKED → status='disconnected', clears errorCode", async () => {
    const { itemId } = await seedItem();
    await dispatchItemEvent({ id: itemId }, { webhook_code: "USER_PERMISSION_REVOKED" });
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("disconnected");
    expect(row.errorCode).toBeNull();
  });

  it("WEBHOOK_UPDATE_ACKNOWLEDGED → row unchanged", async () => {
    const { itemId } = await seedItem();
    await dispatchItemEvent({ id: itemId }, { webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED" });
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("active");
  });

  it("unknown future code → row unchanged", async () => {
    const { itemId } = await seedItem();
    await dispatchItemEvent({ id: itemId }, { webhook_code: "NEW_PRODUCT_ADDED" });
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("active");
  });

  it("last-write-wins: ERROR overrides disconnected status", async () => {
    const { itemId } = await seedItem("disconnected");
    await dispatchItemEvent(
      { id: itemId },
      { webhook_code: "ERROR", error: { error_code: "ITEM_LOGIN_REQUIRED" } },
    );
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe("ITEM_LOGIN_REQUIRED");
  });
});
