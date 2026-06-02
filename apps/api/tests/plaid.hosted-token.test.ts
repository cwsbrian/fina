import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { plaidMock, resetPlaidMock } from "./helpers/plaid-mock.js";
import { geminiMock, resetGeminiMock } from "./helpers/gemini-mock.js";

// vi.mock(path, factory) is hoisted above all imports — pass the factory
// through vi.hoisted() so it's loaded in the same hoisted scope.
const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
  async () => await import("./helpers/plaid-mock.js"),
);
vi.mock("plaid", hoistedPlaidMockFactory);

const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

void geminiMock;

import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

async function makeLiteUser(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { trialEndsAt: null, trialConsumed: true },
  });
  await prisma.subscription.create({
    data: {
      userId,
      tier: "lite",
      source: "stripe",
      sourceSubscriptionId: `sub_lite_hosted_${userId}`,
      status: "active",
      currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
  resetGeminiMock();
});

afterAll(async () => {
  await disconnect();
});

/** Build a /link/token/get response whose latest session completed an Item add. */
function sessionWith(itemAddResults: unknown[]) {
  return {
    data: {
      link_token: "link_test",
      created_at: "2026-05-30T00:00:00Z",
      expiration: "2026-05-30T06:00:00Z",
      link_sessions: [{ link_session_id: "ls_1", results: { item_add_results: itemAddResults } }],
    },
  };
}

describe("POST /workspaces/:id/plaid/hosted-token", () => {
  it("returns publicToken + real institution from the completed Hosted Link session", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "ht@x.com", name: "HT" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    plaidMock.linkTokenGet.push(
      sessionWith([
        { public_token: "public-hosted-123", institution: { institution_id: "ins_42", name: "Tartan Bank" }, accounts: [] },
      ]),
    );

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/hosted-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
      payload: { linkToken: "link_test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      publicToken: "public-hosted-123",
      institutionId: "ins_42",
      institutionName: "Tartan Bank",
    });
    // the link_token from the body is forwarded to Plaid
    expect(plaidMock.linkTokenGetCalls[0]?.[0]).toMatchObject({ link_token: "link_test" });
    await app.close();
  });

  it("defaults institution to unknown/Bank when Plaid omits it", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "ht2@x.com", name: "HT2" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    plaidMock.linkTokenGet.push(
      sessionWith([{ public_token: "public-hosted-xyz", institution: null, accounts: [] }]),
    );

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/hosted-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
      payload: { linkToken: "link_test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      publicToken: "public-hosted-xyz",
      institutionId: "unknown",
      institutionName: "Bank",
    });
    await app.close();
  });

  it("picks the most recently finished session, not array position", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "ht5@x.com", name: "HT5" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    // Two completed sessions; the chronologically LATER one is FIRST in the
    // array. Array-position selection would wrongly pick the older (last) one.
    plaidMock.linkTokenGet.push({
      data: {
        link_token: "link_test",
        link_sessions: [
          {
            link_session_id: "ls_new",
            finished_at: "2026-05-30T05:00:00Z",
            results: { item_add_results: [{ public_token: "public-NEW", institution: { institution_id: "ins_new", name: "New Bank" }, accounts: [] }] },
          },
          {
            link_session_id: "ls_old",
            finished_at: "2026-05-30T01:00:00Z",
            results: { item_add_results: [{ public_token: "public-OLD", institution: { institution_id: "ins_old", name: "Old Bank" }, accounts: [] }] },
          },
        ],
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/hosted-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
      payload: { linkToken: "link_test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ publicToken: "public-NEW", institutionName: "New Bank" });
    await app.close();
  });

  it("returns completed public token for Lite user at item limit", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "ht-lite-limit@x.com", name: "HL" });
    await makeLiteUser(u.userId);
    const wsId = await getOwnerWorkspaceId(u.userId);
    await prisma.plaidItem.create({
      data: {
        workspaceId: wsId,
        connectedBy: u.userId,
        accessTokenCiphertext: Buffer.from([1]),
        accessTokenIv: Buffer.from(new Array(12).fill(2)),
        itemId: "hosted_existing_lite_item",
        institutionId: "ins_1",
        institutionName: "Bank",
        status: "active",
      },
    });
    plaidMock.linkTokenGet.push(
      sessionWith([
        { public_token: "public-hosted-at-limit", institution: { institution_id: "ins_limit", name: "Limit Bank" }, accounts: [] },
      ]),
    );

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/hosted-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
      payload: { linkToken: "link_test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      publicToken: "public-hosted-at-limit",
      institutionId: "ins_limit",
      institutionName: "Limit Bank",
    });
    expect(plaidMock.linkTokenGetCalls[0]?.[0]).toMatchObject({ link_token: "link_test" });
    await app.close();
  });

  it("returns 422 plaid_link_incomplete when no session produced a public token", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "ht3@x.com", name: "HT3" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    // session exists but the user exited before completing an Item add
    plaidMock.linkTokenGet.push(sessionWith([]));

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/hosted-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
      payload: { linkToken: "link_test" },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "plaid_link_incomplete" });
    await app.close();
  });

  it("rejects a missing linkToken with 400 invalid_body", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "ht4@x.com", name: "HT4" });
    const wsId = await getOwnerWorkspaceId(u.userId);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/hosted-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_body" });
    await app.close();
  });
});
