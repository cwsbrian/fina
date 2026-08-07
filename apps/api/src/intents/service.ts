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

type ChatMessageRow = {
  id: string;
  role: string;
  blocks: unknown;
  createdAt: string;
};

/** Human-readable confirmation text for a successful intent execution.
 *  Server-templated (not LLM) — cheap, deterministic, and language
 *  matches the user's locale rather than guessing per-message. */
function confirmationFor(
  tool: string,
  result: unknown,
  locale: string,
): string | null {
  const ko = locale.startsWith("ko");
  switch (tool) {
    case "addManualTransaction": {
      const tx = (result as {
        transaction?: { merchantRaw: string; amount: string; currency: string };
      }).transaction;
      if (!tx) return null;
      return `Added ${tx.merchantRaw} for ${tx.currency} ${tx.amount}.`;
    }
    case "changeWorkspaceCurrencyAndAddManualTransaction": {
      const confirmation = (result as { confirmation?: unknown }).confirmation;
      return typeof confirmation === "string" ? confirmation : null;
    }
    case "addRecurring": {
      const typed = result as {
        recurring?: { name: string; amount: string; cadence: string; nextOccurrenceDate: string };
        wasCreated?: boolean;
      };
      const r = typed.recurring;
      if (!r) return null;
      const c = cadenceLabel(r.cadence, ko);
      const sym = "$"; // CAD default; downstream can localize later
      // wasCreated false = pre-existing row was updated. Switch verb so
      // the user sees "Updated Netflix..." not "Added Netflix..." when
      // they're modifying an existing subscription.
      const updated = typed.wasCreated === false;
      if (ko) {
        return updated
          ? `${r.name}을 ${c} ${sym}${r.amount}로 업데이트했어요. 다음 결제: ${r.nextOccurrenceDate}.`
          : `${r.name}을 ${c} ${sym}${r.amount} 정기지출로 추가했어요. 다음 결제: ${r.nextOccurrenceDate}.`;
      }
      return updated
        ? `Updated ${r.name} to ${c} ${sym}${r.amount}. Next charge: ${r.nextOccurrenceDate}.`
        : `Added ${r.name} as a ${c} recurring expense for ${sym}${r.amount}. Next charge: ${r.nextOccurrenceDate}.`;
    }
    case "removeRecurring": {
      const r = (result as { recurring?: { name: string } }).recurring;
      return ko
        ? `${r?.name ?? "정기지출"}을 삭제했어요.`
        : `Removed ${r?.name ?? "the recurring expense"}.`;
    }
    case "removeAllRecurring": {
      const count = (result as { count?: number }).count ?? 0;
      if (count === 0) {
        return ko ? "삭제할 구독이 없어요." : "There were no subscriptions to remove.";
      }
      return ko
        ? `구독 ${count}개를 모두 삭제했어요.`
        : `Removed all ${count} subscription${count === 1 ? "" : "s"}.`;
    }
    case "addScheduledSpend": {
      const s = (result as { scheduledSpend?: { name: string; amount: string; occurredAt: string } }).scheduledSpend;
      if (!s) return null;
      return ko
        ? `${s.name}을 $${s.amount} (${s.occurredAt}) 예정 지출로 추가했어요.`
        : `Added ${s.name} ($${s.amount}) for ${s.occurredAt}.`;
    }
    case "setBudget": {
      return ko ? "예산을 저장했어요." : "Budget saved.";
    }
    case "createCategory": {
      const c = (result as { category?: { name: string } }).category;
      return ko
        ? `${c?.name ?? "카테고리"}를 만들었어요.`
        : `Created ${c?.name ?? "the category"}.`;
    }
    case "addGoal": {
      const g = (result as { goal?: { title: string; targetAmount: string; dueDate: string } }).goal;
      if (!g) return null;
      return ko
        ? `${g.title} 목표를 만들었어요 — ${g.dueDate}까지 $${g.targetAmount}.`
        : `Created goal "${g.title}" — $${g.targetAmount} by ${g.dueDate}.`;
    }
    case "updateGoal": {
      const g = (result as { goal?: { title: string } }).goal;
      return ko
        ? `${g?.title ? `${g.title} ` : ""}목표를 수정했어요.`
        : `Updated goal "${g?.title ?? "goal"}".`;
    }
    case "archiveGoal": {
      const g = (result as { goal?: { title: string } }).goal;
      return ko
        ? `${g?.title ? `${g.title} ` : ""}목표를 보관했어요.`
        : `Archived goal "${g?.title ?? "goal"}".`;
    }
    case "addScheduledSpendBatch": {
      const n = (result as { count?: number }).count ?? 0;
      return ko
        ? `예정 지출 ${n}개를 추가했어요.`
        : `Added ${n} scheduled item${n === 1 ? "" : "s"}.`;
    }
    default:
      return null;
  }
}

function cadenceLabel(c: string, ko: boolean): string {
  if (ko) {
    switch (c) {
      case "monthly":     return "매월";
      case "semimonthly": return "반월 (월 2회)";
      case "biweekly":    return "격주";
      case "weekly":      return "매주";
      case "yearly":      return "매년";
      default:            return c;
    }
  }
  switch (c) {
    case "monthly":     return "monthly";
    case "semimonthly": return "semi-monthly";
    case "biweekly":    return "biweekly";
    case "weekly":      return "weekly";
    case "yearly":      return "yearly";
    default:            return c;
  }
}

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
  "addManualTransaction",
  "changeWorkspaceCurrencyAndAddManualTransaction",
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
  /** Optional thread to post a confirmation assistant message into
   *  after a successful run. The mobile form passes this so the user
   *  sees a clean "added X" message right after the form locks. */
  threadId?: string,
): Promise<{ result: unknown; confirmationMessage?: ChatMessageRow }> {
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
    await logAuditEvent({
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

  // Server-templated confirmation message — posted as an assistant text
  // block into the chat thread the form was rendered in. The user sees
  // "Added Disney as a biweekly recurring expense for $20.00..."
  // without needing the LLM to round-trip.
  let confirmationMessage: ChatMessageRow | undefined;
  if (threadId) {
    const user = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { locale: true },
    });
    const text = confirmationFor(payload.tool, result, user?.locale ?? "en-CA");
    if (text) {
      const created = await prisma.$transaction(async (tx) => {
        const msg = await tx.chatMessage.create({
          data: {
            threadId,
            role: "assistant",
            blocks: [{ type: "text", markdown: text }] as never,
          },
          select: { id: true, role: true, blocks: true, createdAt: true },
        });
        await tx.chatThread.update({
          where: { id: threadId },
          data: { lastMessageAt: msg.createdAt },
        });
        return msg;
      });
      confirmationMessage = {
        id: created.id,
        role: created.role,
        blocks: created.blocks,
        createdAt: created.createdAt.toISOString(),
      };
    }
  }

  return confirmationMessage
    ? { result, confirmationMessage }
    : { result };
}
