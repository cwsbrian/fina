# Plan 2 — Workspace Sharing (Web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build email-based workspace sharing — invite create/list/revoke, accept-by-token, role transitions, owner transfer, web UI for all of it. Mobile gets minimal `X-Workspace-Id` header plumbing only; mobile sharing UX is a separate follow-up plan.

**Architecture:** Backend adds an `invites` table + `InviteStatus` enum and ten endpoints. A new `requireWorkspaceContext` helper resolves the Better Auth session, reads the `X-Workspace-Id` header, and runs `assertMembership` — every workspace-scoped route is one line. `/me` is refactored to user/tier/trial only; the new `/workspaces` route returns the user's workspaces. Web stores active workspace id in a non-HttpOnly cookie that JS reads to attach the header on every fetch. Web ships an accept page, a settings/workspace page, and a header switcher that drops onto the existing `(app)` layout group. Mobile only learns to call `/workspaces` once and attach the header.

**Tech Stack:** Prisma 5 + Postgres 16 (existing), Fastify 5 + Better Auth 1.6 + Resend 6 (existing), vitest 2 (server tests), Next.js 14 App Router (web), Expo Router (mobile, minor changes).

---

## Spec context

This plan implements `docs/superpowers/specs/2026-05-07-fina-design.md` §15 "Phase 1.5 — Workspace Sharing — Web (Plan 2)". Surface roles principle from §3 (mobile = main daily UX, web = entry surface) governs scope: web ships full sharing UX, mobile only ships header plumbing.

Key design decisions already made (frozen by spec/brainstorm):

- **Email-bound invites.** `invites.invitedEmail` is lowercase; `accept` requires `session.user.email.toLowerCase() === invitedEmail`.
- **Server-issued tokens.** `crypto.randomBytes(32).toString("base64url")`, stored in `invites.token`, unique. 7-day expiry.
- **Active workspace = client header.** Server is stateless on active workspace; clients keep it in cookie (web) / AsyncStorage (mobile) and attach `X-Workspace-Id` per request.
- **Owner cardinality = 1 per workspace, transferable.** Application-level invariant (no DB constraint). Last-owner-cannot-leave or self-demote.
- **Invite roles** = `editor` or `viewer` only. Owner transfer is a separate operation.
- **Per-row authz** for transactions/budgets/etc. is **not** in this plan — those tables don't exist yet. They'll be added in Phase 1B with workspace scope baked in at that time.

---

## File structure

### Backend (`apps/api`)

| File | Status | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | modify | add `Invite` model + `InviteStatus` enum + `Workspace.invites` + `User.invitesSent` / `User.invitesAccepted` relations |
| `prisma/migrations/<ts>_add_invites/migration.sql` | new | generated migration |
| `src/auth/membership.ts` | unchanged | (already exists) |
| `src/auth/context.ts` | new | `requireWorkspaceContext(req, app)` — resolves session, reads `X-Workspace-Id`, calls `assertMembership` |
| `src/workspaces/invites.ts` | new | service: `createInvite`, `listInvites`, `revokeInvite`, `getInviteByToken`, `acceptInviteByToken` |
| `src/workspaces/members.ts` | new | service: `listMembers`, `updateMemberRole`, `removeMember`, `transferOwner` |
| `src/email/invite.ts` | new | `sendInviteEmail({ to, inviter, workspaceName, token, baseUrl })` |
| `src/routes/me.ts` | modify | drop workspace from response (now user/tier/trial only) |
| `src/routes/workspaces.ts` | new | `GET /workspaces`, `GET /workspaces/:id/members`, `PATCH /workspaces/:id/members/:userId`, `DELETE /workspaces/:id/members/:userId` |
| `src/routes/invites.ts` | new | `POST /workspaces/:id/invites`, `GET /workspaces/:id/invites`, `DELETE /workspaces/:id/invites/:inviteId`, `GET /invites/by-token/:token`, `POST /invites/by-token/:token/accept` |
| `src/server.ts` | modify | register two new route plugins |
| `src/env.ts` | modify | add `WEB_APP_URL` (used in invite email link) |
| `tests/helpers/db.ts` | modify | extend TRUNCATE to include `invites` |
| `tests/helpers/auth.ts` | modify | add `getOwnerWorkspaceId(app, userId)` + `signUpWithHeader(app, opts)` (returns cookie + headers helper that attaches X-Workspace-Id) |
| `tests/me.test.ts` | modify | rewrite for new shape (no workspace; needs X-Workspace-Id no longer required because /me is user-scoped) |
| `tests/workspaces.test.ts` | new | GET /workspaces |
| `tests/members.test.ts` | new | members route + transfer |
| `tests/invites.test.ts` | new | invite create/list/revoke/accept |
| `tests/auth.context.test.ts` | new | `requireWorkspaceContext` cases |
| `apps/api/.env.test` | modify | add `WEB_APP_URL=http://localhost:3000` |
| `apps/api/package.json` | unchanged | (already has needed deps) |

### Web (`apps/web`)

| File | Status | Responsibility |
|---|---|---|
| `src/lib/active-workspace.ts` | new | get/set `fina-active-workspace` cookie (browser); SSR-safe stubs |
| `src/lib/api.ts` | new | typed `apiFetch<T>(path, init)` adds `credentials: include` + `X-Workspace-Id` from cookie |
| `src/app/(app)/layout.tsx` | new | shared header with workspace switcher; wraps `/home`, `/settings/*` |
| `src/app/(app)/_components/workspace-switcher.tsx` | new | header dropdown, only renders if ≥2 workspaces |
| `src/app/(app)/home/page.tsx` | modify | adapt to refactored `/me` + new `/workspaces` (still shows workspace name/role) |
| `src/app/(app)/settings/workspace/page.tsx` | new | members + role + remove + pending invites + invite form |
| `src/app/(app)/settings/workspace/_components/invite-form.tsx` | new | owner-only invite form (email + role) |
| `src/app/(app)/settings/workspace/_components/members-list.tsx` | new | members list with role dropdown / remove |
| `src/app/(app)/settings/workspace/_components/pending-invites.tsx` | new | pending invites + revoke |
| `src/app/invites/[token]/page.tsx` | new | accept page (server component) |
| `src/app/invites/[token]/_accept-button.tsx` | new | client form to POST accept |
| `middleware.ts` | modify | also protect `/settings` |

### Mobile (`apps/mobile`) — minimal

| File | Status | Responsibility |
|---|---|---|
| `src/workspace/active.ts` | new | AsyncStorage get/set + `bootstrapActiveWorkspace(apiBase)` (calls `/workspaces`, picks first, stores) |
| `src/api/client.ts` | modify | attach `X-Workspace-Id` from active-workspace store |
| `app/(tabs)/index.tsx` | modify | call `/workspaces` then `/me` (parallel after bootstrap), render same UI |

### Docs / repo

| File | Status | Responsibility |
|---|---|---|
| `README.md` | modify | bump Status to "Plan 2 complete" |

---

## Conventions

- **Imports:** TS source uses `.js` extension on relative imports (matches Plan 1 + ESM build).
- **Test env:** Same env block as existing tests. `WEB_APP_URL` is added to the env object inline in tests.
- **Test isolation:** `beforeEach(truncateAll)` per file. Tests create fresh users via `signUpAndGetCookie`.
- **Fastify request → Headers:** Use the existing pattern (loop `req.headers`, `Headers.set`). Centralized in `auth/context.ts`.
- **Error shape:** `{ error: "<code>", message?: string }`. HTTP codes: 400 missing/invalid input, 401 no session, 403 wrong role, 404 not found / not a member, 409 conflict (already member, duplicate invite, last owner).
- **Commits:** one per task at the end (`feat:` for new behavior, `refactor:` for /me change).

---

## Task 1: Schema — `Invite` model + relations + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_invites/migration.sql` (generated)
- Modify: `apps/api/tests/helpers/db.ts` (add `invites` to TRUNCATE)

- [ ] **Step 1: Add the Invite model + InviteStatus enum + relations**

In `apps/api/prisma/schema.prisma`, append to the Fina core block (after the `Membership` model, before nothing else — file ends with `Role` enum). Also add new relation fields to existing `Workspace` and `User` models.

Add to `User` model (inside the `// Fina relations` block, after `memberships Membership[]`):

```prisma
  invitesSent     Invite[]     @relation("InvitesSent")
  invitesAccepted Invite[]     @relation("InvitesAccepted")
```

Add to `Workspace` model (after `memberships Membership[]`):

```prisma
  invites     Invite[]
```

Append at the end of the file (after `enum Role { ... }`):

```prisma
model Invite {
  id            String       @id @default(cuid())
  workspaceId   String
  invitedEmail  String       // stored lowercase
  invitedRole   Role         // editor | viewer (owner not allowed via API)
  invitedById   String
  token         String       @unique
  status        InviteStatus @default(pending)
  expiresAt     DateTime
  acceptedAt    DateTime?
  acceptedById  String?
  revokedAt     DateTime?
  createdAt     DateTime     @default(now())

  workspace     Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  invitedBy     User         @relation("InvitesSent", fields: [invitedById], references: [id], onDelete: Cascade)
  acceptedBy    User?        @relation("InvitesAccepted", fields: [acceptedById], references: [id], onDelete: SetNull)

  @@index([workspaceId, status])
  @@index([invitedEmail, status])
  @@map("invites")
}

enum InviteStatus {
  pending
  accepted
  revoked
  expired
}
```

> **Note on uniqueness:** we deliberately do **not** put `@@unique([workspaceId, invitedEmail])` because we want to allow re-inviting the same email after a previous invite is revoked/expired. Application-level guard rejects creation when there's an existing `pending` invite for the same `(workspaceId, invitedEmail)`.

- [ ] **Step 2: Generate migration**

```bash
pnpm --filter @fina/api db:migrate -- --name add_invites
```

Prisma will:
1. Connect to `fina` (dev DB), generate migration SQL under `apps/api/prisma/migrations/<ts>_add_invites/`.
2. Apply it.
3. Regenerate the Prisma client.

Expected console: "Your database is now in sync with your schema. Done." Inspect the generated SQL — it should `CREATE TYPE "InviteStatus"` and `CREATE TABLE "invites"` with the two indexes.

- [ ] **Step 3: Update test TRUNCATE list**

Edit `apps/api/tests/helpers/db.ts`:

```ts
import { prisma } from "../../src/db.js";

export async function truncateAll(): Promise<void> {
  // Order: leaf → root.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "invites", "memberships", "workspaces",
                   "verifications", "sessions", "accounts", "users"
    RESTART IDENTITY CASCADE;
  `);
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
```

- [ ] **Step 4: Verify existing tests still pass**

```bash
pnpm nx run api:test
```

Expected: existing 13 tests still PASS (no behavior change yet — just schema addition).

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/tests/helpers/db.ts
git commit -m "feat(api): add invites table for workspace sharing"
```

---

## Task 2: `requireWorkspaceContext` helper

**Files:**
- Create: `apps/api/src/auth/context.ts`
- Create: `apps/api/tests/auth.context.test.ts`
- Modify: `apps/api/tests/helpers/auth.ts` (add `getOwnerWorkspaceId`)

This helper centralizes "get session + read X-Workspace-Id + assertMembership". Every workspace-scoped route uses it as the first line.

- [ ] **Step 1: Add test helper for fetching owner workspace id**

Edit `apps/api/tests/helpers/auth.ts`. Add a value import at the top of the file (next to the existing `type` import):

```ts
import { prisma } from "../../src/db.js";
```

Then append at the bottom:

```ts
export async function getOwnerWorkspaceId(userId: string): Promise<string> {
  const m = await prisma.membership.findFirstOrThrow({
    where: { userId, role: "owner" },
  });
  return m.workspaceId;
}
```

- [ ] **Step 2: Write failing test for `requireWorkspaceContext`**

