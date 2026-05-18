import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

export const AUDIT_WRITE_TOOLS = new Set([
  "categorizeTransaction",
  "createCategory",
  "addTransactionNote",
  "setBudget",
  "mapMerchantToCategory",
  "addRecurring",
  "removeRecurring",
]);

const TARGET_TYPE_MAP: Record<string, string> = {
  categorizeTransaction: "transaction",
  createCategory: "category",
  addTransactionNote: "transaction",
  setBudget: "budget",
  mapMerchantToCategory: "merchant_mapping",
  addRecurring: "recurring_expense",
  removeRecurring: "recurring_expense",
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
    console.warn("audit log failed", {
      action: event.action,
      workspaceId: event.workspaceId,
      err,
    });
  }
}
