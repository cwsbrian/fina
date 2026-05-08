# Plan 1 — Foundations (Nx + API + Mobile + Web + Auth)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap an Nx monorepo containing a Fastify API, an Expo (React Native) mobile app, and a Next.js web app, all sharing TypeScript types via a `libs/shared` package. A user can sign up via Clerk on either client; the backend creates a User + personal Workspace + owner Membership tuple via a Clerk webhook on `user.created` and starts a 30-day Pro trial. Both clients display the authenticated user's workspace via a shared `/me` endpoint. Service-layer authorization patterns from spec §10 are baked in from day one.

**Architecture:** Nx 19+ workspace, pnpm package manager, Postgres 16 (Docker for dev), Prisma ORM. Backend uses Fastify with a Clerk JWT verification middleware and an `assertMembership(user, workspace, role)` helper that gates every authenticated route. Webhook signed with Svix verifies the `user.created` event and calls a transactional `createPersonalWorkspaceWithTrial` service. Both mobile and web register the same Clerk publishable key and call the same backend `/me` endpoint to render workspace info.

**Tech Stack:** Nx 19+, pnpm 9.12+, TypeScript 5.6+, Node 20.18+, Postgres 16, Prisma 5.22+, Fastify 5, Clerk (`@clerk/clerk-expo`, `@clerk/nextjs`, `@clerk/backend`), Expo SDK 53, Expo Router, Next.js 15 (App Router), Vitest, Zod, GitHub Actions. **No LLM yet** — Gemini Flash arrives in Plan 3. **No Plaid yet** — arrives in Plan 1B (after sharing). **No subscriptions table yet** — only trial fields on User.

**Spec reference:** `docs/superpowers/specs/2026-05-07-fina-design.md`
- §4 Multi-tenancy
- §10 Authorization & Service Layer Rules
- §13 Pricing & Billing (specifically §13.5 30-day trial mechanics)
- §14 Tech Stack (Nx repo structure)
- §15 Phase 1A — Foundations

**Out of scope for this plan (later plans cover them):**
- Workspace sharing / invites / role transitions — Plan 2 (Phase 1.5)
- Categories, accounts, transactions, budgets — Plan 3
- Plaid integration + tier gating — Plan 4 (Phase 1B)
- Chat threads/messages, LLM, redaction layer — Plan 5
- Tool execution + action_intents — Plan 6 (Phase 1C)
- Daily ritual + push + Stripe + IAP — Plan 7 (Phase 2)
- Forecasting/advisor — Plan 8 (Phase 3)

---

## File Structure (created during this plan)

```
fina/
├── nx.json                        # Nx workspace config
├── package.json                   # workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .editorconfig
├── .gitignore
├── .nvmrc
├── .prettierrc.json
├── .eslintrc.cjs
├── docker-compose.yml             # Postgres for dev
├── .env.example
├── README.md
├── scripts/
│   └── init-db.sh                 # creates fina_test DB inside the container
├── .github/
│   └── workflows/
│       └── ci.yml
├── apps/
│   ├── api/                       # @nx/node Fastify
│   │   ├── project.json
│   │   ├── tsconfig.json
│   │   ├── tsconfig.app.json
│   │   ├── tsconfig.spec.json
│   │   ├── vitest.config.ts
│   │   ├── .env.test
│   │   ├── prisma/
│   │   │   ├── schema.prisma      # User, Workspace, Membership, trial fields
│   │   │   └── seed.ts            # placeholder
│   │   ├── src/
│   │   │   ├── env.ts
│   │   │   ├── db.ts
│   │   │   ├── server.ts
│   │   │   ├── main.ts            # entrypoint
│   │   │   ├── auth/
│   │   │   │   ├── clerk.ts
│   │   │   │   └── membership.ts
│   │   │   ├── routes/
│   │   │   │   ├── health.ts
│   │   │   │   └── me.ts
│   │   │   ├── webhooks/
│   │   │   │   └── clerk.ts
│   │   │   └── workspaces/
│   │   │       └── bootstrap.ts
│   │   └── tests/
│   │       ├── helpers/
│   │       │   ├── db.ts
│   │       │   ├── migrate.ts
│   │       │   ├── global-setup.ts
│   │       │   └── auth.ts
│   │       ├── health.test.ts
│   │       ├── auth.clerk.test.ts
│   │       ├── membership.test.ts
│   │       ├── workspaces.bootstrap.test.ts
│   │       ├── me.test.ts
│   │       └── webhooks.clerk.test.ts
│   ├── mobile/                    # @nx/expo
│   │   ├── project.json
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── app.json
│   │   ├── babel.config.js
│   │   ├── app/                   # Expo Router
│   │   │   ├── _layout.tsx
│   │   │   ├── index.tsx
│   │   │   ├── (auth)/
│   │   │   │   └── sign-in.tsx
│   │   │   └── (tabs)/
│   │   │       ├── _layout.tsx
│   │   │       └── index.tsx
│   │   └── src/
│   │       ├── env.ts
│   │       └── api/
│   │           └── client.ts
│   └── web/                       # @nx/next App Router
│       ├── project.json
│       ├── package.json
│       ├── tsconfig.json
│       ├── next.config.js
│       ├── middleware.ts          # Clerk authMiddleware
│       └── src/
│           ├── env.ts
│           └── app/
│               ├── layout.tsx     # ClerkProvider
│               ├── page.tsx       # marketing landing (signed-out) → home (signed-in)
│               ├── sign-in/
│               │   └── [[...sign-in]]/page.tsx
│               ├── sign-up/
│               │   └── [[...sign-up]]/page.tsx
│               └── (app)/
│                   └── home/
│                       └── page.tsx
└── libs/
    └── shared/                    # @nx/js
        ├── project.json
        ├── tsconfig.json
        └── src/
            ├── index.ts
            ├── ids.ts
            ├── roles.ts
            └── tier.ts            # Free/Lite/Pro enum + helper guards
```

**Why this layout:**
- One Nx workspace, three apps, one library. Easy to add `libs/api-auth`, `libs/chat-blocks` later without restructure.
- Mobile and web both consume `libs/shared` (types only — no runtime deps that break in RN).
- All tests live next to their app under `apps/<app>/tests/` to keep affected detection accurate.

---

## Task 1: Nx workspace bootstrap

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `nx.json`, `tsconfig.base.json`, `.editorconfig`, `.gitignore`, `.nvmrc`, `.prettierrc.json`, `.eslintrc.cjs`, `README.md`

- [ ] **Step 1: Initialize an empty Nx workspace via the official CLI**

From the `fina/` directory (already a git repo):

```bash
pnpm dlx create-nx-workspace@19 --preset=apps --packageManager=pnpm --interactive=false --name=fina --workspaceType=integrated .
```

Notes:
- `.` puts the workspace in the current directory.
- `--preset=apps` creates an empty workspace with `apps/` and `libs/` directories and no preinstalled apps; we add them by hand for clarity.
- After this runs, you'll see `nx.json`, root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` already created.

If `create-nx-workspace` insists on initializing a new git repo, decline (we already have one). Pass `--skip-git` if available, otherwise discard the `.git` it creates and rely on the existing one.

- [ ] **Step 2: Verify and adjust the generated `package.json`**

Open the root `package.json`. Confirm `"packageManager": "pnpm@9.x.x"` and `"private": true`. Add or merge:

```json
{
  "engines": { "node": ">=20.18.0", "pnpm": ">=9.12.0" },
  "scripts": {
    "build": "nx run-many -t build",
    "dev": "nx run-many -t dev --parallel=10",
    "lint": "nx run-many -t lint",
    "typecheck": "nx run-many -t typecheck",
    "test": "nx run-many -t test"
  }
}
```

- [ ] **Step 3: Verify `nx.json`**

The generated `nx.json` should already include `targetDefaults` for build/lint/test. Confirm or replace with:

```json
{
  "$schema": "./node_modules/nx/schemas/nx-schema.json",
  "namedInputs": {
    "default": ["{projectRoot}/**/*", "sharedGlobals"],
    "production": [
      "default",
      "!{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)",
      "!{projectRoot}/tsconfig.spec.json",
      "!{projectRoot}/vitest.config.ts",
      "!{projectRoot}/.eslintrc.cjs"
    ],
    "sharedGlobals": ["{workspaceRoot}/tsconfig.base.json", "{workspaceRoot}/.eslintrc.cjs"]
  },
  "targetDefaults": {
    "build": { "cache": true, "dependsOn": ["^build"], "inputs": ["production", "^production"] },
    "lint": { "cache": true, "inputs": ["default", "{workspaceRoot}/.eslintrc.cjs"] },
    "test": { "cache": true, "inputs": ["default", "^production"] },
    "typecheck": { "cache": true, "inputs": ["default", "^production"] }
  },
  "defaultBase": "main"
}
```

