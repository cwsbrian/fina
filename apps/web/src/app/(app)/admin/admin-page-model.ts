import {
  isApiError,
  subscriptionSourceLabel,
  type AdminUserDTO,
  type AdminUserDetailDTO,
  type AdminUsersResponse,
} from "@fina/shared";

export type AdminPageErrorState = {
  data: null;
  cursor: null;
  err: string;
};

export function formatAdminDate(value: string | null): string {
  if (!value) return "None";
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatAdminDateTime(value: string | null): string {
  if (!value) return "None";
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatAdminSubscription(user: AdminUserDTO): string {
  if (!user.subscription) return "No active subscription";
  const sub = user.subscription;
  const pending =
    sub.pendingTier && sub.pendingTierAt
      ? `, pending ${sub.pendingTier} on ${formatAdminDate(sub.pendingTierAt)}`
      : "";
  return `${subscriptionSourceLabel(sub.source)} ${sub.tier} ${sub.status}, ends ${formatAdminDate(sub.currentPeriodEnd)}${pending}`;
}

export function formatAdminDevices(user: AdminUserDTO): string {
  if (user.deviceSummary.length === 0) return "No device seen";
  return user.deviceSummary.map((d) => d.platform).join(", ");
}

export function formatCad(value: string): string {
  return `$${Number(value).toFixed(4)} CAD`;
}

export function usageSignal(detail: AdminUserDetailDTO): string {
  const activePlaid = detail.plaidItems.filter((item) => item.status === "active").length;
  if (!detail.activity.lastSeenAt) return "No activity yet";
  return `${activePlaid}/${detail.plaidItems.length} Plaid active, ${detail.activity.transactionCount} tx, ${detail.activity.chatMessageCount} chat msgs`;
}

export function mergeAdminUsersPage(
  previous: AdminUsersResponse | null,
  page: AdminUsersResponse,
  append: boolean,
): AdminUsersResponse {
  if (!append || !previous) return page;
  return {
    users: [...previous.users, ...page.users],
    nextCursor: page.nextCursor,
    summary: page.summary,
  };
}

export function adminErrorState(error: unknown): AdminPageErrorState {
  if (isApiError(error) && error.code === "admin_required") {
    return { data: null, cursor: null, err: "forbidden" };
  }
  return {
    data: null,
    cursor: null,
    err: isApiError(error) ? error.code : "load_error",
  };
}