Create `apps/api/tests/auth.context.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
};

// We exercise requireWorkspaceContext through a temporary route mounted in the test.
// The helper is route-agnostic so this is the right surface to verify.

import type { FastifyInstance } from "fastify";
import { requireWorkspaceContext } from "../src/auth/context.js";

async function mountProbe(app: FastifyInstance): Promise<void> {
  app.get("/_probe/ws", async (req, reply) => {
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      return { ok: true, workspaceId: ctx.membership.workspaceId, role: ctx.membership.role };
    } catch (e) {
      const err = e as { statusCode?: number; code?: string; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.code ?? "internal", message: err.message });
    }
  });
}

describe("requireWorkspaceContext", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("401 when no session", async () => {
    const app = await buildApp(env);
    await mountProbe(app);
    const res = await app.inject({
      method: "GET",
      url: "/_probe/ws",
      headers: { "x-workspace-id": "ws_anything" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("400 when X-Workspace-Id header missing", async () => {
    const app = await buildApp(env);
    await mountProbe(app);
    const u = await signUpAndGetCookie(app, { email: "ctx1@x.com", name: "C1" });
    const res = await app.inject({
      method: "GET",
      url: "/_probe/ws",
      headers: { cookie: u.cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_workspace_header");
    await app.close();
  });

  it("404 when user is not a member of the requested workspace", async () => {
    const app = await buildApp(env);
    await mountProbe(app);
    const u = await signUpAndGetCookie(app, { email: "ctx2@x.com", name: "C2" });
    const res = await app.inject({
      method: "GET",
      url: "/_probe/ws",
      headers: { cookie: u.cookie, "x-workspace-id": "ws_does_not_exist" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("happy path returns membership for owner", async () => {
    const app = await buildApp(env);
    await mountProbe(app);
    const u = await signUpAndGetCookie(app, { email: "ctx3@x.com", name: "C3" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const res = await app.inject({
      method: "GET",
      url: "/_probe/ws",
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, workspaceId: wsId, role: "owner" });
    await app.close();
  });
});
```

- [ ] **Step 3: Run test (expect failure)**

```bash
pnpm nx run api:test -- tests/auth.context.test.ts
```

Expected: FAIL — `requireWorkspaceContext` not found.

- [ ] **Step 4: Implement `apps/api/src/auth/context.ts`**

```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Role } from "@fina/shared";
import { assertMembership, type AssertedMembership } from "./membership.js";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message?: string) {
    super(message ?? code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export type WorkspaceContext = {
  session: { userId: string; email: string };
  membership: AssertedMembership;
};

export type RequireOpts = { requiredRole: Role };

function buildHeadersFromRequest(req: FastifyRequest): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") h.set(k, v);
    else if (Array.isArray(v)) h.set(k, v.join(", "));
  }
  return h;
}

export async function requireSession(
  req: FastifyRequest,
  app: FastifyInstance,
): Promise<{ userId: string; email: string }> {
  const headers = buildHeadersFromRequest(req);
  const s = await app.fina.auth.api.getSession({ headers });
  if (!s?.user) throw new HttpError(401, "unauthenticated");
  return { userId: s.user.id, email: s.user.email };
}

export async function requireWorkspaceContext(
  req: FastifyRequest,
  app: FastifyInstance,
  opts: RequireOpts,
): Promise<WorkspaceContext> {
  const session = await requireSession(req, app);
  const wsId = req.headers["x-workspace-id"];
  if (typeof wsId !== "string" || wsId.length === 0) {
    throw new HttpError(400, "missing_workspace_header", "X-Workspace-Id header required");
  }
  try {
    const membership = await assertMembership({
      userId: session.userId,
      workspaceId: wsId,
      requiredRole: opts.requiredRole,
    });
    return { session, membership };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "no_membership") {
      throw new HttpError(404, "no_membership", err.message);
    }
    if (err.code === "insufficient_role") {
      throw new HttpError(403, "insufficient_role", err.message);
    }
    throw e;
  }
}
```

- [ ] **Step 5: Run test (expect pass)**

```bash
pnpm nx run api:test -- tests/auth.context.test.ts
```

Expected: 4/4 PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/context.ts apps/api/tests/auth.context.test.ts apps/api/tests/helpers/auth.ts
git commit -m "feat(api): requireWorkspaceContext helper for X-Workspace-Id routes"
```

---

## Task 3: Refactor `/me` + add `/workspaces` route

**Files:**
- Modify: `apps/api/src/routes/me.ts` (drop workspace from response)
- Create: `apps/api/src/routes/workspaces.ts` (just GET /workspaces for now — members/roles in later tasks)
- Modify: `apps/api/src/server.ts` (register workspaces routes)
- Modify: `apps/api/tests/me.test.ts` (new shape)
- Create: `apps/api/tests/workspaces.test.ts`

After Plan 2, `/me` is purely user info (id/email/tz/locale/tier/trial). Workspace info lives in `/workspaces`. The home pages on web/mobile call both.

- [ ] **Step 1: Update `/me` test to the new shape**

Replace `apps/api/tests/me.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie } from "./helpers/auth.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
};