- [ ] **Step 4: Replace `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "baseUrl": ".",
    "paths": {
      "@fina/shared": ["libs/shared/src/index.ts"]
    }
  }
}
```

- [ ] **Step 5: Create root `.gitignore`, `.editorconfig`, `.nvmrc`, `.prettierrc.json`, `.eslintrc.cjs`**

`.gitignore`:
```
node_modules/
.nx/cache
.nx/workspace-data
dist/
build/
coverage/
.next/
.expo/
.expo-shared/
.env
.env.local
.env.*.local
!.env.example
*.log
.DS_Store
ios/Pods/
android/build/
android/app/build/
.vscode/
.idea/
```

`.editorconfig`:
```
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true
```

`.nvmrc`:
```
20.18.0
```

`.prettierrc.json`:
```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

`.eslintrc.cjs`:
```js
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  plugins: ["@typescript-eslint", "@nx"],
  extends: ["plugin:@nx/typescript"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  },
  ignorePatterns: ["dist/", "node_modules/", ".nx/", "*.config.*", ".eslintrc.cjs"],
};
```

- [ ] **Step 6: Replace `README.md`**

```markdown
# Fina

AI Financial Advisor (chat-first). See `docs/superpowers/specs/2026-05-07-fina-design.md`.

## Dev Setup

Requires Node 20.18+, pnpm 9.12+, Docker.

```bash
nvm use
pnpm install
docker compose up -d
cp .env.example .env       # fill in CLERK_* keys
pnpm nx run api:db:migrate
pnpm nx run-many -t dev --projects=api,mobile,web --parallel=3
```

## Workspaces

- `apps/api` — Fastify backend
- `apps/mobile` — Expo React Native app
- `apps/web` — Next.js (App Router)
- `libs/shared` — shared TypeScript types
```

- [ ] **Step 7: Smoke test**

```bash
pnpm install
pnpm nx graph --file=/tmp/nx-graph.json
```

Expected: install succeeds. `nx graph` outputs JSON with no projects yet (apps come in later tasks). No errors.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml nx.json tsconfig.base.json \
  .editorconfig .gitignore .nvmrc .prettierrc.json .eslintrc.cjs README.md \
  pnpm-lock.yaml
git commit -m "chore: bootstrap Nx workspace with pnpm"
```

---

## Task 2: `libs/shared` library

**Files:**
- Create via Nx generator: `libs/shared/`
- Create: `libs/shared/src/ids.ts`, `roles.ts`, `tier.ts`, `index.ts`

- [ ] **Step 1: Add Nx JS plugin and generate the library**

```bash
pnpm add -Dw @nx/js@19
pnpm nx g @nx/js:lib shared --directory=libs/shared --projectNameAndRootFormat=as-provided --bundler=tsc --unitTestRunner=vitest --linter=eslint --importPath=@fina/shared --no-interactive
```

This creates `libs/shared/{project.json,package.json,tsconfig.json,tsconfig.lib.json,src/index.ts}` and registers the project.

- [ ] **Step 2: Replace `libs/shared/src/index.ts` and add modules**

`libs/shared/src/ids.ts`:
```ts
type Brand<T, B> = T & { readonly __brand: B };

export type UserId = Brand<string, "UserId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type MembershipId = Brand<string, "MembershipId">;

export const userId = (s: string): UserId => s as UserId;
export const workspaceId = (s: string): WorkspaceId => s as WorkspaceId;
export const membershipId = (s: string): MembershipId => s as MembershipId;
```

`libs/shared/src/roles.ts`:
```ts
export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export function hasAtLeast(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
```

`libs/shared/src/tier.ts`:
```ts
export const TIERS = ["free", "lite", "pro"] as const;
export type Tier = (typeof TIERS)[number];

const TIER_RANK: Record<Tier, number> = { free: 0, lite: 1, pro: 2 };

export function tierAtLeast(actual: Tier, required: Tier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[required];
}

export type EffectiveTier = {
  tier: Tier;
  source: "trial" | "paid" | "default";
  trialActive: boolean;
  trialEndsAt: Date | null;
};
```

`libs/shared/src/index.ts`:
```ts
export * from "./ids.js";
export * from "./roles.js";
export * from "./tier.js";
```

- [ ] **Step 3: Verify lib builds and lints**

```bash
pnpm nx run shared:build
pnpm nx run shared:lint
pnpm nx run shared:typecheck
```

If `typecheck` target was not generated, add to `libs/shared/project.json`:
```json
"typecheck": {
  "executor": "nx:run-commands",
  "options": { "command": "tsc --noEmit -p libs/shared/tsconfig.lib.json" }
}
```

All three commands should succeed.

- [ ] **Step 4: Commit**

```bash
git add libs/shared/ pnpm-lock.yaml package.json
git commit -m "feat(shared): add ids, roles, and tier types"
```

---

## Task 3: Postgres dev container

**Files:**
- Create: `docker-compose.yml`, `.env.example`, `scripts/init-db.sh`

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: fina-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: fina
      POSTGRES_PASSWORD: fina
      POSTGRES_DB: fina
    ports:
      - "5432:5432"
    volumes:
      - fina-postgres:/var/lib/postgresql/data
      - ./scripts/init-db.sh:/docker-entrypoint-initdb.d/init-db.sh
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U fina"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  fina-postgres:
```

- [ ] **Step 2: Create `scripts/init-db.sh` and make executable**

```bash
mkdir -p scripts
cat > scripts/init-db.sh <<'EOF'
#!/bin/bash
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  CREATE DATABASE fina_test;
EOSQL
EOF
chmod +x scripts/init-db.sh
```

- [ ] **Step 3: Create `.env.example`**

```bash
# Backend
DATABASE_URL=postgresql://fina:fina@localhost:5432/fina
NODE_ENV=development
PORT=4000

# Clerk (https://dashboard.clerk.com)
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
CLERK_WEBHOOK_SECRET=whsec_...

# Mobile (Expo public)
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
EXPO_PUBLIC_API_URL=http://localhost:4000

# Web (Next.js public)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
NEXT_PUBLIC_API_URL=http://localhost:4000
CLERK_SIGN_IN_URL=/sign-in
CLERK_SIGN_UP_URL=/sign-up
CLERK_AFTER_SIGN_IN_URL=/home
CLERK_AFTER_SIGN_UP_URL=/home
```

- [ ] **Step 4: Smoke test**

```bash
docker compose up -d
docker compose ps
docker compose exec postgres psql -U fina -l
```

Expected: container healthy; `psql -l` shows both `fina` and `fina_test` databases.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example scripts/init-db.sh
git commit -m "chore: add Postgres 16 dev container with test DB"
```

---

## Task 4: `apps/api` Fastify scaffold + `/health`

**Files:**
- Create via generator: `apps/api/`
- Create: `apps/api/src/env.ts`, `routes/health.ts`, `server.ts`, `main.ts`
- Create: `apps/api/tests/health.test.ts`, `vitest.config.ts`, `.env.test`

- [ ] **Step 1: Generate the Node app**

```bash
pnpm add -Dw @nx/node@19 @nx/vite@19
pnpm nx g @nx/node:application api --directory=apps/api --framework=fastify --bundler=esbuild --unitTestRunner=vitest --e2eTestRunner=none --no-interactive
```

This produces `apps/api/{src,project.json,tsconfig.app.json,tsconfig.json,tsconfig.spec.json}` and a generated `src/main.ts`. Replace its body in later steps.

- [ ] **Step 2: Add deps**

```bash
pnpm add -F @fina/api fastify@^5.0.0 @fastify/sensible@^6.0.1 zod@^3.23.8
pnpm add -DF @fina/api tsx@^4.19.2 vitest@^2.1.5
```

`-F` is pnpm shorthand for `--filter` and targets the `@fina/api` workspace package.

- [ ] **Step 3: Replace `apps/api/src/env.ts`**

```ts
import { z } from "zod";

const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_WEBHOOK_SECRET: z.string().min(1),
});

export type Env = z.infer<typeof Schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
```

- [ ] **Step 4: Create `apps/api/src/routes/health.ts`**

```ts
import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok", time: new Date().toISOString() }));
}
```

- [ ] **Step 5: Replace `apps/api/src/server.ts`**

