import { Prisma } from "@prisma/client";
import type { GoalDTO, CreateGoalInput, PatchGoalInput } from "@fina/shared";
import { prisma } from "../db.js";
import { requireProTier } from "../auth/tier.js";
import { computeGoalSavings } from "./savings.js";

const goalInclude = {
  allocations: {
    include: {
      category: { select: { name: true, icon: true, color: true } },
    },
    orderBy: { monthlyAmount: "desc" as const },
  },
};

type GoalRow = Prisma.GoalGetPayload<{ include: typeof goalInclude }>;

/** Build the wire DTO. `computedSaved` overrides the stored amount —
 *  goal savings are derived from actual under-budget behavior per the
 *  goal's allocations (see goals/savings.ts), not from manual input. */
function toDTO(g: GoalRow, computedSaved: number): GoalDTO {
  return {
    id: g.id,
    title: g.title,
    description: g.description,
    targetAmount: g.targetAmount.toFixed(2),
    savedAmount: computedSaved.toFixed(2),
    dueDate: g.dueDate.toISOString().slice(0, 10),
    icon: g.icon,
    color: g.color,
    strategy: g.strategy as GoalDTO["strategy"],
    allocations: g.allocations.map((a) => ({
      categoryId: a.categoryId,
      categoryName: a.category.name,
      categoryIcon: a.category.icon,
      categoryColor: a.category.color,
      monthlyAmount: a.monthlyAmount.toFixed(2),
      rationale: a.rationale,
    })),
    archivedAt: g.archivedAt?.toISOString() ?? null,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

/** YYYY-MM-DD → UTC noon, same convention as transactions. */
function dateOnly(s: string): Date {
  return new Date(`${s}T12:00:00.000Z`);
}

/** All non-archived goals, soonest due first, each with computed savings.
 *  Perf note: computeGoalSavings runs once per goal and each call
 *  re-reads workspace allocations + the default plan + a budgetPlan
 *  lookup per month — i.e. ~G×(3+M) queries. This matches the existing
 *  REST route (no worse than today); a batched version is a possible
 *  later optimization, not done here. */
export async function listGoalsWithSavings(
  workspaceId: string,
): Promise<GoalDTO[]> {
  const rows = await prisma.goal.findMany({
    where: { workspaceId, archivedAt: null },
    orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
    include: goalInclude,
  });
  return Promise.all(
    rows.map(async (g) => toDTO(g, await computeGoalSavings(workspaceId, g.id))),
  );
}

/** One goal (archived or not) with computed savings, or null. */
export async function getGoalWithSavings(
  workspaceId: string,
  goalId: string,
): Promise<GoalDTO | null> {
  const row = await prisma.goal.findFirst({
    where: { id: goalId, workspaceId },
    include: goalInclude,
  });
  if (!row) return null;
  return toDTO(row, await computeGoalSavings(workspaceId, row.id));
}

/** Non-archived goals whose title CONTAINS `title` (case-insensitive),
 *  soonest due first. The caller decides 0/1/>1 handling. */
export async function findGoalsByTitle(
  workspaceId: string,
  title: string,
): Promise<GoalDTO[]> {
  const rows = await prisma.goal.findMany({
    where: {
      workspaceId,
      archivedAt: null,
      title: { contains: title, mode: "insensitive" },
    },
    orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
    include: goalInclude,
  });
  return Promise.all(
    rows.map(async (g) => toDTO(g, await computeGoalSavings(workspaceId, g.id))),
  );
}

/** Create a goal. Pro-tier gated (throws HttpError(402) for non-Pro).
 *  Does NOT trigger strategy generation — the REST route owns that
 *  fire-and-forget call so chat-created goals don't auto-generate. */
export async function createGoalService(
  workspaceId: string,
  userId: string,
  input: CreateGoalInput,
): Promise<GoalDTO> {
  await requireProTier(userId);
  const created = await prisma.goal.create({
    data: {
      workspaceId,
      title: input.title.trim(),
      description: input.description ?? null,
      targetAmount: new Prisma.Decimal(input.targetAmount),
      savedAmount: new Prisma.Decimal(input.savedAmount ?? 0),
      dueDate: dateOnly(input.dueDate),
      icon: input.icon ?? null,
      color: input.color ?? null,
    },
    include: goalInclude,
  });
  return toDTO(created, await computeGoalSavings(workspaceId, created.id));
}

/** Patch a goal (incl. archived → archivedAt). Pro-tier gated. Returns
 *  null when the goal does not exist in the workspace. */
export async function patchGoalService(
  workspaceId: string,
  userId: string,
  goalId: string,
  input: PatchGoalInput,
): Promise<GoalDTO | null> {
  await requireProTier(userId);
  const row = await prisma.goal.findFirst({
    where: { id: goalId, workspaceId },
    select: { id: true },
  });
  if (!row) return null;
  const data: Prisma.GoalUpdateInput = {};
  if (input.title !== undefined) data.title = input.title.trim();
  if (input.description !== undefined) data.description = input.description;
  if (input.targetAmount !== undefined)
    data.targetAmount = new Prisma.Decimal(input.targetAmount);
  if (input.savedAmount !== undefined)
    data.savedAmount = new Prisma.Decimal(input.savedAmount);
  if (input.dueDate !== undefined) data.dueDate = dateOnly(input.dueDate);
  if (input.icon !== undefined) data.icon = input.icon;
  if (input.color !== undefined) data.color = input.color;
  if (input.archived !== undefined) {
    data.archivedAt = input.archived ? new Date() : null;
  }
  const updated = await prisma.goal.update({
    where: { id: row.id },
    data,
    include: goalInclude,
  });
  return toDTO(updated, await computeGoalSavings(workspaceId, updated.id));
}
