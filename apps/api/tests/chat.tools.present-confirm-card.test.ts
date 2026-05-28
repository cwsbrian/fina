import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { presentConfirmCard } from "../src/chat/tools/present-confirm-card.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("presentConfirmCard chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;

  beforeEach(async () => {
    const stamp = `pcc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "PCC", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "pcc-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("Zod accepts valid args", () => {
    const r = presentConfirmCard.args.safeParse({
      question: "Make a Coffee category?",
      accept_action: { tool: "createCategory", args: { name: "Coffee" } },
    });
    expect(r.success).toBe(true);
  });

  it("Zod rejects missing accept_action", () => {
    const r = presentConfirmCard.args.safeParse({ question: "Confirm?" });
    expect(r.success).toBe(false);
  });

  it("run creates an intent row matching the action; returns accept_intent = intent id", async () => {
    const out = await presentConfirmCard.run(ctx, {
      question: "Make a Coffee category?",
      accept_action: { tool: "createCategory", args: { name: "Coffee" } },
    });
    expect(out.block.type).toBe("confirm_card");
    expect(out.block.accept_intent).toBeTruthy();
    const row = await prisma.actionIntent.findUnique({ where: { id: out.block.accept_intent } });
    expect(row).not.toBeNull();
    expect((row?.payload as { tool: string }).tool).toBe("createCategory");
  });

  it("intent expires ≈ now + 1 hour (read from action_intents row)", async () => {
    const before = Date.now();
    const out = await presentConfirmCard.run(ctx, {
      question: "Q",
      accept_action: { tool: "createCategory", args: { name: "X" } },
    });
    // expiresAt was dropped from the block (mobile doesn't need it —
    // server enforces freshness when /intents/:id/accept is hit).
    // The intent row's expiresAt is still authoritative; assert there.
    const row = await prisma.actionIntent.findUnique({
      where: { id: out.block.accept_intent },
    });
    const ms = new Date(row!.expiresAt).getTime();
    expect(ms - before).toBeGreaterThanOrEqual(3_600_000 - 5_000);
    expect(ms - before).toBeLessThanOrEqual(3_600_000 + 5_000);
  });

  it("propagates invalid_payload_args when args fail target tool's Zod", async () => {
    await expect(
      presentConfirmCard.run(ctx, {
        question: "Q",
        accept_action: { tool: "createCategory", args: { name: "" } },
      }),
    ).rejects.toThrow("invalid_payload_args");
  });
});
