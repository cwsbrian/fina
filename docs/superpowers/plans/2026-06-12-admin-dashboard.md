# Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only web admin dashboard guarded by a global `User.role`, plus a server-side command to promote `cwsbrian@gmail.com` to admin.

**Architecture:** Keep workspace membership roles separate from global app administration by adding a new `UserRole` enum on `User`. Expose the global role through shared DTOs, enforce admin access through a DB-backed Fastify guard, and build `/admin/users` as a paginated, read-only support surface that reuses the existing subscription precedence and effective-tier logic.

**Tech Stack:** TypeScript, Prisma/Postgres, Fastify, Next.js App Router, Vitest, `@fina/shared` DTOs.

---

## File Structure

- Modify `apps/api/prisma/schema.prisma`: add `UserRole` enum and `User.role`.
- Create `apps/api/prisma/migrations/20260612_admin_user_role/migration.sql`: add enum and defaulted column.
- Create `libs/shared/src/user-role.ts`: shared role constants and type guard.
- Create `libs/shared/src/dto/admin.ts`: read-only admin list DTOs.
- Modify `libs/shared/src/dto/me.ts`: add `MeDTO.user.role`.
- Modify `libs/shared/src/errors.ts`: add `admin_required`.
- Modify `libs/shared/src/index.ts`: export new role and admin DTOs.
- Modify `apps/api/src/auth/context.ts`: add DB-backed `requireAdminSession`.
- Modify `apps/api/src/routes/me.ts`: include role in `GET /me` and `PATCH /me`.
- Modify `apps/api/src/routes/billing.ts`: include role in billing sync `MeDTO`.
- Create `apps/api/src/routes/admin.ts`: implement `GET /admin/users`.
- Modify `apps/api/src/server.ts`: register admin routes.
- Create `apps/api/src/scripts/set-user-role.ts`: reusable function and CLI for role assignment.
- Modify `apps/api/package.json`: add `admin:set-role`.
- Modify `apps/api/tests/me.test.ts`: assert role in `/me` and role immutability via `PATCH /me`.
- Modify `apps/api/tests/auth.context.test.ts`: cover `requireAdminSession`.
- Create `apps/api/tests/admin.routes.test.ts`: cover admin list authorization, pagination, and subscription state.
- Create `apps/api/tests/admin.set-user-role.test.ts`: cover bootstrap command helper.
- Modify `apps/web/src/components/AppShell.tsx`: render Admin nav only for admins.
- Create `apps/web/src/app/(app)/admin/page.tsx`: read-only admin table.
- Create `apps/web/src/app/(app)/admin/admin.module.css`: compact admin table styling.
- Create `apps/web/src/app/(app)/admin/page.test.ts`: source-level smoke assertions for the admin page.
- Create `apps/web/src/components/AppShell.admin-nav.test.ts`: source-level smoke assertions for conditional admin nav.

---

### Task 1: Database and Shared Contracts

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260612_admin_user_role/migration.sql`
- Create: `libs/shared/src/user-role.ts`
- Create: `libs/shared/src/dto/admin.ts`
- Modify: `libs/shared/src/dto/me.ts`
- Modify: `libs/shared/src/errors.ts`
- Modify: `libs/shared/src/index.ts`
- Test: `libs/shared/src/user-role.test.ts`

- [ ] **Step 1: Write shared role tests**

Create `libs/shared/src/user-role.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isUserRole, USER_ROLES } from "./user-role.js";

