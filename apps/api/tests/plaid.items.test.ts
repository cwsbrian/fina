import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { plaidMock, resetPlaidMock, plaidApiError } from "./helpers/plaid-mock.js";

// vitest hoists `vi.mock(path, factory)` above all imports; if the factory
// references a top-level import binding (like `plaidMockFactory`) it will
// fail with "Cannot access '__vi_import_0__' before initialization". Use
// `vi.hoisted` to load the helper module synchronously inside the hoisted
// scope so the factory has a stable reference.
const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
  async () => await import("./helpers/plaid-mock.js"),
);
vi.mock("plaid", hoistedPlaidMockFactory);

import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { storeAccessToken, readAccessToken, removeItemStrict, removeItemForBilling } from "../src/plaid/items.js";
import { HttpError } from "../src/auth/context.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

// File-level lifecycle (Plan 2 convention) — keeps hooks consistent with the
// other plaid.* test files and avoids per-describe duplication if more
// describes are added later.
beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
});

afterAll(async () => {
  await disconnect();
});

describe("plaid/items service", () => {
  it("storeAccessToken — encrypts on write; row carries ciphertext + iv, NOT raw", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "s@x.com", name: "S" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const id = await prisma.$transaction(async (tx) =>
      storeAccessToken(env, tx, {
        workspaceId: wsId,
        itemId: "item_x",
        institutionId: "ins_x",
        institutionName: "X",
        accessToken: "secret-token-do-not-leak",
      }),
    );
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id } });
    expect(row.accessTokenIv.length).toBe(12);
    expect(row.accessTokenCiphertext.length).toBeGreaterThan(16);
    expect(Buffer.from(row.accessTokenCiphertext).toString("utf8")).not.toContain("secret-token");
    await app.close();
  });

  it("readAccessToken — round-trips when (workspaceId, plaidItemId) match", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "r1@x.com", name: "R" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const id = await prisma.$transaction((tx) =>
      storeAccessToken(env, tx, {
        workspaceId: wsId, itemId: "item_r", institutionId: "ins", institutionName: "X",
        accessToken: "secret-r",
      }),
    );
    const { accessToken } = await readAccessToken(env, wsId, id);
    expect(accessToken).toBe("secret-r");
    await app.close();
  });

  it("readAccessToken — 404 when workspaceId doesn't match the item's workspace (cross-workspace defense)", async () => {
    const app = await buildApp(env);
    const owner1 = await signUpAndGetCookie(app, { email: "o1@x.com", name: "O" });
    const ws1 = await getOwnerWorkspaceId(owner1.userId);
    const owner2 = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O" });
    const ws2 = await getOwnerWorkspaceId(owner2.userId);
    const id = await prisma.$transaction((tx) =>
      storeAccessToken(env, tx, {
        workspaceId: ws1, itemId: "item_cross", institutionId: "ins", institutionName: "X",
        accessToken: "secret-1",
      }),
    );
    await expect(readAccessToken(env, ws2, id)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
    await app.close();
  });

  it("readAccessToken — 404 when plaidItemId doesn't exist", async () => {
    await expect(readAccessToken(env, "ws_nope", "no_such_item")).rejects.toBeInstanceOf(HttpError);
  });

  it("removeItemStrict — happy path: Plaid /item/remove called, accounts archived, plaid_item deleted, transactions kept", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "rm@x.com", name: "Rm" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const id = await prisma.$transaction((tx) =>
      storeAccessToken(env, tx, {
        workspaceId: wsId, itemId: "item_rm", institutionId: "ins", institutionName: "X",
        accessToken: "secret-rm",
      }),
    );
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, plaidItemId: id, plaidAccountId: "acct_rm", name: "C", type: "depository" },
    });
    const txRow = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidItemId: id,
        plaidTransactionId: "tx_rm", amount: 1, merchantRaw: "X", occurredAt: new Date(), rawData: {},
      },
    });

    plaidMock.itemRemove.push({ data: { request_id: "r" } });
    await removeItemStrict(env, wsId, id);

    expect(await prisma.plaidItem.findUnique({ where: { id } })).toBeNull();
    const acctAfter = await prisma.bankAccount.findUniqueOrThrow({ where: { id: acct.id } });
    expect(acctAfter.archivedAt).not.toBeNull();
    expect(acctAfter.plaidItemId).toBeNull(); // SetNull
    const txAfter = await prisma.transaction.findUniqueOrThrow({ where: { id: txRow.id } });
    expect(txAfter.plaidItemId).toBeNull();
    await app.close();
  });

  it("removeItemStrict — Plaid failure 502 + local row preserved for retry", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "rm2@x.com", name: "Rm" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const id = await prisma.$transaction((tx) =>
      storeAccessToken(env, tx, {
        workspaceId: wsId, itemId: "item_rm2", institutionId: "ins", institutionName: "X",
        accessToken: "secret-rm2",
      }),
    );
    plaidMock.itemRemove.push(plaidApiError({ error_code: "INSTITUTION_DOWN", http_status: 503 }));
    await expect(removeItemStrict(env, wsId, id)).rejects.toMatchObject({
      statusCode: 502,
      code: "plaid_unavailable",
    });
    expect(await prisma.plaidItem.findUnique({ where: { id } })).not.toBeNull();
    await app.close();
  });

  it("removeItemStrict — ITEM_NOT_FOUND from Plaid is treated as already-removed; local cleanup proceeds", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "rm3@x.com", name: "Rm" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const id = await prisma.$transaction((tx) =>
      storeAccessToken(env, tx, {
        workspaceId: wsId, itemId: "item_rm3", institutionId: "ins", institutionName: "X",
        accessToken: "secret-rm3",
      }),
    );
    plaidMock.itemRemove.push(plaidApiError({ error_code: "ITEM_NOT_FOUND" }));
    await removeItemStrict(env, wsId, id);
    expect(await prisma.plaidItem.findUnique({ where: { id } })).toBeNull();
    await app.close();
  });
});

