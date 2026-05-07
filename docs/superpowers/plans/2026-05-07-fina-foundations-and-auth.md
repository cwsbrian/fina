# Fina — Foundations & Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable Fina monorepo where a user can sign up via Clerk on the Expo mobile app, automatically gets a personal Workspace, and can call an authenticated `/me` endpoint that returns their user + workspace info. CI passes. Service-layer authorization patterns from spec §10 are baked in from day one.

**Architecture:** pnpm + Turborepo monorepo. `apps/api` runs Fastify+Prisma against Postgres. `apps/mobile` is Expo Router with Clerk authentication. `packages/shared` holds cross-package types. Backend validates Clerk JWTs via middleware and creates a User+Workspace+Membership tuple via a Clerk webhook on `user.created`. Every authenticated route resolves the caller's workspace via `assertMembership(user_id, workspace_id, role)` so v2 multi-workspace adds no new auth code.

**Tech Stack:** TypeScript everywhere. Backend: Fastify, Prisma, Postgres, Zod, Vitest, Clerk SDK. Mobile: Expo SDK 53, Expo Router, `@clerk/clerk-expo`. Tooling: pnpm, Turborepo, ESLint, Prettier, GitHub Actions.

**Spec reference:** `docs/superpowers/specs/2026-05-07-fina-design.md` — sections 4 (Multi-Tenancy), 9 (Tech Stack — repo structure), 10 (Authorization & Service Layer Rules), 14 (Phase 1A — Foundations).

**Out of scope for this plan (later plans cover them):**
- Categories, accounts, transactions, budgets — Plan 2
- Chat threads/messages, LLM, redaction layer — Plan 3
- Plaid integration — Plan 4
- Tool execution + action_intents — Plan 5
- Daily ritual + push — Plan 6
- Forecasting/advisor — Plan 7

---

## File Structure

```
fina/
├── package.json                  # workspace root, devDependencies, scripts
├── pnpm-workspace.yaml           # workspace globs
├── turbo.json                    # task graph
├── tsconfig.base.json            # shared compiler options
├── .editorconfig
├── .gitignore
├── .nvmrc
├── .prettierrc.json
├── .eslintrc.cjs
├── docker-compose.yml            # Postgres for local dev
├── .env.example                  # template for required env vars
├── README.md                     # one-pager: how to run dev
├── .github/
│   └── workflows/
│       └── ci.yml                # lint + typecheck + test
├── packages/
│   └── shared/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts          # barrel
│           ├── ids.ts            # branded ID types (UserId, WorkspaceId)
│           └── roles.ts          # Role enum, helper guards
├── apps/
│   ├── api/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   ├── prisma/
│   │   │   ├── schema.prisma     # User, Workspace, Membership
│   │   │   └── seed.ts           # placeholder (no seed yet for this plan)
│   │   ├── src/
│   │   │   ├── env.ts            # zod-validated env
│   │   │   ├── db.ts             # Prisma client singleton
│   │   │   ├── server.ts         # Fastify app builder + start
│   │   │   ├── auth/
│   │   │   │   ├── clerk.ts      # JWT verification, decorate request
│   │   │   │   └── membership.ts # assertMembership(user, ws, role)
│   │   │   ├── routes/
│   │   │   │   ├── health.ts     # GET /health (no auth)
│   │   │   │   └── me.ts         # GET /me (auth required)
│   │   │   ├── webhooks/
│   │   │   │   └── clerk.ts      # POST /webhooks/clerk (user.created)
│   │   │   └── workspaces/
│   │   │       └── bootstrap.ts  # createPersonalWorkspace(userId)
│   │   └── tests/
│   │       ├── helpers/
│   │       │   ├── db.ts         # truncate helpers, test transaction
│   │       │   └── auth.ts       # fake Clerk JWT for tests
│   │       ├── health.test.ts
│   │       ├── me.test.ts
│   │       ├── membership.test.ts
│   │       └── webhooks.clerk.test.ts
│   └── mobile/
│       ├── package.json
│       ├── tsconfig.json
│       ├── app.json              # Expo config
│       ├── babel.config.js
│       ├── app/
│       │   ├── _layout.tsx       # ClerkProvider wrapper
│       │   ├── (auth)/
│       │   │   └── sign-in.tsx
│       │   ├── (tabs)/
│       │   │   ├── _layout.tsx
│       │   │   └── index.tsx     # home: shows /me result
│       │   └── index.tsx         # router redirect
│       └── src/
│           ├── api/
│           │   └── client.ts     # fetch helper with Clerk token
│           └── env.ts            # EXPO_PUBLIC_* validation
```

