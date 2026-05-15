import { z } from "zod";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  period: z.enum(["today", "this_week", "this_month", "last_month"]).describe("Time window for the listing. Omit for all-time.").optional(),
  limit: z.number().int().positive().max(50).describe("Max transactions to return. Default 20, hard cap 50.").optional(),
});

type Args = z.infer<typeof Args>;

function periodRange(period: NonNullable<Args["period"]>): { gte: Date; lt: Date } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  if (period === "today") { const start = new Date(y, m, d); return { gte: start, lt: new Date(y, m, d + 1) }; }
  if (period === "this_week") { const day = now.getDay(); const monday = new Date(y, m, d - ((day + 6) % 7)); return { gte: monday, lt: new Date(y, m, monday.getDate() + 7) }; }
  if (period === "this_month") return { gte: new Date(y, m, 1), lt: new Date(y, m + 1, 1) };
  return { gte: new Date(y, m - 1, 1), lt: new Date(y, m, 1) };
}

export const listTransactions: ToolDef<Args, { transactions: Array<{ id: string; amount: string; merchantRaw: string; merchantNormalized: string | null; categoryId: string | null; occurredAt: string }> }> = {
  name: "listTransactions",
  description: "List the user's recent transactions, optionally filtered by time period.",
  args: Args,
  async run(ctx, args) {
    const where: { workspaceId: string; removedAt: null; occurredAt?: { gte: Date; lt: Date } } = { workspaceId: ctx.workspaceId, removedAt: null };
    if (args.period) where.occurredAt = periodRange(args.period);
    const rows = await prisma.transaction.findMany({ where, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: args.limit ?? 20, select: { id: true, amount: true, merchantRaw: true, merchantNormalized: true, categoryId: true, occurredAt: true } });
    return { transactions: rows.map((r) => ({ id: r.id, amount: r.amount.toString(), merchantRaw: r.merchantRaw, merchantNormalized: r.merchantNormalized, categoryId: r.categoryId, occurredAt: r.occurredAt.toISOString() })) };
  },
};