```ts
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import type { Env } from "./env.js";
import { healthRoutes } from "./routes/health.js";

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : { level: "info" },
  });

  await app.register(sensible);
  await app.register(healthRoutes);

  return app;
}
```

- [ ] **Step 6: Replace `apps/api/src/main.ts`**

```ts
import { loadEnv } from "./env.js";
import { buildApp } from "./server.js";

async function start(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);
  await app.listen({ host: "0.0.0.0", port: env.PORT });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 7: Create `apps/api/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, ".env.test") });

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/helpers/global-setup.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 30_000,
  },
});
```

- [ ] **Step 8: Create `apps/api/.env.test`**

```bash
NODE_ENV=test
DATABASE_URL=postgresql://fina:fina@localhost:5432/fina_test
PORT=0
CLERK_SECRET_KEY=sk_test_unused_in_tests
CLERK_PUBLISHABLE_KEY=pk_test_unused_in_tests
CLERK_WEBHOOK_SECRET=whsec_dGVzdHNlY3JldGZvcndlYmhvb2tzaWduYXR1cmV2ZXJpZmllcg==
```

The webhook secret decodes to `testsecretforwebhooksignatureverifier` (svix requires base64 after the `whsec_` prefix).

Append to root `.gitignore` exception:
```
!apps/api/.env.test
```

- [ ] **Step 9: Add `dotenv` and create tests folder structure**

```bash
pnpm add -DF @fina/api dotenv@^16.4.5
mkdir -p apps/api/tests/helpers
```

- [ ] **Step 10: Create `apps/api/tests/helpers/global-setup.ts` (no-op for now; fills in Task 6)**

```ts
export default function setup(): void {
  // Migrations applied per-test-process by ensureMigrationsApplied (Task 6).
}
```

- [ ] **Step 11: Write `apps/api/tests/health.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { buildApp } from "../src/server.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: "postgresql://test",
  CLERK_SECRET_KEY: "sk_test",
  CLERK_PUBLISHABLE_KEY: "pk_test",
  CLERK_WEBHOOK_SECRET: "whsec_test",
};

describe("GET /health", () => {
  it("returns ok with timestamp", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.time).toBe("string");
    await app.close();
  });
});
```

- [ ] **Step 12: Wire test target in `apps/api/project.json`**

The `@nx/node` generator creates a `test` target via Vite by default. Confirm the entry looks like:

```json
"test": {
  "executor": "@nx/vite:test",
  "outputs": ["{options.reportsDirectory}"],
  "options": {
    "passWithNoTests": false,
    "reportsDirectory": "../../coverage/apps/api",
    "configFile": "apps/api/vitest.config.ts"
  }
}
```

If it points to a different config or uses a different executor, replace the target with the block above.

- [ ] **Step 13: Run the test**

```bash
pnpm nx run api:test
```

Expected: PASS. Health test exercises the just-implemented route.

- [ ] **Step 14: Commit**

```bash
git add apps/api/ pnpm-lock.yaml package.json .gitignore
git commit -m "feat(api): scaffold Fastify with /health and zod env validation"
```

---

## Task 5: Prisma schema (User, Workspace, Membership, trial fields)

**Files:**
- Create: `apps/api/prisma/schema.prisma`, `prisma/seed.ts`
- Create: `apps/api/src/db.ts`
- Modify: `apps/api/package.json` (Prisma scripts), `project.json` (custom targets)

- [ ] **Step 1: Add Prisma**

```bash
pnpm add -F @fina/api @prisma/client@^5.22.0
pnpm add -DF @fina/api prisma@^5.22.0
```

- [ ] **Step 2: Add Prisma scripts to `apps/api/package.json`**

The Nx-generated `package.json` for the api app may be minimal. Add:

```json
{
  "name": "@fina/api",
  "version": "0.0.0",
  "private": true,
  "main": "src/main.ts",
  "scripts": {
    "prisma": "prisma",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:deploy": "prisma migrate deploy",
    "db:push": "prisma db push",
    "db:studio": "prisma studio"
  },
  "prisma": {
    "schema": "prisma/schema.prisma",
    "seed": "tsx prisma/seed.ts"
  }
}
```

- [ ] **Step 3: Add custom Nx targets to `apps/api/project.json`**

Inside `"targets"`, add:

```json
"db:generate": {
  "executor": "nx:run-commands",
  "options": { "command": "pnpm --filter @fina/api db:generate" }
},
"db:migrate": {
  "executor": "nx:run-commands",
  "options": { "command": "pnpm --filter @fina/api db:migrate" }
},
"db:deploy": {
  "executor": "nx:run-commands",
  "options": { "command": "pnpm --filter @fina/api db:deploy" }
}
```

- [ ] **Step 4: Create `apps/api/prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id              String   @id @default(cuid())
  clerkId         String   @unique
  email           String   @unique
  tz              String   @default("America/Toronto")
  locale          String   @default("en-CA")
  trialStartedAt  DateTime?
  trialEndsAt     DateTime?
  trialConsumed   Boolean  @default(false)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  memberships     Membership[]

  @@map("users")
}

model Workspace {
  id          String   @id @default(cuid())
  name        String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  memberships Membership[]

  @@map("workspaces")
}

model Membership {
  id          String   @id @default(cuid())
  userId      String
  workspaceId String
  role        Role
  createdAt   DateTime @default(now())
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([userId, workspaceId])
  @@index([workspaceId])
  @@map("memberships")
}

enum Role {
  owner
  editor
  viewer
}
```

- [ ] **Step 5: Create `apps/api/prisma/seed.ts`**

```ts
async function main(): Promise<void> {
  console.log("Seed: nothing to do for Plan 1");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 6: Create `apps/api/src/db.ts`**

```ts
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __fina_prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__fina_prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__fina_prisma = prisma;
}
```

- [ ] **Step 7: Apply migration**

Make sure `.env` exists at the workspace root (copied from `.env.example` and filled). Then:

```bash
pnpm nx run api:db:migrate -- --name init_users_workspaces_memberships
```

Expected: migration created in `apps/api/prisma/migrations/<ts>_init_users_workspaces_memberships/`, schema applied, client generated.

Verify:
```bash
docker compose exec postgres psql -U fina -d fina -c "\dt"
```
Should list `users`, `workspaces`, `memberships`, `_prisma_migrations`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/ apps/api/src/db.ts apps/api/package.json apps/api/project.json pnpm-lock.yaml
git commit -m "feat(api): add Prisma schema for users, workspaces, memberships, trial fields"
```

---

## Task 6: Test database helpers + migrations

**Files:**
- Create: `apps/api/tests/helpers/db.ts`, `migrate.ts`
- Modify: `apps/api/tests/helpers/global-setup.ts`

- [ ] **Step 1: Create `apps/api/tests/helpers/db.ts`**

```ts
import { prisma } from "../../src/db.js";

export async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "memberships", "workspaces", "users" RESTART IDENTITY CASCADE;',
  );
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
```

- [ ] **Step 2: Create `apps/api/tests/helpers/migrate.ts`**

```ts
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

let applied = false;

export function ensureMigrationsApplied(): void {
  if (applied) return;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  execSync("pnpm prisma migrate deploy", {
    stdio: "ignore",
    cwd: path.resolve(__dirname, "../.."),
    env: process.env,
  });
  applied = true;
}
```

- [ ] **Step 3: Replace `apps/api/tests/helpers/global-setup.ts`**

```ts
import { ensureMigrationsApplied } from "./migrate.js";

export default function setup(): void {
  ensureMigrationsApplied();
}
```

- [ ] **Step 4: Run health test (verifies migrations don't break unrelated tests)**

```bash
pnpm nx run api:test
```

Expected: health test still passes, migrations apply silently against `fina_test`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/tests/helpers/
git commit -m "test(api): set up Postgres test DB helpers with migrate-once"
```

---

## Task 7: Workspace bootstrap service (with trial)