describe("GET /me", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("returns user + tier=pro + trial active for fresh signup", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "me1@example.com", name: "Me One" });
    const res = await app.inject({ method: "GET", url: "/me", headers: { cookie: user.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe("me1@example.com");
    expect(body).not.toHaveProperty("workspace");
    expect(body.tier).toBe("pro");
    expect(body.trial.active).toBe(true);
    expect(typeof body.trial.endsAt).toBe("string");
    await app.close();
  });

  it("returns tier=free when trial has ended", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "exp@example.com", name: "Exp" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    const res = await app.inject({ method: "GET", url: "/me", headers: { cookie: user.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tier).toBe("free");
    expect(body.trial.active).toBe(false);
    await app.close();
  });

  it("returns 401 without a session", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 2: Refactor `/me` to drop workspace**

Replace `apps/api/src/routes/me.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { Tier } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";

function effectiveTier(user: { trialEndsAt: Date | null }): {
  tier: Tier;
  trialActive: boolean;
  trialEndsAt: Date | null;
} {
  const now = new Date();
  if (user.trialEndsAt && user.trialEndsAt > now) {
    return { tier: "pro", trialActive: true, trialEndsAt: user.trialEndsAt };
  }
  return { tier: "free", trialActive: false, trialEndsAt: user.trialEndsAt };
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const user = await prisma.user.findUnique({ where: { id: session.userId } });
      if (!user) return reply.code(404).send({ error: "no_user" });
      const { tier, trialActive, trialEndsAt } = effectiveTier(user);
      return {
        user: { id: user.id, email: user.email, tz: user.tz, locale: user.locale },
        tier,
        trial: { active: trialActive, endsAt: trialEndsAt?.toISOString() ?? null },
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
```

- [ ] **Step 3: Run /me tests (expect pass)**

```bash
pnpm nx run api:test -- tests/me.test.ts
```

Expected: 3/3 PASS.

- [ ] **Step 4: Write `/workspaces` test**

Create `apps/api/tests/workspaces.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie } from "./helpers/auth.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
};

describe("GET /workspaces", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("returns the personal workspace after signup", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "ws1@x.com", name: "WS1" });
    const res = await app.inject({ method: "GET", url: "/workspaces", headers: { cookie: u.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.workspaces)).toBe(true);
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toMatchObject({ name: "WS1's workspace", role: "owner" });
    expect(typeof body.workspaces[0].id).toBe("string");
    await app.close();
  });

  it("returns multiple workspaces sorted by createdAt asc", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "ws2@x.com", name: "WS2" });
    const second = await prisma.workspace.create({ data: { name: "Family" } });
    await prisma.membership.create({
      data: { userId: u.userId, workspaceId: second.id, role: "editor" },
    });
    const res = await app.inject({ method: "GET", url: "/workspaces", headers: { cookie: u.cookie } });
    expect(res.statusCode).toBe(200);
    const names = res.json().workspaces.map((w: { name: string }) => w.name);
    expect(names).toEqual(["WS2's workspace", "Family"]);
    await app.close();
  });

  it("401 without session", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/workspaces" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 5: Implement `apps/api/src/routes/workspaces.ts` (GET only for now)**

```ts
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";

export async function workspacesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const memberships = await prisma.membership.findMany({
        where: { userId: session.userId },
        include: { workspace: true },
        orderBy: { workspace: { createdAt: "asc" } },
      });
      return {
        workspaces: memberships.map((m) => ({
          id: m.workspace.id,
          name: m.workspace.name,
          role: m.role,
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
```

- [ ] **Step 6: Register the route in `server.ts`**

Edit `apps/api/src/server.ts` — add the import and the register call:

```ts
import { workspacesRoutes } from "./routes/workspaces.js";
```

After `await app.register(meRoutes);`:

```ts
  await app.register(workspacesRoutes);
```

- [ ] **Step 7: Run all tests**

```bash
pnpm nx run api:test
```

Expected: existing tests still PASS + 3 new `/workspaces` tests PASS. 

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/me.ts apps/api/src/routes/workspaces.ts apps/api/src/server.ts apps/api/tests/me.test.ts apps/api/tests/workspaces.test.ts
git commit -m "refactor(api): split /me into /me + /workspaces"
```

---

## Task 4: `invites` service — `createInvite`, `listInvites`, `revokeInvite`, `getInviteByToken`

**Files:**
- Create: `apps/api/src/workspaces/invites.ts` (partial — accept comes in Task 5)
- Create: `apps/api/tests/invites.service.test.ts` (this file's tests; route tests come later)

Service is route-agnostic and tests it directly. This keeps validation logic well-tested independent of HTTP plumbing.

- [ ] **Step 1: Write failing service test**

Create `apps/api/tests/invites.service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import {
  createInvite,
  listInvites,
  revokeInvite,
  getInviteByToken,
  InviteServiceError,
} from "../src/workspaces/invites.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
};

describe("invites service: create / list / revoke / lookup", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("create — happy path", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "owner@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "GUEST@x.com",
      invitedRole: "editor",
    });
    expect(inv.invitedEmail).toBe("guest@x.com");
    expect(inv.invitedRole).toBe("editor");
    expect(inv.token.length).toBeGreaterThanOrEqual(40);
    expect(inv.status).toBe("pending");
    expect(inv.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await app.close();
  });

  it("create — rejects role=owner", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await expect(
      createInvite({
        workspaceId: wsId,
        invitedById: owner.userId,
        invitedEmail: "g@x.com",
        invitedRole: "owner" as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_role" });
    await app.close();
  });

  it("create — rejects when invitee is already a member", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@x.com", name: "O3" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m@x.com", name: "M" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "editor" },
    });
    await expect(
      createInvite({
        workspaceId: wsId,
        invitedById: owner.userId,
        invitedEmail: "M@x.com",
        invitedRole: "editor",
      }),
    ).rejects.toMatchObject({ code: "already_member" });
    await app.close();
  });

  it("create — rejects when a pending invite already exists for that email", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4@x.com", name: "O4" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g4@x.com",
      invitedRole: "viewer",
    });
    await expect(
      createInvite({
        workspaceId: wsId,
        invitedById: owner.userId,
        invitedEmail: "G4@x.com",
        invitedRole: "editor",
      }),
    ).rejects.toMatchObject({ code: "duplicate_invite" });
    await app.close();
  });

  it("create — rejects inviting yourself", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "self@x.com", name: "Self" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await expect(
      createInvite({
        workspaceId: wsId,
        invitedById: owner.userId,
        invitedEmail: "self@x.com",
        invitedRole: "editor",
      }),
    ).rejects.toMatchObject({ code: "already_member" });
    await app.close();
  });

  it("list — returns only pending invites for the workspace", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o5@x.com", name: "O5" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "a@x.com",
      invitedRole: "editor",
    });
    const inv2 = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "b@x.com",
      invitedRole: "viewer",
    });
    await revokeInvite({ workspaceId: wsId, inviteId: inv2.id });
    const list = await listInvites({ workspaceId: wsId });
    expect(list.map((i) => i.invitedEmail)).toEqual(["a@x.com"]);
    await app.close();
  });

  it("revoke — sets status=revoked + revokedAt", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o6@x.com", name: "O6" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g6@x.com",
      invitedRole: "viewer",
    });
    await revokeInvite({ workspaceId: wsId, inviteId: inv.id });
    const reread = await prisma.invite.findUniqueOrThrow({ where: { id: inv.id } });
    expect(reread.status).toBe("revoked");
    expect(reread.revokedAt).not.toBeNull();
    await app.close();
  });

  it("revoke — 404 when invite belongs to different workspace", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o7@x.com", name: "O7" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g7@x.com",
      invitedRole: "viewer",
    });
    const otherWs = await prisma.workspace.create({ data: { name: "Other" } });
    await expect(
      revokeInvite({ workspaceId: otherWs.id, inviteId: inv.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    await app.close();
  });

  it("getInviteByToken — returns pending; expires lazily", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o8@x.com", name: "O8" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g8@x.com",
      invitedRole: "viewer",
    });
    const fetched = await getInviteByToken(inv.token);
    expect(fetched?.id).toBe(inv.id);
    expect(fetched?.workspaceName).toBe("O8's workspace");
    expect(fetched?.inviterEmail).toBe("o8@x.com");

    // Force expiry then re-read; status should be flipped to "expired".
    await prisma.invite.update({
      where: { id: inv.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const after = await getInviteByToken(inv.token);
    expect(after?.status).toBe("expired");
    await app.close();
  });

  it("getInviteByToken — returns null for unknown token", async () => {
    const app = await buildApp(env);
    const result = await getInviteByToken("not-a-real-token");
    expect(result).toBeNull();
    await app.close();
  });

  it("InviteServiceError carries a code", async () => {
    const e = new InviteServiceError("invalid_role", "boom");
    expect(e.code).toBe("invalid_role");
    expect(e.message).toBe("boom");
  });
});
```

- [ ] **Step 2: Run test (expect failure)**

```bash
pnpm nx run api:test -- tests/invites.service.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `apps/api/src/workspaces/invites.ts` (creation + list + revoke + lookup; accept stub)**

```ts
import crypto from "node:crypto";
import type { Role } from "@fina/shared";
import { prisma } from "../db.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InviteCode =
  | "invalid_role"
  | "already_member"
  | "duplicate_invite"
  | "not_found"
  | "expired"
  | "revoked"
  | "wrong_email"
  | "consumed";

export class InviteServiceError extends Error {
  readonly code: InviteCode;
  constructor(code: InviteCode, message?: string) {
    super(message ?? code);
    this.name = "InviteServiceError";
    this.code = code;
  }
}

function genToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function lower(email: string): string {
  return email.trim().toLowerCase();
}

export type CreateInviteInput = {
  workspaceId: string;
  invitedById: string;
  invitedEmail: string;
  invitedRole: Role;
};

export type Invite = {
  id: string;
  workspaceId: string;
  invitedEmail: string;
  invitedRole: Role;
  invitedById: string;
  token: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedById: string | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export async function createInvite(input: CreateInviteInput): Promise<Invite> {
  if (input.invitedRole !== "editor" && input.invitedRole !== "viewer") {
    throw new InviteServiceError("invalid_role", "invited role must be editor or viewer");
  }
  const email = lower(input.invitedEmail);

  // Reject if invitee is already a member by email.
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    const existingMembership = await prisma.membership.findUnique({
      where: {
        userId_workspaceId: { userId: existingUser.id, workspaceId: input.workspaceId },
      },
    });
    if (existingMembership) {
      throw new InviteServiceError("already_member", "user is already a member");
    }
  }

  // Reject if a pending invite already exists.
  const dup = await prisma.invite.findFirst({
    where: { workspaceId: input.workspaceId, invitedEmail: email, status: "pending" },
  });
  if (dup) {
    throw new InviteServiceError("duplicate_invite", "pending invite already exists");
  }

  const inv = await prisma.invite.create({
    data: {
      workspaceId: input.workspaceId,
      invitedById: input.invitedById,
      invitedEmail: email,
      invitedRole: input.invitedRole,
      token: genToken(),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });
  return inv as Invite;
}

export async function listInvites(input: { workspaceId: string }): Promise<Invite[]> {
  const rows = await prisma.invite.findMany({
    where: { workspaceId: input.workspaceId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  return rows as Invite[];
}

export async function revokeInvite(input: { workspaceId: string; inviteId: string }): Promise<void> {
  const inv = await prisma.invite.findUnique({ where: { id: input.inviteId } });
  if (!inv || inv.workspaceId !== input.workspaceId) {
    throw new InviteServiceError("not_found", "invite not found");
  }
  if (inv.status !== "pending") {
    throw new InviteServiceError("not_found", "invite not pending");
  }
  await prisma.invite.update({
    where: { id: inv.id },
    data: { status: "revoked", revokedAt: new Date() },
  });
}

export type InviteView = Invite & { workspaceName: string; inviterEmail: string };

export async function getInviteByToken(token: string): Promise<InviteView | null> {
  const inv = await prisma.invite.findUnique({
    where: { token },
    include: { workspace: true, invitedBy: true },
  });
  if (!inv) return null;

  // Lazily flip pending → expired so callers always see the right status.
  let status = inv.status;
  if (status === "pending" && inv.expiresAt.getTime() <= Date.now()) {
    await prisma.invite.update({
      where: { id: inv.id },
      data: { status: "expired" },
    });
    status = "expired";
  }

  return {
    ...(inv as unknown as Invite),
    status,
    workspaceName: inv.workspace.name,
    inviterEmail: inv.invitedBy.email,
  };
}
```

- [ ] **Step 4: Run service test (expect pass)**

```bash
pnpm nx run api:test -- tests/invites.service.test.ts
```

Expected: 11/11 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workspaces/invites.ts apps/api/tests/invites.service.test.ts
git commit -m "feat(api): invites service — create / list / revoke / lookup"
```

---

## Task 5: `invites` service — `acceptInviteByToken`

**Files:**
- Modify: `apps/api/src/workspaces/invites.ts` (add `acceptInviteByToken`)
- Modify: `apps/api/tests/invites.service.test.ts` (append accept describe block)

- [ ] **Step 1: Append acceptance test cases**

Append to `apps/api/tests/invites.service.test.ts` (inside the same file, after the existing `describe`):

```ts
import { acceptInviteByToken } from "../src/workspaces/invites.js";

describe("invites service: accept", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("happy path — creates membership, marks invite consumed", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow@x.com", name: "OW" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "guest@x.com",
      invitedRole: "editor",
    });
    const guest = await signUpAndGetCookie(app, { email: "guest@x.com", name: "Guest" });

    const result = await acceptInviteByToken({
      token: inv.token,
      acceptingUserId: guest.userId,
      acceptingEmail: "Guest@x.com", // case-insensitive
    });
    expect(result.workspaceId).toBe(wsId);
    expect(result.role).toBe("editor");

    const reread = await prisma.invite.findUniqueOrThrow({ where: { id: inv.id } });
    expect(reread.status).toBe("accepted");
    expect(reread.acceptedById).toBe(guest.userId);
    expect(reread.acceptedAt).not.toBeNull();

    const member = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: guest.userId, workspaceId: wsId } },
    });
    expect(member.role).toBe("editor");
    await app.close();
  });

  it("rejects when accepting user's email differs from invite email", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow2@x.com", name: "OW2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "expected@x.com",
      invitedRole: "viewer",
    });
    const otherUser = await signUpAndGetCookie(app, { email: "wrong@x.com", name: "Wrong" });
    await expect(
      acceptInviteByToken({
        token: inv.token,
        acceptingUserId: otherUser.userId,
        acceptingEmail: "wrong@x.com",
      }),
    ).rejects.toMatchObject({ code: "wrong_email" });
    await app.close();
  });

  it("rejects revoked invite", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow3@x.com", name: "OW3" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g3@x.com",
      invitedRole: "viewer",
    });
    await revokeInvite({ workspaceId: wsId, inviteId: inv.id });
    const guest = await signUpAndGetCookie(app, { email: "g3@x.com", name: "G3" });
    await expect(
      acceptInviteByToken({
        token: inv.token,
        acceptingUserId: guest.userId,
        acceptingEmail: "g3@x.com",
      }),
    ).rejects.toMatchObject({ code: "revoked" });
    await app.close();
  });

  it("rejects expired invite", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow4@x.com", name: "OW4" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g4@x.com",
      invitedRole: "viewer",
    });
    await prisma.invite.update({
      where: { id: inv.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const guest = await signUpAndGetCookie(app, { email: "g4@x.com", name: "G4" });
    await expect(
      acceptInviteByToken({
        token: inv.token,
        acceptingUserId: guest.userId,
        acceptingEmail: "g4@x.com",
      }),
    ).rejects.toMatchObject({ code: "expired" });
    await app.close();
  });

  it("rejects accepting twice (already consumed)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow5@x.com", name: "OW5" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g5@x.com",
      invitedRole: "viewer",
    });
    const guest = await signUpAndGetCookie(app, { email: "g5@x.com", name: "G5" });
    await acceptInviteByToken({
      token: inv.token,
      acceptingUserId: guest.userId,
      acceptingEmail: "g5@x.com",
    });
    await expect(
      acceptInviteByToken({
        token: inv.token,
        acceptingUserId: guest.userId,
        acceptingEmail: "g5@x.com",
      }),
    ).rejects.toMatchObject({ code: "consumed" });
    await app.close();
  });

  it("404 for unknown token", async () => {
    await expect(
      acceptInviteByToken({
        token: "no-such",
        acceptingUserId: "u_noop",
        acceptingEmail: "noop@x.com",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
```

- [ ] **Step 2: Run accept tests (expect failure)**

```bash
pnpm nx run api:test -- tests/invites.service.test.ts
```

Expected: 6 new FAILures (`acceptInviteByToken not exported`).

- [ ] **Step 3: Append `acceptInviteByToken` to `apps/api/src/workspaces/invites.ts`**

Append at the end of the file:

```ts
export type AcceptInput = {
  token: string;
  acceptingUserId: string;
  acceptingEmail: string;
};

export type AcceptResult = {
  workspaceId: string;
  role: Role;
};

export async function acceptInviteByToken(input: AcceptInput): Promise<AcceptResult> {
  return await prisma.$transaction(async (tx) => {
    const inv = await tx.invite.findUnique({ where: { token: input.token } });
    if (!inv) throw new InviteServiceError("not_found", "invite not found");
    if (inv.status === "revoked") throw new InviteServiceError("revoked", "invite revoked");
    if (inv.status === "accepted") throw new InviteServiceError("consumed", "invite already accepted");
    if (inv.status === "expired" || inv.expiresAt.getTime() <= Date.now()) {
      // Flip if needed, then reject.
      if (inv.status === "pending") {
        await tx.invite.update({ where: { id: inv.id }, data: { status: "expired" } });
      }
      throw new InviteServiceError("expired", "invite expired");
    }
    if (lower(input.acceptingEmail) !== inv.invitedEmail) {
      throw new InviteServiceError("wrong_email", "session email does not match invited email");
    }

    // Idempotent membership creation.
    const existing = await tx.membership.findUnique({
      where: {
        userId_workspaceId: { userId: input.acceptingUserId, workspaceId: inv.workspaceId },
      },
    });
    if (!existing) {
      await tx.membership.create({
        data: {
          userId: input.acceptingUserId,
          workspaceId: inv.workspaceId,
          role: inv.invitedRole,
        },
      });
    }

    await tx.invite.update({
      where: { id: inv.id },
      data: { status: "accepted", acceptedAt: new Date(), acceptedById: input.acceptingUserId },
    });

    return { workspaceId: inv.workspaceId, role: inv.invitedRole as Role };
  });
}
```

- [ ] **Step 4: Run accept tests (expect pass)**

```bash
pnpm nx run api:test -- tests/invites.service.test.ts
```

Expected: 17/17 PASS in this file (11 prior + 6 accept).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workspaces/invites.ts apps/api/tests/invites.service.test.ts
git commit -m "feat(api): invites service — accept by token (atomic)"
```

---

## Task 6: `members` service — list / update role / remove + last-owner invariant

**Files:**
- Create: `apps/api/src/workspaces/members.ts` (partial; transfer comes in Task 7)
- Create: `apps/api/tests/members.service.test.ts`

The "last owner" invariant: there must always be ≥ 1 owner per workspace. `updateMemberRole` and `removeMember` enforce this.

- [ ] **Step 1: Write failing service test**

Create `apps/api/tests/members.service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import {
  listMembers,
  updateMemberRole,
  removeMember,
  MembersServiceError,
} from "../src/workspaces/members.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
};

async function addMember(opts: {
  workspaceId: string;
  email: string;
  role: "editor" | "viewer";
}): Promise<string> {
  const u = await prisma.user.create({
    data: {
      id: `u_${Math.random().toString(36).slice(2, 10)}`,
      email: opts.email,
      emailVerified: true,
    },
  });
  await prisma.membership.create({
    data: { userId: u.id, workspaceId: opts.workspaceId, role: opts.role },
  });
  return u.id;
}

describe("members service: list / update / remove", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("list — returns owner first, then editor, then viewer; sorted by role then email", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "owner@x.com", name: "Owner" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await addMember({ workspaceId: wsId, email: "vy@x.com", role: "viewer" });
    await addMember({ workspaceId: wsId, email: "ed@x.com", role: "editor" });

    const members = await listMembers({ workspaceId: wsId });
    expect(members.map((m) => `${m.role}:${m.email}`)).toEqual([
      "owner:owner@x.com",
      "editor:ed@x.com",
      "viewer:vy@x.com",
    ]);
    await app.close();
  });

  it("update — owner can promote viewer to editor", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const memberId = await addMember({ workspaceId: wsId, email: "v@x.com", role: "viewer" });
    await updateMemberRole({ workspaceId: wsId, targetUserId: memberId, newRole: "editor" });
    const m = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: memberId, workspaceId: wsId } },
    });
    expect(m.role).toBe("editor");
    await app.close();
  });

  it("update — rejects newRole=owner (use transferOwner instead)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const memberId = await addMember({ workspaceId: wsId, email: "v@x.com", role: "viewer" });
    await expect(
      updateMemberRole({ workspaceId: wsId, targetUserId: memberId, newRole: "owner" as never }),
    ).rejects.toMatchObject({ code: "use_transfer" });
    await app.close();
  });

  it("update — rejects demoting the last owner", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await expect(
      updateMemberRole({ workspaceId: wsId, targetUserId: owner.userId, newRole: "editor" }),
    ).rejects.toMatchObject({ code: "last_owner" });
    await app.close();
  });

  it("update — 404 when target is not a member", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await expect(
      updateMemberRole({ workspaceId: wsId, targetUserId: "u_nope", newRole: "viewer" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await app.close();
  });

  it("remove — removes a non-owner member", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o5@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const memberId = await addMember({ workspaceId: wsId, email: "v@x.com", role: "viewer" });
    await removeMember({ workspaceId: wsId, targetUserId: memberId });
    const m = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: memberId, workspaceId: wsId } },
    });
    expect(m).toBeNull();
    await app.close();
  });

  it("remove — rejects removing the last owner", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o6@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await expect(
      removeMember({ workspaceId: wsId, targetUserId: owner.userId }),
    ).rejects.toMatchObject({ code: "last_owner" });
    await app.close();
  });

  it("MembersServiceError carries a code", () => {
    const e = new MembersServiceError("last_owner", "boom");
    expect(e.code).toBe("last_owner");
  });
});
```

- [ ] **Step 2: Run test (expect failure)**

```bash
pnpm nx run api:test -- tests/members.service.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `apps/api/src/workspaces/members.ts` (no transfer yet)**

