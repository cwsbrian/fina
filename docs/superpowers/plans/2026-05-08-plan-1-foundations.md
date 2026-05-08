# Plan 1 — Foundations (Nx + API + Mobile + Web + Better Auth)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap an Nx monorepo with a Fastify API, Expo (React Native) mobile app, and Next.js web app. **Better Auth** (self-hosted OSS) handles email magic-link + Google OAuth on both clients. On signup, an in-process post-creation hook creates a User row, a personal Workspace, an owner Membership, and starts a 30-day Pro trial. Both clients display the authenticated user's workspace via `/me`. Service-layer authorization patterns from spec §10 are baked in from day one.

**Architecture:** Nx 19+ workspace, pnpm package manager, Postgres 16 (Docker for dev), Prisma ORM. Better Auth is mounted as a sub-router on Fastify (`/api/auth/*`) and its `User` / `Session` / `Account` tables live alongside our `Workspace` / `Membership` tables in the same Postgres. A Better Auth `databaseHooks.user.create.after` hook runs `createPersonalWorkspaceWithTrial` in the same transaction context. Both mobile (`@better-auth/expo`) and web (`better-auth/next-js`) use Better Auth's TypeScript clients to manage sessions; the backend exposes `/me` which the clients call with the session cookie / bearer token attached automatically.

**Tech Stack:** Nx 19+, pnpm 9.12+, TypeScript 5.6+, Node 20.18+, Postgres 16, Prisma 5.22+, Fastify 5, **Better Auth 1.x** (`better-auth`, `@better-auth/expo`), Expo SDK 53, Expo Router, Next.js 15 (App Router), Vitest, Zod, Resend (email), GitHub Actions. **No LLM yet** — Gemini Flash-Lite arrives in Plan 3. **No Plaid yet** — Plan 4. **No subscription billing** — Plan 7.

**Spec reference:** `docs/superpowers/specs/2026-05-07-fina-design.md`
- §4 Multi-tenancy
- §10 Authorization & Service Layer Rules
- §13.5 30-day Pro trial mechanics
- §14 Tech Stack (Nx + Better Auth + Resend)
- §15 Phase 1A — Foundations

**Out of scope for this plan:**
- Workspace sharing / invites / role transitions — Plan 2 (Phase 1.5)
- Categories, accounts, transactions, budgets — Plan 3
- Plaid integration + tier gating — Plan 4
- Chat threads/messages, LLM, redaction layer — Plan 5
- Tool execution + action_intents — Plan 6
- Daily ritual + push + Stripe + IAP — Plan 7
- Forecasting/advisor — Plan 8

---

## File Structure

```
fina/
├── nx.json
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .editorconfig
├── .gitignore
├── .nvmrc
├── .prettierrc.json
├── .eslintrc.cjs
├── docker-compose.yml
├── .env.example
├── README.md
├── scripts/
│   └── init-db.sh
├── .github/
│   └── workflows/
│       └── ci.yml
├── apps/
│   ├── api/                       # @nx/node Fastify
│   │   ├── project.json
│   │   ├── tsconfig*.json
│   │   ├── vitest.config.ts
│   │   ├── .env.test
│   │   ├── prisma/
│   │   │   ├── schema.prisma      # Better Auth tables + Workspace/Membership
│   │   │   └── seed.ts
│   │   ├── src/
│   │   │   ├── env.ts
│   │   │   ├── db.ts
│   │   │   ├── auth.ts            # better-auth instance + onCreate hook
│   │   │   ├── server.ts
│   │   │   ├── main.ts
│   │   │   ├── auth/
│   │   │   │   └── membership.ts  # assertMembership helper
│   │   │   ├── routes/
│   │   │   │   ├── health.ts
│   │   │   │   └── me.ts
│   │   │   ├── email/
│   │   │   │   └── send.ts        # Resend wrapper used by Better Auth
│   │   │   └── workspaces/
│   │   │       └── bootstrap.ts   # createPersonalWorkspaceWithTrial
│   │   └── tests/
│   │       ├── helpers/
│   │       │   ├── db.ts
│   │       │   ├── migrate.ts
│   │       │   ├── global-setup.ts
│   │       │   └── auth.ts        # creates Better Auth session for tests
│   │       ├── health.test.ts
│   │       ├── auth.session.test.ts
│   │       ├── membership.test.ts
│   │       ├── workspaces.bootstrap.test.ts
│   │       └── me.test.ts
│   ├── mobile/                    # @nx/expo
│   │   ├── project.json
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── app.json
│   │   ├── babel.config.js
│   │   ├── app/
│   │   │   ├── _layout.tsx
│   │   │   ├── index.tsx
│   │   │   ├── (auth)/
│   │   │   │   └── sign-in.tsx
│   │   │   └── (tabs)/
│   │   │       ├── _layout.tsx
│   │   │       └── index.tsx
│   │   └── src/
│   │       ├── env.ts
│   │       ├── auth/
│   │       │   └── client.ts      # better-auth/expo client
│   │       └── api/
│   │           └── client.ts      # apiFetch
│   └── web/                       # @nx/next App Router
│       ├── project.json
│       ├── package.json
│       ├── tsconfig.json
│       ├── next.config.js
│       ├── middleware.ts          # session-protected routes
│       └── src/
│           ├── env.ts
│           ├── auth/
│           │   └── client.ts      # better-auth/react client
│           └── app/
│               ├── layout.tsx
│               ├── page.tsx       # marketing → /home redirect
│               ├── sign-in/
│               │   └── page.tsx
│               └── (app)/
│                   └── home/
│                       └── page.tsx
└── libs/
    └── shared/
        ├── project.json
        ├── tsconfig.json
        └── src/
            ├── index.ts
            ├── ids.ts
            ├── roles.ts
            └── tier.ts
```

---

## Task 1: Nx workspace bootstrap

**Files:** root `package.json`, `pnpm-workspace.yaml`, `nx.json`, `tsconfig.base.json`, `.gitignore`, `.nvmrc`, `.editorconfig`, `.prettierrc.json`, `.eslintrc.cjs`, `README.md`

- [ ] **Step 1: Run the official Nx generator**

```bash
pnpm dlx create-nx-workspace@19 --preset=apps --packageManager=pnpm --interactive=false --name=fina --workspaceType=integrated .
```

