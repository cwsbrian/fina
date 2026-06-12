# Admin Dashboard Design

## Goal

Add a first internal admin surface for Fina so a global admin can review users and subscription state from the web app.

The first version is read-only. It should make support and billing investigation easier without introducing mutation controls, impersonation, manual plan grants, exports, or access to raw provider identifiers. The design should still leave a clear path for later admin actions.

## Role Model

Add a global app role to the `User` table:

```prisma
enum UserRole {
  user
  admin
}

model User {
  role UserRole @default(user)
}
```

This role is separate from workspace membership `Role` (`owner`, `editor`, `viewer`). Workspace role controls access inside a workspace; `UserRole` controls global service administration.

Admin role does not imply a paid plan, trial override, billing source, or entitlement. Billing logic continues to use subscriptions, trials, and future grant records when those exist.

The first admin user is promoted manually in the database after the migration. No public or self-service role update endpoint is part of v1.

## Shared Contracts

Add a shared `UserRole` union in `@fina/shared`, and extend `MeDTO.user` with:

```ts
role: UserRole;
```

Every server builder that returns `MeDTO` must include the role, including `GET /me`, `PATCH /me`, and billing sync responses. `PATCH /me` must not accept or update `role`.

Add read-only admin DTOs in `@fina/shared`:

```ts
type AdminUsersResponse = {
  users: AdminUserDTO[];
  nextCursor: string | null;
};

type AdminUserDTO = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  role: UserRole;
  tier: Tier;
  trial: {
    active: boolean;
    endsAt: string | null;
  };
  subscription: (SubscriptionDTO & {
    environment: string;
  }) | null;
  activeSubscriptionCount: number;
  isPlanMismatch: boolean;
};
```

The admin DTO intentionally excludes Stripe customer IDs, provider subscription IDs, IAP account tokens, device tokens, notification preferences, workspace data, bank data, and raw subscription rows.

## API Design

Add `requireAdminSession(req, app)` as a DB-backed guard:

1. Call `requireSession`.
2. Query `User.id/email/role` from Prisma using the session user id.
3. Return 401 for no session, 404 for a deleted session user, and 403 with `admin_required` for non-admin users.

The guard must not trust `/me`, client state, Better Auth session metadata, or workspace membership.

Add `GET /admin/users`:

- Requires `requireAdminSession`.
- Ignores `X-Workspace-Id`.
- Returns only the shared admin DTO.
- Uses deterministic ordering: newest users first, then id.
- Supports a capped page size, default 50 and max 100.
- Supports cursor pagination with `nextCursor`.
- Sends `Cache-Control: no-store`.
- Uses narrow Prisma `select` fields for users and subscriptions.

Subscription state must be computed with the same rules as `/me`:

- Load only active subscription statuses (`trialing`, `active`, `past_due`).
- Filter rows by runtime environment before entitlement and primary-subscription selection.
- Stripe wins primary subscription precedence.
- Among non-Stripe subscriptions, `max` beats `pro`, then source order, then creation time.
- Effective tier keeps the existing rule where an active trial can produce `tier=pro`.

Admin reads should log a concise structured event with admin user id and page size, without logging returned user data.

## Web Design

Update `AppShell` so the main nav adds `Admin` only when `me.user.role === "admin"`.

Add `/admin` under the authenticated app layout. The page is a compact, read-only operational table:

- User email and name
- Created date
- Global role
- Effective tier and trial state
- Primary subscription source, tier, status, period end, pending tier, and environment
- Active subscription count
- Plan mismatch flag

The page fetches `/admin/users` directly. A 403 response shows a minimal forbidden state or redirects to home. The web check is presentation only; the API guard is the security boundary.

The v1 UI should not include mutation buttons, role editors, plan grant controls, impersonation, destructive actions, exports, or provider-management links.

## Error Handling

Unauthenticated users receive 401 from the API and follow the existing auth handling.

Non-admin users receive 403 `admin_required`. The admin page must not render partial or cached admin data after a 403.

If the admin list fails for another reason, the page shows a retryable load error. The API should fail closed: no admin rows are returned unless the guard has already passed.

## Future Expansion

This design intentionally leaves space for later admin actions without building them now. Future work can add separate guarded endpoints for:

- Promoting or demoting admins
- Manual complimentary plan grants for family or testers
- Billing sync and mismatch reset actions
- Account support workflows

Those endpoints should get separate DTOs, explicit audit logs, and narrower authorization checks rather than overloading the read-only list route.

## Testing

API tests should cover:

- Default users have `role=user`.
- `/me` returns `user.role` for default and admin users.
- `PATCH /me` cannot change role.
- `/admin/users` returns 401 without a session.
- `/admin/users` returns 403 for a signed-in non-admin, even if they are a workspace owner.
- `/admin/users` returns 200 for an admin.
- The admin response is paginated and contains only the expected safe fields.
- Canceled, unpaid, and incomplete subscriptions are not primary subscriptions.
- `past_due` subscriptions count as active.
- Production runtime filters out sandbox IAP rows.
- Stripe beats IAP in primary subscription selection.
- Among IAP subscriptions, `max` beats `pro`.
- `isPlanMismatch` is surfaced.

Web tests should cover:

- Admin nav is hidden for `user`.
- Admin nav is visible for `admin`.
- The admin page renders returned rows.
- The admin page handles 403 without showing user data.

Focused verification should include shared tests, API tests for the new route and `/me`, web tests if available, and typecheck for touched packages.
