import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await app.close();
  await disconnect();
});

describe("GET /workspaces/:id/accounts", () => {
  it("accounts endpoint hides billing-disconnected archived accounts by default", async () => {
    const owner = await signUpAndGetCookie(app, {
      email: "archived-accounts@x.com",
      name: "Archived Accounts",
    });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const archived = await prisma.bankAccount.create({
      data: {
        workspaceId: wsId,
        name: "Archived Plaid Checking",
        type: "depository",
        archivedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });

    const activeRes = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/accounts`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(activeRes.statusCode).toBe(200);
    expect(
      activeRes
        .json()
        .accounts.some((a: { id: string }) => a.id === archived.id),
    ).toBe(false);

    const archivedRes = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/accounts?includeArchived=true`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(archivedRes.statusCode).toBe(200);
    expect(archivedRes.json().accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: archived.id,
          archivedAt: "2026-06-01T00:00:00.000Z",
        }),
      ]),
    );
  });
});