describe("user roles", () => {
  it("lists only global app roles", () => {
    expect(USER_ROLES).toEqual(["user", "admin"]);
  });

  it("recognizes valid roles", () => {
    expect(isUserRole("user")).toBe(true);
    expect(isUserRole("admin")).toBe(true);
    expect(isUserRole("owner")).toBe(false);
    expect(isUserRole("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run shared test and verify it fails**

Run:

```bash
pnpm exec nx run shared:test
```

Expected: FAIL with an import error for `./user-role.js`.

- [ ] **Step 3: Add shared role helper**

Create `libs/shared/src/user-role.ts`:

```ts
export const USER_ROLES = ["user", "admin"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}
```

- [ ] **Step 4: Add admin DTOs**

Create `libs/shared/src/dto/admin.ts`:

```ts
import type { Tier } from "../tier.js";
import type { UserRole } from "../user-role.js";
import type { SubscriptionDTO } from "./subscription.js";

export type AdminUserDTO = {
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

export type AdminUsersResponse = {
  users: AdminUserDTO[];
  nextCursor: string | null;
};
```

- [ ] **Step 5: Extend `MeDTO`**

Modify `libs/shared/src/dto/me.ts`:

```ts
import type { Tier } from "../tier.js";
import type { SubscriptionDTO } from "./subscription.js";
import type { NotificationPrefs } from "../notifications.js";
import type { CategorizationMode } from "../categorization.js";
import type { UserRole } from "../user-role.js";
```

Add `role` inside `MeDTO.user`:

```ts
    role: UserRole;
```

- [ ] **Step 6: Export new shared contracts and error code**

Modify `libs/shared/src/index.ts`:

```ts
export * from "./roles.js";
export * from "./user-role.js";
export * from "./tier.js";
```

Add the admin DTO export next to other DTOs:

```ts
export * from "./dto/admin.js";
```

Modify `libs/shared/src/errors.ts` by adding `"admin_required"` under auth/session error codes:

```ts
  "admin_required",
```

- [ ] **Step 7: Add Prisma schema and migration**

In `apps/api/prisma/schema.prisma`, add this enum near the Better Auth models:

```prisma
enum UserRole {
  user
  admin
}
```

Add this field to `model User` after `updatedAt`:

```prisma
  role          UserRole @default(user)
```

Create `apps/api/prisma/migrations/20260612_admin_user_role/migration.sql`:

```sql
CREATE TYPE "UserRole" AS ENUM ('user', 'admin');

ALTER TABLE "users"
  ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'user';
```

- [ ] **Step 8: Generate Prisma client and run shared verification**

Run:

```bash
pnpm --filter @fina/api db:generate
pnpm exec nx run shared:test
pnpm exec nx run shared:typecheck
```

Expected: all commands pass.

- [ ] **Step 9: Commit Task 1**

Run:

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260612_admin_user_role/migration.sql libs/shared/src/user-role.ts libs/shared/src/user-role.test.ts libs/shared/src/dto/admin.ts libs/shared/src/dto/me.ts libs/shared/src/errors.ts libs/shared/src/index.ts
git commit -m "Add global user role contract"
```

---

### Task 2: Admin Bootstrap Command

**Files:**
- Create: `apps/api/src/scripts/set-user-role.ts`
- Modify: `apps/api/package.json`
- Test: `apps/api/tests/admin.set-user-role.test.ts`

- [ ] **Step 1: Write failing script tests**

Create `apps/api/tests/admin.set-user-role.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { setUserRoleByEmail } from "../src/scripts/set-user-role.js";
import { truncateAll, disconnect } from "./helpers/db.js";

describe("setUserRoleByEmail", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("promotes an existing user by normalized email", async () => {
    await prisma.user.create({
      data: { id: "admin-1", email: "cwsbrian@gmail.com", name: "Brian" },
    });

    const updated = await setUserRoleByEmail("CwsBrian@Gmail.Com", "admin");

    expect(updated).toEqual({
      id: "admin-1",
      email: "cwsbrian@gmail.com",
      role: "admin",
    });
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: "admin-1" } }),
    ).resolves.toMatchObject({ role: "admin" });
  });

  it("demotes an existing admin", async () => {
    await prisma.user.create({
      data: { id: "admin-2", email: "admin2@example.com", name: "Admin", role: "admin" },
    });

    const updated = await setUserRoleByEmail("admin2@example.com", "user");

    expect(updated.role).toBe("user");
  });

  it("fails when the user does not exist", async () => {
    await expect(setUserRoleByEmail("missing@example.com", "admin")).rejects.toThrow(
      "User not found: missing@example.com",
    );
  });
});
```

- [ ] **Step 2: Run script tests and verify failure**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/admin.set-user-role.test.ts
```

Expected: FAIL because `set-user-role.ts` does not exist.

- [ ] **Step 3: Implement script helper and CLI**

Create `apps/api/src/scripts/set-user-role.ts`:

```ts
import { prisma } from "../db.js";
import { isUserRole, type UserRole } from "@fina/shared";

export type SetUserRoleResult = {
  id: string;
  email: string;
  role: UserRole;
};

function readFlag(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1 || idx === argv.length - 1) return null;
  return argv[idx + 1] ?? null;
}

export async function setUserRoleByEmail(
  email: string,
  role: UserRole,
): Promise<SetUserRoleResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, email: true },
  });
  if (!existing) {
    throw new Error(`User not found: ${normalizedEmail}`);
  }

  const updated = await prisma.user.update({
    where: { id: existing.id },
    data: { role },
    select: { id: true, email: true, role: true },
  });

  return {
    id: updated.id,
    email: updated.email,
    role: updated.role,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const email = readFlag(argv, "--email");
  const role = readFlag(argv, "--role");
  if (!email || !role || !isUserRole(role)) {
    throw new Error("Usage: pnpm --filter @fina/api admin:set-role -- --email user@example.com --role admin");
  }

  const updated = await setUserRoleByEmail(email, role);
  console.log(JSON.stringify(updated, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
```

- [ ] **Step 4: Add package script**

Modify `apps/api/package.json` scripts:

```json
"admin:set-role": "tsx src/scripts/set-user-role.ts",
```

Keep the existing script order readable by placing it near other operational scripts.

- [ ] **Step 5: Run script tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/admin.set-user-role.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add apps/api/src/scripts/set-user-role.ts apps/api/package.json apps/api/tests/admin.set-user-role.test.ts
git commit -m "Add admin role bootstrap command"
```

---

### Task 3: Admin Guard and MeDTO Builders

**Files:**
- Modify: `apps/api/src/auth/context.ts`
- Modify: `apps/api/src/routes/me.ts`
- Modify: `apps/api/src/routes/billing.ts`
- Modify: `apps/api/tests/auth.context.test.ts`
- Modify: `apps/api/tests/me.test.ts`

- [ ] **Step 1: Write failing guard and MeDTO tests**

In `apps/api/tests/auth.context.test.ts`, update the import:

```ts
import { requireAdminSession, requireWorkspaceContext } from "../src/auth/context.js";
```

Add this helper below `mountProbe`:

```ts
async function mountAdminProbe(app: FastifyInstance): Promise<void> {
  app.get("/_probe/admin", async (req, reply) => {
    try {
      const session = await requireAdminSession(req, app);
      return { ok: true, userId: session.userId, email: session.email, role: session.role };
    } catch (e) {
      const err = e as { statusCode?: number; code?: string; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.code ?? "internal", message: err.message });
    }
  });
}
```

Add these tests:

```ts
describe("requireAdminSession", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("401 when no session", async () => {
    const app = await buildApp(env);
    await mountAdminProbe(app);
    const res = await app.inject({ method: "GET", url: "/_probe/admin" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthenticated");
    await app.close();
  });

  it("403 when signed in but not admin", async () => {
    const app = await buildApp(env);
    await mountAdminProbe(app);
    const user = await signUpAndGetCookie(app, { email: "not-admin@example.com" });
    const res = await app.inject({
      method: "GET",
      url: "/_probe/admin",
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("admin_required");
    await app.close();
  });

  it("200 when signed in as admin", async () => {
    const app = await buildApp(env);
    await mountAdminProbe(app);
    const user = await signUpAndGetCookie(app, { email: "admin@example.com" });
    await prisma.user.update({ where: { id: user.userId }, data: { role: "admin" } });
    const res = await app.inject({
      method: "GET",
      url: "/_probe/admin",
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      userId: user.userId,
      email: "admin@example.com",
      role: "admin",
    });
    await app.close();
  });
});
```

In `apps/api/tests/me.test.ts`, inside the fresh signup test, add:

```ts
expect(body.user.role).toBe("user");
```

Add a new test in `describe("GET /me", ...)`:

```ts
it("returns admin role for an admin user", async () => {
  const app = await buildApp(env);
  const user = await signUpAndGetCookie(app, { email: "admin-me@example.com" });
  await prisma.user.update({ where: { id: user.userId }, data: { role: "admin" } });

  const res = await app.inject({ method: "GET", url: "/me", headers: { cookie: user.cookie } });

  expect(res.statusCode).toBe(200);
  expect(res.json().user.role).toBe("admin");
  await app.close();
});
```

Add a new test in `describe("PATCH /me", ...)`:

```ts
it("does not allow role changes through PATCH /me", async () => {
  const app = await buildApp(testEnv());
  const { cookie, userId } = await signUpAndGetCookie(app, { email: "patch-role@t.co" });
  const res = await app.inject({
    method: "PATCH",
    url: "/me",
    headers: { cookie, "content-type": "application/json" },
    payload: JSON.stringify({ role: "admin" }),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().user.role).toBe("user");
  const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  expect(fresh.role).toBe("user");
  await app.close();
});
```

- [ ] **Step 2: Run focused API tests and verify failure**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/auth.context.test.ts tests/me.test.ts
```

Expected: FAIL because `requireAdminSession` and `MeDTO.user.role` are not implemented.

- [ ] **Step 3: Implement `requireAdminSession`**

Modify `apps/api/src/auth/context.ts`:

```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Role, UserRole } from "@fina/shared";
import { prisma } from "../db.js";
import { assertMembership, MembershipError, type AssertedMembership } from "./membership.js";
```

Add these types after `WorkspaceContext`:

```ts
export type AdminSession = {
  userId: string;
  email: string;
  role: UserRole;
};
```

Add this function after `requireSession`:

```ts
export async function requireAdminSession(
  req: FastifyRequest,
  app: FastifyInstance,
): Promise<AdminSession> {
  const session = await requireSession(req, app);
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, role: true },
  });
  if (!user) throw new HttpError(404, "no_user");
  if (user.role !== "admin") throw new HttpError(403, "admin_required");
  return { userId: user.id, email: user.email, role: user.role };
}
```

- [ ] **Step 4: Include role in `MeDTO` builders**

In `apps/api/src/routes/me.ts`, add `role` to `toMeDTO`:

```ts
      role: user.role,
```

Place it next to `email` and `name`.

In `apps/api/src/routes/billing.ts`, add `role` inside `buildMeBody`:

```ts
      role: user.role,
```

Place it next to `email` and `name`.

- [ ] **Step 5: Run focused API tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/auth.context.test.ts tests/me.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add apps/api/src/auth/context.ts apps/api/src/routes/me.ts apps/api/src/routes/billing.ts apps/api/tests/auth.context.test.ts apps/api/tests/me.test.ts
git commit -m "Add DB-backed admin guard"
```

---

### Task 4: Admin Users API

**Files:**
- Create: `apps/api/src/routes/admin.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/tests/admin.routes.test.ts`

- [ ] **Step 1: Write failing admin route tests**

Create `apps/api/tests/admin.routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv({ APPLE_ENV: "production" });

describe("GET /admin/users", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("401 without a session", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/admin/users" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthenticated");
    await app.close();
  });

  it("403 for a signed-in non-admin", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "owner-not-admin@example.com" });
    const res = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { cookie: user.cookie, "x-workspace-id": "ignored" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("admin_required");
    await app.close();
  });

  it("returns paginated safe user rows for an admin", async () => {
    const app = await buildApp(env);
    const admin = await signUpAndGetCookie(app, { email: "admin-list@example.com" });
    const paid = await signUpAndGetCookie(app, { email: "paid@example.com", name: "Paid User" });
    await prisma.user.update({ where: { id: admin.userId }, data: { role: "admin" } });
    await prisma.user.update({
      where: { id: paid.userId },
      data: {
        trialEndsAt: new Date("2026-06-01T00:00:00Z"),
        trialConsumed: true,
        isPlanMismatch: true,
      },
    });
    await prisma.subscription.createMany({
      data: [
        {
          userId: paid.userId,
          tier: "pro",
          source: "iap_google",
          sourceSubscriptionId: "g-admin-1",
          status: "active",
          currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
          environment: "Sandbox",
        },
        {
          userId: paid.userId,
          tier: "max",
          source: "stripe",
          sourceSubscriptionId: "sub_admin_1",
          sourceCustomerId: "cus_admin_1",
          status: "past_due",
          currentPeriodEnd: new Date("2026-07-02T00:00:00Z"),
          environment: "Production",
        },
        {
          userId: paid.userId,
          tier: "pro",
          source: "stripe",
          sourceSubscriptionId: "sub_canceled_1",
          sourceCustomerId: "cus_admin_1",
          status: "canceled",
          currentPeriodEnd: new Date("2026-07-03T00:00:00Z"),
          environment: "Production",
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/users?limit=1",
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.users).toHaveLength(1);
    expect(typeof body.nextCursor).toBe("string");

    const page2 = await app.inject({
      method: "GET",
      url: `/admin/users?limit=10&cursor=${encodeURIComponent(body.nextCursor)}`,
      headers: { cookie: admin.cookie },
    });
    expect(page2.statusCode).toBe(200);
    const rows = [...body.users, ...page2.json().users];
    const paidRow = rows.find((u: { email: string }) => u.email === "paid@example.com");
    expect(paidRow).toMatchObject({
      email: "paid@example.com",
      name: "Paid User",
      role: "user",
      tier: "max",
      activeSubscriptionCount: 1,
      isPlanMismatch: true,
      subscription: {
        tier: "max",
        status: "past_due",
        source: "stripe",
        environment: "Production",
      },
    });
    expect(JSON.stringify(paidRow)).not.toContain("cus_admin_1");
    expect(JSON.stringify(paidRow)).not.toContain("sub_admin_1");
    await app.close();
  });
});
```

- [ ] **Step 2: Run route tests and verify failure**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/admin.routes.test.ts
```

Expected: FAIL with 404 for `/admin/users`.

- [ ] **Step 3: Implement admin route**

Create `apps/api/src/routes/admin.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { $Enums } from "@prisma/client";
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  type AdminUserDTO,
  type AdminUsersResponse,
  type SubscriptionDTO,
} from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireAdminSession } from "../auth/context.js";
import { computeEffectiveTier } from "../auth/tier.js";
import { filterEnvironmentRows, pickPrimarySub } from "../billing/precedence.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type Cursor = {
  createdAt: string;
  id: string;
};

function parseLimit(value: unknown): number {
  if (typeof value !== "string") return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: unknown): Cursor | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return null;
    if (Number.isNaN(new Date(parsed.createdAt).getTime())) return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

function toSubscriptionDTO(
  primary: {
    tier: string;
    status: string;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    source: string;
    pendingTier: string | null;
    pendingTierAt: Date | null;
    environment: string;
  } | null,
): AdminUserDTO["subscription"] {
  if (!primary) return null;
  return {
    tier: primary.tier as "pro" | "max",
    status: primary.status as SubscriptionDTO["status"],
    currentPeriodEnd: primary.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: primary.cancelAtPeriodEnd,
    source: primary.source as SubscriptionDTO["source"],
    pendingTier: primary.pendingTier as "pro" | "max" | null,
    pendingTierAt: primary.pendingTierAt?.toISOString() ?? null,
    environment: primary.environment,
  };
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/users", async (req, reply) => {
    try {
      const admin = await requireAdminSession(req, app);
      const query = req.query as { limit?: string; cursor?: string };
      const limit = parseLimit(query.limit);
      const cursor = decodeCursor(query.cursor);
      const cursorWhere = cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(cursor.createdAt) } },
              { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
            ],
          }
        : {};

      const users = await prisma.user.findMany({
        where: cursorWhere,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: {
          id: true,
          email: true,
          name: true,
          createdAt: true,
          role: true,
          trialEndsAt: true,
          isPlanMismatch: true,
        },
      });

      const pageUsers = users.slice(0, limit);
      const userIds = pageUsers.map((u) => u.id);
      const activeSubs = userIds.length
        ? await prisma.subscription.findMany({
            where: {
              userId: { in: userIds },
              status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as $Enums.SubscriptionStatus[] },
            },
            select: {
              userId: true,
              tier: true,
              status: true,
              currentPeriodEnd: true,
              cancelAtPeriodEnd: true,
              source: true,
              pendingTier: true,
              pendingTierAt: true,
              environment: true,
              createdAt: true,
              sourceSubscriptionId: true,
            },
          })
        : [];

      const subsByUser = new Map<string, typeof activeSubs>();
      for (const sub of activeSubs) {
        const rows = subsByUser.get(sub.userId) ?? [];
        rows.push(sub);
        subsByUser.set(sub.userId, rows);
      }

      const runtimeEnv = app.fina.env.APPLE_ENV === "production" ? "production" : "sandbox";
      const rows: AdminUserDTO[] = pageUsers.map((user) => {
        const filtered = filterEnvironmentRows(subsByUser.get(user.id) ?? [], runtimeEnv);
        const tier = computeEffectiveTier(user, filtered);
        const primary = pickPrimarySub(filtered);
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          createdAt: user.createdAt.toISOString(),
          role: user.role,
          tier: tier.tier,
          trial: {
            active: tier.trialActive,
            endsAt: tier.trialEndsAt?.toISOString() ?? null,
          },
          subscription: toSubscriptionDTO(primary),
          activeSubscriptionCount: filtered.length,
          isPlanMismatch: user.isPlanMismatch,
        };
      });

      const extra = users[limit];
      const response: AdminUsersResponse = {
        users: rows,
        nextCursor: extra
          ? encodeCursor({ createdAt: extra.createdAt.toISOString(), id: extra.id })
          : null,
      };

      app.log.info({ adminUserId: admin.userId, limit, returned: rows.length }, "admin_users_listed");
      return reply.header("Cache-Control", "no-store").send(response);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
```

- [ ] **Step 4: Register admin routes**

Modify `apps/api/src/server.ts` imports:

```ts
import { adminRoutes } from "./routes/admin.js";
```

Register after `meRoutes`:

```ts
  await app.register(adminRoutes);
```

- [ ] **Step 5: Run admin route tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/admin.routes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
git add apps/api/src/routes/admin.ts apps/api/src/server.ts apps/api/tests/admin.routes.test.ts
git commit -m "Add read-only admin users API"
```

---

### Task 5: Web Admin Navigation and Page

**Files:**
- Modify: `apps/web/src/components/AppShell.tsx`
- Create: `apps/web/src/components/AppShell.admin-nav.test.ts`
- Create: `apps/web/src/app/(app)/admin/page.tsx`
- Create: `apps/web/src/app/(app)/admin/admin.module.css`
- Create: `apps/web/src/app/(app)/admin/page.test.ts`

- [ ] **Step 1: Write source-level web tests**

Create `apps/web/src/components/AppShell.admin-nav.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AppShell admin nav", () => {
  it("renders the Admin nav item only from MeDTO user role", () => {
    const source = readFileSync(join(__dirname, "AppShell.tsx"), "utf8");

    expect(source).toContain('me?.user.role === "admin"');
    expect(source).toContain('label: "Admin"');
    expect(source).toContain('path: "/admin"');
  });
});
```

Create `apps/web/src/app/(app)/admin/page.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Admin page source", () => {
  it("fetches the admin users API and handles forbidden responses", () => {
    const source = readFileSync(join(__dirname, "page.tsx"), "utf8");

    expect(source).toContain('"use client"');
    expect(source).toContain('apiFetch<AdminUsersResponse>("/admin/users"');
    expect(source).toContain('err.code === "admin_required"');
    expect(source).toContain("activeSubscriptionCount");
    expect(source).toContain("isPlanMismatch");
  });
});
```

- [ ] **Step 2: Run web tests and verify failure**

Run:

```bash
pnpm --filter @fina/web exec vitest run src/components/AppShell.admin-nav.test.ts "src/app/(app)/admin/page.test.ts"
```

Expected: FAIL because the new tests reference missing source content.

- [ ] **Step 3: Add conditional Admin nav**

Modify `apps/web/src/components/AppShell.tsx`.

Change `NAV_ITEMS` to omit Admin by default:

```ts
const NAV_ITEMS = [
  { id: "home", label: "Home", path: "/home" },
  { id: "banks", label: "Banks", path: "/settings/banks" },
  { id: "workspace", label: "Workspace", path: "/settings/workspace" },
  { id: "plan", label: "Plan", path: "/settings/plan" },
  { id: "account", label: "Account", path: "/settings/account" },
];