**Why this layout:**
- `packages/shared` exists from day one so future tool definitions / block schemas / Zod validators have a home.
- `apps/api/src/auth/` is a directory not a single file because authorization is going to grow (membership + later role guards + plaid item ownership). Splitting now keeps later changes localized.
- `apps/api/src/workspaces/bootstrap.ts` is a service-layer function, not a route, so it can be reused by webhook + tests + future admin tooling.
- All tests in `apps/api/tests/` mirror `src/` paths so engineers can find the test for any file.

---

## Task 1: Monorepo bootstrap

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.editorconfig`
- Create: `.gitignore`
- Create: `.nvmrc`
- Create: `.prettierrc.json`
- Create: `.eslintrc.cjs`
- Create: `README.md`

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "fina",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@9.12.3",
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "@types/node": "^20.16.5",
    "eslint": "^9.13.0",
    "prettier": "^3.3.3",
    "turbo": "^2.2.3",
    "typescript": "^5.6.3"
  },
  "engines": {
    "node": ">=20.18.0",
    "pnpm": ">=9.12.0"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalEnv": ["NODE_ENV"],
  "globalPassThroughEnv": [
    "DATABASE_URL",
    "CLERK_SECRET_KEY",
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_WEBHOOK_SECRET",
    "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "EXPO_PUBLIC_API_URL"
  ],
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {},
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["^build"]
    }
  }
}
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false
  }
}
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
.turbo/
.next/
dist/
build/
coverage/
.env
.env.local
.env.*.local
!.env.example
*.log
.DS_Store
.expo/
.expo-shared/
ios/Pods/
android/build/
android/app/build/
.vscode/
.idea/
```

- [ ] **Step 6: Create `.nvmrc`, `.editorconfig`, `.prettierrc.json`, `.eslintrc.cjs`**

`.nvmrc`:
```
20.18.0
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
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  },
  ignorePatterns: ["dist/", "node_modules/", "*.config.*", ".eslintrc.cjs"],
};
```

Add ESLint plugin deps to root `package.json`:
```bash
pnpm add -Dw @typescript-eslint/parser @typescript-eslint/eslint-plugin
```

- [ ] **Step 7: Create initial `README.md`**

```markdown
# Fina

AI Financial Advisor (chat-first). See `docs/superpowers/specs/2026-05-07-fina-design.md`.

## Dev Setup

Requires Node 20.18+, pnpm 9.12+, Docker.

```bash
nvm use
pnpm install
docker compose up -d         # starts Postgres on :5432
cp .env.example .env         # fill in CLERK_* keys
pnpm --filter @fina/api prisma migrate dev
pnpm dev
```

## Workspaces

- `apps/api` — Fastify backend
- `apps/mobile` — Expo React Native app
- `packages/shared` — shared types
```

- [ ] **Step 8: Run `pnpm install` smoke test**

Run: `pnpm install`
Expected: succeeds with no apps installed yet (workspace globs find nothing → warning OK).

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json \
  .editorconfig .gitignore .nvmrc .prettierrc.json .eslintrc.cjs README.md \
  pnpm-lock.yaml
git commit -m "chore: bootstrap pnpm + turborepo monorepo"
```

---

## Task 2: `packages/shared` scaffold

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/ids.ts`
- Create: `packages/shared/src/roles.ts`

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@fina/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "build": "tsc -b",
    "lint": "eslint src",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.6.3"
  }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/shared/src/ids.ts`**

```ts
type Brand<T, B> = T & { readonly __brand: B };

export type UserId = Brand<string, "UserId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type MembershipId = Brand<string, "MembershipId">;

export const userId = (s: string): UserId => s as UserId;
export const workspaceId = (s: string): WorkspaceId => s as WorkspaceId;
export const membershipId = (s: string): MembershipId => s as MembershipId;
```

- [ ] **Step 4: Create `packages/shared/src/roles.ts`**

```ts
export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export function hasAtLeast(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
```

- [ ] **Step 5: Create `packages/shared/src/index.ts` (barrel)**

```ts
export * from "./ids.js";
export * from "./roles.js";
```

- [ ] **Step 6: Verify typecheck**

Run: `pnpm --filter @fina/shared typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/
git commit -m "chore(shared): add ids and role types package"
```

---

## Task 3: Postgres dev container

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

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
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U fina"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  fina-postgres:
```

- [ ] **Step 2: Create `.env.example`**

```bash
# Backend
DATABASE_URL=postgresql://fina:fina@localhost:5432/fina
NODE_ENV=development
PORT=4000

# Clerk (get from dashboard.clerk.com)
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
CLERK_WEBHOOK_SECRET=whsec_...

# Mobile (Expo public)
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
EXPO_PUBLIC_API_URL=http://localhost:4000
```

- [ ] **Step 3: Smoke test Docker**

Run: `docker compose up -d && docker compose ps`
Expected: `fina-postgres` is up and healthy.

Run: `docker compose exec postgres psql -U fina -c "SELECT 1"`
Expected: returns `1`.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "chore: add Postgres dev container and env template"
```

---

## Task 4: `apps/api` Fastify scaffold

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/src/env.ts`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/tests/health.test.ts`

- [ ] **Step 1: Create `apps/api/package.json`**

```json
{
  "name": "@fina/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/server.js",
  "scripts": {
    "build": "tsc -b",
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "lint": "eslint src tests",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@fina/shared": "workspace:*",
    "fastify": "^5.0.0",
    "@fastify/sensible": "^6.0.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.16.5",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```

- [ ] **Step 2: Create `apps/api/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true,
    "declaration": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../../packages/shared" }]
}
```

- [ ] **Step 3: Create `apps/api/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: [],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
```

- [ ] **Step 4: Create `apps/api/src/env.ts`**

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

- [ ] **Step 5: Create `apps/api/src/routes/health.ts`**

```ts
import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok", time: new Date().toISOString() }));
}
```

- [ ] **Step 6: Create `apps/api/src/server.ts`**

```ts
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { loadEnv, type Env } from "./env.js";
import { healthRoutes } from "./routes/health.js";

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : { level: "info" },
  });

  await app.register(sensible);
  await app.register(healthRoutes);

  return app;
}

