import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { addTransactionNote } from "../src/chat/tools/add-transaction-note.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("addTransactionNote chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let acctId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `atn-${Date.now()}`, email: `atn-${Date.now()}@t.co`, name: "ATN" } });
    const ws = await prisma.workspace.create({ data: { name: "atn-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "editor" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "editor" };

    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });
    acctId = acct.id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function seedTx(id: string, extra: { note?: string | null; removedAt?: Date | null } = {}) {
    return prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acctId,
        plaidTransactionId: `pt-${id}`,
        amount: "5.00",
        merchantRaw: "Test",
        occurredAt: new Date(),
        rawData: {},
        note: extra.note ?? null,
        removedAt: extra.removedAt ?? null,
      },
      select: { id: true },
    }).then((r) => r.id);
  }

  it("sets a note on an active transaction", async () => {
    const txId = await seedTx("1");
    const r = await addTransactionNote.run(ctx, { tx_id: txId, note: "paid by John" });
    expect(r.tx.note).toBe("paid by John");
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId }, select: { note: true } });
    expect(row.note).toBe("paid by John");
  });

  it("replaces (does NOT append to) an existing note", async () => {
    const txId = await seedTx("2", { note: "old text" });
    const r = await addTransactionNote.run(ctx, { tx_id: txId, note: "new text" });
    expect(r.tx.note).toBe("new text");
  });

  it("note: null clears the note", async () => {
    const txId = await seedTx("3", { note: "to be cleared" });
    const r = await addTransactionNote.run(ctx, { tx_id: txId, note: null });
    expect(r.tx.note).toBeNull();
  });

  it("works on soft-deleted transactions (notes are historical metadata)", async () => {
    const txId = await seedTx("4", { removedAt: new Date() });
    const r = await addTransactionNote.run(ctx, { tx_id: txId, note: "history" });
    expect(r.tx.note).toBe("history");
  });

  it("unknown tx_id → throws transaction_not_found", async () => {
    await expect(addTransactionNote.run(ctx, { tx_id: "does-not-exist", note: "x" })).rejects.toThrow("transaction_not_found");
  });

  it("cross-workspace tx_id → throws transaction_not_found", async () => {
    const other = await prisma.workspace.create({ data: { name: "other" } });
    const otherAcct = await prisma.bankAccount.create({ data: { workspaceId: other.id, name: "x", type: "depository" } });
    const otherTx = await prisma.transaction.create({
      data: {
        workspaceId: other.id,
        accountId: otherAcct.id,
        plaidTransactionId: "p-other",
        amount: "1.00",
        merchantRaw: "x",
        occurredAt: new Date(),
        rawData: {},
      },
      select: { id: true },
    });
    await expect(addTransactionNote.run(ctx, { tx_id: otherTx.id, note: "x" })).rejects.toThrow("transaction_not_found");
    await prisma.workspace.delete({ where: { id: other.id } });
  });

  it("Zod: empty string note → fails parsing", async () => {
    // run() receives already-parsed args from dispatchTool. Test the schema directly.
    const parsed = addTransactionNote.args.safeParse({ tx_id: "any", note: "" });
    expect(parsed.success).toBe(false);
  });

  it("Zod: note longer than 1000 chars → fails parsing", async () => {
    const parsed = addTransactionNote.args.safeParse({ tx_id: "any", note: "x".repeat(1001) });
    expect(parsed.success).toBe(false);
  });
});
