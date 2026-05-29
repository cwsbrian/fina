import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { presentGoalForm } from "../src/chat/tools/present-goal-form.js";
import { isDueDateAtLeastOneMonth } from "@fina/shared";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("presentGoalForm chat tool", () => {
  let wsId: string;
  let proCtx: ToolContext;
  let freeCtx: ToolContext;

  beforeEach(async () => {
    const stamp = `pf-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const ws = await prisma.workspace.create({ data: { name: "pf-ws", currency: "CAD" } });
    wsId = ws.id;
    const pro = await prisma.user.create({
      data: { id: `${stamp}-pro`, email: `${stamp}-pro@t.co`, name: "Pro", tz: "America/Toronto", trialEndsAt: new Date(Date.now() + 30 * 86_400_000) },
    });
    await prisma.membership.create({ data: { userId: pro.id, workspaceId: wsId, role: "owner" } });
    proCtx = { env: {} as never, workspaceId: wsId, userId: pro.id, role: "owner" };
    const free = await prisma.user.create({
      data: { id: `${stamp}-free`, email: `${stamp}-free@t.co`, name: "Free", tz: "America/Toronto", trialEndsAt: new Date(Date.now() - 86_400_000), trialConsumed: true },
    });
    await prisma.membership.create({ data: { userId: free.id, workspaceId: wsId, role: "editor" } });
    freeCtx = { env: {} as never, workspaceId: wsId, userId: free.id, role: "editor" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns a goal_form_card with an add intent for a Pro user", async () => {
    const r = await presentGoalForm.run(proCtx, {
      question: "새 목표를 만들까요?",
      defaults: { title: "Japan trip", target_amount: 2000 },
    });
    if (r.block.type !== "goal_form_card") throw new Error("wrong block");
    expect(r.block.mode).toBe("add");
    expect(r.block.intent_id).toBeTruthy();
    expect(r.block.defaults.title).toBe("Japan trip");
    expect(r.block.defaults.target_amount).toBe("2000.00");
    // The default due date must satisfy the server's 1-month floor.
    expect(isDueDateAtLeastOneMonth(r.block.defaults.due_date!)).toBe(true);
  });

  it("clamps a too-soon inferred due date up to the floor", async () => {
    const r = await presentGoalForm.run(proCtx, {
      question: "q",
      defaults: { title: "X", target_amount: 100, due_date: "2026-05-20" },
    });
    if (r.block.type !== "goal_form_card") throw new Error("wrong block");
    expect(isDueDateAtLeastOneMonth(r.block.defaults.due_date!)).toBe(true);
  });

  it("returns update mode + carries goal_id when given an existing goal", async () => {
    const g = await prisma.goal.create({
      data: { workspaceId: wsId, title: "Japan trip", targetAmount: new Prisma.Decimal(2000), savedAmount: new Prisma.Decimal(0), dueDate: new Date(Date.now() + 90 * 86_400_000) },
    });
    const r = await presentGoalForm.run(proCtx, { question: "q", goal_id: g.id, defaults: { target_amount: 3000 } });
    if (r.block.type !== "goal_form_card") throw new Error("wrong block");
    expect(r.block.mode).toBe("update");
    expect(r.block.defaults.title).toBe("Japan trip"); // filled from existing
    expect(r.block.defaults.target_amount).toBe("3000.00"); // override wins
  });

  it("short-circuits a non-Pro user to a text 'Pro feature' block (no form)", async () => {
    const r = await presentGoalForm.run(freeCtx, {
      question: "q",
      defaults: { title: "X", target_amount: 100 },
    });
    expect(r.block.type).toBe("text");
  });
});