async function start(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);
  await app.listen({ host: "0.0.0.0", port: env.PORT });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 7: Write the failing test for /health**

`apps/api/tests/health.test.ts`:
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

- [ ] **Step 8: Run tests**

Run: `pnpm --filter @fina/api install && pnpm --filter @fina/api test`
Expected: PASS (test exercises the just-implemented route).

- [ ] **Step 9: Commit**

```bash
git add apps/api/ pnpm-lock.yaml
git commit -m "feat(api): scaffold Fastify with /health and zod env validation"
```

---

## Task 5: Prisma schema (User, Workspace, Membership)

**Files:**
- Create: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/seed.ts`
- Modify: `apps/api/package.json` (add prisma deps + scripts)
- Create: `apps/api/src/db.ts`

- [ ] **Step 1: Add Prisma deps**

```bash
pnpm --filter @fina/api add @prisma/client
pnpm --filter @fina/api add -D prisma
```

- [ ] **Step 2: Add Prisma scripts to `apps/api/package.json`**

Add inside `"scripts"`:
```json
"prisma": "prisma",
"db:generate": "prisma generate",
"db:migrate": "prisma migrate dev",
"db:push": "prisma db push",
"db:studio": "prisma studio"
```

And add at top level:
```json
"prisma": {
  "schema": "prisma/schema.prisma",
  "seed": "tsx prisma/seed.ts"
}
```

- [ ] **Step 3: Create `apps/api/prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id          String       @id @default(cuid())
  clerkId     String       @unique
  email       String       @unique
  tz          String       @default("America/Toronto")
  locale      String       @default("en-CA")
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  memberships Membership[]

  @@map("users")
}

model Workspace {
  id          String       @id @default(cuid())
  name        String
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  memberships Membership[]

  @@map("workspaces")
}

