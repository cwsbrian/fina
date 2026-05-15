import { z } from "zod";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  include_archived: z
    .boolean()
    .describe("Whether to include archived bank accounts. Defaults to false.")
    .optional(),
});

type Args = z.infer<typeof Args>;

type Account = {
  id: string;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  currency: string;
  status: "active" | "closed" | "hidden";
  balanceCurrent: string | null;
  balanceAvailable: string | null;
  balanceLimit: string | null;
  lastBalanceSyncAt: string | null;
  archivedAt: string | null;
  institutionName: string | null;
  plaidItemStatus: "active" | "error" | "relink_required" | "disconnected" | null;
  plaidItemErrorCode: string | null;
  plaidItemLastSyncAt: string | null;
};

export const listAccounts: ToolDef<Args, { accounts: Account[] }> = {
  name: "listAccounts",
  description:
    "List bank accounts in the workspace with balances, account status, and Plaid connection status.",
  args: Args,
  async run(ctx, args) {
    const where: { workspaceId: string; archivedAt?: null } = { workspaceId: ctx.workspaceId };
    if (args.include_archived !== true) where.archivedAt = null;

    const rows = await prisma.bankAccount.findMany({
      where,
      include: {
        plaidItem: {
          select: { institutionName: true, status: true, errorCode: true, lastSyncAt: true },
        },
      },
    });

    const statusOrder: Record<string, number> = { active: 0, hidden: 1, closed: 2 };
    rows.sort((a, b) => {
      const aArch = a.archivedAt ? 1 : 0;
      const bArch = b.archivedAt ? 1 : 0;
      if (aArch !== bArch) return aArch - bArch;
      const sa = statusOrder[a.status] ?? 99;
      const sb = statusOrder[b.status] ?? 99;
      if (sa !== sb) return sa - sb;
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return a.id.localeCompare(b.id);
    });

    const accounts: Account[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      officialName: r.officialName,
      type: r.type,
      subtype: r.subtype,
      currency: r.currency,
      status: r.status as Account["status"],
      balanceCurrent: r.balanceCurrent?.toFixed(2) ?? null,
      balanceAvailable: r.balanceAvailable?.toFixed(2) ?? null,
      balanceLimit: r.balanceLimit?.toFixed(2) ?? null,
      lastBalanceSyncAt: r.lastBalanceSyncAt?.toISOString() ?? null,
      archivedAt: r.archivedAt?.toISOString() ?? null,
      institutionName: r.plaidItem?.institutionName ?? null,
      plaidItemStatus: (r.plaidItem?.status ?? null) as Account["plaidItemStatus"],
      plaidItemErrorCode: r.plaidItem?.errorCode ?? null,
      plaidItemLastSyncAt: r.plaidItem?.lastSyncAt?.toISOString() ?? null,
    }));

    return { accounts };
  },
};