```ts
import type { Role } from "@fina/shared";
import { prisma } from "../db.js";

export type MembersCode = "not_found" | "last_owner" | "use_transfer";

export class MembersServiceError extends Error {
  readonly code: MembersCode;
  constructor(code: MembersCode, message?: string) {
    super(message ?? code);
    this.name = "MembersServiceError";
    this.code = code;
  }
}

export type MemberView = {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  joinedAt: Date;
};

const ROLE_ORDER: Record<Role, number> = { owner: 0, editor: 1, viewer: 2 };

export async function listMembers(input: { workspaceId: string }): Promise<MemberView[]> {
  const rows = await prisma.membership.findMany({
    where: { workspaceId: input.workspaceId },
    include: { user: true },
  });
  return rows
    .map((r) => ({
      userId: r.userId,
      email: r.user.email,
      name: r.user.name,
      role: r.role as Role,
      joinedAt: r.createdAt,
    }))
    .sort((a, b) => {
      const ra = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
      return ra !== 0 ? ra : a.email.localeCompare(b.email);
    });
}

export type UpdateRoleInput = {
  workspaceId: string;
  targetUserId: string;
  newRole: Role;
};

export async function updateMemberRole(input: UpdateRoleInput): Promise<void> {
  if (input.newRole === "owner") {
    throw new MembersServiceError("use_transfer", "use transferOwner to make someone an owner");
  }
  const target = await prisma.membership.findUnique({
    where: {
      userId_workspaceId: { userId: input.targetUserId, workspaceId: input.workspaceId },
    },
  });
  if (!target) throw new MembersServiceError("not_found", "member not found");
  if (target.role === "owner") {
    // Demoting an owner: only allowed if another owner exists.
    const owners = await prisma.membership.count({
      where: { workspaceId: input.workspaceId, role: "owner" },
    });
    if (owners <= 1) {
      throw new MembersServiceError("last_owner", "cannot demote the last owner");
    }
  }
  await prisma.membership.update({
    where: {
      userId_workspaceId: { userId: input.targetUserId, workspaceId: input.workspaceId },
    },
    data: { role: input.newRole },
  });
}

export async function removeMember(input: {
  workspaceId: string;
  targetUserId: string;
}): Promise<void> {
  const target = await prisma.membership.findUnique({
    where: {
      userId_workspaceId: { userId: input.targetUserId, workspaceId: input.workspaceId },
    },
  });
  if (!target) throw new MembersServiceError("not_found", "member not found");
  if (target.role === "owner") {
    const owners = await prisma.membership.count({
      where: { workspaceId: input.workspaceId, role: "owner" },
    });
    if (owners <= 1) {
      throw new MembersServiceError("last_owner", "cannot remove the last owner");
    }
  }
  await prisma.membership.delete({
    where: {
      userId_workspaceId: { userId: input.targetUserId, workspaceId: input.workspaceId },
    },
  });
}
```

- [ ] **Step 4: Run service test (expect pass)**

```bash
pnpm nx run api:test -- tests/members.service.test.ts
```

Expected: 8/8 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workspaces/members.ts apps/api/tests/members.service.test.ts
git commit -m "feat(api): members service — list / update role / remove (last-owner invariant)"
```

---

## Task 7: `members` service — `transferOwner` (atomic)

**Files:**
- Modify: `apps/api/src/workspaces/members.ts` (append `transferOwner`)
- Modify: `apps/api/tests/members.service.test.ts` (append transfer describe block)

Owner is exactly 1 per workspace (application invariant). Transfer atomically: target → owner, caller → editor (or chosen demote role; editor is the default and the only API-exposed choice for v1).

- [ ] **Step 1: Append failing transfer tests**

Append to `apps/api/tests/members.service.test.ts`:

```ts
import { transferOwner } from "../src/workspaces/members.js";

describe("members service: transferOwner", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("happy path — atomically promotes target, demotes current owner to editor", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow@x.com", name: "OW" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const newOwnerId = await addMember({
      workspaceId: wsId,
      email: "newowner@x.com",
      role: "editor",
    });
    await transferOwner({
      workspaceId: wsId,
      currentOwnerId: owner.userId,
      newOwnerId,
    });
    const o = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: owner.userId, workspaceId: wsId } },
    });
    const n = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: newOwnerId, workspaceId: wsId } },
    });
    expect(o.role).toBe("editor");
    expect(n.role).toBe("owner");

    const owners = await prisma.membership.count({
      where: { workspaceId: wsId, role: "owner" },
    });
    expect(owners).toBe(1);
    await app.close();
  });

  it("rejects when caller is not actually the owner of the workspace", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow2@x.com", name: "OW2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const memberId = await addMember({ workspaceId: wsId, email: "m@x.com", role: "editor" });
    await expect(
      transferOwner({
        workspaceId: wsId,
        currentOwnerId: memberId, // wrong — not the owner
        newOwnerId: memberId,
      }),
    ).rejects.toMatchObject({ code: "not_owner" });
    await app.close();
  });

  it("rejects when target is not a member", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow3@x.com", name: "OW3" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await expect(
      transferOwner({
        workspaceId: wsId,
        currentOwnerId: owner.userId,
        newOwnerId: "u_nobody",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await app.close();
  });

  it("rejects when target is the same as current owner (no-op)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow4@x.com", name: "OW4" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await expect(
      transferOwner({
        workspaceId: wsId,
        currentOwnerId: owner.userId,
        newOwnerId: owner.userId,
      }),
    ).rejects.toMatchObject({ code: "same_user" });
    await app.close();
  });
});
```

Also extend the `MembersCode` type usage in tests by extending the union — already covered: the implementation will add `not_owner` and `same_user` codes (see Step 3).

- [ ] **Step 2: Run transfer tests (expect failure)**

```bash
pnpm nx run api:test -- tests/members.service.test.ts
```

Expected: 4 new FAILures.

- [ ] **Step 3: Append `transferOwner` to `apps/api/src/workspaces/members.ts`**

First, extend the `MembersCode` type (replace its declaration):

```ts
export type MembersCode =
  | "not_found"
  | "last_owner"
  | "use_transfer"
  | "not_owner"
  | "same_user";
```

Then append at the bottom of the file:

```ts
export type TransferInput = {
  workspaceId: string;
  currentOwnerId: string;
  newOwnerId: string;
};

export async function transferOwner(input: TransferInput): Promise<void> {
  if (input.currentOwnerId === input.newOwnerId) {
    throw new MembersServiceError("same_user", "cannot transfer ownership to yourself");
  }
  await prisma.$transaction(async (tx) => {
    const current = await tx.membership.findUnique({
      where: {
        userId_workspaceId: { userId: input.currentOwnerId, workspaceId: input.workspaceId },
      },
    });
    if (!current || current.role !== "owner") {
      throw new MembersServiceError("not_owner", "caller is not the owner of this workspace");
    }
    const next = await tx.membership.findUnique({
      where: {
        userId_workspaceId: { userId: input.newOwnerId, workspaceId: input.workspaceId },
      },
    });
    if (!next) {
      throw new MembersServiceError("not_found", "target user is not a member");
    }
    await tx.membership.update({
      where: { id: current.id },
      data: { role: "editor" },
    });
    await tx.membership.update({
      where: { id: next.id },
      data: { role: "owner" },
    });
  });
}
```

- [ ] **Step 4: Run transfer tests (expect pass)**

```bash
pnpm nx run api:test -- tests/members.service.test.ts
```

Expected: 12/12 PASS in this file (8 prior + 4 transfer).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workspaces/members.ts apps/api/tests/members.service.test.ts
git commit -m "feat(api): transferOwner — atomic owner role swap"
```

---

## Task 8: Invite email + `WEB_APP_URL` env

**Files:**
- Modify: `apps/api/src/env.ts` (add `WEB_APP_URL`)
- Create: `apps/api/src/email/invite.ts`
- Modify: `apps/api/.env.test` (add `WEB_APP_URL=http://localhost:3000`)
- Modify: `.env.example` (add `WEB_APP_URL`)

The email is plain text; Resend renders it. In dev (no `RESEND_API_KEY`), `sendEmail` already falls back to console.log — same path used here.

- [ ] **Step 1: Add `WEB_APP_URL` to env schema**

Edit `apps/api/src/env.ts`. After `RESEND_API_KEY`:

```ts
  WEB_APP_URL: z.string().url(),
```

- [ ] **Step 2: Add to `.env.test` and `.env.example`**

Append to `apps/api/.env.test`:

```
WEB_APP_URL=http://localhost:3000
```

In repo-root `.env.example`, add a line in the appropriate section:

```
WEB_APP_URL=http://localhost:3000
```

- [ ] **Step 3: Update existing env literals in legacy test files**

These four test files were created in Plan 1 and pass an `Env`-typed literal directly to `buildApp(env)`. After Step 1, that literal must include `WEB_APP_URL` or TypeScript will reject it. Add `WEB_APP_URL: "http://localhost:3000",` to the env block in each:

- `apps/api/tests/health.test.ts`
- `apps/api/tests/auth.session.test.ts`
- `apps/api/tests/workspaces.bootstrap.test.ts`
- `apps/api/tests/membership.test.ts`

(Tests added in Tasks 2-7 already include `WEB_APP_URL` — this step only patches Plan 1 leftovers.)

- [ ] **Step 4: Implement `apps/api/src/email/invite.ts`**

```ts
import { sendEmail } from "./send.js";

export type SendInviteEmailInput = {
  apiKey: string | undefined;
  from: string;
  to: string;
  inviterEmail: string;
  inviterName: string | null;
  workspaceName: string;
  token: string;
  webAppUrl: string;
};

export async function sendInviteEmail(input: SendInviteEmailInput): Promise<void> {
  const inviter = input.inviterName?.trim().length ? input.inviterName : input.inviterEmail;
  const link = `${input.webAppUrl.replace(/\/$/, "")}/invites/${encodeURIComponent(input.token)}`;
  const text =
    `${inviter} invited you to "${input.workspaceName}" on Fina.\n\n` +
    `Open this link to accept:\n${link}\n\n` +
    `This link expires in 7 days. If you weren't expecting this email, just ignore it.`;
  await sendEmail(input.apiKey, input.from, {
    to: input.to,
    subject: `${inviter} invited you to ${input.workspaceName}`,
    text,
  });
}
```

- [ ] **Step 5: Verify all existing tests still pass**

The env now requires `WEB_APP_URL`. Tasks 2-7 tests included it; Step 3 patched Plan 1 leftovers.

```bash
pnpm nx run api:test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/env.ts apps/api/src/email/invite.ts apps/api/.env.test .env.example apps/api/tests/health.test.ts apps/api/tests/auth.session.test.ts apps/api/tests/workspaces.bootstrap.test.ts apps/api/tests/membership.test.ts
git commit -m "feat(api): invite email + WEB_APP_URL env"
```

---

## Task 9: Routes — `routes/workspaces.ts` (members management)

**Files:**
- Modify: `apps/api/src/routes/workspaces.ts` (extend with members routes)
- Create: `apps/api/tests/members.routes.test.ts`

We extend the existing file from Task 3. Routes are thin: parse body → call service → map service errors to HTTP via a single helper.

- [ ] **Step 1: Write failing route tests**

Create `apps/api/tests/members.routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
};

