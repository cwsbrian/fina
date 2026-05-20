import { withWorkspaceLock } from "../locks/workspace.js";
import { resolveUserTz, partsInTz, localMidnightToUtc } from "../chat/tools/periods.js";

/**
 * Match unresolved past-or-today schedules to real tx in the same workspace.
 *
 * For each candidate schedule (ordered scheduledDate asc, createdAt asc, id asc):
 *   - Find tx in workspace + occurredAt in the schedule's day (workspace-owner tz) +
 *     positive amount + ≥1 positive allocation in the schedule's category.
 *   - Skip already-consumed (txId, categoryId) pairs (per-category one-to-one).
 *   - Set matchedTxId on first available match.
 *
 * Returns counts for logging/observability.
 */
export async function matchScheduledSpends(
  workspaceId: string,
  today: Date,
): Promise<{ matched: number; unresolved: number }> {
  return await withWorkspaceLock(workspaceId, async (tx) => {
    // 1. Resolve workspace owner's tz (used to compute day boundaries).
    const owner = await tx.membership.findFirst({
      where: { workspaceId, role: "owner" },
      orderBy: { createdAt: "asc" },
      select: { userId: true },
    });
    const ownerTz = owner ? await resolveUserTz(owner.userId) : "America/Toronto";

    // 2. Pre-load already-matched (txId, categoryId) pairs for cross-run dedupe.
    const alreadyMatched = await tx.scheduledSpend.findMany({
      where: { workspaceId, matchedTxId: { not: null } },
      select: { matchedTxId: true, categoryId: true },
    });
    const usedTxAllocations = new Set<string>(
      alreadyMatched.map((r) => `${r.matchedTxId}|${r.categoryId}`),
    );

    // 3. Load candidates: past-or-today, unmatched, undismissed.
    // today is a Date instant; compare against scheduledDate (DATE wall-clock).
    // We use UTC date components from `today` for the comparison since scheduledDate
    // is stored as Postgres DATE (no tz). For the canonical "today" we use the
    // workspace-owner-tz date and convert it to a UTC midnight Date for the SQL bound.
    const todayParts = partsInTz(today, ownerTz);
    const todayDateOnly = new Date(Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day));

    const candidates = await tx.scheduledSpend.findMany({
      where: {
        workspaceId,
        matchedTxId: null,
        dismissedAt: null,
        scheduledDate: { lte: todayDateOnly },
      },
      orderBy: [
        { scheduledDate: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
    });

    let matched = 0;
    let unresolved = 0;
    for (const candidate of candidates) {
      // Compute the schedule's day in workspace-owner tz → UTC half-open instant range.
      const yyyy = candidate.scheduledDate.getUTCFullYear();
      const mm = candidate.scheduledDate.getUTCMonth();
      const dd = candidate.scheduledDate.getUTCDate();
      // Wall-clock day {yyyy-mm-dd} in workspace tz → start/end instants.
      const dayStart = localMidnightToUtc(yyyy, mm + 1, dd, ownerTz);
      const nextDayStart = localMidnightToUtc(yyyy, mm + 1, dd + 1, ownerTz);

      const matches = await tx.transaction.findMany({
        where: {
          workspaceId,
          removedAt: null,
          amount: { gt: 0 },
          occurredAt: { gte: dayStart, lt: nextDayStart },
          allocations: {
            some: { categoryId: candidate.categoryId, amount: { gt: 0 } },
          },
        },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      const picked = matches.find(
        (m) => !usedTxAllocations.has(`${m.id}|${candidate.categoryId}`),
      );
      if (picked) {
        await tx.scheduledSpend.update({
          where: { id: candidate.id },
          data: { matchedTxId: picked.id },
        });
        usedTxAllocations.add(`${picked.id}|${candidate.categoryId}`);
        matched += 1;
      } else {
        unresolved += 1;
      }
    }
    return { matched, unresolved };
  });
}