If it tries to init a fresh git repo on top of the existing one, discard the resulting `.git` and keep the original.

- [ ] **Step 2: Replace the generated `package.json` scripts block**

```json
{
  "name": "fina",
  "private": true,
  "packageManager": "pnpm@9.12.3",
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

Keep the devDependencies the generator added (TypeScript, Nx, ESLint, Prettier, etc.).

- [ ] **Step 3: Replace `nx.json`**

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

- [ ] **Step 5: Create `.gitignore`, `.nvmrc`, `.editorconfig`, `.prettierrc.json`, `.eslintrc.cjs`**

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
{ "semi": true, "singleQuote": false, "trailingComma": "all", "printWidth": 100, "tabWidth": 2 }
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
cp .env.example .env       # fill in BETTER_AUTH_SECRET, GOOGLE_*, RESEND_API_KEY
pnpm nx run api:db:migrate
pnpm nx run-many -t dev --projects=api,mobile,web --parallel=3
```

## Workspaces

- `apps/api` — Fastify backend with Better Auth mounted at `/api/auth`
- `apps/mobile` — Expo React Native app
- `apps/web` — Next.js (App Router)
- `libs/shared` — shared TypeScript types
```

- [ ] **Step 7: Smoke test**

```bash
pnpm install
pnpm nx graph --file=/tmp/nx-graph.json
```

Expected: install succeeds, `nx graph` outputs JSON without errors (no projects yet).

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml nx.json tsconfig.base.json \
  .editorconfig .gitignore .nvmrc .prettierrc.json .eslintrc.cjs README.md \
  pnpm-lock.yaml
git commit -m "chore: bootstrap Nx workspace with pnpm"
```

---

## Task 2: `libs/shared`

**Files:** `libs/shared/{src/{index.ts,ids.ts,roles.ts,tier.ts},tsconfig*.json,project.json,package.json}`

- [ ] **Step 1: Generate the JS library**

```bash
pnpm add -Dw @nx/js@19
pnpm nx g @nx/js:lib shared --directory=libs/shared --projectNameAndRootFormat=as-provided --bundler=tsc --unitTestRunner=vitest --linter=eslint --importPath=@fina/shared --no-interactive
```

- [ ] **Step 2: Create `libs/shared/src/ids.ts`**

```ts
type Brand<T, B> = T & { readonly __brand: B };

export type UserId = Brand<string, "UserId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type MembershipId = Brand<string, "MembershipId">;

export const userId = (s: string): UserId => s as UserId;
export const workspaceId = (s: string): WorkspaceId => s as WorkspaceId;
export const membershipId = (s: string): MembershipId => s as MembershipId;
```

- [ ] **Step 3: Create `libs/shared/src/roles.ts`**

```ts
export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export function hasAtLeast(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
```

- [ ] **Step 4: Create `libs/shared/src/tier.ts`**

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

- [ ] **Step 5: Replace `libs/shared/src/index.ts`**

```ts
export * from "./ids.js";
export * from "./roles.js";
export * from "./tier.js";
```

- [ ] **Step 6: Verify**

```bash
pnpm nx run shared:build
pnpm nx run shared:lint
```

If a `typecheck` target wasn't generated, add to `libs/shared/project.json` under `"targets"`:
```json
"typecheck": {
  "executor": "nx:run-commands",
  "options": { "command": "tsc --noEmit -p libs/shared/tsconfig.lib.json" }
}
```
Then `pnpm nx run shared:typecheck` should pass.

- [ ] **Step 7: Commit**

```bash
git add libs/shared/ pnpm-lock.yaml package.json
git commit -m "feat(shared): add ids, roles, tier types"
```

---

## Task 3: Postgres dev container

**Files:** `docker-compose.yml`, `.env.example`, `scripts/init-db.sh`

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

- [ ] **Step 2: Create `scripts/init-db.sh`**

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

# Better Auth — required
BETTER_AUTH_SECRET=replace-with-32+-char-random-string-from-openssl-rand-base64-32
BETTER_AUTH_URL=http://localhost:4000

# OAuth providers — optional but recommended
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
APPLE_CLIENT_ID=
APPLE_CLIENT_SECRET=
APPLE_KEY_ID=
APPLE_TEAM_ID=

# Email (Resend)
RESEND_API_KEY=re_...
EMAIL_FROM=Fina <noreply@fina.app>

# Mobile (Expo public)
EXPO_PUBLIC_API_URL=http://localhost:4000

# Web (Next.js public)
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Generate a real `BETTER_AUTH_SECRET` for the actual `.env` you'll fill in:
```bash
openssl rand -base64 32
```

- [ ] **Step 4: Smoke test**

```bash
docker compose up -d
docker compose exec postgres psql -U fina -l
```
Expected: `fina` and `fina_test` databases listed.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example scripts/init-db.sh
git commit -m "chore: add Postgres dev container with test DB"
```

---

## Task 4: `apps/api` Fastify scaffold + `/health`

**Files:** `apps/api/{src/{env.ts,server.ts,main.ts,routes/health.ts},tests/health.test.ts,vitest.config.ts,.env.test,project.json,tsconfig*.json}`

- [ ] **Step 1: Generate the Node app**

```bash
pnpm add -Dw @nx/node@19 @nx/vite@19
pnpm nx g @nx/node:application api --directory=apps/api --framework=fastify --bundler=esbuild --unitTestRunner=vitest --e2eTestRunner=none --no-interactive
```

- [ ] **Step 2: Add backend deps**

```bash
pnpm add -F @fina/api fastify@^5.0.0 @fastify/sensible@^6.0.1 zod@^3.23.8
pnpm add -DF @fina/api tsx@^4.19.2 vitest@^2.1.5 dotenv@^16.4.5
```

- [ ] **Step 3: Replace `apps/api/src/env.ts`**

```ts
import { z } from "zod";

const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Fina <noreply@fina.app>"),
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

- [ ] **Step 7: Create `apps/api/.env.test`**

```bash
NODE_ENV=test
DATABASE_URL=postgresql://fina:fina@localhost:5432/fina_test
PORT=0
BETTER_AUTH_SECRET=test-secret-at-least-32-characters-long-for-tests-only
BETTER_AUTH_URL=http://localhost:0
EMAIL_FROM=test@fina.app
```

