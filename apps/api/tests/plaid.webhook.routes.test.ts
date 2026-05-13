import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { resetPlaidMock } from "./helpers/plaid-mock.js";

const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
  async () => await import("./helpers/plaid-mock.js"),
);
vi.mock("plaid", hoistedPlaidMockFactory);

import { resetGeminiMock } from "./helpers/gemini-mock.js";
const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

import {
  generateWebhookKeys,
  signWebhook,
  injectJwkForTest,
  resetJwkCache,
  type WebhookKeyPair,
} from "./helpers/plaid-webhook-mock.js";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { truncateAll, disconnect } from "./helpers/db.js";

vi.mock("../src/plaid/webhook-dispatch.js", async () => {
  return { dispatchWebhookSync: vi.fn().mockResolvedValue(undefined) };
});
import { dispatchWebhookSync } from "../src/plaid/webhook-dispatch.js";

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

let keys: WebhookKeyPair;

async function seedItem(): Promise<{ wsId: string; pi: { id: string; itemId: string } }> {
  const ws = await prisma.workspace.create({ data: { name: "W" } });
  const pi = await prisma.plaidItem.create({
    data: {
      workspaceId: ws.id,
      accessTokenCiphertext: Buffer.from([1]),
      accessTokenIv: Buffer.from([2]),
      itemId: `pi_${Math.random()}`,
      institutionId: "ins_1",
      institutionName: "Bank",
    },
    select: { id: true, itemId: true },
  });
  return { wsId: ws.id, pi };
}

async function postWebhook(
  app: Awaited<ReturnType<typeof buildApp>>,
  body: object,
  jwt: string,
) {
  return await app.inject({
    method: "POST",
    url: "/plaid/webhook",
    headers: { "content-type": "application/json", "plaid-verification": jwt },
    payload: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
  resetGeminiMock();
  resetJwkCache();
  vi.mocked(dispatchWebhookSync).mockClear();
  keys = await generateWebhookKeys();
  injectJwkForTest(keys.kid, keys.publicKey);
});
afterAll(async () => { await disconnect(); });

describe("POST /plaid/webhook", () => {
  it("happy path: SYNC_UPDATES_AVAILABLE → 200, row stored, dispatch called", async () => {
    const app = await buildApp(env);
    const { wsId, pi } = await seedItem();
    const body = {
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: pi.itemId,
      initial_update_complete: true,
      historical_update_complete: true,
      environment: "sandbox",
    };
    const jwt = await signWebhook(Buffer.from(JSON.stringify(body)), keys.privateKey, keys.kid);

    const res = await postWebhook(app, body, jwt);

    expect(res.statusCode).toBe(200);
    const rows = await prisma.plaidWebhookEvent.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0].plaidItemId).toBe(pi.id);
    expect(rows[0].webhookType).toBe("TRANSACTIONS");
    expect(rows[0].webhookCode).toBe("SYNC_UPDATES_AVAILABLE");
    expect(dispatchWebhookSync).toHaveBeenCalledWith(env, wsId, pi.id, rows[0].id);
    await app.close();
  });

  it("invalid signature → 401, no row, no dispatch", async () => {
    const app = await buildApp(env);
    await seedItem();
    const body = { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "p_x" };
    const otherKeys = await generateWebhookKeys(keys.kid);
    const jwt = await signWebhook(Buffer.from(JSON.stringify(body)), otherKeys.privateKey, keys.kid);

    const res = await postWebhook(app, body, jwt);

    expect(res.statusCode).toBe(401);
    expect(await prisma.plaidWebhookEvent.count()).toBe(0);
    expect(dispatchWebhookSync).not.toHaveBeenCalled();
    await app.close();
  });

  it("unknown item_id → 200, row with plaidItemId=null, no dispatch", async () => {
    const app = await buildApp(env);
    const body = {
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "p_does_not_exist",
      environment: "sandbox",
    };
    const jwt = await signWebhook(Buffer.from(JSON.stringify(body)), keys.privateKey, keys.kid);

    const res = await postWebhook(app, body, jwt);

    expect(res.statusCode).toBe(200);
    const rows = await prisma.plaidWebhookEvent.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0].plaidItemId).toBeNull();
    expect(dispatchWebhookSync).not.toHaveBeenCalled();
    await app.close();
  });

  it("webhookType ITEM → 200, row stored, no dispatch", async () => {
    const app = await buildApp(env);
    const { pi } = await seedItem();
    const body = {
      webhook_type: "ITEM",
      webhook_code: "ERROR",
      item_id: pi.itemId,
      environment: "sandbox",
    };
    const jwt = await signWebhook(Buffer.from(JSON.stringify(body)), keys.privateKey, keys.kid);

    const res = await postWebhook(app, body, jwt);

    expect(res.statusCode).toBe(200);
    expect(await prisma.plaidWebhookEvent.count()).toBe(1);
    expect(dispatchWebhookSync).not.toHaveBeenCalled();
    await app.close();
  });

  it("non-JSON body → 400", async () => {
    const app = await buildApp(env);
    const rawBody = Buffer.from("not json");
    const jwt = await signWebhook(rawBody, keys.privateKey, keys.kid);
    const res = await app.inject({
      method: "POST",
      url: "/plaid/webhook",
      headers: { "content-type": "application/json", "plaid-verification": jwt },
      payload: "not json",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("same body twice → both rows stored, dispatch called twice", async () => {
    const app = await buildApp(env);
    const { pi } = await seedItem();
    const body = {
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: pi.itemId,
      environment: "sandbox",
    };
    const bodyBuf = Buffer.from(JSON.stringify(body));
    const jwt1 = await signWebhook(bodyBuf, keys.privateKey, keys.kid);
    const jwt2 = await signWebhook(bodyBuf, keys.privateKey, keys.kid);

    const r1 = await postWebhook(app, body, jwt1);
    const r2 = await postWebhook(app, body, jwt2);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(await prisma.plaidWebhookEvent.count()).toBe(2);
    expect(dispatchWebhookSync).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
