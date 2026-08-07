import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { changeWorkspaceCurrencyAndAddManualTransaction } from "../src/chat/tools/change-workspace-currency-and-add-manual-transaction.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("changeWorkspaceCurrencyAndAddManualTransaction chat tool", () => {
  let ctx: ToolContext;
  let workspaceId: string;
  let categoryName: string;

  beforeEach(async () => {
    const stamp = `currency-tx-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const user = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, tz: "Europe/Madrid" },
    });
    const workspace = await prisma.workspace.create({
      data: { name: "Personal", currency: "CAD" },
    });
    workspaceId = workspace.id;
    await prisma.membership.create({
      data: { userId: user.id, workspaceId, role: "owner" },
    });
    await prisma.bankAccount.create({
      data: { workspaceId, name: "Cash", type: "depository", currency: "CAD" },
    });
    categoryName = "Café";
    await prisma.category.create({
      data: { workspaceId, name: categoryName, type: "expense" },
    });
    ctx = { env: {} as never, workspaceId, userId: user.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: ctx.userId } });
  });

  it("changes the workspace currency and records the transaction atomically", async () => {
    const result = await changeWorkspaceCurrencyAndAddManualTransaction.run(ctx, {
      merchant: "Antonino",
      amount: 4.5,
      currency: "EUR",
      occurred_at: "2026-07-23",
      category_name: categoryName,
      confirmation_text: "La moneda del espacio cambió a EUR y registré Antonino por 4,50 €.",
    });

    expect(result.transaction).toMatchObject({
      merchantRaw: "Antonino",
      amount: "4.5",
      currency: "EUR",
    });
    expect(result.workspace.currency).toBe("EUR");
    expect(result.confirmation).toContain("registré Antonino");
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).currency).toBe(
      "EUR",
    );
    const accounts = await prisma.bankAccount.findMany({ where: { workspaceId } });
    expect(accounts.every((account) => account.currency === "EUR")).toBe(true);
    expect(await prisma.transaction.count({ where: { workspaceId } })).toBe(1);
  });

  it("rejects non-owners", async () => {
    await expect(
      changeWorkspaceCurrencyAndAddManualTransaction.run(
        { ...ctx, role: "editor" },
        {
          merchant: "Antonino",
          amount: 4.5,
          currency: "EUR",
          category_name: categoryName,
          confirmation_text: "Saved.",
        },
      ),
    ).rejects.toThrow("insufficient_role");
  });
});
