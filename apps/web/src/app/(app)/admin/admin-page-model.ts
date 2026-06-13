import {
  isApiError,
  subscriptionSourceLabel,
  type AdminUserDTO,
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

export function formatAdminSubscription(user: AdminUserDTO): string {
  if (!user.subscription) return "No active subscription";
  const sub = user.subscription;
  const pending =
    sub.pendingTier && sub.pendingTierAt
      ? `, pending ${sub.pendingTier} on ${formatAdminDate(sub.pendingTierAt)}`
      : "";
  return `${subscriptionSourceLabel(sub.source)} ${sub.tier} ${sub.status}, ends ${formatAdminDate(sub.currentPeriodEnd)}${pending}`;
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