model Membership {
  id          String    @id @default(cuid())
  userId      String
  workspaceId String
  role        Role
  createdAt   DateTime  @default(now())
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
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

- [ ] **Step 4: Create `apps/api/prisma/seed.ts`**

```ts
async function main(): Promise<void> {
  // Plan 2 will add categories seed. Empty for now.
  console.log("Seed: nothing to do for Plan 1");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 5: Create `apps/api/src/db.ts`**

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

- [ ] **Step 6: Run initial migration**

Run with `.env` populated and Postgres up:
```bash
pnpm --filter @fina/api db:migrate -- --name init_users_workspaces_memberships
```
Expected: migration created at `apps/api/prisma/migrations/<ts>_init_users_workspaces_memberships/migration.sql`, schema applied to DB, generator runs.

- [ ] **Step 7: Verify with psql**

Run: `docker compose exec postgres psql -U fina -d fina -c "\dt"`
Expected: tables `users`, `workspaces`, `memberships`, `_prisma_migrations`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/ apps/api/src/db.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add Prisma schema for users, workspaces, memberships"
```

---

## Task 6: Test database helpers

**Files:**
- Create: `apps/api/tests/helpers/db.ts`
- Modify: `apps/api/vitest.config.ts` (add setup file)
- Create: `apps/api/tests/helpers/setup.ts`

The tests need a real Postgres because Prisma against an in-memory DB is brittle. Use a separate `fina_test` database; truncate between tests.

- [ ] **Step 1: Add test DB to docker-compose.yml**

Edit `docker-compose.yml` — add a second DB by changing `POSTGRES_DB` strategy. Simpler: keep one Postgres, create test DB via init script.

Replace the `postgres` service block with:
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
```

- [ ] **Step 2: Create `scripts/init-db.sh`**

```bash
#!/bin/bash
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  CREATE DATABASE fina_test;
EOSQL
```

Make it executable:
```bash
chmod +x scripts/init-db.sh
```

- [ ] **Step 3: Recreate Postgres so init script runs**

```bash
docker compose down -v
docker compose up -d
```

Verify:
```bash
docker compose exec postgres psql -U fina -l
```
Expected: lists `fina` and `fina_test`.

- [ ] **Step 4: Add test DB env file**

Create `apps/api/.env.test`:
```bash
NODE_ENV=test
DATABASE_URL=postgresql://fina:fina@localhost:5432/fina_test
CLERK_SECRET_KEY=sk_test_unused_in_tests
CLERK_PUBLISHABLE_KEY=pk_test_unused_in_tests
CLERK_WEBHOOK_SECRET=whsec_test
```

Add to `.gitignore` exception:
```
!apps/api/.env.test
```

- [ ] **Step 5: Create `apps/api/tests/helpers/db.ts`**

```ts
import { prisma } from "../../src/db.js";

export async function truncateAll(): Promise<void> {
  // Order matters: leaf tables first.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "memberships", "workspaces", "users" RESTART IDENTITY CASCADE;',
  );
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
```

- [ ] **Step 6: Create `apps/api/tests/helpers/migrate.ts`**

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

- [ ] **Step 7: Update `apps/api/vitest.config.ts` to load `.env.test` and run migrations**

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

Loading dotenv at the top of `vitest.config.ts` mutates `process.env` before Vitest forks worker processes, and forked workers inherit env. So tests running `import { prisma } from "../src/db"` see the test DB URL.

- [ ] **Step 8: Create `apps/api/tests/helpers/global-setup.ts`**

```ts
import { ensureMigrationsApplied } from "./migrate.js";

export default function setup(): void {
  ensureMigrationsApplied();
}
```

- [ ] **Step 9: Add dotenv dep**

```bash
pnpm --filter @fina/api add -D dotenv
```

- [ ] **Step 10: Verify health test still passes against test DB context**

Run: `pnpm --filter @fina/api test`
Expected: PASS (health test doesn't touch DB but setup runs migrations harmlessly).

- [ ] **Step 11: Commit**

```bash
git add apps/api/.env.test apps/api/tests/helpers/ apps/api/vitest.config.ts \
  apps/api/package.json docker-compose.yml scripts/init-db.sh pnpm-lock.yaml
git commit -m "test(api): set up Postgres test DB with truncate helpers"
```

---

## Task 7: Workspace bootstrap service

**Files:**
- Create: `apps/api/src/workspaces/bootstrap.ts`
- Create: `apps/api/tests/workspaces.bootstrap.test.ts`

This is a pure service-layer function. Extracted now so it has one home; webhook + future admin tooling both call it.

- [ ] **Step 1: Write the failing test**

`apps/api/tests/workspaces.bootstrap.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { createPersonalWorkspace } from "../src/workspaces/bootstrap.js";
import { truncateAll, disconnect } from "./helpers/db.js";

describe("createPersonalWorkspace", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("creates user, workspace, and owner membership atomically", async () => {
    const result = await createPersonalWorkspace({
      clerkId: "user_clerk_123",
      email: "brian@example.com",
      displayName: "Brian",
    });

    expect(result.user.clerkId).toBe("user_clerk_123");
    expect(result.workspace.name).toBe("Brian's workspace");
    expect(result.membership.role).toBe("owner");

    const memberships = await prisma.membership.findMany({
      where: { userId: result.user.id },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.workspaceId).toBe(result.workspace.id);
    expect(memberships[0]?.role).toBe("owner");
  });

  it("is idempotent on duplicate clerkId — returns existing tuple", async () => {
    const first = await createPersonalWorkspace({
      clerkId: "user_dup",
      email: "dup@example.com",
      displayName: "Dup",
    });
    const second = await createPersonalWorkspace({
      clerkId: "user_dup",
      email: "dup@example.com",
      displayName: "Dup",
    });
    expect(second.user.id).toBe(first.user.id);
    expect(second.workspace.id).toBe(first.workspace.id);
    const userCount = await prisma.user.count();
    expect(userCount).toBe(1);
  });

  it("falls back to email-derived name if displayName is empty", async () => {
    const result = await createPersonalWorkspace({
      clerkId: "user_no_name",
      email: "alice@example.com",
      displayName: "",
    });
    expect(result.workspace.name).toBe("alice's workspace");
  });
});
```

- [ ] **Step 2: Run the test (expect failure)**

Run: `pnpm --filter @fina/api test workspaces.bootstrap`
Expected: FAIL — module `../src/workspaces/bootstrap` does not exist.

- [ ] **Step 3: Implement `apps/api/src/workspaces/bootstrap.ts`**

```ts
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

export type BootstrapInput = {
  clerkId: string;
  email: string;
  displayName: string;
};

export type BootstrapResult = {
  user: { id: string; clerkId: string; email: string };
  workspace: { id: string; name: string };
  membership: { id: string; userId: string; workspaceId: string; role: "owner" };
};

function deriveWorkspaceName(displayName: string, email: string): string {
  const name = displayName.trim();
  if (name.length > 0) return `${name}'s workspace`;
  const local = email.split("@")[0] ?? "personal";
  return `${local}'s workspace`;
}

export async function createPersonalWorkspace(
  input: BootstrapInput,
): Promise<BootstrapResult> {
  return await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { clerkId: input.clerkId } });
    if (existing) {
      const membership = await tx.membership.findFirstOrThrow({
        where: { userId: existing.id, role: "owner" },
        include: { workspace: true },
      });
      return {
        user: { id: existing.id, clerkId: existing.clerkId, email: existing.email },
        workspace: { id: membership.workspace.id, name: membership.workspace.name },
        membership: {
          id: membership.id,
          userId: membership.userId,
          workspaceId: membership.workspaceId,
          role: "owner",
        },
      };
    }

    const user = await tx.user.create({
      data: { clerkId: input.clerkId, email: input.email },
    });
    const workspace = await tx.workspace.create({
      data: { name: deriveWorkspaceName(input.displayName, input.email) },
    });
    const membership = await tx.membership.create({
      data: { userId: user.id, workspaceId: workspace.id, role: "owner" },
    });

    return {
      user: { id: user.id, clerkId: user.clerkId, email: user.email },
      workspace: { id: workspace.id, name: workspace.name },
      membership: {
        id: membership.id,
        userId: membership.userId,
        workspaceId: membership.workspaceId,
        role: "owner",
      },
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @fina/api test workspaces.bootstrap`
Expected: all 3 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workspaces/ apps/api/tests/workspaces.bootstrap.test.ts
git commit -m "feat(api): add createPersonalWorkspace service with idempotency"
```

---

## Task 8: Clerk JWT verification middleware

**Files:**
- Create: `apps/api/src/auth/clerk.ts`
- Create: `apps/api/tests/helpers/auth.ts`
- Create: `apps/api/tests/auth.clerk.test.ts`

Clerk issues JWTs signed with their JWKS. We verify them via `@clerk/backend`. For tests we inject a mock verifier so we don't hit Clerk's network.

- [ ] **Step 1: Add Clerk backend dep**

```bash
pnpm --filter @fina/api add @clerk/backend
```

- [ ] **Step 2: Create test auth helper `apps/api/tests/helpers/auth.ts`**

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

Add deps:
```bash
pnpm --filter @fina/api add -D jsonwebtoken @types/jsonwebtoken
```

- [ ] **Step 3: Write the failing test**

`apps/api/tests/auth.clerk.test.ts`:
```ts
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
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects request with invalid JWT", async () => {
    const app = await buildApp(env);
    const res = await app.inject({
      method: "GET",
      url: "/me",
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
  // For tests: when set, verify HS256 with this secret and skip Clerk JWKS.
  testJwtSecret?: string;
};

export function authPlugin(opts: AuthOptions) {
  return async function (app: FastifyInstance): Promise<void> {
    app.decorateRequest("auth", undefined);

    app.addHook("onRequest", async (req: FastifyRequest, reply) => {
      // Public routes:
      if (req.routeOptions.url === "/health") return;
      if (req.routeOptions.url?.startsWith("/webhooks/")) return;

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

    // Test-only diagnostic route — only registered in NODE_ENV=test.
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

Replace the body of `buildApp` with:
```ts
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { loadEnv, type Env } from "./env.js";
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

(Keep the `start()` and `isMain` blocks unchanged.)

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @fina/api test auth.clerk`
Expected: all 3 cases PASS. The whoami test relies on `process.env.NODE_ENV === "test"` which Vitest sets by default.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/ apps/api/src/server.ts apps/api/tests/auth.clerk.test.ts \
  apps/api/tests/helpers/auth.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add Clerk auth middleware with test secret bypass"
```

---

## Task 9: assertMembership helper + /me route

**Files:**
- Create: `apps/api/src/auth/membership.ts`
- Create: `apps/api/src/routes/me.ts`
- Modify: `apps/api/src/server.ts` (register /me)
- Create: `apps/api/tests/membership.test.ts`
- Create: `apps/api/tests/me.test.ts`

`assertMembership` is the v1 enforcement point for spec §10. Even if v1 has only one workspace, every authenticated route must call it before reading workspace-scoped data. This habit prevents v2 multi-workspace bugs.

- [ ] **Step 1: Write membership test**

`apps/api/tests/membership.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { assertMembership, MembershipError } from "../src/auth/membership.js";
import { createPersonalWorkspace } from "../src/workspaces/bootstrap.js";
import { truncateAll, disconnect } from "./helpers/db.js";

describe("assertMembership", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("returns membership when user is owner of workspace", async () => {
    const { user, workspace } = await createPersonalWorkspace({
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
    const { user } = await createPersonalWorkspace({
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

Run: `pnpm --filter @fina/api test membership`
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

Run: `pnpm --filter @fina/api test membership`
Expected: all 3 cases PASS.

- [ ] **Step 5: Write /me test**

`apps/api/tests/me.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { makeFakeJwt } from "./helpers/auth.js";
import { createPersonalWorkspace } from "../src/workspaces/bootstrap.js";

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

  it("returns user + workspace + role for authenticated user with workspace", async () => {
    const { user, workspace } = await createPersonalWorkspace({
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
    expect(res.json()).toEqual({
      user: { id: user.id, email: "me1@example.com", tz: "America/Toronto", locale: "en-CA" },
      workspace: { id: workspace.id, name: "Me One's workspace", role: "owner" },
    });
    await app.close();
  });

  it("returns 404 when authenticated user has no workspace yet", async () => {
    // Simulates the small race window before clerk webhook fires.
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
import { prisma } from "../db.js";

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

    return {
      user: { id: user.id, email: user.email, tz: user.tz, locale: user.locale },
      workspace: { id: m.workspace.id, name: m.workspace.name, role: m.role },
    };
  });
}
```

- [ ] **Step 7: Register /me in `apps/api/src/server.ts`**

Add import at top:
```ts
import { meRoutes } from "./routes/me.js";
```

Add registration after `healthRoutes`:
```ts
await app.register(meRoutes);
```

- [ ] **Step 8: Run /me test**

Run: `pnpm --filter @fina/api test me`
Expected: both cases PASS.

- [ ] **Step 9: Run full test suite to confirm nothing else broke**

Run: `pnpm --filter @fina/api test`
Expected: all tests PASS (health, auth, membership, workspaces.bootstrap, me).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/auth/membership.ts apps/api/src/routes/me.ts \
  apps/api/src/server.ts apps/api/tests/membership.test.ts apps/api/tests/me.test.ts
git commit -m "feat(api): add assertMembership and GET /me route"
```

---

## Task 10: Clerk webhook for user.created → workspace bootstrap

**Files:**
- Create: `apps/api/src/webhooks/clerk.ts`
- Modify: `apps/api/src/server.ts` (register webhook + skip auth)
- Create: `apps/api/tests/webhooks.clerk.test.ts`

Clerk `user.created` payload signed with Svix. Verify signature, then call `createPersonalWorkspace`.

- [ ] **Step 1: Add svix dep**

```bash
pnpm --filter @fina/api add svix
```

- [ ] **Step 2: Write the failing test**

`apps/api/tests/webhooks.clerk.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Webhook } from "svix";
import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";

// svix decodes the part after "whsec_" as base64; this string decodes to "testsecretforwebhooksignatureverifier".
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

  it("creates user + workspace + owner membership on user.created", async () => {
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

  it("ignores unknown event types", async () => {
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

Run: `pnpm --filter @fina/api test webhooks.clerk`
Expected: FAIL — route not found.

- [ ] **Step 4: Implement `apps/api/src/webhooks/clerk.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { Webhook } from "svix";
import { z } from "zod";
import { createPersonalWorkspace } from "../workspaces/bootstrap.js";

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
    // Need raw body for signature verification.
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

      await createPersonalWorkspace({ clerkId, email, displayName });
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

Register before authPlugin (so webhook path bypass isn't needed) — actually the auth plugin already exempts `/webhooks/*`. So registration order doesn't matter for behavior, but for clarity put webhooks before authPlugin in registration:

Replace registrations block in `buildApp`:
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

Run: `pnpm --filter @fina/api test webhooks.clerk`
Expected: all 3 cases PASS.

- [ ] **Step 7: Run full suite**

Run: `pnpm --filter @fina/api test`
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/webhooks/ apps/api/src/server.ts \
  apps/api/tests/webhooks.clerk.test.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add Clerk user.created webhook with svix verification"
```

---

## Task 11: Mobile app scaffold (Expo + Clerk)

**Files:**
- Create: `apps/mobile/package.json`
- Create: `apps/mobile/tsconfig.json`
- Create: `apps/mobile/app.json`
- Create: `apps/mobile/babel.config.js`
- Create: `apps/mobile/src/env.ts`
- Create: `apps/mobile/src/api/client.ts`
- Create: `apps/mobile/app/_layout.tsx`
- Create: `apps/mobile/app/index.tsx`
- Create: `apps/mobile/app/(auth)/sign-in.tsx`
- Create: `apps/mobile/app/(tabs)/_layout.tsx`
- Create: `apps/mobile/app/(tabs)/index.tsx`

Note: Mobile gets less automated test coverage in this plan (Detox/Maestro is a heavy install for one screen). The mobile app is verified manually at the end of the task. Snapshot/unit tests come in later plans when we have rich UI components.

- [ ] **Step 1: Bootstrap Expo app via SDK template**

From repo root:
```bash
cd apps && pnpm create expo-app@latest mobile --template blank-typescript --yes
cd mobile
```
Then remove the auto-installed `node_modules`/`pnpm-lock.yaml` so the workspace install will own it:
```bash
rm -rf node_modules
```

- [ ] **Step 2: Replace `apps/mobile/package.json` with workspace-friendly version**

```json
{
  "name": "@fina/mobile",
  "version": "0.0.0",
  "private": true,
  "main": "expo-router/entry",
  "scripts": {
    "dev": "expo start",
    "android": "expo start --android",
    "ios": "expo start --ios",
    "web": "expo start --web",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@clerk/clerk-expo": "^2.6.0",
    "@fina/shared": "workspace:*",
    "expo": "~53.0.0",
    "expo-router": "~5.0.0",
    "expo-secure-store": "~14.0.0",
    "expo-status-bar": "~2.0.0",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "react-native": "0.79.0",
    "react-native-safe-area-context": "5.4.0",
    "react-native-screens": "~4.4.0",
    "react-native-web": "~0.20.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@babel/core": "^7.25.2",
    "@types/react": "~19.0.10",
    "typescript": "^5.6.3"
  }
}
```

(Versions match Expo SDK 53 RN 0.79. If SDK changed, run `npx expo install --fix` to align.)

- [ ] **Step 3: Create `apps/mobile/app.json`**

```json
{
  "expo": {
    "name": "Fina",
    "slug": "fina",
    "scheme": "fina",
    "version": "0.0.1",
    "orientation": "portrait",
    "icon": "./assets/icon.png",
    "userInterfaceStyle": "automatic",
    "splash": {
      "image": "./assets/splash.png",
      "resizeMode": "contain",
      "backgroundColor": "#ffffff"
    },
    "ios": { "supportsTablet": false, "bundleIdentifier": "app.fina.dev" },
    "android": { "package": "app.fina.dev" },
    "plugins": ["expo-router", "expo-secure-store"],
    "experiments": { "typedRoutes": true }
  }
}
```

If `assets/icon.png` and `assets/splash.png` are missing from the Expo template, copy them from the template defaults (the `create-expo-app` step should have produced them).

- [ ] **Step 4: Create `apps/mobile/babel.config.js`**

```js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo"]],
  };
};
```

- [ ] **Step 5: Create `apps/mobile/tsconfig.json`**

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "paths": { "@/*": ["./*"] },
    "moduleResolution": "Bundler"
  },
  "include": ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"]
}
```

- [ ] **Step 6: Create `apps/mobile/src/env.ts`**

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

- [ ] **Step 7: Create `apps/mobile/src/api/client.ts`**

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

- [ ] **Step 8: Create `apps/mobile/app/_layout.tsx`**

```tsx
import { ClerkProvider, ClerkLoaded } from "@clerk/clerk-expo";
import { tokenCache } from "@clerk/clerk-expo/token-cache";
import { Stack } from "expo-router";
import { env } from "../src/env";

export default function RootLayout() {
  return (
    <ClerkProvider
      tokenCache={tokenCache}
      publishableKey={env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY}
    >
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

- [ ] **Step 9: Create `apps/mobile/app/index.tsx` (router redirect)**

```tsx
import { Redirect } from "expo-router";
import { useAuth } from "@clerk/clerk-expo";

export default function Index() {
  const { isSignedIn, isLoaded } = useAuth();
  if (!isLoaded) return null;
  return isSignedIn ? <Redirect href="/(tabs)" /> : <Redirect href="/(auth)/sign-in" />;
}
```

- [ ] **Step 10: Create `apps/mobile/app/(auth)/sign-in.tsx`**

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

  async function startEmailLink() {
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

  async function verifyCode() {
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
          <Pressable style={styles.button} disabled={busy || !email} onPress={startEmailLink}>
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
          <Pressable style={styles.button} disabled={busy || code.length < 4} onPress={verifyCode}>
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
  input: {
    borderWidth: 1, borderColor: "#ddd", borderRadius: 8,
    padding: 14, fontSize: 16, marginBottom: 12,
  },
  button: { backgroundColor: "#111", borderRadius: 8, padding: 14, alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  error: { color: "#c00", marginTop: 12 },
});
```

- [ ] **Step 11: Create `apps/mobile/app/(tabs)/_layout.tsx`**

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

- [ ] **Step 12: Create `apps/mobile/app/(tabs)/index.tsx`**

```tsx
import { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import { useAuth, useUser } from "@clerk/clerk-expo";
import { apiFetch } from "../../src/api/client";

type Me = {
  user: { id: string; email: string; tz: string; locale: string };
  workspace: { id: string; name: string; role: string };
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
  err: { color: "#c00", marginBottom: 16 },
  btn: { padding: 14, borderRadius: 8, borderWidth: 1, borderColor: "#ddd", alignItems: "center" },
  btnText: { fontSize: 16 },
});
```

- [ ] **Step 13: Install workspace-aware**

Back at repo root:
```bash
pnpm install
```

- [ ] **Step 14: Manual smoke test**

Prereqs:
- Real Clerk dev project created at clerk.com — copy `pk_test_…` and `sk_test_…` into `.env`.
- Add a webhook in Clerk dashboard pointing at `http://YOUR_LAN_IP:4000/webhooks/clerk` for events `user.created`. Copy the signing secret into `.env` as `CLERK_WEBHOOK_SECRET`.
- For local development without an HTTPS tunnel, Clerk webhooks won't fire. Use `ngrok http 4000` or `cloudflared` and configure that URL as the webhook target.

Steps:
```bash
# Terminal 1: backend
pnpm --filter @fina/api dev

# Terminal 2: ngrok
ngrok http 4000   # update Clerk webhook URL with ngrok URL

# Terminal 3: mobile
pnpm --filter @fina/mobile dev   # press 'i' for iOS sim or 'a' for Android
```

Verify in the running mobile app:
1. App opens to sign-in.
2. Enter email → receive 6-digit code → verify.
3. Routes to home, displays workspace name "<your-name>'s workspace" and role "owner".
4. Backend logs show `/webhooks/clerk` 200 followed by `/me` 200.

If `/me` returns 404 `no_workspace`, the webhook didn't reach the backend — re-check ngrok URL in Clerk dashboard.

- [ ] **Step 15: Commit**

```bash
git add apps/mobile/ pnpm-lock.yaml
git commit -m "feat(mobile): scaffold Expo app with Clerk auth and /me home screen"
```

---

## Task 12: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main, master]
  pull_request:

jobs:
  lint-typecheck-test:
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

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.3

      - uses: actions/setup-node@v4
        with:
          node-version: 20.18.0
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Create test DB
        run: |
          PGPASSWORD=fina psql -h localhost -U fina -c "CREATE DATABASE fina_test;" postgres

      - name: Generate Prisma client
        run: pnpm --filter @fina/api db:generate

      - name: Apply migrations to test DB
        run: pnpm --filter @fina/api prisma migrate deploy

      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
```

- [ ] **Step 2: Smoke test locally with act (optional)**

If `act` is installed:
```bash
act -j lint-typecheck-test
```
Otherwise rely on first push to verify.

- [ ] **Step 3: Commit and push**

```bash
git add .github/
git commit -m "ci: add lint + typecheck + test workflow"
```

When pushed to GitHub, the workflow runs. Confirm green check.

---

## Task 13: Final verification

- [ ] **Step 1: Run full local verification**

```bash
docker compose up -d
pnpm install --frozen-lockfile
pnpm --filter @fina/api db:generate
pnpm --filter @fina/api db:migrate     # if not already applied
pnpm typecheck
pnpm lint
pnpm test
```
All steps pass.

- [ ] **Step 2: End-to-end manual test**

Run the manual smoke test from Task 11 Step 14 once more. Sign up with a fresh email; confirm:
1. Workspace created with expected name.
2. `/me` returns `role: "owner"`.
3. Sign out + sign back in restores the same workspace (idempotency).

- [ ] **Step 3: Update root README with what's working**

Append to `README.md`:
```markdown
## Status — 2026-05-07

- ✅ Plan 1 complete: monorepo, Postgres, Fastify API with Clerk JWT auth, Workspace bootstrap on user.created, Expo mobile with sign-in + home, CI passing.
- 🚧 Next: Plan 2 — categories, accounts, manual transactions, budget UI.
```

- [ ] **Step 4: Commit final docs**

```bash
git add README.md
git commit -m "docs: mark Plan 1 complete and roadmap pointer"
```

---

## Done — Plan 1 Exit Criteria

- [ ] `pnpm test` green: `health`, `auth.clerk`, `membership`, `workspaces.bootstrap`, `me`, `webhooks.clerk` all pass.
- [ ] `pnpm typecheck` green across `@fina/api`, `@fina/mobile`, `@fina/shared`.
- [ ] CI green on push.
- [ ] Mobile app: email sign-up → home screen displays workspace name & role.
- [ ] DB inspection: every signed-up Clerk user has exactly one User row, one Workspace row, one Membership row with role=owner.
- [ ] Re-sign-in flow does not duplicate User/Workspace.

When all checked, move to **Plan 2: Categories, Accounts, Manual Transactions, Budget UI**.