Add `!apps/api/.env.test` to root `.gitignore` exception block.

- [ ] **Step 8: Create `apps/api/vitest.config.ts`**

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

- [ ] **Step 9: Create test helpers stub**

```bash
mkdir -p apps/api/tests/helpers
```

`apps/api/tests/helpers/global-setup.ts`:
```ts
export default function setup(): void {
  // Migrations applied per-process via ensureMigrationsApplied() (Task 6).
}
```

- [ ] **Step 10: Write `apps/api/tests/health.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { buildApp } from "../src/server.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: "postgresql://test",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
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

- [ ] **Step 11: Confirm test target uses `apps/api/vitest.config.ts`**

Open `apps/api/project.json` and verify (or add) the `test` target:
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

- [ ] **Step 12: Run the test**

```bash
pnpm nx run api:test
```

Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add apps/api/ pnpm-lock.yaml package.json .gitignore
git commit -m "feat(api): scaffold Fastify with /health and zod env validation"
```

---

## Task 5: Prisma schema (Better Auth tables + Workspace/Membership/trial fields)

**Files:** `apps/api/prisma/schema.prisma`, `prisma/seed.ts`, `apps/api/src/db.ts`, modifications to `apps/api/package.json` and `project.json`

- [ ] **Step 1: Add deps**

```bash
pnpm add -F @fina/api @prisma/client@^5.22.0 better-auth@^1.0.0
pnpm add -DF @fina/api prisma@^5.22.0
```

- [ ] **Step 2: Add Prisma config to `apps/api/package.json`**

Merge into `apps/api/package.json`:
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
    "db:studio": "prisma studio"
  },
  "prisma": {
    "schema": "prisma/schema.prisma",
    "seed": "tsx prisma/seed.ts"
  }
}
```

- [ ] **Step 3: Add Nx wrapper targets to `apps/api/project.json`**

Inside `"targets"`:
```json
"db:generate": { "executor": "nx:run-commands", "options": { "command": "pnpm --filter @fina/api db:generate" } },
"db:migrate":  { "executor": "nx:run-commands", "options": { "command": "pnpm --filter @fina/api db:migrate" } },
"db:deploy":   { "executor": "nx:run-commands", "options": { "command": "pnpm --filter @fina/api db:deploy" } }
```

- [ ] **Step 4: Create `apps/api/prisma/schema.prisma`**

The Better Auth core schema requires `User`, `Session`, `Account`, `Verification` tables. We extend `User` with our trial and locale fields and add our own `Workspace` + `Membership`.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ----- Better Auth -----
model User {
  id              String       @id
  email           String       @unique
  emailVerified   Boolean      @default(false)
  name            String?
  image           String?
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt

  // Fina extensions
  tz              String       @default("America/Toronto")
  locale          String       @default("en-CA")
  trialStartedAt  DateTime?
  trialEndsAt     DateTime?
  trialConsumed   Boolean      @default(false)

  // Better Auth relations
  sessions        Session[]
  accounts        Account[]

  // Fina relations
  memberships     Membership[]

  @@map("users")
}

model Session {
  id           String   @id
  userId       String
  token        String   @unique
  expiresAt    DateTime
  ipAddress    String?
  userAgent    String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("sessions")
}

model Account {
  id                    String   @id
  userId                String
  accountId             String
  providerId            String
  accessToken           String?
  refreshToken          String?
  accessTokenExpiresAt  DateTime?
  refreshTokenExpiresAt DateTime?
  scope                 String?
  idToken               String?
  password              String?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  user                  User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([providerId, accountId])
  @@index([userId])
  @@map("accounts")
}

model Verification {
  id         String   @id
  identifier String
  value      String
  expiresAt  DateTime
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@index([identifier])
  @@map("verifications")
}

// ----- Fina core -----
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

The exact column set for Better Auth tables follows the official Better Auth Prisma adapter schema. If any field name differs in the version you install, run `pnpm dlx @better-auth/cli generate --schema prisma` after installation to regenerate the canonical schema, then merge with the Fina-specific fields above.

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

- [ ] **Step 7: Apply initial migration**

With `.env` populated (real `BETTER_AUTH_SECRET` + `DATABASE_URL`):
```bash
pnpm nx run api:db:migrate -- --name init_better_auth_users_workspaces
```

Verify:
```bash
docker compose exec postgres psql -U fina -d fina -c "\dt"
```
Expected: `users`, `sessions`, `accounts`, `verifications`, `workspaces`, `memberships`, `_prisma_migrations`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/ apps/api/src/db.ts apps/api/package.json apps/api/project.json pnpm-lock.yaml
git commit -m "feat(api): Prisma schema with Better Auth tables + Workspace/Membership/trial fields"
```

---

## Task 6: Test DB helpers + migrations

**Files:** `apps/api/tests/helpers/{db.ts,migrate.ts,global-setup.ts}`

- [ ] **Step 1: Create `apps/api/tests/helpers/db.ts`**

```ts
import { prisma } from "../../src/db.js";

export async function truncateAll(): Promise<void> {
  // Order: leaf → root.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "memberships", "workspaces", "verifications", "sessions",
                   "accounts", "users"
    RESTART IDENTITY CASCADE;
  `);
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