**Files:**
- Create: `apps/api/src/workspaces/bootstrap.ts`
- Create: `apps/api/tests/workspaces.bootstrap.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/workspaces.bootstrap.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { createPersonalWorkspaceWithTrial } from "../src/workspaces/bootstrap.js";
import { truncateAll, disconnect } from "./helpers/db.js";

describe("createPersonalWorkspaceWithTrial", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("creates user, workspace, owner membership, and starts a 30-day Pro trial", async () => {
    const before = Date.now();
    const result = await createPersonalWorkspaceWithTrial({
      clerkId: "user_clerk_123",
      email: "brian@example.com",
      displayName: "Brian",
    });
    const after = Date.now();

    expect(result.user.clerkId).toBe("user_clerk_123");
    expect(result.workspace.name).toBe("Brian's workspace");
    expect(result.membership.role).toBe("owner");

    const trialStart = result.user.trialStartedAt!.getTime();
    const trialEnd = result.user.trialEndsAt!.getTime();
    expect(trialStart).toBeGreaterThanOrEqual(before);
    expect(trialStart).toBeLessThanOrEqual(after);
    // 30 days ± 1s
    expect(trialEnd - trialStart).toBeGreaterThan(30 * 24 * 60 * 60 * 1000 - 1000);
    expect(trialEnd - trialStart).toBeLessThan(30 * 24 * 60 * 60 * 1000 + 1000);
    expect(result.user.trialConsumed).toBe(false);

    const memberships = await prisma.membership.findMany({
      where: { userId: result.user.id },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.workspaceId).toBe(result.workspace.id);
    expect(memberships[0]?.role).toBe("owner");
  });

  it("is idempotent on duplicate clerkId — returns existing tuple, does not restart trial", async () => {
    const first = await createPersonalWorkspaceWithTrial({
      clerkId: "user_dup",
      email: "dup@example.com",
      displayName: "Dup",
    });
    const firstTrialStart = first.user.trialStartedAt!.getTime();

    await new Promise((r) => setTimeout(r, 5));

    const second = await createPersonalWorkspaceWithTrial({
      clerkId: "user_dup",
      email: "dup@example.com",
      displayName: "Dup",
    });
    expect(second.user.id).toBe(first.user.id);
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(second.user.trialStartedAt!.getTime()).toBe(firstTrialStart);

    const userCount = await prisma.user.count();
    expect(userCount).toBe(1);
  });

  it("falls back to email-derived name if displayName is empty", async () => {
    const result = await createPersonalWorkspaceWithTrial({
      clerkId: "user_no_name",
      email: "alice@example.com",
      displayName: "",
    });
    expect(result.workspace.name).toBe("alice's workspace");
  });
});
```

- [ ] **Step 2: Run test (expect failure)**

```bash
pnpm nx run api:test --testPathPattern=workspaces.bootstrap
```

Expected: FAIL — module `../src/workspaces/bootstrap` does not exist.

- [ ] **Step 3: Implement `apps/api/src/workspaces/bootstrap.ts`**

```ts
import { Prisma, type User } from "@prisma/client";
import { prisma } from "../db.js";

const TRIAL_DAYS = 30;

export type BootstrapInput = {
  clerkId: string;
  email: string;
  displayName: string;
};

export type BootstrapResult = {
  user: User;
  workspace: { id: string; name: string };
  membership: { id: string; userId: string; workspaceId: string; role: "owner" };
};

function deriveWorkspaceName(displayName: string, email: string): string {
  const name = displayName.trim();
  if (name.length > 0) return `${name}'s workspace`;
  const local = email.split("@")[0] ?? "personal";
  return `${local}'s workspace`;
}