describe("members routes", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("GET /workspaces/:id/members — owner sees self", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/members`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).toMatchObject({ email: "o@x.com", role: "owner" });
    await app.close();
  });

  it("GET /workspaces/:id/members — 404 when caller not member", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O2" });
    const otherWs = await prisma.workspace.create({ data: { name: "Other" } });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${otherWs.id}/members`,
      headers: { cookie: u.cookie, "x-workspace-id": otherWs.id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("PATCH /workspaces/:id/members/:userId — owner promotes viewer to editor", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@x.com", name: "O3" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m@x.com", name: "M" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "viewer" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/members/${member.userId}`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ role: "editor" }),
    });
    expect(res.statusCode).toBe(200);
    const m = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: member.userId, workspaceId: wsId } },
    });
    expect(m.role).toBe("editor");
    await app.close();
  });

  it("PATCH — 403 when caller is not owner", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4@x.com", name: "O4" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m4@x.com", name: "M4" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "editor" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/members/${owner.userId}`,
      headers: {
        cookie: member.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ role: "viewer" }),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("PATCH role=owner triggers transfer — current owner becomes editor", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o5@x.com", name: "O5" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m5@x.com", name: "M5" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "editor" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/members/${member.userId}`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ role: "owner" }),
    });
    expect(res.statusCode).toBe(200);
    const o = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: owner.userId, workspaceId: wsId } },
    });
    const n = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: member.userId, workspaceId: wsId } },
    });
    expect(o.role).toBe("editor");
    expect(n.role).toBe("owner");
    await app.close();
  });

  it("DELETE — owner removes a member", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o6@x.com", name: "O6" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m6@x.com", name: "M6" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "viewer" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/members/${member.userId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(204);
    const m = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: member.userId, workspaceId: wsId } },
    });
    expect(m).toBeNull();
    await app.close();
  });

  it("DELETE — member can leave (delete self) when not last owner", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o7@x.com", name: "O7" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m7@x.com", name: "M7" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "viewer" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/members/${member.userId}`,
      headers: { cookie: member.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("DELETE — 403 when non-owner tries to remove someone else", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o8@x.com", name: "O8" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const a = await signUpAndGetCookie(app, { email: "a8@x.com", name: "A8" });
    const b = await signUpAndGetCookie(app, { email: "b8@x.com", name: "B8" });
    await prisma.membership.create({
      data: { userId: a.userId, workspaceId: wsId, role: "editor" },
    });
    await prisma.membership.create({
      data: { userId: b.userId, workspaceId: wsId, role: "editor" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/members/${b.userId}`,
      headers: { cookie: a.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("DELETE — 409 last owner cannot leave", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o9@x.com", name: "O9" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/members/${owner.userId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("last_owner");
    await app.close();
  });
});
```

- [ ] **Step 2: Run test (expect failure)**

```bash
pnpm nx run api:test -- tests/members.routes.test.ts
```

Expected: FAIL — routes not implemented.

- [ ] **Step 3: Extend `apps/api/src/routes/workspaces.ts` with members routes**

Replace the file with:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Role } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireSession, requireWorkspaceContext } from "../auth/context.js";
import {
  listMembers,
  updateMemberRole,
  removeMember,
  transferOwner,
  MembersServiceError,
} from "../workspaces/members.js";

const PatchRoleBody = z.object({ role: z.enum(["owner", "editor", "viewer"]) });

function mapMembersError(e: unknown): { statusCode: number; code: string } {
  if (e instanceof MembersServiceError) {
    switch (e.code) {
      case "not_found":
        return { statusCode: 404, code: "not_found" };
      case "last_owner":
        return { statusCode: 409, code: "last_owner" };
      case "use_transfer":
      case "same_user":
        return { statusCode: 400, code: e.code };
      case "not_owner":
        return { statusCode: 403, code: "not_owner" };
    }
  }
  return { statusCode: 500, code: "internal" };
}

export async function workspacesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const memberships = await prisma.membership.findMany({
        where: { userId: session.userId },
        include: { workspace: true },
        orderBy: { workspace: { createdAt: "asc" } },
      });
      return {
        workspaces: memberships.map((m) => ({
          id: m.workspace.id,
          name: m.workspace.name,
          role: m.role,
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get("/workspaces/:id/members", async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      // Path id must match header to avoid confused-deputy; we trust the header context.
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const members = await listMembers({ workspaceId: ctx.membership.workspaceId });
      return { members };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.patch("/workspaces/:id/members/:userId", async (req, reply) => {
    const params = req.params as { id: string; userId: string };
    const parsed = PatchRoleBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const newRole = parsed.data.role as Role;
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      if (newRole === "owner") {
        await transferOwner({
          workspaceId: ctx.membership.workspaceId,
          currentOwnerId: ctx.session.userId,
          newOwnerId: params.userId,
        });
      } else {
        await updateMemberRole({
          workspaceId: ctx.membership.workspaceId,
          targetUserId: params.userId,
          newRole,
        });
      }
      return reply.code(200).send({ ok: true });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapMembersError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });

  app.delete("/workspaces/:id/members/:userId", async (req, reply) => {
    const params = req.params as { id: string; userId: string };
    try {
      const session = await requireSession(req, app);
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const isSelf = params.userId === session.userId;
      if (!isSelf && ctx.membership.role !== "owner") {
        return reply.code(403).send({ error: "insufficient_role" });
      }
      await removeMember({
        workspaceId: ctx.membership.workspaceId,
        targetUserId: params.userId,
      });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapMembersError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });
}
```

- [ ] **Step 4: Run all member route tests (expect pass)**

```bash
pnpm nx run api:test -- tests/members.routes.test.ts tests/workspaces.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/workspaces.ts apps/api/tests/members.routes.test.ts
git commit -m "feat(api): /workspaces/:id/members routes (list/patch/delete + transfer)"
```

---

## Task 10: Routes — `routes/invites.ts` (workspace-scoped + by-token)

**Files:**
- Create: `apps/api/src/routes/invites.ts`
- Modify: `apps/api/src/server.ts` (register)
- Create: `apps/api/tests/invites.routes.test.ts`

The accept route is the most security-sensitive: it must verify the session email matches the invite email.

- [ ] **Step 1: Write failing route tests**

Create `apps/api/tests/invites.routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";

vi.mock("../src/email/invite.js", async () => {
  const sent: unknown[] = [];
  return {
    sendInviteEmail: vi.fn(async (input: unknown) => {
      sent.push(input);
    }),
    __sent: sent,
  };
});
import * as inviteEmailModule from "../src/email/invite.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
};

describe("invites routes", () => {
  beforeEach(async () => {
    await truncateAll();
    (inviteEmailModule as unknown as { __sent: unknown[] }).__sent.length = 0;
  });
  afterAll(async () => {
    await disconnect();
  });

  it("POST /workspaces/:id/invites — owner creates + email is sent", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "Guest@x.com", role: "editor" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.invite).toMatchObject({ invitedEmail: "guest@x.com", invitedRole: "editor" });
    expect(typeof body.invite.id).toBe("string");

    expect(inviteEmailModule.sendInviteEmail).toHaveBeenCalledTimes(1);
    const sentInput = (inviteEmailModule.sendInviteEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sentInput).toMatchObject({ to: "guest@x.com", workspaceName: "O's workspace" });
    await app.close();
  });

  it("POST — 403 when non-owner attempts", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m2@x.com", name: "M2" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "editor" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: member.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "g@x.com", role: "viewer" }),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("POST — 409 duplicate invite", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@x.com", name: "O3" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const headers = {
      cookie: owner.cookie,
      "x-workspace-id": wsId,
      "content-type": "application/json",
    };
    const first = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers,
      payload: JSON.stringify({ email: "g3@x.com", role: "viewer" }),
    });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers,
      payload: JSON.stringify({ email: "g3@x.com", role: "editor" }),
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("duplicate_invite");
    await app.close();
  });

  it("GET /workspaces/:id/invites — owner sees pending list", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4@x.com", name: "O4" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "p@x.com", role: "viewer" }),
    });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/invites`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().invites).toHaveLength(1);
    await app.close();
  });

  it("DELETE /workspaces/:id/invites/:inviteId — owner revokes", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o5@x.com", name: "O5" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "p5@x.com", role: "viewer" }),
    });
    const inviteId = created.json().invite.id;
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/invites/${inviteId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(204);
    const reread = await prisma.invite.findUniqueOrThrow({ where: { id: inviteId } });
    expect(reread.status).toBe("revoked");
    await app.close();
  });

  it("GET /invites/by-token/:token — returns preview when authenticated and email matches", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o6@x.com", name: "O6" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "guest6@x.com", role: "editor" }),
    });
    const inv = await prisma.invite.findUniqueOrThrow({ where: { id: created.json().invite.id } });
    const guest = await signUpAndGetCookie(app, { email: "guest6@x.com", name: "G6" });

    const res = await app.inject({
      method: "GET",
      url: `/invites/by-token/${inv.token}`,
      headers: { cookie: guest.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      status: "pending",
      workspaceName: "O6's workspace",
      invitedRole: "editor",
      emailMatch: true,
    });
    await app.close();
  });

  it("GET — emailMatch=false when authenticated as different user", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o7@x.com", name: "O7" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "expected7@x.com", role: "viewer" }),
    });
    const inv = await prisma.invite.findUniqueOrThrow({ where: { id: created.json().invite.id } });
    const wrong = await signUpAndGetCookie(app, { email: "wrong@x.com", name: "W" });

    const res = await app.inject({
      method: "GET",
      url: `/invites/by-token/${inv.token}`,
      headers: { cookie: wrong.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().emailMatch).toBe(false);
    await app.close();
  });

  it("GET — 404 for unknown token", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "u@x.com", name: "U" });
    const res = await app.inject({
      method: "GET",
      url: "/invites/by-token/not-a-real-token",
      headers: { cookie: u.cookie },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("POST /invites/by-token/:token/accept — happy path creates membership", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o8@x.com", name: "O8" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "guest8@x.com", role: "editor" }),
    });
    const inv = await prisma.invite.findUniqueOrThrow({ where: { id: created.json().invite.id } });
    const guest = await signUpAndGetCookie(app, { email: "guest8@x.com", name: "G8" });

    const res = await app.inject({
      method: "POST",
      url: `/invites/by-token/${inv.token}/accept`,
      headers: { cookie: guest.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ workspaceId: wsId, role: "editor" });
    const m = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: guest.userId, workspaceId: wsId } },
    });
    expect(m.role).toBe("editor");
    await app.close();
  });

  it("POST accept — 403 wrong_email when session email differs", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o9@x.com", name: "O9" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "expected9@x.com", role: "viewer" }),
    });
    const inv = await prisma.invite.findUniqueOrThrow({ where: { id: created.json().invite.id } });
    const wrong = await signUpAndGetCookie(app, { email: "wrong9@x.com", name: "W" });

    const res = await app.inject({
      method: "POST",
      url: `/invites/by-token/${inv.token}/accept`,
      headers: { cookie: wrong.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("wrong_email");
    await app.close();
  });

  it("POST accept — 401 unauthenticated", async () => {
    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: "/invites/by-token/anytoken/accept",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test (expect failure)**

```bash
pnpm nx run api:test -- tests/invites.routes.test.ts
```

Expected: FAIL — routes not implemented.

- [ ] **Step 3: Implement `apps/api/src/routes/invites.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, requireSession, requireWorkspaceContext } from "../auth/context.js";
import {
  createInvite,
  listInvites,
  revokeInvite,
  getInviteByToken,
  acceptInviteByToken,
  InviteServiceError,
} from "../workspaces/invites.js";
import { sendInviteEmail } from "../email/invite.js";

const CreateBody = z.object({
  email: z.string().email(),
  role: z.enum(["editor", "viewer"]),
});

function mapInviteError(e: unknown): { statusCode: number; code: string } {
  if (e instanceof InviteServiceError) {
    switch (e.code) {
      case "not_found":
        return { statusCode: 404, code: "not_found" };
      case "already_member":
      case "duplicate_invite":
        return { statusCode: 409, code: e.code };
      case "invalid_role":
        return { statusCode: 400, code: "invalid_role" };
      case "expired":
      case "revoked":
      case "consumed":
      case "wrong_email":
        return { statusCode: 403, code: e.code };
    }
  }
  return { statusCode: 500, code: "internal" };
}

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:id/invites", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      // Reject inviting yourself by email — `createInvite` also rejects via already_member,
      // but a clearer error helps clients.
      if (parsed.data.email.toLowerCase() === ctx.session.email.toLowerCase()) {
        return reply.code(409).send({ error: "already_member" });
      }
      const invite = await createInvite({
        workspaceId: ctx.membership.workspaceId,
        invitedById: ctx.session.userId,
        invitedEmail: parsed.data.email,
        invitedRole: parsed.data.role,
      });
      const ws = await prisma.workspace.findUniqueOrThrow({
        where: { id: ctx.membership.workspaceId },
      });
      const inviter = await prisma.user.findUniqueOrThrow({ where: { id: ctx.session.userId } });
      await sendInviteEmail({
        apiKey: app.fina.env.RESEND_API_KEY,
        from: app.fina.env.EMAIL_FROM,
        to: invite.invitedEmail,
        inviterEmail: inviter.email,
        inviterName: inviter.name,
        workspaceName: ws.name,
        token: invite.token,
        webAppUrl: app.fina.env.WEB_APP_URL,
      });
      return reply.code(201).send({
        invite: {
          id: invite.id,
          invitedEmail: invite.invitedEmail,
          invitedRole: invite.invitedRole,
          expiresAt: invite.expiresAt.toISOString(),
        },
      });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapInviteError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });

  app.get("/workspaces/:id/invites", async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const invites = await listInvites({ workspaceId: ctx.membership.workspaceId });
      return {
        invites: invites.map((i) => ({
          id: i.id,
          invitedEmail: i.invitedEmail,
          invitedRole: i.invitedRole,
          expiresAt: i.expiresAt.toISOString(),
          createdAt: i.createdAt.toISOString(),
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.delete("/workspaces/:id/invites/:inviteId", async (req, reply) => {
    const params = req.params as { id: string; inviteId: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      await revokeInvite({
        workspaceId: ctx.membership.workspaceId,
        inviteId: params.inviteId,
      });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapInviteError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });

  app.get("/invites/by-token/:token", async (req, reply) => {
    const params = req.params as { token: string };
    try {
      const session = await requireSession(req, app);
      const view = await getInviteByToken(params.token);
      if (!view) return reply.code(404).send({ error: "not_found" });
      return {
        status: view.status,
        workspaceName: view.workspaceName,
        inviterEmail: view.inviterEmail,
        invitedEmail: view.invitedEmail,
        invitedRole: view.invitedRole,
        expiresAt: view.expiresAt.toISOString(),
        emailMatch: session.email.toLowerCase() === view.invitedEmail,
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.post("/invites/by-token/:token/accept", async (req, reply) => {
    const params = req.params as { token: string };
    try {
      const session = await requireSession(req, app);
      const result = await acceptInviteByToken({
        token: params.token,
        acceptingUserId: session.userId,
        acceptingEmail: session.email,
      });
      return reply.code(200).send({ workspaceId: result.workspaceId, role: result.role });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapInviteError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });
}
```

- [ ] **Step 4: Register the new route in `server.ts`**

Edit `apps/api/src/server.ts`:

```ts
import { inviteRoutes } from "./routes/invites.js";
```

After `await app.register(workspacesRoutes);`:

```ts
  await app.register(inviteRoutes);
```

- [ ] **Step 5: Run all API tests**

```bash
pnpm nx run api:test
```

Expected: every previous test still PASSes + 11 new invite-route tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/invites.ts apps/api/src/server.ts apps/api/tests/invites.routes.test.ts
git commit -m "feat(api): invites routes (workspace-scoped CRUD + by-token accept)"
```

---

## Task 11: Mobile — `X-Workspace-Id` plumbing + home page consumes `/me` + `/workspaces`

**Files:**
- Create: `apps/mobile/src/workspace/active.ts`
- Modify: `apps/mobile/src/api/client.ts`
- Modify: `apps/mobile/app/(tabs)/index.tsx`

Mobile gets no new UI — just learns to send the header so existing `/me` consumer keeps working, and renders workspace info from `/workspaces` (still a list of 1 for current users). Switcher / member screens are explicitly out of scope.

- [ ] **Step 1: Create active-workspace store**

`apps/mobile/src/workspace/active.ts`:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "fina.activeWorkspaceId";

let cached: string | null = null;

export async function getActiveWorkspaceId(): Promise<string | null> {
  if (cached) return cached;
  const v = await AsyncStorage.getItem(KEY);
  cached = v;
  return v;
}

export async function setActiveWorkspaceId(id: string): Promise<void> {
  cached = id;
  await AsyncStorage.setItem(KEY, id);
}

export function clearActiveWorkspaceCache(): void {
  cached = null;
}
```

If `@react-native-async-storage/async-storage` isn't already a dependency, add it:

```bash
pnpm --filter @fina/mobile add @react-native-async-storage/async-storage@1.23.1
```

- [ ] **Step 2: Update API client to attach the header**

`apps/mobile/src/api/client.ts`:

```ts
import { authClient } from "../auth/client";
import { env } from "../env";
import { getActiveWorkspaceId } from "../workspace/active";

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cookie = (authClient as { getCookie?: () => string }).getCookie?.() ?? "";
  const wsId = await getActiveWorkspaceId();
  const res = await fetch(`${env.EXPO_PUBLIC_API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(wsId ? { "x-workspace-id": wsId } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function bootstrapActiveWorkspace(): Promise<string | null> {
  const existing = await getActiveWorkspaceId();
  if (existing) return existing;
  const data = await apiFetch<{ workspaces: { id: string; name: string; role: string }[] }>(
    "/workspaces",
  );
  const first = data.workspaces[0]?.id ?? null;
  if (first) {
    const { setActiveWorkspaceId } = await import("../workspace/active");
    await setActiveWorkspaceId(first);
  }
  return first;
}
```

- [ ] **Step 3: Update home page to consume the new shape**

Replace `apps/mobile/app/(tabs)/index.tsx`:

```tsx
import { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import { useSession, signOut } from "../../src/auth/client";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";

type Me = {
  user: { id: string; email: string; tz: string; locale: string };
  tier: "free" | "lite" | "pro";
  trial: { active: boolean; endsAt: string | null };
};

type Workspace = { id: string; name: string; role: string };

export default function Home() {
  const { data: session } = useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await bootstrapActiveWorkspace();
        const [meData, wsData] = await Promise.all([
          apiFetch<Me>("/me"),
          apiFetch<{ workspaces: Workspace[] }>("/workspaces"),
        ]);
        if (cancelled) return;
        setMe(meData);
        setWorkspace(wsData.workspaces[0] ?? null);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={styles.root}>
      <Text style={styles.h1}>
        Welcome{session?.user?.name ? `, ${session.user.name}` : ""}
      </Text>
      {!me && !err && <ActivityIndicator />}
      {err && <Text style={styles.err}>Could not reach API: {err}</Text>}
      {me && workspace && (
        <View style={styles.card}>
          <Text style={styles.label}>Workspace</Text>
          <Text style={styles.value}>{workspace.name}</Text>
          <Text style={styles.label}>Role</Text>
          <Text style={styles.value}>{workspace.role}</Text>
          <Text style={styles.label}>Tier</Text>
          <Text style={styles.value}>{me.tier.toUpperCase()}</Text>
          {me.trial.active && (
            <Text style={styles.trial}>
              Pro trial active — ends {new Date(me.trial.endsAt!).toLocaleDateString()}
            </Text>
          )}
        </View>
      )}
      <Pressable style={styles.btn} onPress={() => signOut()}>
        <Text style={styles.btnText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, backgroundColor: "#fff", justifyContent: "center" },
  h1: { fontSize: 28, fontWeight: "700", marginBottom: 24 },
  card: { borderWidth: 1, borderColor: "#eee", borderRadius: 12, padding: 16, marginBottom: 24 },
  label: { fontSize: 12, opacity: 0.5, marginTop: 8 },
  value: { fontSize: 18, fontWeight: "600" },
  trial: { fontSize: 12, marginTop: 12, color: "#0a7" },
  err: { color: "#c00", marginBottom: 16 },
  btn: {
    padding: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ddd",
    alignItems: "center",
  },
  btnText: { fontSize: 16 },
});
```

- [ ] **Step 4: Manual verification**

```bash
docker compose up -d
pnpm nx run-many -t dev --projects=api,mobile --parallel=2
```

In the Expo dev client / iOS simulator:
1. Sign up with a new email + password.
2. After redirect to home, verify: workspace name = "<Name>'s workspace", role = "owner", tier = "PRO", trial line visible.
3. Background the app + reopen — same data still loads (proves AsyncStorage persistence).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/workspace apps/mobile/src/api/client.ts apps/mobile/app/'(tabs)'/index.tsx apps/mobile/package.json pnpm-lock.yaml
git commit -m "feat(mobile): X-Workspace-Id plumbing; consume /me + /workspaces"
```

---

## Task 12: Web — `lib/api.ts` + active-workspace cookie helpers

**Files:**
- Create: `apps/web/src/lib/active-workspace.ts`
- Create: `apps/web/src/lib/api.ts`

Cookie name: `fina-active-workspace`. Not HttpOnly (client JS reads it to attach the header). Same-site Lax. 365-day expiry.

- [ ] **Step 1: Create cookie helpers**

`apps/web/src/lib/active-workspace.ts`:

```ts
const COOKIE = "fina-active-workspace";
const ONE_YEAR = 60 * 60 * 24 * 365;

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split("=").slice(1).join("=")) : null;
}

export function getActiveWorkspaceId(): string | null {
  return readCookie(COOKIE);
}

export function setActiveWorkspaceId(id: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax`;
}

export function clearActiveWorkspaceId(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}
```

- [ ] **Step 2: Create the API fetch wrapper**

`apps/web/src/lib/api.ts`:

```ts
import { env } from "../env";
import { getActiveWorkspaceId } from "./active-workspace";

export type ApiError = { status: number; code: string; message?: string };

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const wsId = getActiveWorkspaceId();
  const res = await fetch(`${env.NEXT_PUBLIC_API_URL}${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...(wsId ? { "x-workspace-id": wsId } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    let body: { error?: string; message?: string } = {};
    try {
      body = await res.json();
    } catch {
      // ignore — body might not be json
    }
    const err: ApiError = {
      status: res.status,
      code: body.error ?? `http_${res.status}`,
      message: body.message,
    };
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function bootstrapActiveWorkspace(): Promise<string | null> {
  const existing = getActiveWorkspaceId();
  if (existing) return existing;
  const data = await apiFetch<{ workspaces: { id: string; name: string; role: string }[] }>(
    "/workspaces",
  );
  const first = data.workspaces[0]?.id ?? null;
  if (first) {
    const { setActiveWorkspaceId } = await import("./active-workspace");
    setActiveWorkspaceId(first);
  }
  return first;
}
```

- [ ] **Step 3: Verify build**

```bash
pnpm nx run web:typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib
git commit -m "feat(web): apiFetch wrapper + active-workspace cookie helpers"
```

---

## Task 13: Web — `/invites/[token]` accept page

**Files:**
- Create: `apps/web/src/app/invites/[token]/page.tsx`
- Create: `apps/web/src/app/invites/[token]/_accept-button.tsx`
- Modify: `apps/web/middleware.ts` (DO NOT protect `/invites/*` — accept page must be reachable while signed-out so we can route to sign-in)

Page is a client component (it uses session + window APIs). It fetches the invite preview, shows status, and either renders the accept button or sign-in/sign-out hints.

- [ ] **Step 1: Implement the accept button (client component)**

`apps/web/src/app/invites/[token]/_accept-button.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../../../lib/api";
import { setActiveWorkspaceId } from "../../../lib/active-workspace";

export function AcceptButton({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setErr(null);
    try {
      const result = await apiFetch<{ workspaceId: string; role: string }>(
        `/invites/by-token/${encodeURIComponent(token)}/accept`,
        { method: "POST" },
      );
      setActiveWorkspaceId(result.workspaceId);
      router.replace("/home");
    } catch (e) {
      const code = (e as { code?: string }).code ?? "error";
      setErr(`Could not accept: ${code}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        onClick={accept}
        disabled={busy}
        style={{
          padding: "12px 24px",
          background: "#111",
          color: "#fff",
          borderRadius: 8,
          border: "none",
          cursor: busy ? "default" : "pointer",
        }}
      >
        {busy ? "Joining..." : "Accept invite"}
      </button>
      {err && <p style={{ color: "#c00", marginTop: 12 }}>{err}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Implement the page**

`apps/web/src/app/invites/[token]/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession, signOut } from "../../../auth/client";
import { apiFetch } from "../../../lib/api";
import { AcceptButton } from "./_accept-button";

type Preview = {
  status: "pending" | "accepted" | "revoked" | "expired";
  workspaceName: string;
  inviterEmail: string;
  invitedEmail: string;
  invitedRole: "editor" | "viewer";
  emailMatch: boolean;
};

export default function InvitePage({ params }: { params: { token: string } }) {
  const { data: session, isPending: sessionLoading } = useSession();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    if (sessionLoading) return;
    if (!session?.user) {
      setLoadErr(null);
      setPreview(null);
      return;
    }
    apiFetch<Preview>(`/invites/by-token/${encodeURIComponent(params.token)}`)
      .then(setPreview)
      .catch((e) => setLoadErr((e as { code?: string }).code ?? "load_error"));
  }, [session, sessionLoading, params.token]);

  return (
    <main style={{ maxWidth: 480, margin: "64px auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 28, marginBottom: 16 }}>You've been invited to Fina</h1>

      {sessionLoading && <p>Loading…</p>}

      {!sessionLoading && !session?.user && (
        <div>
          <p style={{ marginBottom: 16 }}>Sign in or create an account to view this invite.</p>
          <Link
            href={`/sign-in?from=${encodeURIComponent(`/invites/${params.token}`)}`}
            style={{
              display: "inline-block",
              padding: "12px 24px",
              background: "#111",
              color: "#fff",
              borderRadius: 8,
              textDecoration: "none",
            }}
          >
            Sign in / Sign up
          </Link>
        </div>
      )}

      {!sessionLoading && session?.user && loadErr === "not_found" && (
        <p style={{ color: "#c00" }}>This invite link is invalid or has been deleted.</p>
      )}

      {!sessionLoading && session?.user && loadErr && loadErr !== "not_found" && (
        <p style={{ color: "#c00" }}>Could not load invite ({loadErr}).</p>
      )}

      {!sessionLoading && session?.user && preview && (
        <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 14, opacity: 0.6, marginBottom: 8 }}>From</div>
          <div style={{ fontSize: 16, marginBottom: 12 }}>{preview.inviterEmail}</div>
          <div style={{ fontSize: 14, opacity: 0.6, marginBottom: 8 }}>Workspace</div>
          <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>
            {preview.workspaceName}
          </div>
          <div style={{ fontSize: 14, opacity: 0.6, marginBottom: 8 }}>You'd join as</div>
          <div style={{ fontSize: 16, marginBottom: 16 }}>{preview.invitedRole}</div>

          {preview.status !== "pending" && (
            <p style={{ color: "#c00" }}>This invite is {preview.status}.</p>
          )}

          {preview.status === "pending" && !preview.emailMatch && (
            <div>
              <p style={{ marginBottom: 12 }}>
                This invite is for <strong>{preview.invitedEmail}</strong>. You're signed in as{" "}
                <strong>{session.user.email}</strong>.
              </p>
              <button
                onClick={() => signOut()}
                style={{
                  padding: "12px 24px",
                  background: "#fff",
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  cursor: "pointer",
                }}
              >
                Sign out and try again
              </button>
            </div>
          )}

          {preview.status === "pending" && preview.emailMatch && (
            <AcceptButton token={params.token} />
          )}
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 3: Confirm middleware does not protect `/invites/*`**

Read `apps/web/middleware.ts` — current `PROTECTED_PREFIXES = ["/home"]`. `/invites` is intentionally NOT in this list (a logged-out user must reach the page so they can be told to sign in). No change yet.

- [ ] **Step 4: Manual verification**

```bash
docker compose up -d
pnpm nx run-many -t dev --projects=api,web --parallel=2
```

1. Sign up `inviter@x.com` on the web app.
2. (Will work once Task 14 is done — for now verify the page itself.) From a separate terminal, create an invite directly:
   ```bash
   docker compose exec postgres psql -U fina -d fina -c \
     "SELECT id, name FROM workspaces;"  # grab the ws id
   curl -i -X POST http://localhost:4000/workspaces/<wsId>/invites \
     -H "x-workspace-id: <wsId>" -H "content-type: application/json" \
     --cookie "<copy from browser DevTools for inviter@x.com>" \
     -d '{"email":"guest@x.com","role":"editor"}'
   # console output (dev) will show the magic link with token
   ```
3. Open the printed `/invites/<token>` URL in an incognito window:
   - Should see "Sign in or create an account…" with link to `/sign-in?from=...`.
4. Sign up as `guest@x.com` from the sign-in page → after redirect to `/home`, navigate back to the invite link manually.
5. See the invite preview card → click "Accept invite" → land on `/home` and see the new workspace.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/invites
git commit -m "feat(web): /invites/[token] accept page"
```

---

## Task 14: Web — `/settings/workspace` page (members + invites)

**Files:**
- Create: `apps/web/src/app/(app)/settings/workspace/page.tsx`
- Create: `apps/web/src/app/(app)/settings/workspace/_components/members-list.tsx`
- Create: `apps/web/src/app/(app)/settings/workspace/_components/invite-form.tsx`
- Create: `apps/web/src/app/(app)/settings/workspace/_components/pending-invites.tsx`
- Modify: `apps/web/middleware.ts` (also protect `/settings`)

The page is a client component that fetches `/workspaces`, picks the active one (by cookie or first), then renders three sub-components. We don't add a TanStack Query layer — keep it raw `useState/useEffect` like `/home`. Plan 2 doesn't justify the dep yet.

- [ ] **Step 1: Update middleware to protect `/settings`**

Edit `apps/web/middleware.ts`:

```ts
const PROTECTED_PREFIXES = ["/home", "/settings"];
```

(Leave the rest as-is.)

- [ ] **Step 2: Implement `members-list.tsx`**

`apps/web/src/app/(app)/settings/workspace/_components/members-list.tsx`:

```tsx
"use client";

import { useState } from "react";
import { apiFetch } from "../../../../../lib/api";

type Member = {
  userId: string;
  email: string;
  name: string | null;
  role: "owner" | "editor" | "viewer";
};

export function MembersList({
  members,
  workspaceId,
  currentUserId,
  isOwner,
  onChange,
}: {
  members: Member[];
  workspaceId: string;
  currentUserId: string;
  isOwner: boolean;
  onChange: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function patchRole(userId: string, role: Member["role"]) {
    setBusyId(userId);
    setErr(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      onChange();
    } catch (e) {
      setErr((e as { code?: string }).code ?? "error");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(userId: string) {
    const isSelf = userId === currentUserId;
    const msg = isSelf ? "Leave this workspace?" : "Remove this member?";
    if (!window.confirm(msg)) return;
    setBusyId(userId);
    setErr(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/members/${userId}`, { method: "DELETE" });
      onChange();
    } catch (e) {
      setErr((e as { code?: string }).code ?? "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, marginBottom: 12 }}>Members</h2>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>
            <th style={{ padding: 8 }}>Email</th>
            <th style={{ padding: 8 }}>Role</th>
            <th style={{ padding: 8 }}></th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const isSelf = m.userId === currentUserId;
            return (
              <tr key={m.userId} style={{ borderBottom: "1px solid #f5f5f5" }}>
                <td style={{ padding: 8 }}>
                  {m.email}
                  {isSelf && <span style={{ opacity: 0.5 }}> (you)</span>}
                </td>
                <td style={{ padding: 8 }}>
                  {isOwner && !isSelf ? (
                    <select
                      value={m.role}
                      disabled={busyId === m.userId}
                      onChange={(e) => patchRole(m.userId, e.target.value as Member["role"])}
                    >
                      <option value="owner">owner (transfer)</option>
                      <option value="editor">editor</option>
                      <option value="viewer">viewer</option>
                    </select>
                  ) : (
                    m.role
                  )}
                </td>
                <td style={{ padding: 8, textAlign: "right" }}>
                  {(isOwner || isSelf) && (
                    <button
                      onClick={() => remove(m.userId)}
                      disabled={busyId === m.userId}
                      style={{
                        padding: "6px 12px",
                        background: "#fff",
                        border: "1px solid #ddd",
                        borderRadius: 6,
                        cursor: "pointer",
                      }}
                    >
                      {isSelf ? "Leave" : "Remove"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {err && <p style={{ color: "#c00", marginTop: 8 }}>Error: {err}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Implement `invite-form.tsx`**

`apps/web/src/app/(app)/settings/workspace/_components/invite-form.tsx`:

```tsx
"use client";

import { useState } from "react";
import { apiFetch } from "../../../../../lib/api";

export function InviteForm({
  workspaceId,
  onCreated,
}: {
  workspaceId: string;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/invites`, {
        method: "POST",
        body: JSON.stringify({ email, role }),
      });
      setEmail("");
      setOk(`Invite sent to ${email}`);
      onCreated();
    } catch (e) {
      setErr((e as { code?: string }).code ?? "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <input
        type="email"
        required
        placeholder="email@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{ padding: 8, border: "1px solid #ddd", borderRadius: 6, flex: 1 }}
      />
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as "editor" | "viewer")}
        style={{ padding: 8, border: "1px solid #ddd", borderRadius: 6 }}
      >
        <option value="editor">editor</option>
        <option value="viewer">viewer</option>
      </select>
      <button
        type="submit"
        disabled={busy || !email}
        style={{
          padding: "8px 16px",
          background: "#111",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        {busy ? "..." : "Invite"}
      </button>
      {err && <span style={{ color: "#c00", marginLeft: 8 }}>{err}</span>}
      {ok && <span style={{ color: "#0a7", marginLeft: 8 }}>{ok}</span>}
    </form>
  );
}
```

- [ ] **Step 4: Implement `pending-invites.tsx`**

`apps/web/src/app/(app)/settings/workspace/_components/pending-invites.tsx`:

```tsx
"use client";

import { useState } from "react";
import { apiFetch } from "../../../../../lib/api";

type Invite = {
  id: string;
  invitedEmail: string;
  invitedRole: "editor" | "viewer";
  expiresAt: string;
  createdAt: string;
};

export function PendingInvites({
  invites,
  workspaceId,
  onChange,
}: {
  invites: Invite[];
  workspaceId: string;
  onChange: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function revoke(inviteId: string) {
    if (!window.confirm("Revoke this invite?")) return;
    setBusyId(inviteId);
    try {
      await apiFetch(`/workspaces/${workspaceId}/invites/${inviteId}`, { method: "DELETE" });
      onChange();
    } finally {
      setBusyId(null);
    }
  }

  if (invites.length === 0) {
    return <p style={{ opacity: 0.6, marginTop: 8 }}>No pending invites.</p>;
  }
  return (
    <ul style={{ listStyle: "none", padding: 0 }}>
      {invites.map((i) => (
        <li
          key={i.id}
          style={{
            padding: 8,
            borderBottom: "1px solid #f5f5f5",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>
            {i.invitedEmail} <span style={{ opacity: 0.6 }}>({i.invitedRole})</span>
          </span>
          <button
            onClick={() => revoke(i.id)}
            disabled={busyId === i.id}
            style={{
              padding: "4px 10px",
              background: "#fff",
              border: "1px solid #ddd",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Revoke
          </button>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Implement the page**

`apps/web/src/app/(app)/settings/workspace/page.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "../../../../auth/client";
import { apiFetch, bootstrapActiveWorkspace } from "../../../../lib/api";
import { getActiveWorkspaceId } from "../../../../lib/active-workspace";
import { MembersList } from "./_components/members-list";
import { InviteForm } from "./_components/invite-form";
import { PendingInvites } from "./_components/pending-invites";

type Member = {
  userId: string;
  email: string;
  name: string | null;
  role: "owner" | "editor" | "viewer";
};
type Invite = {
  id: string;
  invitedEmail: string;
  invitedRole: "editor" | "viewer";
  expiresAt: string;
  createdAt: string;
};

export default function WorkspaceSettingsPage() {
  const { data: session } = useSession();
  const [wsId, setWsId] = useState<string | null>(null);
  const [wsName, setWsName] = useState<string>("");
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const id = (await bootstrapActiveWorkspace()) ?? getActiveWorkspaceId();
      if (!id) {
        setErr("no_workspace");
        return;
      }
      setWsId(id);
      const [{ workspaces }, { members }] = await Promise.all([
        apiFetch<{ workspaces: { id: string; name: string }[] }>("/workspaces"),
        apiFetch<{ members: Member[] }>(`/workspaces/${id}/members`),
      ]);
      const current = workspaces.find((w) => w.id === id);
      setWsName(current?.name ?? "");
      setMembers(members);
      const myMembership = members.find((m) => m.userId === session?.user?.id);
      if (myMembership?.role === "owner") {
        const { invites } = await apiFetch<{ invites: Invite[] }>(`/workspaces/${id}/invites`);
        setInvites(invites);
      } else {
        setInvites([]);
      }
    } catch (e) {
      setErr((e as { code?: string }).code ?? "error");
    }
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session?.user) return;
    load();
  }, [session?.user, load]);

  if (!session?.user) return <main style={{ padding: 32 }}>Loading…</main>;
  if (err) return <main style={{ padding: 32 }}>Error: {err}</main>;
  if (!wsId) return <main style={{ padding: 32 }}>Loading workspace…</main>;

  const me = members.find((m) => m.userId === session.user.id);
  const isOwner = me?.role === "owner";

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 32, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Workspace settings</h1>
      <p style={{ opacity: 0.6, marginBottom: 24 }}>{wsName}</p>

      <MembersList
        members={members}
        workspaceId={wsId}
        currentUserId={session.user.id}
        isOwner={isOwner}
        onChange={load}
      />

      {isOwner && (
        <section style={{ marginTop: 32 }}>
          <h2 style={{ fontSize: 18, marginBottom: 12 }}>Invite a member</h2>
          <InviteForm workspaceId={wsId} onCreated={load} />
          <h3 style={{ fontSize: 16, marginTop: 24, marginBottom: 8 }}>Pending invites</h3>
          <PendingInvites invites={invites} workspaceId={wsId} onChange={load} />
        </section>
      )}
    </main>
  );
}
```

- [ ] **Step 6: Manual verification**

With both `api` and `web` dev servers running:

1. Sign up as `owner@x.com` on `/sign-in`.
2. Navigate to `/settings/workspace` → see one member (you) as owner.
3. Use the invite form to invite `guest@x.com` as editor → see "Invite sent" + the row appears in pending invites.
4. Watch the api dev server console for the `[dev email]` log line containing the `/invites/<token>` URL.
5. Open that URL in an incognito window → sign up as `guest@x.com` → return to invite link → accept → redirected to `/home`.
6. Back as `owner@x.com`, refresh `/settings/workspace` → guest now appears in members list, pending list is empty.
7. As owner, change guest's role → editor/viewer toggle works.
8. As owner, transfer ownership: choose "owner (transfer)" on guest's row → confirm → guest is now owner, you are now editor.
9. As (now-)editor owner@x.com, try the role dropdown — it doesn't render (you're not owner).
10. As editor, click "Leave" → workspace removed from your list (`/workspaces` only returns the personal one now).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/'(app)'/settings apps/web/middleware.ts
git commit -m "feat(web): /settings/workspace — members, role transitions, invites, transfer"
```

---

## Task 15: Web — `(app)` layout + workspace switcher + home page update

**Files:**
- Create: `apps/web/src/app/(app)/layout.tsx`
- Create: `apps/web/src/app/(app)/_components/workspace-switcher.tsx`
- Modify: `apps/web/src/app/(app)/home/page.tsx` (consume refactored `/me` + `/workspaces`)

The switcher renders only when the user has ≥2 workspaces. It writes the cookie + reloads the page (cheapest, correct invalidation — full data re-fetch).

- [ ] **Step 1: Implement the switcher**

`apps/web/src/app/(app)/_components/workspace-switcher.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../../lib/api";
import {
  getActiveWorkspaceId,
  setActiveWorkspaceId,
} from "../../../lib/active-workspace";

type Workspace = { id: string; name: string; role: string };

export function WorkspaceSwitcher() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ workspaces: Workspace[] }>("/workspaces")
      .then((d) => {
        setWorkspaces(d.workspaces);
        setActiveId(getActiveWorkspaceId() ?? d.workspaces[0]?.id ?? null);
      })
      .catch(() => {
        // ignore — header just won't render
      });
  }, []);

  if (workspaces.length < 2) {
    const single = workspaces[0];
    return (
      <div style={{ fontSize: 14 }}>
        {single ? (
          <>
            <span style={{ opacity: 0.6 }}>Workspace:</span>{" "}
            <strong>{single.name}</strong>{" "}
            <span style={{ opacity: 0.6 }}>({single.role})</span>
          </>
        ) : null}
      </div>
    );
  }

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    setActiveWorkspaceId(id);
    setActiveId(id);
    // Full reload re-fetches every page consumer with the new header.
    window.location.reload();
  }

  return (
    <select
      value={activeId ?? ""}
      onChange={onChange}
      style={{ padding: 6, border: "1px solid #ddd", borderRadius: 6 }}
    >
      {workspaces.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name} ({w.role})
        </option>
      ))}
    </select>
  );
}
```

- [ ] **Step 2: Implement the layout**

`apps/web/src/app/(app)/layout.tsx`:

```tsx
import Link from "next/link";
import { WorkspaceSwitcher } from "./_components/workspace-switcher";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 24px",
          borderBottom: "1px solid #eee",
          fontFamily: "system-ui",
        }}
      >
        <nav style={{ display: "flex", gap: 16 }}>
          <Link href="/home" style={{ color: "inherit", textDecoration: "none" }}>
            Home
          </Link>
          <Link href="/settings/workspace" style={{ color: "inherit", textDecoration: "none" }}>
            Workspace
          </Link>
        </nav>
        <WorkspaceSwitcher />
      </header>
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Update `/home` to consume new `/me` shape**

Replace `apps/web/src/app/(app)/home/page.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { signOut } from "../../../auth/client";
import { apiFetch, bootstrapActiveWorkspace } from "../../../lib/api";
import { getActiveWorkspaceId } from "../../../lib/active-workspace";

type Me = {
  user: { id: string; email: string; tz: string; locale: string };
  tier: "free" | "lite" | "pro";
  trial: { active: boolean; endsAt: string | null };
};
type Workspace = { id: string; name: string; role: string };

export default function HomePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await bootstrapActiveWorkspace();
        const [meData, wsData] = await Promise.all([
          apiFetch<Me>("/me"),
          apiFetch<{ workspaces: Workspace[] }>("/workspaces"),
        ]);
        setMe(meData);
        const activeId = getActiveWorkspaceId();
        setWorkspace(
          wsData.workspaces.find((w) => w.id === activeId) ?? wsData.workspaces[0] ?? null,
        );
      } catch (e) {
        setErr((e as { code?: string }).code ?? "error");
      }
    })();
  }, []);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui", maxWidth: 600 }}>
      <h1 style={{ fontSize: 32, marginBottom: 24 }}>Welcome</h1>
      {err && <p style={{ color: "#c00" }}>Could not reach API: {err}</p>}
      {!me && !err && <p>Loading…</p>}
      {me && workspace && (
        <div
          style={{
            border: "1px solid #eee",
            borderRadius: 12,
            padding: 16,
            marginBottom: 24,
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.5 }}>Workspace</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{workspace.name}</div>
          <div style={{ fontSize: 12, opacity: 0.5, marginTop: 8 }}>Role</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{workspace.role}</div>
          <div style={{ fontSize: 12, opacity: 0.5, marginTop: 8 }}>Tier</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{me.tier.toUpperCase()}</div>
          {me.trial.active && (
            <div style={{ fontSize: 12, marginTop: 12, color: "#0a7" }}>
              Pro trial active — ends {new Date(me.trial.endsAt!).toLocaleDateString()}
            </div>
          )}
        </div>
      )}
      <button
        onClick={() => signOut()}
        style={{
          padding: "12px 24px",
          borderRadius: 8,
          border: "1px solid #ddd",
          background: "#fff",
          cursor: "pointer",
        }}
      >
        Sign out
      </button>
    </main>
  );
}
```

- [ ] **Step 4: Manual verification (full flow end-to-end)**

```bash
docker compose up -d
pnpm nx run-many -t dev --projects=api,web --parallel=2
```

1. Sign up `alice@x.com` on `/sign-in` → land on `/home`. Header reads "Workspace: Alice's workspace (owner)" (single — no dropdown).
2. Visit `/settings/workspace` → invite `bob@x.com` as editor.
3. Tail the api dev console; copy the `/invites/<token>` URL.
4. Incognito window, sign up `bob@x.com`, visit the invite URL, accept → redirected to `/home` with header "Workspace: Alice's workspace (editor)" (single — no dropdown for bob yet).
5. As bob, navigate `/settings/workspace`, click "Leave" → workspace gone from the list, header shows "Bob's workspace (owner)".
6. Re-invite bob from alice. Bob accepts again. Bob now has 2 workspaces — header shows the dropdown switcher. Switching writes the cookie and reloads — `/home` shows the picked workspace.
7. As alice, on `/settings/workspace`, change bob's role to "owner (transfer)" → confirm. Bob is now owner; alice is editor. The dropdowns disappear for alice (no longer owner).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/'(app)'/layout.tsx apps/web/src/app/'(app)'/_components apps/web/src/app/'(app)'/home/page.tsx
git commit -m "feat(web): (app) layout + workspace switcher + home consumes new /me + /workspaces"
```

---

## Task 16: Final verification + README + commit

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Run the full test suite**

```bash
pnpm nx run-many -t test
pnpm nx run-many -t typecheck
pnpm nx run-many -t lint
```

Expected: all green. Tests added in Plan 2: `auth.context` (4), `workspaces` (3), `members.service` (12), `invites.service` (17), `members.routes` (9), `invites.routes` (11), plus rewritten `me` (3). Total **59 server tests** vs. 13 from Plan 1.

- [ ] **Step 2: Update README status block**

Edit the `## Status` section near the bottom of `README.md`. Replace it with:

```markdown
## Status — 2026-05-08

- ✅ Plan 1 complete: Nx monorepo, Postgres, Fastify API + Better Auth (email/password + magic link), workspace bootstrap with 30-day Pro trial via post-create hook, Expo mobile + Next.js web both rendering /me, CI workflow ready.
- ✅ Plan 2 complete: workspace sharing on web — invites table + 10 endpoints, web UI for accept page, /settings/workspace, header switcher. Mobile gets X-Workspace-Id plumbing only. **API: 59 tests passing.**
- 🚧 Next: Plan 1B — Plaid + Account model (mobile-first), or Plan 2-mobile — mirror sharing UX onto mobile (TBD).
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: mark Plan 2 complete + roadmap pointer"
```

- [ ] **Step 4: Push + open PR if branched**

```bash
git push origin HEAD
```

If working on a feature branch, open a PR using the standard tooling.

---

## Done — Plan 2 Exit Criteria

- [ ] `pnpm nx run-many -t test` green: 59 API tests across health, auth.session, membership, workspaces.bootstrap, me, workspaces (list), auth.context, members.service, members.routes, invites.service, invites.routes.
- [ ] `pnpm nx run-many -t typecheck` green across api, mobile, web, shared.
- [ ] `pnpm nx run-many -t lint` green.
- [ ] CI green on push.
- [ ] Web flow: owner signs up → invites editor by email → editor signs up via the link → editor accepts → both see same workspace via `/settings/workspace`. Owner can promote/demote/transfer/remove. Last-owner-leave returns 409.
- [ ] `/invites/<token>` rejects logged-in users with the wrong email (sign-out hint shown). `/invites/<token>` for an unknown/expired/revoked token shows the right state. 7-day expiry honored.
- [ ] Header switcher appears only when the user has ≥ 2 workspaces. Switching changes the cookie and reloads — every subsequent fetch carries the new `X-Workspace-Id`.
- [ ] Mobile: solo user with one workspace still sees the same `/home` UI. Header `X-Workspace-Id` is sent on every API call (verify in Fastify logs).
- [ ] DB: every accepted invite creates exactly one new `memberships` row + flips `invites.status` to `accepted` with `acceptedAt` and `acceptedById` set. Revoked invites stay around with `status = revoked`.
- [ ] Re-invite of a previously accepted email is rejected (`already_member`).
