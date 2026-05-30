import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { logWarn } from "../logger.js";

export const AUDIT_WRITE_TOOLS = new Set([
  "categorizeTransaction",
  "createCategory",
  "addTransactionNote",
  "setBudget",
  "mapMerchantToCategory",
  "addRecurring",
  "removeRecurring",
  "removeAllRecurring",
  "addScheduledSpend",
  "dismissScheduledSpend",
  "removeScheduledSpend",
  "addGoal",
  "updateGoal",
  "archiveGoal",
  "addScheduledSpendBatch",
]);

const TARGET_TYPE_MAP: Record<string, string> = {
  categorizeTransaction: "transaction",
  createCategory: "category",
  addTransactionNote: "transaction",
  setBudget: "budget",
  mapMerchantToCategory: "merchant_mapping",
  addRecurring: "recurring_expense",
  removeRecurring: "recurring_expense",
  removeAllRecurring: "recurring_expense",
  addScheduledSpend: "scheduled_spend",
  dismissScheduledSpend: "scheduled_spend",
  removeScheduledSpend: "scheduled_spend",
  addGoal: "goal",
  updateGoal: "goal",
  archiveGoal: "goal",
  addScheduledSpendBatch: "scheduled_spend",
};

export function resolveTargetType(action: string): string | null {
  return TARGET_TYPE_MAP[action] ?? null;
}

export function extractTargetId(action: string, result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;

  if (action === "categorizeTransaction" || action === "addTransactionNote") {
    const tx = r.tx as Record<string, unknown> | undefined;
    return typeof tx?.id === "string" ? tx.id : null;
  }
  if (action === "createCategory") {
    const cat = r.category as Record<string, unknown> | undefined;
    return typeof cat?.id === "string" ? cat.id : null;
  }
  if (action === "setBudget") {
    const b = r.budget as Record<string, unknown> | undefined;
    return typeof b?.id === "string" ? b.id : null;
  }
  if (action === "addRecurring") {
    const rec = r.recurring as Record<string, unknown> | undefined;
    return typeof rec?.id === "string" ? rec.id : null;
  }
  if (action === "addScheduledSpend") {
    const s = (result as any)?.schedule as Record<string, unknown> | undefined;
    return typeof s?.id === "string" ? s.id : null;
  }
  if (action === "dismissScheduledSpend") {
    // result is either { schedule: {id} } or { dismissed: false }
    const s = (result as any)?.schedule as Record<string, unknown> | undefined;
    return typeof s?.id === "string" ? s.id : null;
  }
  if (action === "removeScheduledSpend") {
    // result is { removed: bool, alreadyRemoved?: true } — no id returned.
    // Best-effort: pull from the original intent's args if it ever lands here.
    // For v1, return null (audit row is still created, just without targetId).
    return null;
  }
  if (action === "addGoal" || action === "updateGoal" || action === "archiveGoal") {
    const g = (result as Record<string, unknown>).goal as Record<string, unknown> | undefined;
    return typeof g?.id === "string" ? g.id : null;
  }
  if (action === "addScheduledSpendBatch") return null; // N rows — detail is in payload/result
  return null;
}

export type AuditEventInput = {
  workspaceId: string;
  actorType: "agent" | "user";
  actorUserId: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  intentId?: string | null;
  payload?: unknown;
  result?: unknown;
};

export async function logAuditEvent(event: AuditEventInput): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        workspaceId: event.workspaceId,
        actorType: event.actorType,
        actorUserId: event.actorUserId,
        action: event.action,
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        intentId: event.intentId ?? null,
        payload: (event.payload ?? null) as Prisma.InputJsonValue,
        result: (event.result ?? null) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    logWarn(
      { auditAction: event.action, workspaceId: event.workspaceId, err },
      "audit log failed",
    );
  }
}
