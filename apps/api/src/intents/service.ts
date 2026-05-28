import { Prisma } from "@prisma/client";
import {
  AUDIT_WRITE_TOOLS,
  logAuditEvent,
  resolveTargetType,
  extractTargetId,
} from "../audit/service.js";
import type { Role } from "@fina/shared";
import { prisma } from "../db.js";
import type { ToolDef } from "../chat/tools/types.js";
import type { Env } from "../env.js";

// Lazy dynamic import breaks the cycle:
//   present-confirm-card → intents/service → chat/tools/index → present-confirm-card
// A static `import { REGISTRY }` at module top causes the cycle to produce
// `ReferenceError: Cannot access 'presentConfirmCard' before initialization`
// when the barrel is read before initialization completes.
async function getRegistry(): Promise<ToolDef[]> {
  const { REGISTRY } = await import("../chat/tools/index.js");
  return REGISTRY;
}

export const CONFIRMABLE_TOOLS = [
  "createCategory",
  "addTransactionNote",
  "setBudget",
  "mapMerchantToCategory",
  "addRecurring",
  "removeRecurring",
  "addScheduledSpend",
  "dismissScheduledSpend",
  "removeScheduledSpend",
] as const;

// presentRecurringForm is a UI presenter — never a confirmable target,
// only the SOURCE of intents that BIND to addRecurring above.

export type ConfirmableTool = (typeof CONFIRMABLE_TOOLS)[number];

function isConfirmable(t: string): t is ConfirmableTool {
  return (CONFIRMABLE_TOOLS as readonly string[]).includes(t);
}

const INTENT_TTL_MS = 60 * 60 * 1000;

export type IntentPayload = { tool: string; args: Record<string, unknown> };
export type CreateIntentInput = {
  tool: string;
  args: Record<string, unknown>;
  messageId?: string;
  /** Form-flow intents leave required fields unset (the user fills them
   *  in at submit time). When true, skip the create-time zod validation;
   *  consume re-validates after overrides land. */
  skipStrictValidate?: boolean;
};
export type CreateIntentOutput = { intent: { id: string; expiresAt: string } };

export async function createIntentService(
  ctx: { workspaceId: string; userId: string },
  input: CreateIntentInput,
): Promise<CreateIntentOutput> {
  if (!isConfirmable(input.tool)) throw new Error("invalid_tool");
  const registry = await getRegistry();
  const tool = registry.find((t) => t.name === input.tool);
  if (!tool) throw new Error("invalid_tool");
  // Form intents (presentRecurringForm etc) deliberately store partial
  // args because the user is going to fill in the missing fields at
  // submit time. Skip strict zod validation at creation; the consume
  // path re-validates after merging overrides.
  if (input.skipStrictValidate !== true) {
    const parsed = tool.args.safeParse(input.args);
    if (!parsed.success) throw new Error("invalid_payload_args");
  }
  const expiresAt = new Date(Date.now() + INTENT_TTL_MS);
  const data: Prisma.ActionIntentUncheckedCreateInput = {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    kind: "tool_call",
    payload: { tool: input.tool, args: input.args } as Prisma.InputJsonValue,
    expiresAt,
  };
  if (input.messageId !== undefined) data.messageId = input.messageId;
  const row = await prisma.actionIntent.create({ data });
  return { intent: { id: row.id, expiresAt: row.expiresAt.toISOString() } };
}

export async function consumeIntentService(
  ctx: { workspaceId: string; userId: string; role: Role; env: Env },
  intentId: string,
  /** Optional field overrides — used by form blocks (e.g.
   *  recurring_form_card) so the user's edits land in the executed args.
   *  Merged on top of the intent's stored args, then re-validated
   *  against the target tool's zod schema. */
  overrides?: Record<string, unknown>,
): Promise<{ result: unknown }> {
  const row = await prisma.actionIntent.findUnique({ where: { id: intentId } });
  if (!row) throw new Error("intent_not_found");
  if (row.workspaceId !== ctx.workspaceId || row.userId !== ctx.userId) {
    throw new Error("intent_owner_mismatch");
  }
  if (row.consumedAt !== null || row.expiresAt.getTime() <= Date.now()) {
    throw new Error("intent_gone");
  }
  const updated = await prisma.actionIntent.updateMany({
    where: { id: intentId, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (updated.count === 0) throw new Error("intent_gone");
  const payload = row.payload as IntentPayload;
  if (!isConfirmable(payload.tool)) throw new Error("invalid_tool");
  const registry = await getRegistry();
  const tool = registry.find((t) => t.name === payload.tool);
  if (!tool) throw new Error("invalid_tool");
  // Apply form-side overrides BEFORE zod parsing so invalid edits fail
  // with the same error path as a malformed LLM call would have.
  const mergedArgs: Record<string, unknown> = overrides
    ? { ...payload.args, ...overrides }
    : payload.args;
  const parsed = tool.args.safeParse(mergedArgs);
  if (!parsed.success) throw new Error("invalid_payload_args");
  const result = await tool.run(
    { env: ctx.env, workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role },
    parsed.data,
  );
  if (AUDIT_WRITE_TOOLS.has(payload.tool)) {
    void logAuditEvent({
      workspaceId: ctx.workspaceId,
      actorType: "user",
      actorUserId: ctx.userId,
      action: payload.tool,
      targetType: resolveTargetType(payload.tool),
      targetId:   extractTargetId(payload.tool, result),
      intentId:   intentId,
      payload:    mergedArgs,
      result:     result,
    });
  }
  return { result };
}