- [ ] **Step 4: Run health test (verifies migrations don't break)**

```bash
pnpm nx run api:test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/tests/helpers/
git commit -m "test(api): Postgres test DB helpers with migrate-once"
```

---

## Task 7: Workspace bootstrap service (with trial)

**Files:** `apps/api/src/workspaces/bootstrap.ts`, `apps/api/tests/workspaces.bootstrap.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/workspaces.bootstrap.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { startTrialAndBootstrapWorkspace } from "../src/workspaces/bootstrap.js";
import { truncateAll, disconnect } from "./helpers/db.js";

describe("startTrialAndBootstrapWorkspace", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("creates workspace + owner membership + 30d trial for an existing user", async () => {
    // Better Auth creates the user; this hook runs after that.
    const u = await prisma.user.create({
      data: { id: "user_1", email: "brian@example.com", emailVerified: true, name: "Brian" },
    });

    const before = Date.now();
    const result = await startTrialAndBootstrapWorkspace({ userId: u.id });
    const after = Date.now();

    expect(result.workspace.name).toBe("Brian's workspace");
    expect(result.membership.role).toBe("owner");

    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(userAfter.trialStartedAt).not.toBeNull();
    expect(userAfter.trialEndsAt).not.toBeNull();
    const trialStart = userAfter.trialStartedAt!.getTime();
    const trialEnd = userAfter.trialEndsAt!.getTime();
    expect(trialStart).toBeGreaterThanOrEqual(before);
    expect(trialStart).toBeLessThanOrEqual(after);
    expect(trialEnd - trialStart).toBeGreaterThan(30 * 24 * 60 * 60 * 1000 - 1000);
    expect(trialEnd - trialStart).toBeLessThan(30 * 24 * 60 * 60 * 1000 + 1000);
    expect(userAfter.trialConsumed).toBe(false);

    const memberships = await prisma.membership.findMany({ where: { userId: u.id } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.workspaceId).toBe(result.workspace.id);
  });

  it("is idempotent — running twice does not create extra workspace or restart trial", async () => {
    const u = await prisma.user.create({
      data: { id: "user_dup", email: "dup@example.com", emailVerified: true, name: "Dup" },
    });
    const first = await startTrialAndBootstrapWorkspace({ userId: u.id });
    const firstUser = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    const firstStart = firstUser.trialStartedAt!.getTime();

    await new Promise((r) => setTimeout(r, 5));

    const second = await startTrialAndBootstrapWorkspace({ userId: u.id });
    expect(second.workspace.id).toBe(first.workspace.id);

    const secondUser = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(secondUser.trialStartedAt!.getTime()).toBe(firstStart);
    expect(await prisma.workspace.count()).toBe(1);
    expect(await prisma.membership.count()).toBe(1);
  });

  it("falls back to email-derived workspace name when name is null", async () => {
    const u = await prisma.user.create({
      data: { id: "user_no_name", email: "alice@example.com", emailVerified: true, name: null },
    });
    const result = await startTrialAndBootstrapWorkspace({ userId: u.id });
    expect(result.workspace.name).toBe("alice's workspace");
  });
});
```

- [ ] **Step 2: Run test (expect failure)**

```bash
pnpm nx run api:test --testPathPattern=workspaces.bootstrap
```
FAIL — module does not exist yet.

- [ ] **Step 3: Implement `apps/api/src/workspaces/bootstrap.ts`**

```ts
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

const TRIAL_DAYS = 30;

export type BootstrapInput = { userId: string };

export type BootstrapResult = {
  workspace: { id: string; name: string };
  membership: { id: string; userId: string; workspaceId: string; role: "owner" };
};

function deriveWorkspaceName(name: string | null, email: string): string {
  const trimmed = (name ?? "").trim();
  if (trimmed.length > 0) return `${trimmed}'s workspace`;
  const local = email.split("@")[0] ?? "personal";
  return `${local}'s workspace`;
}