export async function createPersonalWorkspaceWithTrial(
  input: BootstrapInput,
): Promise<BootstrapResult> {
  return await prisma.$transaction(
    async (tx) => {
      const existing = await tx.user.findUnique({ where: { clerkId: input.clerkId } });
      if (existing) {
        const m = await tx.membership.findFirstOrThrow({
          where: { userId: existing.id, role: "owner" },
          include: { workspace: true },
        });
        return {
          user: existing,
          workspace: { id: m.workspace.id, name: m.workspace.name },
          membership: {
            id: m.id,
            userId: m.userId,
            workspaceId: m.workspaceId,
            role: "owner",
          },
        };
      }

      const now = new Date();
      const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

      const user = await tx.user.create({
        data: {
          clerkId: input.clerkId,
          email: input.email,
          trialStartedAt: now,
          trialEndsAt: trialEnd,
          trialConsumed: false,
        },
      });
      const workspace = await tx.workspace.create({
        data: { name: deriveWorkspaceName(input.displayName, input.email) },
      });
      const membership = await tx.membership.create({
        data: { userId: user.id, workspaceId: workspace.id, role: "owner" },
      });

      return {
        user,
        workspace: { id: workspace.id, name: workspace.name },
        membership: {
          id: membership.id,
          userId: membership.userId,
          workspaceId: membership.workspaceId,
          role: "owner",
        },
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm nx run api:test --testPathPattern=workspaces.bootstrap
```

Expected: all 3 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workspaces/ apps/api/tests/workspaces.bootstrap.test.ts
git commit -m "feat(api): add createPersonalWorkspaceWithTrial service (30d Pro trial)"
```

---

## Task 8: Clerk JWT verification middleware

**Files:**
- Create: `apps/api/src/auth/clerk.ts`, `tests/helpers/auth.ts`, `tests/auth.clerk.test.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Add Clerk backend SDK and JWT helper for tests**

```bash
pnpm add -F @fina/api @clerk/backend@^1.21.0
pnpm add -DF @fina/api jsonwebtoken@^9.0.2 @types/jsonwebtoken@^9.0.7
```

- [ ] **Step 2: Create `apps/api/tests/helpers/auth.ts`**

```ts
import jwt from "jsonwebtoken";

export const TEST_JWT_SECRET = "test-secret-do-not-use-in-prod";

export type FakeClaims = {
  sub: string;
  email?: string;
  name?: string;
};

export function makeFakeJwt(claims: FakeClaims): string {
  return jwt.sign(claims, TEST_JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
}
```

- [ ] **Step 3: Write the failing test**

```ts
// apps/api/tests/auth.clerk.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { makeFakeJwt } from "./helpers/auth.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  CLERK_SECRET_KEY: "sk_test_dummy",
  CLERK_PUBLISHABLE_KEY: "pk_test_dummy",
  CLERK_WEBHOOK_SECRET: "whsec_dummy",
};

describe("Clerk auth middleware", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("rejects request with no Authorization header on protected route", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/__test/whoami" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects request with invalid JWT", async () => {
    const app = await buildApp(env);
    const res = await app.inject({
      method: "GET",
      url: "/__test/whoami",
      headers: { authorization: "Bearer not.a.real.jwt" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("decorates request.auth with clerkId from valid JWT", async () => {
    const app = await buildApp(env);
    const token = makeFakeJwt({ sub: "user_clerk_test", email: "t@example.com", name: "T" });
    const res = await app.inject({
      method: "GET",
      url: "/__test/whoami",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ clerkId: "user_clerk_test" });
    await app.close();
  });

  it("allows public routes (/health, /webhooks/*) without token", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
```

- [ ] **Step 4: Implement `apps/api/src/auth/clerk.ts`**

```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { verifyToken } from "@clerk/backend";

declare module "fastify" {
  interface FastifyRequest {
    auth?: { clerkId: string; email?: string };
  }
}

export type AuthOptions = {
  clerkSecretKey: string;
  testJwtSecret?: string;
};

const PUBLIC_PREFIXES = ["/health", "/webhooks/"] as const;

function isPublic(url: string | undefined): boolean {
  if (!url) return false;
  return PUBLIC_PREFIXES.some((p) => url === p || url.startsWith(p));
}

export function authPlugin(opts: AuthOptions) {
  return async function (app: FastifyInstance): Promise<void> {
    app.decorateRequest("auth", undefined);

    app.addHook("onRequest", async (req: FastifyRequest, reply) => {
      const url = req.routeOptions.url ?? req.url;
      if (isPublic(url)) return;

      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ")) {
        return reply.code(401).send({ error: "missing_token" });
      }
      const token = auth.slice("Bearer ".length).trim();

      try {
        if (opts.testJwtSecret) {
          const claims = jwt.verify(token, opts.testJwtSecret, {
            algorithms: ["HS256"],
          }) as { sub: string; email?: string };
          req.auth = { clerkId: claims.sub, email: claims.email };
          return;
        }
        const payload = await verifyToken(token, { secretKey: opts.clerkSecretKey });
        if (!payload.sub) {
          return reply.code(401).send({ error: "invalid_token" });
        }
        req.auth = {
          clerkId: payload.sub,
          email: typeof payload.email === "string" ? payload.email : undefined,
        };
      } catch {
        return reply.code(401).send({ error: "invalid_token" });
      }
    });

    if (process.env.NODE_ENV === "test") {
      app.get("/__test/whoami", async (req, reply) => {
        if (!req.auth) return reply.code(401).send({ error: "unauthenticated" });
        return { clerkId: req.auth.clerkId };
      });
    }
  };
}
```

- [ ] **Step 5: Wire into `apps/api/src/server.ts`**

Replace the `buildApp` body:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import type { Env } from "./env.js";
import { healthRoutes } from "./routes/health.js";
import { authPlugin } from "./auth/clerk.js";

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : { level: "info" },
  });

  await app.register(sensible);
  await app.register(
    authPlugin({
      clerkSecretKey: env.CLERK_SECRET_KEY,
      testJwtSecret: env.NODE_ENV === "test" ? "test-secret-do-not-use-in-prod" : undefined,
    }),
  );
  await app.register(healthRoutes);

  return app;
}
```

- [ ] **Step 6: Run tests**

```bash
pnpm nx run api:test --testPathPattern=auth.clerk
```

Expected: all 4 cases PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/clerk.ts apps/api/src/server.ts \
  apps/api/tests/auth.clerk.test.ts apps/api/tests/helpers/auth.ts \
  pnpm-lock.yaml
git commit -m "feat(api): Clerk JWT middleware with test HS256 bypass"
```

---

## Task 9: assertMembership helper + GET /me

**Files:**
- Create: `apps/api/src/auth/membership.ts`, `routes/me.ts`
- Create: `apps/api/tests/membership.test.ts`, `me.test.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Write membership test**

```ts
// apps/api/tests/membership.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { assertMembership, MembershipError } from "../src/auth/membership.js";
import { createPersonalWorkspaceWithTrial } from "../src/workspaces/bootstrap.js";
import { truncateAll, disconnect } from "./helpers/db.js";

describe("assertMembership", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("returns membership when user is owner of workspace", async () => {
    const { user, workspace } = await createPersonalWorkspaceWithTrial({
      clerkId: "u1",
      email: "u1@x.com",
      displayName: "U1",
    });
    const m = await assertMembership({
      userId: user.id,
      workspaceId: workspace.id,
      requiredRole: "owner",
    });
    expect(m.role).toBe("owner");
  });

  it("throws when user is not a member of the workspace", async () => {
    const { user } = await createPersonalWorkspaceWithTrial({
      clerkId: "u2",
      email: "u2@x.com",
      displayName: "U2",
    });
    const otherWs = await prisma.workspace.create({ data: { name: "Other" } });
    await expect(
      assertMembership({
        userId: user.id,
        workspaceId: otherWs.id,
        requiredRole: "viewer",
      }),
    ).rejects.toThrow(MembershipError);
  });

  it("throws when role is below required (owner-only on viewer)", async () => {
    const ws = await prisma.workspace.create({ data: { name: "Shared" } });
    const u = await prisma.user.create({
      data: { clerkId: "u3", email: "u3@x.com" },
    });
    await prisma.membership.create({
      data: { userId: u.id, workspaceId: ws.id, role: "viewer" },
    });
    await expect(
      assertMembership({
        userId: u.id,
        workspaceId: ws.id,
        requiredRole: "owner",
      }),
    ).rejects.toThrow(MembershipError);
  });
});
```

- [ ] **Step 2: Run test (expect failure)**

```bash
pnpm nx run api:test --testPathPattern=membership
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/api/src/auth/membership.ts`**

```ts
import { hasAtLeast, type Role } from "@fina/shared";
import { prisma } from "../db.js";

export class MembershipError extends Error {
  readonly statusCode: number;
  readonly code: "no_membership" | "insufficient_role";

  constructor(code: "no_membership" | "insufficient_role", message: string) {
    super(message);
    this.name = "MembershipError";
    this.code = code;
    this.statusCode = code === "no_membership" ? 404 : 403;
  }
}

export type AssertInput = {
  userId: string;
  workspaceId: string;
  requiredRole: Role;
};

export type AssertedMembership = {
  id: string;
  userId: string;
  workspaceId: string;
  role: Role;
};

export async function assertMembership(input: AssertInput): Promise<AssertedMembership> {
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: input.userId, workspaceId: input.workspaceId } },
  });
  if (!m) {
    throw new MembershipError("no_membership", "User is not a member of this workspace");
  }
  const role = m.role as Role;
  if (!hasAtLeast(role, input.requiredRole)) {
    throw new MembershipError("insufficient_role", `Role ${role} < required ${input.requiredRole}`);
  }
  return { id: m.id, userId: m.userId, workspaceId: m.workspaceId, role };
}
```

- [ ] **Step 4: Run membership test**

```bash
pnpm nx run api:test --testPathPattern=membership
```

Expected: all 3 cases PASS.

- [ ] **Step 5: Write /me test**

```ts
// apps/api/tests/me.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { makeFakeJwt } from "./helpers/auth.js";
import { createPersonalWorkspaceWithTrial } from "../src/workspaces/bootstrap.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  CLERK_SECRET_KEY: "sk_test_dummy",
  CLERK_PUBLISHABLE_KEY: "pk_test_dummy",
  CLERK_WEBHOOK_SECRET: "whsec_dummy",
};

describe("GET /me", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("returns user, workspace, role, and trial state for authenticated user", async () => {
    const { user, workspace } = await createPersonalWorkspaceWithTrial({
      clerkId: "user_me_1",
      email: "me1@example.com",
      displayName: "Me One",
    });
    const app = await buildApp(env);
    const token = makeFakeJwt({ sub: "user_me_1", email: "me1@example.com" });
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toEqual({
      id: user.id,
      email: "me1@example.com",
      tz: "America/Toronto",
      locale: "en-CA",
    });
    expect(body.workspace).toEqual({
      id: workspace.id,
      name: "Me One's workspace",
      role: "owner",
    });
    expect(body.tier).toBe("pro"); // trial active
    expect(body.trial.active).toBe(true);
    expect(typeof body.trial.endsAt).toBe("string");
    await app.close();
  });

  it("returns tier=free when trial has ended and user has no paid subscription", async () => {
    const { user } = await createPersonalWorkspaceWithTrial({
      clerkId: "user_expired",
      email: "exp@example.com",
      displayName: "Exp",
    });
    // Force trial expiry by writing past endsAt.
    const { prisma } = await import("../src/db.js");
    await prisma.user.update({
      where: { id: user.id },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });

    const app = await buildApp(env);
    const token = makeFakeJwt({ sub: "user_expired", email: "exp@example.com" });
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tier).toBe("free");
    expect(res.json().trial.active).toBe(false);
    await app.close();
  });

  it("returns 404 when authenticated user has no workspace yet", async () => {
    const app = await buildApp(env);
    const token = makeFakeJwt({ sub: "user_orphan", email: "orphan@example.com" });
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "no_workspace" });
    await app.close();
  });
});
```

- [ ] **Step 6: Implement `apps/api/src/routes/me.ts`**

```ts
import type { FastifyInstance } from "fastify";
import type { Tier } from "@fina/shared";
import { prisma } from "../db.js";

function effectiveTier(user: {
  trialEndsAt: Date | null;
  trialConsumed: boolean;
}): { tier: Tier; trialActive: boolean; trialEndsAt: Date | null } {
  const now = new Date();
  if (user.trialEndsAt && user.trialEndsAt > now) {
    return { tier: "pro", trialActive: true, trialEndsAt: user.trialEndsAt };
  }
  // Plan 7 (Phase 2) wires real subscriptions; for now, post-trial = free.
  return { tier: "free", trialActive: false, trialEndsAt: user.trialEndsAt };
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "unauthenticated" });

    const user = await prisma.user.findUnique({
      where: { clerkId: req.auth.clerkId },
      include: {
        memberships: { include: { workspace: true }, where: { role: "owner" }, take: 1 },
      },
    });
    if (!user) return reply.code(404).send({ error: "no_user" });
    const m = user.memberships[0];
    if (!m) return reply.code(404).send({ error: "no_workspace" });

    const { tier, trialActive, trialEndsAt } = effectiveTier(user);

    return {
      user: { id: user.id, email: user.email, tz: user.tz, locale: user.locale },
      workspace: { id: m.workspace.id, name: m.workspace.name, role: m.role },
      tier,
      trial: {
        active: trialActive,
        endsAt: trialEndsAt?.toISOString() ?? null,
      },
    };
  });
}
```

- [ ] **Step 7: Register `/me` in `apps/api/src/server.ts`**

Add import:
```ts
import { meRoutes } from "./routes/me.js";
```

Register after `healthRoutes`:
```ts
await app.register(meRoutes);
```

- [ ] **Step 8: Run /me test**

```bash
pnpm nx run api:test --testPathPattern=me
```

Expected: 3 cases PASS.

- [ ] **Step 9: Run full api suite**

```bash
pnpm nx run api:test
```

Expected: all tests PASS (`health`, `auth.clerk`, `membership`, `workspaces.bootstrap`, `me`).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/auth/membership.ts apps/api/src/routes/me.ts \
  apps/api/src/server.ts apps/api/tests/membership.test.ts apps/api/tests/me.test.ts
git commit -m "feat(api): assertMembership + GET /me with effective tier and trial state"
```

---

## Task 10: Clerk webhook → workspace bootstrap

**Files:**
- Create: `apps/api/src/webhooks/clerk.ts`, `tests/webhooks.clerk.test.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Add svix**

```bash
pnpm add -F @fina/api svix@^1.40.0
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/tests/webhooks.clerk.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Webhook } from "svix";
import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";

const WEBHOOK_SECRET = "whsec_dGVzdHNlY3JldGZvcndlYmhvb2tzaWduYXR1cmV2ZXJpZmllcg==";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  CLERK_SECRET_KEY: "sk_test_dummy",
  CLERK_PUBLISHABLE_KEY: "pk_test_dummy",
  CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

function signWebhook(body: object): { headers: Record<string, string>; raw: string } {
  const wh = new Webhook(WEBHOOK_SECRET);
  const id = "msg_test_" + Date.now();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const raw = JSON.stringify(body);
  const signature = wh.sign(id, new Date(Number(timestamp) * 1000), raw);
  return {
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
      "content-type": "application/json",
    },
    raw,
  };
}

describe("POST /webhooks/clerk", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("creates user + workspace + owner membership + 30d trial on user.created", async () => {
    const app = await buildApp(env);
    const body = {
      type: "user.created",
      data: {
        id: "user_clerk_webhook_1",
        email_addresses: [{ email_address: "wh@example.com" }],
        first_name: "WH",
        last_name: "User",
      },
    };
    const { headers, raw } = signWebhook(body);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/clerk",
      headers,
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    const u = await prisma.user.findUnique({ where: { clerkId: "user_clerk_webhook_1" } });
    expect(u?.email).toBe("wh@example.com");
    expect(u?.trialStartedAt).not.toBeNull();
    expect(u?.trialEndsAt).not.toBeNull();
    const memberships = await prisma.membership.findMany({ where: { userId: u!.id } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("owner");
    await app.close();
  });

  it("rejects request with invalid signature", async () => {
    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/clerk",
      headers: {
        "svix-id": "msg_bad",
        "svix-timestamp": Math.floor(Date.now() / 1000).toString(),
        "svix-signature": "v1,wrongsignature",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ type: "user.created", data: { id: "x" } }),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("ignores non-user.created event types", async () => {
    const app = await buildApp(env);
    const body = { type: "user.updated", data: { id: "x" } };
    const { headers, raw } = signWebhook(body);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/clerk",
      headers,
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(await prisma.user.count()).toBe(0);
    await app.close();
  });
});
```

- [ ] **Step 3: Run test (expect failure)**

```bash
pnpm nx run api:test --testPathPattern=webhooks.clerk
```

Expected: FAIL — route not found.

- [ ] **Step 4: Implement `apps/api/src/webhooks/clerk.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { Webhook } from "svix";
import { z } from "zod";
import { createPersonalWorkspaceWithTrial } from "../workspaces/bootstrap.js";

const UserCreated = z.object({
  type: z.literal("user.created"),
  data: z.object({
    id: z.string(),
    email_addresses: z
      .array(z.object({ email_address: z.string().email() }))
      .min(1),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
  }),
});

const AnyEvent = z.object({ type: z.string() });

export function clerkWebhookRoutes(secret: string) {
  return async function (app: FastifyInstance): Promise<void> {
    app.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_req, body, done) => {
        try {
          done(null, body);
        } catch (err) {
          done(err as Error);
        }
      },
    );

    app.post("/webhooks/clerk", async (req, reply) => {
      const id = req.headers["svix-id"];
      const timestamp = req.headers["svix-timestamp"];
      const signature = req.headers["svix-signature"];
      if (typeof id !== "string" || typeof timestamp !== "string" || typeof signature !== "string") {
        return reply.code(401).send({ error: "missing_signature_headers" });
      }
      const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      let parsed: unknown;
      try {
        parsed = new Webhook(secret).verify(raw, {
          "svix-id": id,
          "svix-timestamp": timestamp,
          "svix-signature": signature,
        });
      } catch {
        return reply.code(401).send({ error: "invalid_signature" });
      }

      const head = AnyEvent.safeParse(parsed);
      if (!head.success) return reply.code(400).send({ error: "bad_payload" });

      if (head.data.type !== "user.created") {
        return { ignored: true };
      }

      const event = UserCreated.safeParse(parsed);
      if (!event.success) {
        return reply.code(400).send({ error: "bad_user_created_payload" });
      }
      const { id: clerkId, email_addresses, first_name, last_name } = event.data.data;
      const email = email_addresses[0]!.email_address;
      const displayName = [first_name ?? "", last_name ?? ""].join(" ").trim();

      await createPersonalWorkspaceWithTrial({ clerkId, email, displayName });
      return { ok: true };
    });
  };
}
```

- [ ] **Step 5: Register in `apps/api/src/server.ts`**

Add import:
```ts
import { clerkWebhookRoutes } from "./webhooks/clerk.js";
```

Register before `authPlugin` so the order is explicit (auth plugin already exempts `/webhooks/*`):

```ts
await app.register(sensible);
await app.register(clerkWebhookRoutes(env.CLERK_WEBHOOK_SECRET));
await app.register(
  authPlugin({
    clerkSecretKey: env.CLERK_SECRET_KEY,
    testJwtSecret: env.NODE_ENV === "test" ? "test-secret-do-not-use-in-prod" : undefined,
  }),
);
await app.register(healthRoutes);
await app.register(meRoutes);
```

- [ ] **Step 6: Run webhook test**

```bash
pnpm nx run api:test --testPathPattern=webhooks.clerk
```

Expected: 3 cases PASS.

- [ ] **Step 7: Run full api suite**

```bash
pnpm nx run api:test
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/webhooks/ apps/api/src/server.ts \
  apps/api/tests/webhooks.clerk.test.ts pnpm-lock.yaml
git commit -m "feat(api): Clerk user.created webhook with svix verification + trial start"
```

---

## Task 11: Mobile app scaffold (Expo + Clerk)

**Files:**
- Create via generator: `apps/mobile/`
- Replace: app router files, env, api client

- [ ] **Step 1: Generate the Expo app**

```bash
pnpm add -Dw @nx/expo@19
pnpm nx g @nx/expo:application mobile --directory=apps/mobile --e2eTestRunner=none --linter=eslint --no-interactive
```

This creates `apps/mobile/{App.tsx,app.json,babel.config.js,project.json,tsconfig.*.json}`.

- [ ] **Step 2: Add deps**

```bash
pnpm add -F @fina/mobile @clerk/clerk-expo@^2.6.0 expo-router@~5.0.0 \
  expo-secure-store@~14.0.0 expo-status-bar@~2.0.0 \
  react-native-safe-area-context@5.4.0 react-native-screens@~4.4.0 zod@^3.23.8
pnpm add -F @fina/mobile @fina/shared@workspace:*
```

- [ ] **Step 3: Switch to Expo Router**

Edit `apps/mobile/package.json` — set `"main": "expo-router/entry"` (replacing the default Expo entry).

Update `apps/mobile/app.json` — within `"expo"`, ensure:

```json
{
  "expo": {
    "name": "Fina",
    "slug": "fina",
    "scheme": "fina",
    "version": "0.0.1",
    "orientation": "portrait",
    "userInterfaceStyle": "automatic",
    "ios": { "supportsTablet": false, "bundleIdentifier": "app.fina.dev" },
    "android": { "package": "app.fina.dev" },
    "plugins": ["expo-router", "expo-secure-store"],
    "experiments": { "typedRoutes": true }
  }
}
```

Delete the generated `App.tsx` (Expo Router replaces it).

- [ ] **Step 4: Create `apps/mobile/src/env.ts`**

```ts
import { z } from "zod";

const Schema = z.object({
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  EXPO_PUBLIC_API_URL: z.string().url(),
});

export const env = Schema.parse({
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
  EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
});
```

- [ ] **Step 5: Create `apps/mobile/src/api/client.ts`**

```ts
import { env } from "../env";

export type FetchAuth = { getToken: () => Promise<string | null> };

export async function apiFetch<T>(
  auth: FetchAuth,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await auth.getToken();
  const res = await fetch(`${env.EXPO_PUBLIC_API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
```

- [ ] **Step 6: Create router files**

`apps/mobile/app/_layout.tsx`:
```tsx
import { ClerkProvider, ClerkLoaded } from "@clerk/clerk-expo";
import { tokenCache } from "@clerk/clerk-expo/token-cache";
import { Stack } from "expo-router";
import { env } from "../src/env";

export default function RootLayout() {
  return (
    <ClerkProvider tokenCache={tokenCache} publishableKey={env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY}>
      <ClerkLoaded>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="(auth)/sign-in" />
        </Stack>
      </ClerkLoaded>
    </ClerkProvider>
  );
}
```

`apps/mobile/app/index.tsx`:
```tsx
import { Redirect } from "expo-router";
import { useAuth } from "@clerk/clerk-expo";

export default function Index() {
  const { isSignedIn, isLoaded } = useAuth();
  if (!isLoaded) return null;
  return isSignedIn ? <Redirect href="/(tabs)" /> : <Redirect href="/(auth)/sign-in" />;
}
```

`apps/mobile/app/(auth)/sign-in.tsx`:
```tsx
import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useSignIn, useSignUp } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";

export default function SignInScreen() {
  const { signIn, setActive: setSignInActive, isLoaded: signInLoaded } = useSignIn();
  const { signUp, setActive: setSignUpActive, isLoaded: signUpLoaded } = useSignUp();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function startEmail() {
    if (!signInLoaded || !signUpLoaded) return;
    setBusy(true);
    setErr(null);
    try {
      try {
        const su = await signUp.create({ emailAddress: email });
        await su.prepareEmailAddressVerification({ strategy: "email_code" });
        setStage("code");
      } catch {
        const si = await signIn.create({ identifier: email });
        const factor = si.supportedFirstFactors?.find((f) => f.strategy === "email_code");
        if (!factor) throw new Error("Email not supported on this account");
        await si.prepareFirstFactor({ strategy: "email_code", emailAddressId: factor.emailAddressId });
        setStage("code");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to start sign-in");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setErr(null);
    try {
      if (signUp?.status === "missing_requirements") {
        const result = await signUp.attemptEmailAddressVerification({ code });
        if (result.status === "complete") {
          await setSignUpActive({ session: result.createdSessionId! });
          router.replace("/(tabs)");
          return;
        }
      }
      if (signIn) {
        const result = await signIn.attemptFirstFactor({ strategy: "email_code", code });
        if (result.status === "complete") {
          await setSignInActive({ session: result.createdSessionId! });
          router.replace("/(tabs)");
          return;
        }
      }
      throw new Error("Verification incomplete");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Fina</Text>
      <Text style={styles.subtitle}>Your AI financial advisor</Text>
      {stage === "email" ? (
        <>
          <TextInput
            style={styles.input}
            placeholder="email@example.com"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <Pressable style={styles.button} disabled={busy || !email} onPress={startEmail}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Continue</Text>}
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.hint}>We sent a code to {email}</Text>
          <TextInput
            style={styles.input}
            placeholder="6-digit code"
            keyboardType="number-pad"
            value={code}
            onChangeText={setCode}
          />
          <Pressable style={styles.button} disabled={busy || code.length < 4} onPress={verify}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Verify</Text>}
          </Pressable>
        </>
      )}
      {err && <Text style={styles.error}>{err}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#fff" },
  title: { fontSize: 36, fontWeight: "700", marginBottom: 4 },
  subtitle: { fontSize: 14, opacity: 0.6, marginBottom: 32 },
  hint: { fontSize: 14, marginBottom: 12, opacity: 0.7 },
  input: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 14, fontSize: 16, marginBottom: 12 },
  button: { backgroundColor: "#111", borderRadius: 8, padding: 14, alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  error: { color: "#c00", marginTop: 12 },
});
```

`apps/mobile/app/(tabs)/_layout.tsx`:
```tsx
import { Tabs } from "expo-router";

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: "Home" }} />
    </Tabs>
  );
}
```

`apps/mobile/app/(tabs)/index.tsx`:
```tsx
import { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import { useAuth, useUser } from "@clerk/clerk-expo";
import { apiFetch } from "../../src/api/client";

type Me = {
  user: { id: string; email: string; tz: string; locale: string };
  workspace: { id: string; name: string; role: string };
  tier: "free" | "lite" | "pro";
  trial: { active: boolean; endsAt: string | null };
};

export default function Home() {
  const { signOut, getToken } = useAuth();
  const { user } = useUser();
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Me>({ getToken: () => getToken() }, "/me")
      .then((m) => { if (!cancelled) setMe(m); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [getToken]);

  return (
    <View style={styles.root}>
      <Text style={styles.h1}>Welcome{user?.firstName ? `, ${user.firstName}` : ""}</Text>
      {!me && !err && <ActivityIndicator />}
      {err && <Text style={styles.err}>Could not reach API: {err}</Text>}
      {me && (
        <View style={styles.card}>
          <Text style={styles.label}>Workspace</Text>
          <Text style={styles.value}>{me.workspace.name}</Text>
          <Text style={styles.label}>Role</Text>
          <Text style={styles.value}>{me.workspace.role}</Text>
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
  btn: { padding: 14, borderRadius: 8, borderWidth: 1, borderColor: "#ddd", alignItems: "center" },
  btnText: { fontSize: 16 },
});
```

- [ ] **Step 7: Install workspace**

```bash
pnpm install
```

- [ ] **Step 8: Manual smoke test**

Prereqs:
1. Clerk dev project at clerk.com — copy `pk_test_...` into both `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_PUBLISHABLE_KEY`. Copy `sk_test_...` into `CLERK_SECRET_KEY`.
2. Add a Clerk webhook (`user.created` event) pointing at `https://YOUR_TUNNEL/webhooks/clerk`. Use ngrok or cloudflared:
   ```bash
   ngrok http 4000
   ```
   Update Clerk webhook URL with the tunnel URL. Copy webhook signing secret into `CLERK_WEBHOOK_SECRET`.

Run:
```bash
# terminal 1
pnpm nx run api:dev

# terminal 2 (different port for tunnel) — see Prereq 2

# terminal 3
pnpm nx run mobile:start
# press 'i' for iOS sim or 'a' for Android, or scan QR with Expo Go
```

Verify:
1. Mobile app opens to sign-in.
2. Enter email → receive 6-digit code → verify.
3. Lands on home, displays workspace name + role `owner` + tier `PRO` + "Pro trial active — ends ..." line.
4. Backend logs show `/webhooks/clerk` 200 followed by `/me` 200.

If tier shows `FREE` and trial.active is false, the webhook didn't fire — check ngrok URL in Clerk dashboard.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/ pnpm-lock.yaml package.json
git commit -m "feat(mobile): scaffold Expo app with Clerk + /me home screen"
```

---

## Task 12: Web app scaffold (Next.js + Clerk)

**Files:**
- Create via generator: `apps/web/`
- Create router files, middleware, env, api client

- [ ] **Step 1: Generate the Next.js app**

```bash
pnpm add -Dw @nx/next@19
pnpm nx g @nx/next:application web --directory=apps/web --appDir=true --src=true --style=css --linter=eslint --unitTestRunner=none --e2eTestRunner=none --no-interactive
```

This creates `apps/web/{src/app/{layout.tsx,page.tsx},next.config.js,project.json,tsconfig*.json}`.

- [ ] **Step 2: Add Clerk + shared deps**

```bash
pnpm add -F @fina/web @clerk/nextjs@^6.0.0 zod@^3.23.8
pnpm add -F @fina/web @fina/shared@workspace:*
```

- [ ] **Step 3: Create `apps/web/src/env.ts`**

```ts
import { z } from "zod";

const Schema = z.object({
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_API_URL: z.string().url(),
});

export const env = Schema.parse({
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});
```

- [ ] **Step 4: Create `apps/web/middleware.ts`**

```ts
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher(["/home(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
```

- [ ] **Step 5: Replace `apps/web/src/app/layout.tsx`**

```tsx
import { ClerkProvider } from "@clerk/nextjs";
import "./global.css";

export const metadata = {
  title: "Fina",
  description: "AI Financial Advisor",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
```

(If the generator created `apps/web/src/app/global.css` already, leave it. If not, create an empty one.)

- [ ] **Step 6: Replace `apps/web/src/app/page.tsx` (marketing landing → /home redirect for signed-in)**

```tsx
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function Landing() {
  const { userId } = await auth();
  if (userId) redirect("/home");
  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 48, marginBottom: 16 }}>Fina</h1>
      <p style={{ fontSize: 18, opacity: 0.7, marginBottom: 32 }}>
        AI Financial Advisor — chat with your money.
      </p>
      <Link
        href="/sign-in"
        style={{
          display: "inline-block",
          background: "#111",
          color: "#fff",
          padding: "12px 24px",
          borderRadius: 8,
          textDecoration: "none",
        }}
      >
        Sign in
      </Link>
    </main>
  );
}
```

- [ ] **Step 7: Create sign-in / sign-up route stubs**

`apps/web/src/app/sign-in/[[...sign-in]]/page.tsx`:
```tsx
import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return (
    <main style={{ display: "flex", justifyContent: "center", padding: 64 }}>
      <SignIn signUpUrl="/sign-up" forceRedirectUrl="/home" />
    </main>
  );
}
```

`apps/web/src/app/sign-up/[[...sign-up]]/page.tsx`:
```tsx
import { SignUp } from "@clerk/nextjs";

export default function Page() {
  return (
    <main style={{ display: "flex", justifyContent: "center", padding: 64 }}>
      <SignUp signInUrl="/sign-in" forceRedirectUrl="/home" />
    </main>
  );
}
```

- [ ] **Step 8: Create `apps/web/src/app/(app)/home/page.tsx`**

```tsx
import { auth } from "@clerk/nextjs/server";
import { env } from "../../../env";
import { SignOutButton } from "@clerk/nextjs";

type Me = {
  user: { id: string; email: string; tz: string; locale: string };
  workspace: { id: string; name: string; role: string };
  tier: "free" | "lite" | "pro";
  trial: { active: boolean; endsAt: string | null };
};

async function fetchMe(token: string): Promise<Me> {
  const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/me`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export default async function HomePage() {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) {
    return <main style={{ padding: 32 }}>Not signed in.</main>;
  }
  let me: Me;
  try {
    me = await fetchMe(token);
  } catch (e) {
    return (
      <main style={{ padding: 32 }}>
        <p style={{ color: "#c00" }}>Could not reach API: {e instanceof Error ? e.message : String(e)}</p>
      </main>
    );
  }
  return (
    <main style={{ padding: 32, fontFamily: "system-ui", maxWidth: 600 }}>
      <h1 style={{ fontSize: 32, marginBottom: 24 }}>Welcome</h1>
      <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 16, marginBottom: 24 }}>
        <div style={{ fontSize: 12, opacity: 0.5 }}>Workspace</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{me.workspace.name}</div>
        <div style={{ fontSize: 12, opacity: 0.5, marginTop: 8 }}>Role</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{me.workspace.role}</div>
        <div style={{ fontSize: 12, opacity: 0.5, marginTop: 8 }}>Tier</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{me.tier.toUpperCase()}</div>
        {me.trial.active && (
          <div style={{ fontSize: 12, marginTop: 12, color: "#0a7" }}>
            Pro trial active — ends {new Date(me.trial.endsAt!).toLocaleDateString()}
          </div>
        )}
      </div>
      <SignOutButton>
        <button style={{ padding: "12px 24px", borderRadius: 8, border: "1px solid #ddd" }}>
          Sign out
        </button>
      </SignOutButton>
    </main>
  );
}
```

- [ ] **Step 9: Add Clerk redirect env vars to `apps/web/.env.local.example`**

If Nx's generator already created `apps/web/.env.local`, add to it (and also document in root `.env.example`):

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
NEXT_PUBLIC_API_URL=http://localhost:4000
```

The redirect URLs (`/sign-in`, `/sign-up`, `/home`) are passed inline via Clerk component props above; no env required.

- [ ] **Step 10: Smoke test**

```bash
pnpm install
pnpm nx run web:dev
# open http://localhost:3000 in a browser
```

Verify:
1. Landing page shows "Sign in" link.
2. Click sign-in → Clerk-hosted form.
3. Sign up with a new email → 6-digit code → verify.
4. Lands on `/home` showing workspace name + role + tier `PRO` + trial active line.
5. Sign-out button returns to landing.

If Clerk webhook is configured (from Task 11 manual smoke test), the same backend records show through both clients.

- [ ] **Step 11: Commit**

```bash
git add apps/web/ pnpm-lock.yaml package.json
git commit -m "feat(web): scaffold Next.js with Clerk + /home showing /me"
```

---

## Task 13: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: CI

on:
  push:
    branches: [main, master]
  pull_request:

jobs:
  affected:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: fina
          POSTGRES_PASSWORD: fina
          POSTGRES_DB: fina
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U fina"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      DATABASE_URL: postgresql://fina:fina@localhost:5432/fina_test
      CLERK_SECRET_KEY: sk_test_dummy
      CLERK_PUBLISHABLE_KEY: pk_test_dummy
      CLERK_WEBHOOK_SECRET: whsec_dGVzdHNlY3JldGZvcndlYmhvb2tzaWduYXR1cmV2ZXJpZmllcg==
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: pk_test_dummy
      EXPO_PUBLIC_API_URL: http://localhost:4000
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: pk_test_dummy
      NEXT_PUBLIC_API_URL: http://localhost:4000

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.3

      - uses: actions/setup-node@v4
        with:
          node-version: 20.18.0
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Create test DB
        run: PGPASSWORD=fina psql -h localhost -U fina -c "CREATE DATABASE fina_test;" postgres

      - run: pnpm nx run api:db:generate
      - run: pnpm nx run api:db:deploy

      - name: Lint
        run: pnpm nx run-many -t lint --base=origin/main --head=HEAD
      - name: Typecheck
        run: pnpm nx run-many -t typecheck --base=origin/main --head=HEAD
      - name: Test
        run: pnpm nx run-many -t test --base=origin/main --head=HEAD
```

For pushes to `main` (no diff base), Nx falls back to running across all projects.

- [ ] **Step 2: Commit and push**

```bash
git add .github/
git commit -m "ci: add Nx affected lint + typecheck + test workflow"
```

After pushing to GitHub (a remote must already be set up by the user), confirm the workflow is green on the first run.

---

## Task 14: Final verification

- [ ] **Step 1: Local end-to-end**

Fresh checkout simulation:
```bash
docker compose down -v
docker compose up -d
pnpm install --frozen-lockfile
pnpm nx run api:db:generate
pnpm nx run api:db:deploy
pnpm nx run-many -t typecheck
pnpm nx run-many -t lint
pnpm nx run-many -t test
```

All steps pass.

- [ ] **Step 2: Manual e2e on both clients**

Run the manual smoke test from Task 11 Step 8 (mobile) and Task 12 Step 10 (web). Sign up with a fresh email; verify on each client:
1. Workspace name correct.
2. Role = `owner`.
3. Tier = `PRO` and trial active line visible.
4. Sign out, sign back in (same email) → same workspace.

Confirm in Postgres:
```sql
SELECT id, email, "trialEndsAt", "trialConsumed" FROM users;
SELECT * FROM memberships;
```
- One User row per signup; `trialEndsAt` ~30 days from now; `trialConsumed` = false.
- One Membership with `role = 'owner'` per user.

- [ ] **Step 3: Update root README with status**

Append to `README.md`:
```markdown
## Status — 2026-05-08

- ✅ Plan 1 complete: Nx workspace, Postgres, Fastify API with Clerk JWT, workspace bootstrap with 30-day Pro trial, Expo mobile + Next.js web both rendering /me, CI green.
- 🚧 Next: Plan 2 — workspace sharing (invites + roles + switcher).
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: mark Plan 1 complete and roadmap pointer"
```

---

## Done — Plan 1 Exit Criteria

- [ ] `pnpm nx run-many -t test` green: api tests cover health, auth.clerk, membership, workspaces.bootstrap, me, webhooks.clerk.
- [ ] `pnpm nx run-many -t typecheck` green across api, mobile, web, shared.
- [ ] `pnpm nx run-many -t lint` green.
- [ ] CI green on push.
- [ ] Mobile app: email sign-up → home displays workspace + role + tier `PRO` + trial active line.
- [ ] Web app: same flow at `localhost:3000`.
- [ ] DB: every signed-up Clerk user has exactly one User row (with non-null trial fields), one Workspace row, one Membership row with role=owner.
- [ ] Re-sign-in does not duplicate User/Workspace and does not restart the trial.

When all checked, move to **Plan 2: Workspace Sharing (Phase 1.5)**.
