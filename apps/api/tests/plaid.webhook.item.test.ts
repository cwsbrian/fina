import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

vi.mock("../src/push/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/send.js")>();
  return {
    ...actual,
    sendBankReconnectPush: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  };
});

import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { dispatchItemEvent } from "../src/plaid/webhook-item.js";
import { testEnv } from "./helpers/test-env.js";
import * as sendMod from "../src/push/send.js";
import { setupWorkspaceWithRoles } from "./helpers/factories.js";

const env = testEnv();

beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.clearAllMocks(); });
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

let itemCounter = 0;
async function seedItemInWorkspace(wsId: string) {
  itemCounter++;
  return await prisma.plaidItem.create({
    data: {
      id: `pi-${Date.now()}-${itemCounter}`,
      workspaceId: wsId,
      itemId: `plaid-item-${Date.now()}-${itemCounter}`,
      accessTokenCiphertext: Buffer.from("ciphertext-placeholder"),
      accessTokenIv: Buffer.from("iv-placeholder"),
      institutionId: "ins_test",
      institutionName: "Test Bank",
      status: "active",
    },
  });
}

describe("dispatchItemEvent", () => {
  it("ERROR + error_code → status='error', errorCode set", async () => {
    const { itemId } = await seedItem();
    await dispatchItemEvent(
      { id: itemId },
      { webhook_code: "ERROR", error: { error_code: "ITEM_LOGIN_REQUIRED" } },
      env,
    );
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe("ITEM_LOGIN_REQUIRED");
  });

  it("ERROR without error_code → status='error', errorCode='unknown'", async () => {
    const { itemId } = await seedItem();
    await dispatchItemEvent({ id: itemId }, { webhook_code: "ERROR" }, env);
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe("unknown");
  });

  it("PENDING_EXPIRATION → status='relink_required', clears prior errorCode", async () => {
    const { itemId } = await seedItem("error");
    await prisma.plaidItem.update({ where: { id: itemId }, data: { errorCode: "SOME_ERROR" } });
    await dispatchItemEvent({ id: itemId }, { webhook_code: "PENDING_EXPIRATION" }, env);
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("relink_required");
    expect(row.errorCode).toBeNull();
  });

  it("USER_PERMISSION_REVOKED → status='disconnected', clears errorCode", async () => {
    const { itemId } = await seedItem();
    await dispatchItemEvent({ id: itemId }, { webhook_code: "USER_PERMISSION_REVOKED" }, env);
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("disconnected");
    expect(row.errorCode).toBeNull();
  });

  it("WEBHOOK_UPDATE_ACKNOWLEDGED → row unchanged", async () => {
    const { itemId } = await seedItem();
    await dispatchItemEvent({ id: itemId }, { webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED" }, env);
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("active");
  });

  it("unknown future code → row unchanged", async () => {
    const { itemId } = await seedItem();
    await dispatchItemEvent({ id: itemId }, { webhook_code: "NEW_PRODUCT_ADDED" }, env);
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("active");
  });

  it("last-write-wins: ERROR overrides disconnected status", async () => {
    const { itemId } = await seedItem("disconnected");
    await dispatchItemEvent(
      { id: itemId },
      { webhook_code: "ERROR", error: { error_code: "ITEM_LOGIN_REQUIRED" } },
      env,
    );
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe("ITEM_LOGIN_REQUIRED");
  });
});

describe("dispatchItemEvent — push integration", () => {
  it("ITEM_LOGIN_REQUIRED → owner+editor push fan-out (viewer excluded)", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner", "editor", "viewer"]);
    const ownerId = userIds[0]!;
    const editorId = userIds[1]!;
    const item = await seedItemInWorkspace(wsId);

    await dispatchItemEvent(
      item,
      { webhook_code: "ERROR", error: { error_code: "ITEM_LOGIN_REQUIRED" } },
      env,
    );

    const calls = vi.mocked(sendMod.sendBankReconnectPush).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c[1]).sort()).toEqual([ownerId, editorId].sort());

    const fresh = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.status).toBe("error");
    expect(fresh.errorCode).toBe("ITEM_LOGIN_REQUIRED");
  });

  it("PENDING_EXPIRATION → owner+editor push fan-out + status='relink_required'", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner", "editor"]);
    const item = await seedItemInWorkspace(wsId);

    await dispatchItemEvent(item, { webhook_code: "PENDING_EXPIRATION" }, env);

    expect(vi.mocked(sendMod.sendBankReconnectPush)).toHaveBeenCalledTimes(2);
    const fresh = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.status).toBe("relink_required");
  });

  it("ERROR with non-LOGIN_REQUIRED → status='error' but NO push", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner", "editor"]);
    const item = await seedItemInWorkspace(wsId);

    await dispatchItemEvent(
      item,
      { webhook_code: "ERROR", error: { error_code: "ITEM_NOT_FOUND" } },
      env,
    );

    expect(vi.mocked(sendMod.sendBankReconnectPush)).toHaveBeenCalledTimes(0);
    const fresh = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.status).toBe("error");
    expect(fresh.errorCode).toBe("ITEM_NOT_FOUND");
  });

  it("USER_PERMISSION_REVOKED → status='disconnected', NO push", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner", "editor"]);
    const item = await seedItemInWorkspace(wsId);

    await dispatchItemEvent(item, { webhook_code: "USER_PERMISSION_REVOKED" }, env);

    expect(vi.mocked(sendMod.sendBankReconnectPush)).toHaveBeenCalledTimes(0);
    const fresh = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.status).toBe("disconnected");
  });

  it("first push throws → caught + 2nd member STILL attempted (per-recipient containment)", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner", "editor"]);
    const item = await seedItemInWorkspace(wsId);
    vi.mocked(sendMod.sendBankReconnectPush).mockRejectedValueOnce(new Error("boom"));

    await expect(
      dispatchItemEvent(
        item,
        { webhook_code: "ERROR", error: { error_code: "ITEM_LOGIN_REQUIRED" } },
        env,
      ),
    ).resolves.toBeUndefined();

    // Per-recipient containment — both attempted.
    expect(vi.mocked(sendMod.sendBankReconnectPush)).toHaveBeenCalledTimes(2);
  });
});
