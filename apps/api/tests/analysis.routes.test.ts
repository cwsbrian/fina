import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { disconnect, truncateAll } from "./helpers/db.js";
import { getOwnerWorkspaceId, signUpAndGetCookie } from "./helpers/auth.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await disconnect();
});

beforeEach(async () => {
  await truncateAll();
});

async function seedTransaction(opts: {
  workspaceId: string;
  accountId: string;
  categoryId: string;
  amount: string;
  occurredAt: Date;
}) {
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: opts.workspaceId,
      accountId: opts.accountId,
      amount: new Prisma.Decimal(opts.amount),
      merchantRaw: "Merchant",
      occurredAt: opts.occurredAt,
      source: "manual",
      pending: false,
      rawData: {},
    },
  });
  await prisma.transactionAllocation.create({
    data: {
      transactionId: tx.id,
      categoryId: opts.categoryId,
      amount: new Prisma.Decimal(opts.amount),
    },
  });
}

describe("GET /workspaces/:id/analysis", () => {
  it("returns explicit May transactions", async () => {
    const user = await signUpAndGetCookie(app, {
      email: `analysis-route-${Date.now()}@t.co`,
    });
    const wsId = await getOwnerWorkspaceId(user.userId);
    const account = await prisma.bankAccount.create({
      data: {
        workspaceId: wsId,
        name: "Checking",
        type: "depository",
        currency: "CAD",
        status: "active",
      },
    });
    const category =
      (await prisma.category.findFirst({
        where: { workspaceId: wsId, name: "Dining" },
      })) ??
      (await prisma.category.create({
        data: { workspaceId: wsId, name: "Dining" },
      }));
    await seedTransaction({
      workspaceId: wsId,
      accountId: account.id,
      categoryId: category.id,
      amount: "42.00",
      occurredAt: new Date("2026-05-20T12:00:00.000Z"),
    });

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/analysis?year=2026&month=5`,
      headers: { cookie: user.cookie, "x-workspace-id": wsId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().current).toMatchObject({
      year: 2026,
      month: 5,
      spend: 42,
      net: -42,
    });
    expect(res.json().current.spendByCategory).toEqual([
      expect.objectContaining({
        categoryId: category.id,
        categoryName: "Dining",
        amount: 42,
      }),
    ]);
  });
});