export async function startTrialAndBootstrapWorkspace(
  input: BootstrapInput,
): Promise<BootstrapResult> {
  return await prisma.$transaction(
    async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId } });

      // Check for existing owner membership — idempotent path.
      const existing = await tx.membership.findFirst({
        where: { userId: user.id, role: "owner" },
        include: { workspace: true },
      });
      if (existing) {
        return {
          workspace: { id: existing.workspace.id, name: existing.workspace.name },
          membership: {
            id: existing.id,
            userId: existing.userId,
            workspaceId: existing.workspaceId,
            role: "owner",
          },
        };
      }

      const workspace = await tx.workspace.create({
        data: { name: deriveWorkspaceName(user.name, user.email) },
      });
      const membership = await tx.membership.create({
        data: { userId: user.id, workspaceId: workspace.id, role: "owner" },
      });

      // Start trial only if not already started.
      if (!user.trialStartedAt) {
        const now = new Date();
        const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
        await tx.user.update({
          where: { id: user.id },
          data: { trialStartedAt: now, trialEndsAt: trialEnd, trialConsumed: false },
        });
      }

      return {
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
Expected: 3 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workspaces/ apps/api/tests/workspaces.bootstrap.test.ts
git commit -m "feat(api): startTrialAndBootstrapWorkspace service (30d Pro trial, idempotent)"
```

---

## Task 8: Better Auth integration (server)

**Files:** `apps/api/src/auth.ts`, `apps/api/src/email/send.ts`, modifications to `apps/api/src/server.ts`, `apps/api/tests/auth.session.test.ts`, `apps/api/tests/helpers/auth.ts`

This is the biggest task. Better Auth needs:
- A configured server instance with the Prisma adapter.
- Email sending (Resend) for magic-link verifications and password resets.
- A post-create hook that runs `startTrialAndBootstrapWorkspace` in the same DB transaction.
- A handler mounted on Fastify at `/api/auth/*`.

- [ ] **Step 1: Add deps**

```bash
pnpm add -F @fina/api resend@^4.0.0
```

(`better-auth` itself was added in Task 5.)

- [ ] **Step 2: Create `apps/api/src/email/send.ts`**

```ts
import { Resend } from "resend";

let client: Resend | null = null;

function getClient(apiKey: string | undefined): Resend | null {
  if (!apiKey) return null;
  if (!client) client = new Resend(apiKey);
  return client;
}

export type EmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export async function sendEmail(
  apiKey: string | undefined,
  from: string,
  input: EmailInput,
): Promise<void> {
  const c = getClient(apiKey);
  if (!c) {
    // Dev fallback: log the email so the magic link is still usable.
    // eslint-disable-next-line no-console
    console.log(`[dev email] to=${input.to} subject="${input.subject}"\n${input.text}`);
    return;
  }
  await c.emails.send({ from, to: input.to, subject: input.subject, text: input.text, html: input.html });
}
```

- [ ] **Step 3: Create `apps/api/src/auth.ts`**

```ts
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { magicLink } from "better-auth/plugins";
import { prisma } from "./db.js";
import type { Env } from "./env.js";
import { sendEmail } from "./email/send.js";
import { startTrialAndBootstrapWorkspace } from "./workspaces/bootstrap.js";

export type FinaAuth = ReturnType<typeof createAuth>;

export function createAuth(env: Env) {
  const oauthProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    oauthProviders.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    socialProviders: oauthProviders,
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          await sendEmail(env.RESEND_API_KEY, env.EMAIL_FROM, {
            to: email,
            subject: "Your Fina sign-in link",
            text: `Click to sign in: ${url}\n\nThis link expires in 10 minutes.`,
          });
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            // Run in the same transaction context as Better Auth's create.
            await startTrialAndBootstrapWorkspace({ userId: user.id });
          },
        },
      },
    },
  });
}
```

If this version of Better Auth's API names a hook differently (e.g. `databaseHooks.user.create` is named `databaseHooks.user.afterCreate`), adjust to the version's name. The behavior — fire after the user row is committed — is what matters.

- [ ] **Step 4: Mount Better Auth on Fastify and write the failing test**

Update `apps/api/src/server.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import type { Env } from "./env.js";
import { healthRoutes } from "./routes/health.js";
import { createAuth, type FinaAuth } from "./auth.js";

export type AppCtx = { env: Env; auth: FinaAuth };

declare module "fastify" {
  interface FastifyInstance {
    fina: AppCtx;
  }
}

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : { level: "info" },
  });
  const auth = createAuth(env);
  app.decorate("fina", { env, auth });

  await app.register(sensible);

  // Better Auth's request handler is a Web Fetch handler; bridge to Fastify.
  app.all("/api/auth/*", async (req, reply) => {
    const url = new URL(req.url, env.BETTER_AUTH_URL);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    const init: RequestInit = {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined :
        typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}),
    };
    const response = await auth.handler(new Request(url, init));

    reply.code(response.status);
    response.headers.forEach((value, key) => reply.header(key, value));
    const buf = Buffer.from(await response.arrayBuffer());
    return reply.send(buf);
  });

  await app.register(healthRoutes);

  return app;
}
```

- [ ] **Step 5: Create `apps/api/tests/helpers/auth.ts`**

This helper signs up a user via the Better Auth HTTP endpoints and returns the resulting session cookie. Tests use this instead of fabricating sessions.

```ts
import type { FastifyInstance } from "fastify";

export type SignedUpUser = {
  userId: string;
  email: string;
  cookie: string;
};

let counter = 0;

export async function signUpAndGetCookie(app: FastifyInstance, opts?: {
  name?: string;
  email?: string;
  password?: string;
}): Promise<SignedUpUser> {
  const id = ++counter;
  const email = opts?.email ?? `user${id}@example.com`;
  const password = opts?.password ?? "password-1234567890";
  const name = opts?.name ?? `User ${id}`;

  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ email, password, name }),
  });
  if (res.statusCode !== 200) {
    throw new Error(`sign-up failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json();
  const cookie = res.headers["set-cookie"];
  const cookieStr = Array.isArray(cookie) ? cookie.join("; ") : cookie ?? "";
  return { userId: body.user.id as string, email, cookie: cookieStr };
}
```

The exact endpoint path and response shape follow Better Auth's email+password sign-up route. If your Better Auth version uses different paths, adjust here only — the rest of the tests stay stable.

- [ ] **Step 6: Write `apps/api/tests/auth.session.test.ts`**

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
};

describe("Better Auth integration", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("sign-up creates user + workspace + owner membership + trial via post-create hook", async () => {
    const app = await buildApp(env);
    const { userId, email } = await signUpAndGetCookie(app, { email: "hook@example.com", name: "Hook" });

    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.email).toBe(email);
    expect(u.trialStartedAt).not.toBeNull();
    expect(u.trialEndsAt).not.toBeNull();

    const memberships = await prisma.membership.findMany({ where: { userId } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("owner");
    await app.close();
  });

  it("session cookie authenticates subsequent requests", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "ses@example.com", name: "Ses" });
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user?.id).toBe(user.userId);
    await app.close();
  });

  it("rejects /me without a session", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 7: Run the suite**

```bash
pnpm nx run api:test --testPathPattern=auth.session
```
Expected: first 2 cases PASS. Third (`/me` rejection) PASSes only after `/me` is added in Task 9 — for now it will fail with `404 not found` which is acceptable as TODO; comment it out or use `it.todo` if the runner is strict, then re-enable in Task 9.

A simple workaround: change that third test to `it.todo("rejects /me without a session — see Task 9")` for now.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/auth.ts apps/api/src/email/ apps/api/src/server.ts \
  apps/api/tests/auth.session.test.ts apps/api/tests/helpers/auth.ts \
  pnpm-lock.yaml
git commit -m "feat(api): integrate Better Auth with email/password + magic link + Resend + trial bootstrap"
```

---

## Task 9: assertMembership helper + `/me` route

**Files:** `apps/api/src/auth/membership.ts`, `apps/api/src/routes/me.ts`, modifications to `apps/api/src/server.ts`, `apps/api/tests/membership.test.ts`, `apps/api/tests/me.test.ts`

This task introduces the session-aware helper that resolves the calling user from the Better Auth session and the `/me` route both clients call.

- [ ] **Step 1: Write the membership test**

```ts
// apps/api/tests/membership.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { assertMembership, MembershipError } from "../src/auth/membership.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
};

describe("assertMembership", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("returns membership when user is owner of workspace", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "u1@x.com", name: "U1" });
    const m = await prisma.membership.findFirstOrThrow({ where: { userId: user.userId } });

    const result = await assertMembership({
      userId: user.userId,
      workspaceId: m.workspaceId,
      requiredRole: "owner",
    });
    expect(result.role).toBe("owner");
    await app.close();
  });

  it("throws when user is not a member", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "u2@x.com", name: "U2" });
    const otherWs = await prisma.workspace.create({ data: { name: "Other" } });
    await expect(
      assertMembership({
        userId: user.userId,
        workspaceId: otherWs.id,
        requiredRole: "viewer",
      }),
    ).rejects.toThrow(MembershipError);
    await app.close();
  });

  it("throws when role is below required", async () => {
    const ws = await prisma.workspace.create({ data: { name: "Shared" } });
    const u = await prisma.user.create({
      data: { id: "u3", email: "u3@x.com", emailVerified: true, name: "U3" },
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
FAIL — module missing.

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
Expected: 3 cases PASS.

- [ ] **Step 5: Write `/me` test**

```ts
// apps/api/tests/me.test.ts
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
};

describe("GET /me", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("returns user + workspace + role + tier=pro + trial active for fresh signup", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "me1@example.com", name: "Me One" });

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe("me1@example.com");
    expect(body.workspace.name).toBe("Me One's workspace");
    expect(body.workspace.role).toBe("owner");
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
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: user.cookie },
    });
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

- [ ] **Step 6: Implement `apps/api/src/routes/me.ts`**

```ts
import type { FastifyInstance } from "fastify";
import type { Tier } from "@fina/shared";
import { prisma } from "../db.js";

function effectiveTier(user: {
  trialEndsAt: Date | null;
}): { tier: Tier; trialActive: boolean; trialEndsAt: Date | null } {
  const now = new Date();
  if (user.trialEndsAt && user.trialEndsAt > now) {
    return { tier: "pro", trialActive: true, trialEndsAt: user.trialEndsAt };
  }
  return { tier: "free", trialActive: false, trialEndsAt: user.trialEndsAt };
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req, reply) => {
    // Convert Fastify headers to a Web Headers for Better Auth.
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    const session = await app.fina.auth.api.getSession({ headers });
    if (!session?.user) return reply.code(401).send({ error: "unauthenticated" });

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
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

- [ ] **Step 8: Re-enable the rejection assertion in `auth.session.test.ts`**

Change `it.todo("rejects /me without a session — see Task 9")` back to a real test:
```ts
it("rejects /me without a session", async () => {
  const app = await buildApp(env);
  const res = await app.inject({ method: "GET", url: "/me" });
  expect(res.statusCode).toBe(401);
  await app.close();
});
```

- [ ] **Step 9: Run full api suite**

```bash
pnpm nx run api:test
```
Expected: all PASS — `health`, `auth.session`, `membership`, `workspaces.bootstrap`, `me`.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/auth/membership.ts apps/api/src/routes/me.ts \
  apps/api/src/server.ts apps/api/tests/membership.test.ts apps/api/tests/me.test.ts \
  apps/api/tests/auth.session.test.ts
git commit -m "feat(api): assertMembership + GET /me with effective tier from session"
```

---

## Task 10: Mobile app scaffold (Expo + Better Auth)

**Files:** `apps/mobile/{app/{_layout.tsx,index.tsx,(auth)/sign-in.tsx,(tabs)/_layout.tsx,(tabs)/index.tsx},src/{env.ts,api/client.ts,auth/client.ts}}`, `package.json`, `app.json`, `babel.config.js`, `tsconfig.json`, `project.json`

- [ ] **Step 1: Generate the Expo app**

```bash
pnpm add -Dw @nx/expo@19
pnpm nx g @nx/expo:application mobile --directory=apps/mobile --e2eTestRunner=none --linter=eslint --no-interactive
```

- [ ] **Step 2: Add deps**

```bash
pnpm add -F @fina/mobile better-auth@^1.0.0 @better-auth/expo@^1.0.0 \
  expo-router@~5.0.0 expo-secure-store@~14.0.0 expo-status-bar@~2.0.0 \
  react-native-safe-area-context@5.4.0 react-native-screens@~4.4.0 zod@^3.23.8 \
  @fina/shared@workspace:*
```

- [ ] **Step 3: Switch to Expo Router and update `apps/mobile/package.json`**

Set `"main": "expo-router/entry"` in `apps/mobile/package.json`.

- [ ] **Step 4: Update `apps/mobile/app.json`**

Within the `expo` block, ensure:
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
Delete the generated `App.tsx` (Expo Router takes over).

- [ ] **Step 5: Create `apps/mobile/src/env.ts`**

```ts
import { z } from "zod";

const Schema = z.object({
  EXPO_PUBLIC_API_URL: z.string().url(),
});

export const env = Schema.parse({
  EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
});
```

- [ ] **Step 6: Create `apps/mobile/src/auth/client.ts`**

```ts
import { createAuthClient } from "better-auth/react";
import { expoClient } from "@better-auth/expo/client";
import * as SecureStore from "expo-secure-store";
import { env } from "../env";

export const authClient = createAuthClient({
  baseURL: `${env.EXPO_PUBLIC_API_URL}/api/auth`,
  plugins: [expoClient({ scheme: "fina", storagePrefix: "fina", storage: SecureStore })],
});

export const { useSession, signIn, signUp, signOut } = authClient;
```

- [ ] **Step 7: Create `apps/mobile/src/api/client.ts`**

```ts
import { authClient } from "../auth/client";
import { env } from "../env";

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cookie = authClient.getCookie?.() ?? "";
  const res = await fetch(`${env.EXPO_PUBLIC_API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
```

If `getCookie` is not the actual exported helper in this version of `@better-auth/expo` (the API has been stabilizing), substitute the version's documented session-header helper — the call site stays the same.

- [ ] **Step 8: Create `apps/mobile/app/_layout.tsx`**

```tsx
import { Stack } from "expo-router";

export default function RootLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="(auth)/sign-in" />
    </Stack>
  );
}
```

- [ ] **Step 9: Create `apps/mobile/app/index.tsx`**

```tsx
import { Redirect } from "expo-router";
import { useSession } from "../src/auth/client";

export default function Index() {
  const { data, isPending } = useSession();
  if (isPending) return null;
  return data?.user ? <Redirect href="/(tabs)" /> : <Redirect href="/(auth)/sign-in" />;
}
```

- [ ] **Step 10: Create `apps/mobile/app/(auth)/sign-in.tsx`**

```tsx
import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { signIn, signUp } from "../../src/auth/client";

export default function SignInScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signIn" | "signUp">("signUp");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      if (mode === "signUp") {
        const result = await signUp.email({ email, password, name: name || email.split("@")[0] });
        if (result.error) throw new Error(result.error.message ?? "Sign up failed");
      } else {
        const result = await signIn.email({ email, password });
        if (result.error) throw new Error(result.error.message ?? "Sign in failed");
      }
      router.replace("/(tabs)");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Auth failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Fina</Text>
      <Text style={styles.subtitle}>Your AI financial advisor</Text>

      <Pressable onPress={() => setMode(mode === "signUp" ? "signIn" : "signUp")}>
        <Text style={styles.toggle}>
          {mode === "signUp" ? "Already have an account? Sign in" : "New here? Sign up"}
        </Text>
      </Pressable>

      {mode === "signUp" && (
        <TextInput
          style={styles.input}
          placeholder="Your name"
          value={name}
          onChangeText={setName}
        />
      )}
      <TextInput
        style={styles.input}
        placeholder="email@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password (8+ characters)"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <Pressable
        style={styles.button}
        disabled={busy || !email || password.length < 8}
        onPress={submit}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>{mode === "signUp" ? "Create account" : "Sign in"}</Text>
        )}
      </Pressable>
      {err && <Text style={styles.error}>{err}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#fff" },
  title: { fontSize: 36, fontWeight: "700", marginBottom: 4 },
  subtitle: { fontSize: 14, opacity: 0.6, marginBottom: 24 },
  toggle: { fontSize: 14, color: "#06f", marginBottom: 16 },
  input: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 14, fontSize: 16, marginBottom: 12 },
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
import { useSession, signOut } from "../../src/auth/client";
import { apiFetch } from "../../src/api/client";

type Me = {
  user: { id: string; email: string; tz: string; locale: string };
  workspace: { id: string; name: string; role: string };
  tier: "free" | "lite" | "pro";
  trial: { active: boolean; endsAt: string | null };
};

export default function Home() {
  const { data: session } = useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Me>("/me")
      .then((m) => { if (!cancelled) setMe(m); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  return (
    <View style={styles.root}>
      <Text style={styles.h1}>
        Welcome{session?.user?.name ? `, ${session.user.name}` : ""}
      </Text>
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

- [ ] **Step 13: Install workspace**

```bash
pnpm install
```

- [ ] **Step 14: Manual smoke test**

Prereqs in `.env`:
- Real `BETTER_AUTH_SECRET` (32+ chars, openssl rand -base64 32).
- `BETTER_AUTH_URL=http://YOUR_LAN_IP:4000` (so the device can reach it).
- `EXPO_PUBLIC_API_URL=http://YOUR_LAN_IP:4000` (same).
- For dev with no `RESEND_API_KEY`, the email fallback logs the magic link to the API console — useful for testing.

Run:
```bash
pnpm nx run api:dev
pnpm nx run mobile:start
# 'i' iOS sim or 'a' Android, or scan QR with Expo Go
```

Verify on the device:
1. App opens on sign-in.
2. Switch to "Sign up", fill name + email + password, tap Create account.
3. Lands on home. Card shows workspace name, role `owner`, tier `PRO`, "Pro trial active" line.
4. Sign out, sign back in (use the same email + password) — same workspace.

If the card never loads, check API logs for `databaseHooks.user.create` errors and confirm the migrations were applied.

- [ ] **Step 15: Commit**

```bash
git add apps/mobile/ pnpm-lock.yaml package.json
git commit -m "feat(mobile): Expo + Better Auth sign-up/sign-in + /me home screen"
```

---

## Task 11: Web app scaffold (Next.js + Better Auth)

**Files:** `apps/web/{src/{env.ts,auth/client.ts,app/{layout.tsx,page.tsx,sign-in/page.tsx,(app)/home/page.tsx}},middleware.ts}`, generator-created config files

- [ ] **Step 1: Generate the Next.js app**

```bash
pnpm add -Dw @nx/next@19
pnpm nx g @nx/next:application web --directory=apps/web --appDir=true --src=true --style=css --linter=eslint --unitTestRunner=none --e2eTestRunner=none --no-interactive
```

- [ ] **Step 2: Add deps**

```bash
pnpm add -F @fina/web better-auth@^1.0.0 zod@^3.23.8 @fina/shared@workspace:*
```

- [ ] **Step 3: Create `apps/web/src/env.ts`**

```ts
import { z } from "zod";

const Schema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url(),
});

export const env = Schema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});
```

- [ ] **Step 4: Create `apps/web/src/auth/client.ts`**

```ts
import { createAuthClient } from "better-auth/react";
import { env } from "../env";

export const authClient = createAuthClient({
  baseURL: `${env.NEXT_PUBLIC_API_URL}/api/auth`,
});

export const { useSession, signIn, signUp, signOut } = authClient;
```

- [ ] **Step 5: Create `apps/web/middleware.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";

const PROTECTED_PREFIXES = ["/home"];

export async function middleware(req: NextRequest) {
  if (!PROTECTED_PREFIXES.some((p) => req.nextUrl.pathname.startsWith(p))) {
    return NextResponse.next();
  }
  // Better Auth's default cookie name is "better-auth.session_token".
  const sessionCookie = req.cookies.get("better-auth.session_token");
  if (!sessionCookie) {
    const signInUrl = new URL("/sign-in", req.url);
    signInUrl.searchParams.set("from", req.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next|.*\\..*|api).*)"],
};
```

If your Better Auth version uses a different default cookie name, adjust it here. The simpler path: use Better Auth's helper in `next-js` integration if available in your version.

- [ ] **Step 6: Replace `apps/web/src/app/layout.tsx`**

```tsx
import "./global.css";

export const metadata = {
  title: "Fina",
  description: "AI Financial Advisor",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

(The generator may have created `apps/web/src/app/global.css` already. If not, create an empty file.)

- [ ] **Step 7: Replace `apps/web/src/app/page.tsx` (landing)**

```tsx
"use client";
import Link from "next/link";
import { useSession } from "../auth/client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function Landing() {
  const { data, isPending } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (data?.user) router.replace("/home");
  }, [data, router]);

  if (isPending) return null;
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

- [ ] **Step 8: Create `apps/web/src/app/sign-in/page.tsx`**

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn, signUp } from "../../auth/client";

export default function SignInPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signIn" | "signUp">("signUp");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (mode === "signUp") {
        const r = await signUp.email({ email, password, name: name || email.split("@")[0]! });
        if (r.error) throw new Error(r.error.message ?? "Sign up failed");
      } else {
        const r = await signIn.email({ email, password });
        if (r.error) throw new Error(r.error.message ?? "Sign in failed");
      }
      router.replace("/home");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Auth failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ display: "flex", justifyContent: "center", padding: 64, fontFamily: "system-ui" }}>
      <form onSubmit={submit} style={{ width: 360, display: "flex", flexDirection: "column", gap: 12 }}>
        <h1 style={{ fontSize: 32, marginBottom: 8 }}>{mode === "signUp" ? "Create account" : "Sign in"}</h1>
        <button type="button" onClick={() => setMode(mode === "signUp" ? "signIn" : "signUp")}
          style={{ background: "none", border: "none", color: "#06f", textAlign: "left", cursor: "pointer", padding: 0, marginBottom: 8 }}>
          {mode === "signUp" ? "Already have an account? Sign in" : "New here? Sign up"}
        </button>
        {mode === "signUp" && (
          <input type="text" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)}
            style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }} />
        )}
        <input type="email" placeholder="email@example.com" required value={email} onChange={(e) => setEmail(e.target.value)}
          style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }} />
        <input type="password" placeholder="Password (8+ chars)" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)}
          style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }} />
        <button type="submit" disabled={busy || !email || password.length < 8}
          style={{ padding: 12, background: "#111", color: "#fff", borderRadius: 8, border: "none", cursor: "pointer" }}>
          {busy ? "..." : mode === "signUp" ? "Create account" : "Sign in"}
        </button>
        {err && <div style={{ color: "#c00" }}>{err}</div>}
      </form>
    </main>
  );
}
```

- [ ] **Step 9: Create `apps/web/src/app/(app)/home/page.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { signOut } from "../../../auth/client";
import { env } from "../../../env";

type Me = {
  user: { id: string; email: string; tz: string; locale: string };
  workspace: { id: string; name: string; role: string };
  tier: "free" | "lite" | "pro";
  trial: { active: boolean; endsAt: string | null };
};

async function fetchMe(): Promise<Me> {
  const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/me`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export default function HomePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchMe().then(setMe).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui", maxWidth: 600 }}>
      <h1 style={{ fontSize: 32, marginBottom: 24 }}>Welcome</h1>
      {err && <p style={{ color: "#c00" }}>Could not reach API: {err}</p>}
      {!me && !err && <p>Loading…</p>}
      {me && (
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
      )}
      <button onClick={() => signOut()}
        style={{ padding: "12px 24px", borderRadius: 8, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
        Sign out
      </button>
    </main>
  );
}
```

- [ ] **Step 10: Smoke test**

Make sure CORS on the API allows `http://localhost:3000` and `credentials: include`. By default, Better Auth's handler emits the right CORS headers for its endpoints; the `/me` route uses the same origin policy so adding `@fastify/cors` registered with `origin: ["http://localhost:3000"], credentials: true` is required. If not yet added, add it now in `apps/api/src/server.ts`:

```ts
import cors from "@fastify/cors";
// ... inside buildApp:
await app.register(cors, {
  origin: env.NODE_ENV === "production" ? false : ["http://localhost:3000"],
  credentials: true,
});
```
and `pnpm add -F @fina/api @fastify/cors@^10.0.0`. Re-run api tests to ensure nothing broke.

```bash
pnpm install
pnpm nx run api:dev   # terminal 1
pnpm nx run web:dev   # terminal 2 — browse http://localhost:3000
```

Verify in browser:
1. Landing page → click Sign in.
2. Sign up with email + name + password → land on `/home`.
3. Card shows workspace + role `owner` + tier `PRO` + trial active line.
4. Sign out returns to landing.

- [ ] **Step 11: Commit**

```bash
git add apps/web/ apps/api/src/server.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(web): Next.js + Better Auth sign-up/sign-in + /home + CORS"
```

---

## Task 12: GitHub Actions CI

**Files:** `.github/workflows/ci.yml`

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
      BETTER_AUTH_SECRET: ci-secret-at-least-32-characters-long-for-tests-only
      BETTER_AUTH_URL: http://localhost:4000
      EMAIL_FROM: ci@fina.app
      EXPO_PUBLIC_API_URL: http://localhost:4000
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

For pushes to `main` (no diff base) Nx falls back to all projects.

- [ ] **Step 2: Commit and push**

```bash
git add .github/
git commit -m "ci: Nx affected lint + typecheck + test workflow"
```

After pushing to GitHub, confirm the workflow is green.

---

## Task 13: Final verification

- [ ] **Step 1: Local end-to-end**

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

Run the smoke tests from Task 10 Step 14 (mobile) and Task 11 Step 10 (web). Sign up with a fresh email, confirm:
1. Workspace name correct (derived from name → email).
2. Role = `owner`.
3. Tier = `PRO` and trial active line visible.
4. Sign out, sign back in (same email + password) → same workspace.

Check Postgres:
```sql
SELECT id, email, "trialEndsAt", "trialConsumed" FROM users;
SELECT * FROM memberships;
SELECT id, "userId", "providerId", "accountId" FROM accounts;
SELECT id, "userId", "expiresAt" FROM sessions;
```
- One User per signup (`trialEndsAt` ~30 days out, `trialConsumed=false`).
- One Membership with `role=owner` per user.
- Account row(s) linking the credential / OAuth providers used.
- Session rows live until expiry.

- [ ] **Step 3: Update root README with status**

Append:
```markdown
## Status — 2026-05-08

- ✅ Plan 1 complete: Nx monorepo, Postgres, Fastify API + Better Auth (email/password + magic link), workspace bootstrap with 30-day Pro trial via post-create hook, Expo mobile + Next.js web both rendering /me, CI green.
- 🚧 Next: Plan 2 — workspace sharing (invites + roles + switcher).
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: mark Plan 1 complete and roadmap pointer"
```

---

## Done — Plan 1 Exit Criteria

- [ ] `pnpm nx run-many -t test` green: api tests cover health, auth.session, membership, workspaces.bootstrap, me.
- [ ] `pnpm nx run-many -t typecheck` green across api, mobile, web, shared.
- [ ] `pnpm nx run-many -t lint` green.
- [ ] CI green on push.
- [ ] Mobile app: email + password sign-up → home displays workspace + role + tier `PRO` + trial active line.
- [ ] Web app: same flow at `localhost:3000`.
- [ ] DB: every signed-up user has a User row (with non-null trial fields), Account row(s) for the credential they used, Session row(s) for active sessions, exactly one Workspace row, one Membership row with role=owner.
- [ ] Re-sign-in does not duplicate User/Workspace and does not restart the trial.

When all checked, move to **Plan 2: Workspace Sharing (Phase 1.5)**.
