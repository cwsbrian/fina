import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { listAccounts } from "../src/chat/tools/list-accounts.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("listAccounts tool", () => {
  let ctx: ToolContext;
  let wsId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `la-${Date.now()}`, email: `la-${Date.now()}@t.co`, name: "LA" } });
    const ws = await prisma.workspace.create({ data: { name: "la-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id };

    const item = await prisma.plaidItem.create({
      data: {
        workspaceId: wsId,
        accessTokenCiphertext: Buffer.from(""),
        accessTokenIv: Buffer.from(""),
        itemId: `it-${Date.now()}`,
        institutionId: "ins_1",
        institutionName: "TD",
        status: "active",
        lastSyncAt: new Date("2026-05-10T12:00:00Z"),
      },
    });
    await prisma.bankAccount.create({
      data: {
        workspaceId: wsId,
        plaidItemId: item.id,
        name: "Chequing",
        type: "depository",
        subtype: "checking",
        currency: "CAD",
        balanceCurrent: "1234.56",
      },
    });
    await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Old", type: "depository", archivedAt: new Date() },
    });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("excludes archived by default", async () => {
    const res = await listAccounts.run(ctx, {});
    expect(res.accounts.map((a) => a.name)).toEqual(["Chequing"]);
  });

  it("includes archived when requested", async () => {
    const res = await listAccounts.run(ctx, { include_archived: true });
    expect(res.accounts.map((a) => a.name).sort()).toEqual(["Chequing", "Old"]);
  });

  it("returns plaid status fields when account has a plaidItem", async () => {
    const res = await listAccounts.run(ctx, {});
    const acc = res.accounts.find((a) => a.name === "Chequing");
    expect(acc?.institutionName).toBe("TD");
    expect(acc?.plaidItemStatus).toBe("active");
    expect(acc?.plaidItemLastSyncAt).toBe("2026-05-10T12:00:00.000Z");
  });

  it("serializes balances as strings", async () => {
    const res = await listAccounts.run(ctx, {});
    expect(res.accounts[0].balanceCurrent).toBe("1234.56");
  });

  it("isolates by workspace", async () => {
    const other = await prisma.workspace.create({ data: { name: "other" } });
    await prisma.bankAccount.create({ data: { workspaceId: other.id, name: "Other Acc", type: "depository" } });
    const res = await listAccounts.run(ctx, {});
    expect(res.accounts.map((a) => a.name)).not.toContain("Other Acc");
    await prisma.workspace.delete({ where: { id: other.id } });
  });
});

describe("listAccounts chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;

  beforeEach(async () => {
    const stamp = `la-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "LA" } });
    const ws = await prisma.workspace.create({ data: { name: "la-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns an accounts_list block with total_balance for single-currency", async () => {
    await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Chequing", type: "depository", currency: "CAD", balanceCurrent: "1200.50" },
    });
    await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Savings", type: "depository", currency: "CAD", balanceCurrent: "800.00" },
    });
    const r = await listAccounts.run(ctx, {});
    expect(r.block?.type).toBe("accounts_list");
    if (r.block?.type !== "accounts_list") throw new Error("wrong block");
    expect(r.block.rows).toHaveLength(2);
    expect(r.block.total_balance).toBe("2000.50");
  });

  it("omits total_balance when currencies differ", async () => {
    await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "CAD", type: "depository", currency: "CAD", balanceCurrent: "10.00" },
    });
    await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "USD", type: "depository", currency: "USD", balanceCurrent: "10.00" },
    });
    const r = await listAccounts.run(ctx, {});
    if (r.block?.type !== "accounts_list") throw new Error("wrong block");
    expect(r.block.total_balance).toBeUndefined();
    expect(r.block.currency).toBeUndefined();
  });
});