describe("removeItemForBilling", () => {
  async function seedItemWithTransactions() {
    const ws = await prisma.workspace.create({ data: { name: "W-billing" } });
    // storeAccessToken encrypts and creates the plaid_items row.
    const itemRowId = await storeAccessToken(env, prisma, {
      workspaceId: ws.id,
      itemId: `pi_bill_${Math.random()}`,
      institutionId: "ins_1",
      institutionName: "Bank",
      accessToken: "access-sandbox-test-billing",
    });
    // Seed a transaction so we can verify it survives after billing removal.
    const account = await prisma.bankAccount.create({
      data: {
        workspaceId: ws.id,
        plaidItemId: itemRowId,
        plaidAccountId: "acct_bill",
        name: "Checking",
        type: "depository",
        currency: "CAD",
      },
    });
    await prisma.transaction.create({
      data: {
        workspaceId: ws.id,
        accountId: account.id,      // NOTE: field is accountId, not bankAccountId
        amount: 10,
        merchantRaw: "Test",
        occurredAt: new Date(),
        rawData: {},                 // required Json field (no default)
      },
    });
    return { wsId: ws.id, itemRowId, accountId: account.id };
  }

  it("normal path: Plaid /item/remove → status='disconnected', row + transactions preserved", async () => {
    const { wsId, itemRowId, accountId } = await seedItemWithTransactions();

    plaidMock.itemRemove.push({ data: { request_id: "req" } });

    await removeItemForBilling(env, wsId, itemRowId);

    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemRowId } });
    expect(item.status).toBe("disconnected");
    expect(item.errorCode).toBeNull();

    // Row preserved (not deleted).
    expect(item.id).toBe(itemRowId);

    // Transactions preserved.
    const txCount = await prisma.transaction.count({ where: { accountId } });
    expect(txCount).toBe(1);
  });

  it("ITEM_NOT_FOUND: graceful — Plaid already removed, still sets disconnected", async () => {
    const { wsId, itemRowId } = await seedItemWithTransactions();

    plaidMock.itemRemove.push(plaidApiError({ error_code: "ITEM_NOT_FOUND" }));

    await removeItemForBilling(env, wsId, itemRowId);

    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemRowId } });
    expect(item.status).toBe("disconnected");
  });

  it("other Plaid error: propagates (caller catches and continues)", async () => {
    const { wsId, itemRowId } = await seedItemWithTransactions();

    plaidMock.itemRemove.push(plaidApiError({ error_code: "PLAID_UNAVAILABLE", http_status: 503 }));

    await expect(removeItemForBilling(env, wsId, itemRowId)).rejects.toThrow();

    // Status NOT changed — item still active (cron retries tomorrow).
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemRowId } });
    expect(item.status).toBe("active");
  });
});
