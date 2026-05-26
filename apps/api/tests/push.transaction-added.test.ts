import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import { notifyTransactionAdded } from "../src/push/transaction-added.js";
import * as sendMod from "../src/push/send.js";
import * as loggerMod from "../src/logger.js";
import { setupWorkspaceWithRoles } from "./helpers/factories.js";

const env = testEnv();

vi.mock("../src/push/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/send.js")>();
  return {
    ...actual,
    sendTransactionAddedPush: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  };
});

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.clearAllMocks(); });

describe("notifyTransactionAdded", () => {
  it("workspace with 0 memberships → no push", async () => {
    const ws = await prisma.workspace.create({
      data: { id: `nta-empty-${Date.now()}`, name: "Empty WS", currency: "CAD" },
    });
    await notifyTransactionAdded(env, {
      workspaceId: ws.id,
      merchant: "Coffee",
      amount: 5.5,
      categoryName: "Food",
    });
    expect(vi.mocked(sendMod.sendTransactionAddedPush)).toHaveBeenCalledTimes(0);
  });

  it("1 member, no excludeUserId → push called with toFixed(2) amount", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner"]);
    const ownerId = userIds[0]!;
    await notifyTransactionAdded(env, {
      workspaceId: wsId,
      merchant: "Coffee",
      amount: 5.5,
      categoryName: "Food",
    });
    const calls = vi.mocked(sendMod.sendTransactionAddedPush).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([env, ownerId, "Coffee", "5.50", "Food"]);
  });

  it("owner+editor+viewer + excludeUserId=owner → 2 pushes (editor+viewer, NOT viewer-filtered)", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner", "editor", "viewer"]);
    const ownerId = userIds[0]!;
    const editorId = userIds[1]!;
    const viewerId = userIds[2]!;
    await notifyTransactionAdded(env, {
      workspaceId: wsId,
      merchant: "Restaurant",
      amount: 50,
      categoryName: null,
      excludeUserId: ownerId,
    });
    const calls = vi.mocked(sendMod.sendTransactionAddedPush).mock.calls;
    expect(calls).toHaveLength(2);
    // Viewer IS notified (intentional — read-only members want awareness).
    expect(calls.map((c) => c[1]).sort()).toEqual([editorId, viewerId].sort());
  });

  it("excludeUserId matches no member → all notified", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner", "editor"]);
    await notifyTransactionAdded(env, {
      workspaceId: wsId,
      merchant: "Shop",
      amount: 10,
      categoryName: null,
      excludeUserId: "user-not-in-workspace",
    });
    const calls = vi.mocked(sendMod.sendTransactionAddedPush).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c[1]).sort()).toEqual([...userIds].sort());
  });

  it("first push throws → caught + logged, 2nd member still attempted (per-recipient containment)", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner", "editor"]);
    const logErrorSpy = vi.spyOn(loggerMod, "logError");
    vi.mocked(sendMod.sendTransactionAddedPush).mockRejectedValueOnce(new Error("boom"));

    await expect(
      notifyTransactionAdded(env, {
        workspaceId: wsId,
        merchant: "X",
        amount: 1,
        categoryName: null,
      }),
    ).resolves.toBeUndefined();

    expect(vi.mocked(sendMod.sendTransactionAddedPush)).toHaveBeenCalledTimes(2);
    expect(logErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: expect.any(String) }),
      expect.stringContaining("recipient"),
    );
  });

  it("solo owner is the actor (excludeUserId=ownerId) → 0 pushes", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner"]);
    const ownerId = userIds[0]!;
    await notifyTransactionAdded(env, {
      workspaceId: wsId,
      merchant: "Bookstore",
      amount: 25,
      categoryName: "Books",
      excludeUserId: ownerId,
    });
    expect(vi.mocked(sendMod.sendTransactionAddedPush)).toHaveBeenCalledTimes(0);
  });
});
