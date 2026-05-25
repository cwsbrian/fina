import { z } from "zod";

/** All push-notification types Fina can emit. Missing keys read as the
 *  per-key default in `DEFAULT_NOTIFICATION_PREFS` — so adding a new
 *  type doesn't strand existing users with a stale prefs blob. */
export type NotificationPrefs = {
  /** Daily morning summary push. Brief still lands in chat regardless. */
  morningBrief: boolean;
  /** Plaid item entered relink_required / error — sync stalled. */
  bankReconnect: boolean;
  /** Someone invited the user to a workspace and the user is already
   *  registered (so we can DM them via push). */
  workspaceInvites: boolean;
  /** Pro trial within 5 / 3 / 1 day of ending. */
  trialExpiring: boolean;
  /** Crossed 25 / 50 / 75 / 100% on a goal's target. */
  goalMilestones: boolean;
  /** Single transaction looks unusually large vs the category's recent
   *  baseline. */
  largeCharges: boolean;
  /** Any new transaction lands in a workspace this user belongs to.
   *  For manual transactions, the creator is excluded from the push
   *  (they already know — they just typed it in). */
  transactionAdded: boolean;
  /** Sparse marketing — new features, tips. */
  productUpdates: boolean;
};

/** Conservative defaults: morning brief + account-state pushes are
 *  on by default (they're the "you'd want to know" kind). Marketing +
 *  goal milestones default off — the user has to opt in. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  morningBrief: true,
  bankReconnect: true,
  workspaceInvites: true,
  trialExpiring: true,
  goalMilestones: false,
  largeCharges: true,
  // Off by default — every new tx is a lot of pushes for a busy
  // household; user opts in if they want a live feed.
  transactionAdded: false,
  productUpdates: false,
};

export const NotificationPrefsSchema = z
  .object({
    morningBrief: z.boolean(),
    bankReconnect: z.boolean(),
    workspaceInvites: z.boolean(),
    trialExpiring: z.boolean(),
    goalMilestones: z.boolean(),
    largeCharges: z.boolean(),
    transactionAdded: z.boolean(),
    productUpdates: z.boolean(),
  })
  .partial();

export type NotificationPrefsPatch = z.infer<typeof NotificationPrefsSchema>;

/** Merge a stored prefs blob (any shape, possibly null) with the
 *  defaults so consumers always see a complete object. */
export function resolveNotificationPrefs(
  stored: unknown,
): NotificationPrefs {
  if (!stored || typeof stored !== "object") return { ...DEFAULT_NOTIFICATION_PREFS };
  const s = stored as Record<string, unknown>;
  const out: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS };
  for (const k of Object.keys(out) as Array<keyof NotificationPrefs>) {
    if (typeof s[k] === "boolean") out[k] = s[k] as boolean;
  }
  return out;
}
