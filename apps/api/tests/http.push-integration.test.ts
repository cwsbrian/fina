import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { testEnv } from "./helpers/test-env.js";
import * as anomalyMod from "../src/push/anomaly.js";
import * as addedMod from "../src/push/transaction-added.js";
import * as sendMod from "../src/push/send.js";

vi.mock("../src/push/anomaly.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/anomaly.js")>();
  return { ...actual, checkLargeChargeAndPush: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../src/push/transaction-added.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/transaction-added.js")>();
  return { ...actual, notifyTransactionAdded: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../src/push/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/send.js")>();
  return {
    ...actual,
    sendWorkspaceInvitePush: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  };
});

const env = testEnv();

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.clearAllMocks(); });

/** Flush microtask + macrotask once so `void asyncFn()` settles. Mocks
 *  resolve synchronously, so a single setImmediate is sufficient. */
async function drainFireAndForget(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("POST /workspaces/:id/transactions/manual — push integration", () => {
  it("fires checkLargeChargeAndPush with env + correct args", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o1@t.co", name: "Alice" });
    const wsId = await getOwnerWorkspaceId(owner.userId);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/manual`,
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-workspace-id": wsId },
      payload: JSON.stringify({ merchantRaw: "Coffee Shop", amount: 30 }),
    });
    expect(res.statusCode).toBe(201);

    await drainFireAndForget();

    // Per-arg assertions (vs. whole-tuple `toEqual([...])`) — tolerant of future
    // helper signature changes that add a 3rd positional arg (e.g., requestId).
    const calls = vi.mocked(anomalyMod.checkLargeChargeAndPush).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(env);
    expect(calls[0]?.[1]).toEqual(
      expect.objectContaining({
        transactionId: expect.any(String),
        workspaceId: wsId,
        amount: 30,
        merchant: expect.any(String),
      }),
    );

    await app.close();
  });

  it("fires notifyTransactionAdded with env + excludeUserId=actor + categoryName null", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@t.co", name: "Alice" });
    const wsId = await getOwnerWorkspaceId(owner.userId);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/manual`,
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-workspace-id": wsId },
      payload: JSON.stringify({ merchantRaw: "Restaurant", amount: 30 }),
    });
    expect(res.statusCode).toBe(201);

    await drainFireAndForget();

    const calls = vi.mocked(addedMod.notifyTransactionAdded).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(env);
    expect(calls[0]?.[1]).toEqual(
      expect.objectContaining({
        workspaceId: wsId,
        merchant: expect.any(String),
        amount: 30,
        categoryName: null,
        excludeUserId: owner.userId,
      }),
    );

    await app.close();
  });

  it("invalid body (missing merchantRaw) → 400, no push fires", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@t.co", name: "Alice" });
    const wsId = await getOwnerWorkspaceId(owner.userId);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/manual`,
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-workspace-id": wsId },
      payload: JSON.stringify({ amount: 30 }),  // missing merchantRaw
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");

    await drainFireAndForget();

    expect(vi.mocked(anomalyMod.checkLargeChargeAndPush)).toHaveBeenCalledTimes(0);
    expect(vi.mocked(addedMod.notifyTransactionAdded)).toHaveBeenCalledTimes(0);

    await app.close();
  });
});

describe("POST /workspaces/:id/invites — push integration", () => {
  it("invite to existing user → sendWorkspaceInvitePush called with displayName", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "inv1@t.co", name: "Alice" });
    const wsId = await getOwnerWorkspaceId(owner.userId);

    // Pre-create the invitee user
    const invitee = await prisma.user.create({
      data: { id: `inv-${Date.now()}`, email: "bob@t.co", name: "Bob" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-workspace-id": wsId },
      payload: JSON.stringify({ email: "bob@t.co", role: "viewer" }),
    });
    expect(res.statusCode).toBe(201);

    const calls = vi.mocked(sendMod.sendWorkspaceInvitePush).mock.calls;
    expect(calls).toHaveLength(1);
    // Args: (env, inviteeId, inviterDisplayName, workspaceName)
    expect(calls[0]?.[0]).toBe(env);
    expect(calls[0]?.[1]).toBe(invitee.id);
    expect(calls[0]?.[2]).toBe("Alice");  // displayName({name: "Alice"}) → "Alice"
    expect(typeof calls[0]?.[3]).toBe("string");  // workspaceName auto-bootstrapped

    await app.close();
  });

  it("invite to non-existing email → no push fires (best-effort skip)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "inv2@t.co", name: "Alice" });
    const wsId = await getOwnerWorkspaceId(owner.userId);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-workspace-id": wsId },
      payload: JSON.stringify({ email: "stranger@nowhere.com", role: "viewer" }),
    });
    expect(res.statusCode).toBe(201);

    expect(vi.mocked(sendMod.sendWorkspaceInvitePush)).toHaveBeenCalledTimes(0);

    await app.close();
  });

  it("push throws → invite still succeeds (caught at invites.ts:99-114)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "inv3@t.co", name: "Alice" });
    const wsId = await getOwnerWorkspaceId(owner.userId);

    await prisma.user.create({
      data: { id: `inv-throws-${Date.now()}`, email: "bob3@t.co", name: "Bob" },
    });

    // Override only this call to reject; subsequent calls fall back to factory's mockResolvedValue.
    vi.mocked(sendMod.sendWorkspaceInvitePush).mockRejectedValueOnce(new Error("boom"));

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-workspace-id": wsId },
      payload: JSON.stringify({ email: "bob3@t.co", role: "viewer" }),
    });
    // Route's try/catch swallows the push error; invite is created.
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(sendMod.sendWorkspaceInvitePush)).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