const ADMIN_NAV_ITEM = { id: "admin", label: "Admin", path: "/admin" };
```

Before `return`, add:

```ts
  const navItems =
    me?.user.role === "admin" ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;
```

Change the nav rendering loop:

```tsx
            {navItems.map((it) => (
```

- [ ] **Step 4: Add admin page**

Create `apps/web/src/app/(app)/admin/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import {
  isApiError,
  subscriptionSourceLabel,
  type AdminUsersResponse,
  type AdminUserDTO,
} from "@fina/shared";
import { apiFetch } from "../../../lib/api";
import styles from "./admin.module.css";

function formatDate(value: string | null): string {
  if (!value) return "None";
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatSub(user: AdminUserDTO): string {
  if (!user.subscription) return "No active subscription";
  const sub = user.subscription;
  const pending =
    sub.pendingTier && sub.pendingTierAt
      ? `, pending ${sub.pendingTier} on ${formatDate(sub.pendingTierAt)}`
      : "";
  return `${subscriptionSourceLabel(sub.source)} ${sub.tier} ${sub.status}, ends ${formatDate(sub.currentPeriodEnd)}${pending}`;
}

export default function AdminPage() {
  const [data, setData] = useState<AdminUsersResponse | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (nextCursor: string | null = null) => {
    setLoading(true);
    setErr(null);
    try {
      const qs = nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : "";
      const page = await apiFetch<AdminUsersResponse>(`/admin/users${qs}`);
      setData((prev) =>
        nextCursor && prev
          ? { users: [...prev.users, ...page.users], nextCursor: page.nextCursor }
          : page,
      );
      setCursor(page.nextCursor);
    } catch (e) {
      if (isApiError(e) && e.code === "admin_required") {
        setErr("forbidden");
      } else {
        setErr(isApiError(e) ? e.code : "load_error");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (err === "forbidden") {
    return (
      <div className={styles.container}>
        <h1 className={styles.title}>Admin</h1>
        <p className={styles.error}>You do not have access to this page.</p>
      </div>
    );
  }

  if (err) {
    return (
      <div className={styles.container}>
        <h1 className={styles.title}>Admin</h1>
        <p className={styles.error}>Could not load: {err}</p>
        <button className={styles.button} type="button" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  const users = data?.users ?? [];

  return (
    <div className={styles.container}>
      <div className={styles.head}>
        <h1 className={styles.title}>Admin</h1>
        <p className={styles.sub}>{users.length} users loaded</p>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Tier</th>
              <th>Subscription</th>
              <th>Active</th>
              <th>Mismatch</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <div className={styles.primary}>{user.email}</div>
                  <div className={styles.muted}>{user.name ?? "No name"}</div>
                </td>
                <td>{user.role}</td>
                <td>
                  <div className={styles.primary}>{user.tier}</div>
                  <div className={styles.muted}>
                    {user.trial.active ? `Trial ends ${formatDate(user.trial.endsAt)}` : "No active trial"}
                  </div>
                </td>
                <td>
                  <div className={styles.primary}>{formatSub(user)}</div>
                  <div className={styles.muted}>{user.subscription?.environment ?? "No environment"}</div>
                </td>
                <td>{user.activeSubscriptionCount}</td>
                <td>
                  <span className={user.isPlanMismatch ? styles.badgeDanger : styles.badge}>
                    {user.isPlanMismatch ? "Mismatch" : "OK"}
                  </span>
                </td>
                <td>{formatDate(user.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {cursor && (
        <button
          className={styles.button}
          type="button"
          disabled={loading}
          onClick={() => void load(cursor)}
        >
          {loading ? "Loading" : "Load more"}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Add admin page CSS**

Create `apps/web/src/app/(app)/admin/admin.module.css`:

```css
.container {
  max-width: 1240px;
  margin: 0 auto;
  padding: 40px 24px 72px;
}

.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}

.title {
  font-size: 32px;
  line-height: 1.13;
  font-weight: 500;
  color: var(--color-ink);
}

.sub,
.muted {
  color: var(--color-muted);
  font-size: 13px;
}

.tableWrap {
  overflow-x: auto;
  border: 1px solid var(--color-hairline);
  background: var(--color-canvas);
}

.table {
  width: 100%;
  min-width: 980px;
  border-collapse: collapse;
}

.table th,
.table td {
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-hairline-soft);
  text-align: left;
  vertical-align: top;
  font-size: 14px;
}

.table th {
  font-size: 12px;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  background: var(--color-surface-soft);
}

.primary {
  color: var(--color-ink);
  font-weight: 600;
}

.badge,
.badgeDanger {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
}

.badge {
  color: var(--color-up);
  background: rgba(31, 138, 91, 0.1);
}

.badgeDanger {
  color: var(--color-down);
  background: rgba(207, 32, 47, 0.1);
}

.button {
  margin-top: 18px;
  height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: 8px;
  background: var(--color-primary);
  color: var(--color-on-primary);
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

.button:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.error {
  color: var(--color-down);
}
```

- [ ] **Step 6: Run web tests and typecheck**

Run:

```bash
pnpm --filter @fina/web exec vitest run src/components/AppShell.admin-nav.test.ts "src/app/(app)/admin/page.test.ts"
pnpm exec nx run web:typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

Run:

```bash
git add apps/web/src/components/AppShell.tsx apps/web/src/components/AppShell.admin-nav.test.ts apps/web/src/app/\\(app\\)/admin/page.tsx apps/web/src/app/\\(app\\)/admin/admin.module.css apps/web/src/app/\\(app\\)/admin/page.test.ts
git commit -m "Add read-only admin dashboard"
```

---

### Task 6: Full Verification and Bootstrap Smoke

**Files:**
- No new files expected.

- [ ] **Step 1: Run focused verification**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/admin.set-user-role.test.ts tests/auth.context.test.ts tests/me.test.ts tests/admin.routes.test.ts
pnpm exec nx run shared:test
pnpm --filter @fina/web exec vitest run src/components/AppShell.admin-nav.test.ts "src/app/(app)/admin/page.test.ts"
pnpm exec nx run shared:typecheck
pnpm exec nx run api:typecheck
pnpm exec nx run web:typecheck
```

Expected: all commands pass.

- [ ] **Step 2: Run Prisma migration locally if the dev database is available**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina pnpm --filter @fina/api db:migrate
```

Expected: migration applies and Prisma reports the database is in sync.

- [ ] **Step 3: Bootstrap Brian as admin in the target database**

After the migration is applied to the database that contains `cwsbrian@gmail.com`, run:

```bash
pnpm --filter @fina/api admin:set-role -- --email cwsbrian@gmail.com --role admin
```

Expected output contains:

```json
{
  "email": "cwsbrian@gmail.com",
  "role": "admin"
}
```

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git status --short
git diff --stat HEAD
```

Expected: only intended admin-dashboard files changed. Existing unrelated `README.md` changes remain unstaged unless they were created by the implementer during this plan.

- [ ] **Step 5: Commit final verification adjustments if any were needed**

If Step 1 or Step 2 required small fixes, commit those fixes:

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260612_admin_user_role/migration.sql libs/shared/src/user-role.ts libs/shared/src/user-role.test.ts libs/shared/src/dto/admin.ts libs/shared/src/dto/me.ts libs/shared/src/errors.ts libs/shared/src/index.ts apps/api/src/scripts/set-user-role.ts apps/api/package.json apps/api/tests/admin.set-user-role.test.ts apps/api/src/auth/context.ts apps/api/src/routes/me.ts apps/api/src/routes/billing.ts apps/api/tests/auth.context.test.ts apps/api/tests/me.test.ts apps/api/src/routes/admin.ts apps/api/src/server.ts apps/api/tests/admin.routes.test.ts apps/web/src/components/AppShell.tsx apps/web/src/components/AppShell.admin-nav.test.ts apps/web/src/app/\\(app\\)/admin/page.tsx apps/web/src/app/\\(app\\)/admin/admin.module.css apps/web/src/app/\\(app\\)/admin/page.test.ts
git commit -m "Stabilize admin dashboard verification"
```

If no fixes were needed, skip this step.
