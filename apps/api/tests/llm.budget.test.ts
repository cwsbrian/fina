import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";

import { prisma } from "../src/db.js";
import { logLlmCall, userWeeklyCostCad } from "../src/llm/budget.js";
import { disconnect, truncateAll } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

describe("LLM budget accounting", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await disconnect();
  });

  async function createUser() {
    return prisma.user.create({
      data: {
        id: randomUUID(),
        email: `llm-budget-${Date.now()}-${Math.random()}@example.com`,
        emailVerified: true,
      },
    });
  }

  it("stores DeepSeek cache-aware USD cost and fixed CAD cost for each call", async () => {
    const user = await createUser();

    await logLlmCall({
      userId: user.id,
      source: "chat",
      model: "deepseek-v4-flash",
      inputTokens: 1_000_000,
      inputCacheHitTokens: 600_000,
      inputCacheMissTokens: 400_000,
      outputTokens: 100_000,
      usdToCadRate: 1.4,
    });

    const rows = await prisma.$queryRaw<
      Array<{
        inputCacheHitTokens: number;
        inputCacheMissTokens: number;
        costUsd: unknown;
        costCad: unknown;
        usdToCadRate: unknown;
      }>
    >`
      SELECT
        "inputCacheHitTokens",
        "inputCacheMissTokens",
        "costUsd",
        "costCad",
        "usdToCadRate"
      FROM "llm_call_logs"
      WHERE "userId" = ${user.id}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputCacheHitTokens).toBe(600_000);
    expect(rows[0]?.inputCacheMissTokens).toBe(400_000);
    expect(Number(rows[0]?.costUsd)).toBeCloseTo(0.08568, 6);
    expect(Number(rows[0]?.costCad)).toBeCloseTo(0.119952, 6);
    expect(Number(rows[0]?.usdToCadRate)).toBeCloseTo(1.4, 6);
  });

  it("sums stored CAD cost without revaluing old calls when the env FX rate changes", async () => {
    const user = await createUser();

    await logLlmCall({
      userId: user.id,
      source: "chat",
      model: "deepseek-v4-flash",
      inputTokens: 0,
      outputTokens: 1_000_000,
      usdToCadRate: 1.4,
    });

    await logLlmCall({
      userId: user.id,
      source: "chat",
      model: "deepseek-v4-flash",
      inputTokens: 0,
      outputTokens: 1_000_000,
      usdToCadRate: 2,
    });

    await expect(
      userWeeklyCostCad(user.id, testEnv({ LLM_BUDGET_USD_TO_CAD_RATE: 99 })),
    ).resolves.toBeCloseTo(0.952, 6);
  });
});
