# Plan 1B-webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive Plaid webhook callbacks (`SYNC_UPDATES_AVAILABLE`), verify their authenticity, and trigger `syncTransactions` + `categorizeNewTransactions` in the background — so new transactions appear without the user hitting Refresh.

**Architecture:** Single unauthenticated POST endpoint (`/plaid/webhook`) verifies a Plaid ES256 JWT signature against a JWK fetched from Plaid (cached in-memory respecting Plaid's `expired_at`), inserts an audit row into `plaid_webhook_events`, and detaches the sync+categorize work via a fire-and-forget promise. No DB-level dedup — sync's cursor-based + row-level lock makes duplicate dispatches safe.

**Tech Stack:** Fastify (custom content-type parser for raw buffer), `jose` (ES256 JWT verify, added as direct dep), Prisma (new table + column + back-relation), vitest (unit tests with scriptable Plaid mock + ES256 keypair helper), Playwright (E2E with skip-guard on Tailscale Funnel URL).

**Spec:** `docs/superpowers/specs/2026-05-12-plan-1b-webhooks-design.md`

---

## File Structure

**New files:**
- `apps/api/src/plaid/webhook-jwks.ts` — JWK cache + signature verification (`verifyPlaidWebhook`, `_clearCacheForTest`)
- `apps/api/src/plaid/webhook-dispatch.ts` — `dispatchWebhookSync(env, wsId, plaidItemId, eventId)` (sync + categorize + row update)
- `apps/api/src/plaid/webhook-backfill.ts` — `backfillWebhookUrls(env)` startup task
- `apps/api/src/routes/plaid-webhook.ts` — Fastify route plugin (raw-buffer parser scoped here)
- `apps/api/tests/helpers/plaid-webhook-mock.ts` — ES256 keypair generator + signing helper + JWK cache injector
- `apps/api/tests/plaid.webhook.signature.test.ts`
- `apps/api/tests/plaid.webhook.routes.test.ts`
- `apps/api/tests/plaid.webhook.dispatch.test.ts`
- `apps/api/tests/plaid.webhook.backfill.test.ts`
- `e2e/plan-1b-webhooks.spec.ts` (skip-guarded)
- `docs/superpowers/smoke-tests/2026-05-12-plan-1b-webhooks.md`

**Modified files:**
- `apps/api/package.json` — add `"jose": "^6"` direct dep
- `apps/api/prisma/schema.prisma` — add `PlaidWebhookEvent` model + `PlaidItem.webhookUrl` + `PlaidItem.webhookEvents` back-relation
- `apps/api/src/env.ts` — add optional `PLAID_WEBHOOK_URL`
- `apps/api/src/server.ts` — register `plaidWebhookRoutes`
- `apps/api/src/main.ts` — call `backfillWebhookUrls` after `app.listen`
- `apps/api/src/routes/plaid.ts` — pass `webhook: env.PLAID_WEBHOOK_URL` to `linkTokenCreate` when present
- `apps/api/tests/helpers/plaid-mock.ts` — add `webhookVerificationKeyGet`, `itemWebhookUpdate` queues
- `.env.example` — document `PLAID_WEBHOOK_URL`
- `README.md` — update progress section after Plan 1B-webhooks complete

---

## Task 1: Schema, env, and dependency setup

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/env.ts`
- Create: `apps/api/prisma/migrations/<timestamp>_add_plaid_webhooks/migration.sql` (generated)
- Modify: `.env.example`

- [ ] **Step 1.1: Add jose to apps/api/package.json**

Open `apps/api/package.json`. In the `dependencies` block, add `"jose": "^6"` (alphabetical order — between `@google/genai` and `@prisma/client`). Save.

- [ ] **Step 1.2: Install**

Run from repo root:
```bash
pnpm install
```
Expected: pnpm-lock.yaml updates with `apps/api` declaring `jose`. `apps/api/node_modules/jose` symlink created.

Verify:
```bash
ls apps/api/node_modules/jose && node -e "console.log(require.resolve('jose', { paths: ['apps/api'] }))"
```
Expected: directory exists, `require.resolve` prints a path.

- [ ] **Step 1.3: Update Prisma schema — add PlaidItem.webhookUrl + back-relation**

Open `apps/api/prisma/schema.prisma`. Find the `PlaidItem` model. After the existing `lastCursor` line, add:

```prisma
  // Webhook URL registered with Plaid for this item (per §1B-webhooks).
  // NULL for items connected before the webhook feature shipped — startup task backfills them.
  webhookUrl            String?
```

Then in the relations block (after `transactions Transaction[]`), add:
```prisma
  webhookEvents         PlaidWebhookEvent[] @relation("PlaidItemWebhookEvents")
```

- [ ] **Step 1.4: Add PlaidWebhookEvent model**

In the same file, after the `PlaidItem` model + its `enum PlaidItemStatus`, add:

```prisma
model PlaidWebhookEvent {
  id            String    @id @default(cuid())
  // NULL when item_id is not in our DB (disconnected item, stale Plaid delivery).
  plaidItemId   String?
  webhookType   String    // e.g. "TRANSACTIONS"
  webhookCode   String    // e.g. "SYNC_UPDATES_AVAILABLE"
  // Raw Plaid body — audit trail. No unique constraint:
  // SYNC_UPDATES_AVAILABLE bodies are identical across deliveries once
  // initial_update_complete=true; body-hash dedup would silently drop
  // legitimate events. Sync's cursor + row-level lock handles duplicates.
  body          Json
  receivedAt    DateTime  @default(now())
  // Set by detached dispatchWebhookSync after sync+categorize completes (or fails).
  // NULL while in-flight, when webhook type wasn't dispatched, OR when sync hit lock_held
  // (so 1B-cron can retry — competing sync may have started before this delta existed).
  processedAt   DateTime?
  processError  String?   // ≤500 chars; full stack to structured log.

  plaidItem PlaidItem? @relation("PlaidItemWebhookEvents", fields: [plaidItemId], references: [id], onDelete: SetNull)

  @@index([plaidItemId, receivedAt])
  @@index([webhookType, webhookCode])
  @@map("plaid_webhook_events")
}
```

- [ ] **Step 1.5: Add PLAID_WEBHOOK_URL to env.ts**

Open `apps/api/src/env.ts`. After the `PLAID_SYNC_TIMEOUT_MS` line, add:

```typescript
  // Plaid webhook delivery URL (Tailscale Funnel in dev, prod URL in prod).
  // Optional — unit tests + local dev without Funnel omit it. linkTokenCreate
  // and the startup backfill task skip the Plaid call when absent.
  PLAID_WEBHOOK_URL: z.string().url().optional(),
```

- [ ] **Step 1.6: Generate migration**

From repo root:
```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina pnpm --filter @fina/api prisma migrate dev --name add_plaid_webhooks
```
Expected: new directory under `apps/api/prisma/migrations/<timestamp>_add_plaid_webhooks/` with a `migration.sql` containing `CREATE TABLE "plaid_webhook_events"` and `ALTER TABLE "plaid_items" ADD COLUMN "webhookUrl" TEXT`.

If the dev DB isn't running:
```bash
pnpm smoke:db:start
```
Then retry the migrate command.

- [ ] **Step 1.7: Run test DB migration**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api prisma migrate deploy
```
Expected: applies the new migration to `fina_test`.

- [ ] **Step 1.8: Update .env.example**

Open `.env.example`. After the `PLAID_ENV=sandbox` line, add:

```
# Public URL Plaid hits for webhooks (e.g. Tailscale Funnel: https://<machine>.<tailnet>.ts.net/plaid/webhook)
# Optional — leave blank for unit tests / local dev without Funnel.
PLAID_WEBHOOK_URL=
```

- [ ] **Step 1.9: Verify build still passes**

```bash
pnpm --filter @fina/api typecheck 2>&1 | tail -20
```
Expected: no errors.

- [ ] **Step 1.10: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/src/env.ts .env.example
git commit -m "$(cat <<'EOF'
feat(plan 1b-webhooks): schema + env + jose dep

- Add PlaidWebhookEvent model + PlaidItem.webhookUrl column + back-relation
- Add optional PLAID_WEBHOOK_URL env var
- Add jose@^6 as direct dep (pnpm strict; transitive copy via better-auth not resolvable)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Test helpers — ES256 keypair + Plaid mock additions

**Files:**
- Create: `apps/api/tests/helpers/plaid-webhook-mock.ts`
- Modify: `apps/api/tests/helpers/plaid-mock.ts`

- [ ] **Step 2.1: Extend plaid-mock with webhook methods + arg capture for linkTokenCreate**

Open `apps/api/tests/helpers/plaid-mock.ts`. Three edits:

(a) In the `plaidMock` object literal (around line 32), add three new entries:
```typescript
  webhookVerificationKeyGet: [] as AnyResponse[],
  itemWebhookUpdate: [] as AnyResponse[],
  linkTokenCreateCalls: [] as unknown[][],
```

(b) In `resetPlaidMock` (around line 40), add to the reset:
```typescript
  plaidMock.linkTokenCreateCalls.length = 0;
```
The `for` loop already resets the queue arrays; only `linkTokenCreateCalls` needs explicit reset.

(c) In the `PlaidApi` class inside `plaidMockFactory` (around line 82-89), replace the `linkTokenCreate` line and add two new methods:
```typescript
      async linkTokenCreate(args: unknown) {
        plaidMock.linkTokenCreateCalls.push([args]);
        return callOrThrow("linkTokenCreate");
      }
      async itemPublicTokenExchange() { return callOrThrow("itemPublicTokenExchange"); }
      async accountsGet() { return callOrThrow("accountsGet"); }
      async transactionsSync() { return callOrThrow("transactionsSync"); }
      async itemRemove() { return callOrThrow("itemRemove"); }
      async webhookVerificationKeyGet() { return callOrThrow("webhookVerificationKeyGet"); }
      async itemWebhookUpdate() { return callOrThrow("itemWebhookUpdate"); }
```

- [ ] **Step 2.2: Create plaid-webhook-mock.ts**

Create `apps/api/tests/helpers/plaid-webhook-mock.ts`:

```typescript
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from "jose";
import { createHash } from "node:crypto";
import { _clearCacheForTest, _injectJwkForTest } from "../../src/plaid/webhook-jwks.js";

export type WebhookKeyPair = {
  privateKey: KeyLike;
  publicKey: KeyLike;
  jwk: Record<string, unknown>;
  kid: string;
};

export async function generateWebhookKeys(kid = "test-kid-1"): Promise<WebhookKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = "ES256";
  jwk.use = "sig";
  return { privateKey, publicKey, jwk, kid };
}

/**
 * Sign a body buffer and return the plaid-verification JWT header value.
 * `iat` defaults to now (in seconds). Pass an older value to test iat_expired.
 */
export async function signWebhook(
  body: Buffer,
  privateKey: KeyLike,
  kid: string,
  iat: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return await new SignJWT({ request_body_sha256: bodyHash })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuedAt(iat)
    .sign(privateKey);
}

/**
 * Inject a public key into the JWK cache so verification skips the Plaid API call.
 * `expiresAt` is an absolute ms timestamp; defaults to 1h from now.
 */
export function injectJwkForTest(kid: string, publicKey: KeyLike, expiresAt?: number): void {
  _injectJwkForTest(kid, publicKey, expiresAt ?? Date.now() + 60 * 60 * 1000);
}

export function resetJwkCache(): void {
  _clearCacheForTest();
}
```

Note: `_clearCacheForTest` and `_injectJwkForTest` will be exported from `webhook-jwks.ts` in Task 3.

- [ ] **Step 2.3: Verify typecheck still passes (will fail on missing imports — expected)**

```bash
pnpm --filter @fina/api typecheck 2>&1 | tail -10
```
Expected: errors about missing `webhook-jwks.js` exports — that's fine; Task 3 creates them. Don't commit yet.

- [ ] **Step 2.4: Commit (deferred to end of Task 3 since helper depends on Task 3 file)**

Skip commit here — bundle with Task 3.

---

## Task 3: webhook-jwks.ts — signature verification with TDD

**Files:**
- Create: `apps/api/src/plaid/webhook-jwks.ts`
- Create: `apps/api/tests/plaid.webhook.signature.test.ts`

- [ ] **Step 3.1: Write the failing test file**

Create `apps/api/tests/plaid.webhook.signature.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetPlaidMock, plaidMock } from "./helpers/plaid-mock.js";

const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
  async () => await import("./helpers/plaid-mock.js"),
);
vi.mock("plaid", hoistedPlaidMockFactory);

import {
  generateWebhookKeys,
  signWebhook,
  injectJwkForTest,
  resetJwkCache,
  type WebhookKeyPair,
} from "./helpers/plaid-webhook-mock.js";
import {
  verifyPlaidWebhook,
  PlaidWebhookVerifyError,
} from "../src/plaid/webhook-jwks.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

let keys: WebhookKeyPair;

beforeEach(async () => {
  resetPlaidMock();
  resetJwkCache();
  keys = await generateWebhookKeys();
});

describe("verifyPlaidWebhook", () => {
  it("accepts a valid JWT + matching body hash", async () => {
    injectJwkForTest(keys.kid, keys.publicKey);
    const body = Buffer.from(JSON.stringify({ webhook_type: "TRANSACTIONS", item_id: "i1" }));
    const jwt = await signWebhook(body, keys.privateKey, keys.kid);
    await expect(verifyPlaidWebhook(env, body, jwt)).resolves.toBeUndefined();
  });

  it("throws missing_header when JWT is undefined", async () => {
    const body = Buffer.from("{}");
    await expect(verifyPlaidWebhook(env, body, undefined)).rejects.toMatchObject({
      code: "missing_header",
    });
  });

  it("throws invalid_signature when JWT was signed by a different key", async () => {
    injectJwkForTest(keys.kid, keys.publicKey);
    const otherKeys = await generateWebhookKeys("test-kid-1"); // same kid, different actual key
    const body = Buffer.from("{}");
    const jwt = await signWebhook(body, otherKeys.privateKey, keys.kid);
    await expect(verifyPlaidWebhook(env, body, jwt)).rejects.toMatchObject({
      code: "invalid_signature",
    });
  });

  it("throws body_mismatch when body hash claim doesn't match raw body", async () => {
    injectJwkForTest(keys.kid, keys.publicKey);
    const signedBody = Buffer.from('{"webhook_type":"TRANSACTIONS"}');
    const actualBody = Buffer.from('{"webhook_type":"ITEM"}'); // different bytes
    const jwt = await signWebhook(signedBody, keys.privateKey, keys.kid);
    await expect(verifyPlaidWebhook(env, actualBody, jwt)).rejects.toMatchObject({
      code: "body_mismatch",
    });
  });

  it("throws iat_expired when iat is more than 5 minutes old", async () => {
    injectJwkForTest(keys.kid, keys.publicKey);
    const body = Buffer.from("{}");
    const oldIat = Math.floor(Date.now() / 1000) - 301; // 5min 1s ago
    const jwt = await signWebhook(body, keys.privateKey, keys.kid, oldIat);
    await expect(verifyPlaidWebhook(env, body, jwt)).rejects.toMatchObject({
      code: "iat_expired",
    });
  });

  it("fetches JWK from Plaid on cache miss and caches it", async () => {
    plaidMock.webhookVerificationKeyGet.push({ data: { key: { ...keys.jwk, expired_at: null } } });
    const body = Buffer.from("{}");
    const jwt = await signWebhook(body, keys.privateKey, keys.kid);

    await verifyPlaidWebhook(env, body, jwt);
    expect(plaidMock.webhookVerificationKeyGet.length).toBe(0); // consumed

    // Second call uses cache — no second Plaid call needed.
    const body2 = Buffer.from("{}");
    const jwt2 = await signWebhook(body2, keys.privateKey, keys.kid);
    await verifyPlaidWebhook(env, body2, jwt2); // would throw if it tried to pop from empty mock queue
  });

  it("rejects already-expired JWK from Plaid", async () => {
    const pastUnix = Math.floor(Date.now() / 1000) - 60;
    plaidMock.webhookVerificationKeyGet.push({
      data: { key: { ...keys.jwk, expired_at: pastUnix } },
    });
    const body = Buffer.from("{}");
    const jwt = await signWebhook(body, keys.privateKey, keys.kid);
    await expect(verifyPlaidWebhook(env, body, jwt)).rejects.toMatchObject({
      code: "key_expired",
    });
  });

  it("respects Plaid expired_at when shorter than max TTL", async () => {
    // Inject a key with an explicit short expiry (5 seconds from now).
    const shortExpiry = Date.now() + 5000;
    injectJwkForTest(keys.kid, keys.publicKey, shortExpiry);
    const body = Buffer.from("{}");
    const jwt = await signWebhook(body, keys.privateKey, keys.kid);

    // Within expiry: ok.
    await expect(verifyPlaidWebhook(env, body, jwt)).resolves.toBeUndefined();

    // Simulate time passing past the cache expiry — cache miss should re-fetch.
    // We push a new key into the Plaid mock; the cache should pop it.
    vi.useFakeTimers();
    vi.setSystemTime(shortExpiry + 1);
    plaidMock.webhookVerificationKeyGet.push({
      data: { key: { ...keys.jwk, expired_at: null } },
    });
    const jwt2 = await signWebhook(body, keys.privateKey, keys.kid, Math.floor(shortExpiry / 1000));
    await expect(verifyPlaidWebhook(env, body, jwt2)).resolves.toBeUndefined();
    expect(plaidMock.webhookVerificationKeyGet.length).toBe(0);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 3.2: Run the test — expect all to fail**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run tests/plaid.webhook.signature.test.ts 2>&1 | tail -30
```
Expected: all tests FAIL with "Cannot find module ../src/plaid/webhook-jwks.js" or similar.

- [ ] **Step 3.3: Implement webhook-jwks.ts**

Create `apps/api/src/plaid/webhook-jwks.ts`:

```typescript
import { compactVerify, importJWK, type KeyLike, type JWK } from "jose";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Env } from "../env.js";
import { plaidClient } from "./client.js";

const MAX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const IAT_WINDOW_S = 300;

export class PlaidWebhookVerifyError extends Error {
  constructor(public readonly code: string) {
    super(`Plaid webhook verification failed: ${code}`);
    this.name = "PlaidWebhookVerifyError";
  }
}

const PlaidJwtPayloadSchema = z.object({
  request_body_sha256: z.string(),
  iat: z.number(),
});

type CacheEntry = { key: KeyLike; expiresAt: number };
const cache = new Map<string, CacheEntry>();

async function getJwk(env: Env, kid: string): Promise<KeyLike> {
  const hit = cache.get(kid);
  if (hit && Date.now() < hit.expiresAt) return hit.key;

  const res = await plaidClient(env).webhookVerificationKeyGet({ key_id: kid });
  const jwk = res.data.key as JWK & { expired_at: number | null };

  if (jwk.expired_at !== null && jwk.expired_at * 1000 <= Date.now()) {
    throw new PlaidWebhookVerifyError("key_expired");
  }

  const key = await importJWK(jwk, "ES256");
  if (typeof key !== "object" || !("type" in key)) {
    // jose returns Uint8Array for symmetric keys — webhook verification is asymmetric (ES256), so this is unreachable.
    throw new PlaidWebhookVerifyError("invalid_jwk");
  }
  const plaidExpiry = jwk.expired_at !== null ? jwk.expired_at * 1000 : Number.POSITIVE_INFINITY;
  const expiresAt = Math.min(Date.now() + MAX_CACHE_TTL_MS, plaidExpiry);
  cache.set(kid, { key: key as KeyLike, expiresAt });
  return key as KeyLike;
}

export async function verifyPlaidWebhook(
  env: Env,
  rawBody: Buffer,
  jwtHeader: string | undefined,
): Promise<void> {
  if (!jwtHeader) throw new PlaidWebhookVerifyError("missing_header");

  let payload: Uint8Array;
  let kid: string;
  try {
    // First decode (without verifying) to learn the kid → fetch the right JWK → verify.
    const headerB64 = jwtHeader.split(".")[0];
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as { kid?: string };
    if (!header.kid) throw new Error("no kid");
    kid = header.kid;
  } catch {
    throw new PlaidWebhookVerifyError("invalid_signature");
  }

  const key = await getJwk(env, kid);

  try {
    const verified = await compactVerify(jwtHeader, key, { algorithms: ["ES256"] });
    payload = verified.payload;
  } catch {
    throw new PlaidWebhookVerifyError("invalid_signature");
  }

  const claims = PlaidJwtPayloadSchema.parse(JSON.parse(new TextDecoder().decode(payload)));

  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  if (claims.request_body_sha256 !== bodyHash) {
    throw new PlaidWebhookVerifyError("body_mismatch");
  }

  if (Math.abs(Date.now() / 1000 - claims.iat) > IAT_WINDOW_S) {
    throw new PlaidWebhookVerifyError("iat_expired");
  }
}

// Test-only helpers. Not part of the public surface.
export function _clearCacheForTest(): void {
  cache.clear();
}
export function _injectJwkForTest(kid: string, key: KeyLike, expiresAt: number): void {
  cache.set(kid, { key, expiresAt });
}
```

- [ ] **Step 3.4: Run the test — expect all to pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run tests/plaid.webhook.signature.test.ts 2>&1 | tail -30
```
Expected: all 8 tests PASS.

If a test fails, fix the implementation (do not change the test). Common issues:
- `key_expired` test expects the error before caching — make sure the expiry check runs before `importJWK`.
- `iat_expired` test signs with `iat = now - 301s`; ensure the comparison uses absolute value > 300.

- [ ] **Step 3.5: Commit**

```bash
git add apps/api/src/plaid/webhook-jwks.ts apps/api/tests/helpers/plaid-webhook-mock.ts apps/api/tests/helpers/plaid-mock.ts apps/api/tests/plaid.webhook.signature.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1b-webhooks): JWK cache + JWT signature verification

- verifyPlaidWebhook with ES256, request_body_sha256 check, iat 5min window
- JWK cache respects Plaid expired_at (min(24h, expired_at - now))
- Test helpers: ES256 keypair generator, signWebhook, JWK cache injector

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: webhook-dispatch.ts — sync + categorize dispatcher with TDD

**Files:**
- Create: `apps/api/src/plaid/webhook-dispatch.ts`
- Create: `apps/api/tests/plaid.webhook.dispatch.test.ts`

- [ ] **Step 4.1: Write the failing test**

Create `apps/api/tests/plaid.webhook.dispatch.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { resetPlaidMock } from "./helpers/plaid-mock.js";

const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
  async () => await import("./helpers/plaid-mock.js"),
);
vi.mock("plaid", hoistedPlaidMockFactory);

import { resetGeminiMock } from "./helpers/gemini-mock.js";
const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { dispatchWebhookSync } from "../src/plaid/webhook-dispatch.js";

vi.mock("../src/plaid/sync.js", async () => {
  return {
    syncTransactions: vi.fn(),
    SyncLockHeld: class SyncLockHeld extends Error {},
  };
});
vi.mock("../src/categorize/service.js", async () => {
  return { categorizeNewTransactions: vi.fn() };
});

import { syncTransactions } from "../src/plaid/sync.js";
import { categorizeNewTransactions } from "../src/categorize/service.js";

const env = { /* same minimal env as signature.test.ts */ } as any;

async function seedItem(): Promise<{ wsId: string; itemId: string; eventId: string }> {
  const ws = await prisma.workspace.create({ data: { name: "W" } });
  const item = await prisma.plaidItem.create({
    data: {
      workspaceId: ws.id,
      accessTokenCiphertext: Buffer.from([1]),
      accessTokenIv: Buffer.from([2]),
      itemId: `pi_${Math.random()}`,
      institutionId: "ins_1",
      institutionName: "Bank",
    },
  });
  const event = await prisma.plaidWebhookEvent.create({
    data: {
      plaidItemId: item.id,
      webhookType: "TRANSACTIONS",
      webhookCode: "SYNC_UPDATES_AVAILABLE",
      body: {},
    },
  });
  return { wsId: ws.id, itemId: item.id, eventId: event.id };
}

beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
  resetGeminiMock();
  vi.mocked(syncTransactions).mockReset();
  vi.mocked(categorizeNewTransactions).mockReset();
});

afterAll(async () => { await disconnect(); });

describe("dispatchWebhookSync", () => {
  it("sets processedAt after successful sync + categorize", async () => {
    const { wsId, itemId, eventId } = await seedItem();
    vi.mocked(syncTransactions).mockResolvedValue({ added: 2, modified: 0, removed: 0, newTxIds: ["t1", "t2"] });
    vi.mocked(categorizeNewTransactions).mockResolvedValue();

    await dispatchWebhookSync(env, wsId, itemId, eventId);

    const row = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).not.toBeNull();
    expect(row.processError).toBeNull();
    expect(categorizeNewTransactions).toHaveBeenCalledWith(env, wsId, ["t1", "t2"]);
  });

  it("does not call categorize when newTxIds is empty", async () => {
    const { wsId, itemId, eventId } = await seedItem();
    vi.mocked(syncTransactions).mockResolvedValue({ added: 0, modified: 5, removed: 0, newTxIds: [] });

    await dispatchWebhookSync(env, wsId, itemId, eventId);

    expect(categorizeNewTransactions).not.toHaveBeenCalled();
    const row = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).not.toBeNull();
  });

  it("leaves processedAt NULL when syncTransactions returns lock_held (retryable)", async () => {
    const { wsId, itemId, eventId } = await seedItem();
    vi.mocked(syncTransactions).mockResolvedValue({
      skipped: "lock_held", added: 0, modified: 0, removed: 0, newTxIds: [],
    });

    await dispatchWebhookSync(env, wsId, itemId, eventId);

    const row = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).toBeNull();
    expect(row.processError).toBeNull();
    expect(categorizeNewTransactions).not.toHaveBeenCalled();
  });

  it("records processError + processedAt when sync throws", async () => {
    const { wsId, itemId, eventId } = await seedItem();
    vi.mocked(syncTransactions).mockRejectedValue(new Error("plaid 500"));

    await dispatchWebhookSync(env, wsId, itemId, eventId);

    const row = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).not.toBeNull();
    expect(row.processError).toContain("plaid 500");
  });

  it("still categorizes newTxIds from a lock_held result if any were committed", async () => {
    // Note: lock_held leaves processedAt NULL, but committed newTxIds should
    // still be categorized so they get categories before cron retry.
    const { wsId, itemId, eventId } = await seedItem();
    vi.mocked(syncTransactions).mockResolvedValue({
      skipped: "lock_held", added: 1, modified: 0, removed: 0, newTxIds: ["t1"],
    });
    vi.mocked(categorizeNewTransactions).mockResolvedValue();

    await dispatchWebhookSync(env, wsId, itemId, eventId);

    expect(categorizeNewTransactions).toHaveBeenCalledWith(env, wsId, ["t1"]);
    const row = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).toBeNull(); // still retryable
  });
});
```

Replace the `const env = { ... } as any` placeholder with the same minimal env object used in `signature.test.ts` (copy-paste the literal).

- [ ] **Step 4.2: Run test — expect failure**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run tests/plaid.webhook.dispatch.test.ts 2>&1 | tail -20
```
Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement webhook-dispatch.ts**

Create `apps/api/src/plaid/webhook-dispatch.ts`:

```typescript
import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { syncTransactions } from "./sync.js";
import { categorizeNewTransactions } from "../categorize/service.js";

/**
 * Detached worker called by the webhook handler. The handler has already
 * returned 200 — this runs in the background.
 *
 * Result handling:
 *  - normal sync → processedAt set, processError null
 *  - sync threw   → processedAt set, processError = err.message
 *  - lock_held    → processedAt LEFT NULL (1B-cron retries; competing sync
 *                   may have started before this Plaid delta existed)
 *
 * In all "data committed" cases (normal + lock_held) we still call
 * categorizeNewTransactions on the newTxIds returned, so categories land
 * before any retry.
 */
export async function dispatchWebhookSync(
  env: Env,
  workspaceId: string,
  plaidItemId: string,
  webhookEventId: string,
): Promise<void> {
  try {
    const r = await syncTransactions(env, workspaceId, plaidItemId);

    if (r.newTxIds.length > 0) {
      await categorizeNewTransactions(env, workspaceId, r.newTxIds);
    }

    if ("skipped" in r) {
      // lock_held — leave processedAt NULL so cron retries.
      return;
    }

    await prisma.plaidWebhookEvent.update({
      where: { id: webhookEventId },
      data: { processedAt: new Date() },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
    await prisma.plaidWebhookEvent
      .update({
        where: { id: webhookEventId },
        data: { processedAt: new Date(), processError: msg },
      })
      .catch(() => {/* swallow — log handles diagnostic */});
    // eslint-disable-next-line no-console
    console.error("webhook sync failed", { err: e, plaidItemId, webhookEventId });
  }
}
```

- [ ] **Step 4.4: Run test — expect pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run tests/plaid.webhook.dispatch.test.ts 2>&1 | tail -20
```
Expected: all 5 tests PASS.

- [ ] **Step 4.5: Commit**

```bash
git add apps/api/src/plaid/webhook-dispatch.ts apps/api/tests/plaid.webhook.dispatch.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1b-webhooks): dispatchWebhookSync

- Detached sync + categorize after webhook handler returned 200
- lock_held leaves processedAt NULL (cron-retryable) but still categorizes any committed newTxIds
- Sync exception → processedAt + processError recorded for operational visibility

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Webhook route — TDD

**Files:**
- Create: `apps/api/src/routes/plaid-webhook.ts`
- Create: `apps/api/tests/plaid.webhook.routes.test.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 5.1: Write failing test**

Create `apps/api/tests/plaid.webhook.routes.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { resetPlaidMock } from "./helpers/plaid-mock.js";

const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
  async () => await import("./helpers/plaid-mock.js"),
);
vi.mock("plaid", hoistedPlaidMockFactory);

import { resetGeminiMock } from "./helpers/gemini-mock.js";
const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

import {
  generateWebhookKeys,
  signWebhook,
  injectJwkForTest,
  resetJwkCache,
  type WebhookKeyPair,
} from "./helpers/plaid-webhook-mock.js";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { truncateAll, disconnect } from "./helpers/db.js";

vi.mock("../src/plaid/webhook-dispatch.js", async () => {
  return { dispatchWebhookSync: vi.fn().mockResolvedValue(undefined) };
});
import { dispatchWebhookSync } from "../src/plaid/webhook-dispatch.js";

// Same minimal env literal as in plaid.webhook.signature.test.ts (Step 3.1) — copy verbatim.
const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

let keys: WebhookKeyPair;

async function seedItem(): Promise<{ wsId: string; pi: { id: string; itemId: string } }> {
  const ws = await prisma.workspace.create({ data: { name: "W" } });
  const pi = await prisma.plaidItem.create({
    data: {
      workspaceId: ws.id,
      accessTokenCiphertext: Buffer.from([1]),
      accessTokenIv: Buffer.from([2]),
      itemId: `pi_${Math.random()}`,
      institutionId: "ins_1",
      institutionName: "Bank",
    },
    select: { id: true, itemId: true },
  });
  return { wsId: ws.id, pi };
}

async function postWebhook(app: Awaited<ReturnType<typeof buildApp>>, body: object, jwt: string) {
  return await app.inject({
    method: "POST",
    url: "/plaid/webhook",
    headers: { "content-type": "application/json", "plaid-verification": jwt },
    payload: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
  resetGeminiMock();
  resetJwkCache();
  vi.mocked(dispatchWebhookSync).mockClear();
  keys = await generateWebhookKeys();
  injectJwkForTest(keys.kid, keys.publicKey);
});
afterAll(async () => { await disconnect(); });

describe("POST /plaid/webhook", () => {
  it("happy path: SYNC_UPDATES_AVAILABLE → 200, row stored, dispatch called", async () => {
    const app = await buildApp(env);
    const { wsId, pi } = await seedItem();
    const body = {
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: pi.itemId,
      initial_update_complete: true,
      historical_update_complete: true,
      environment: "sandbox",
    };
    const jwt = await signWebhook(Buffer.from(JSON.stringify(body)), keys.privateKey, keys.kid);

    const res = await postWebhook(app, body, jwt);

    expect(res.statusCode).toBe(200);
    const rows = await prisma.plaidWebhookEvent.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0].plaidItemId).toBe(pi.id);
    expect(rows[0].webhookType).toBe("TRANSACTIONS");
    expect(rows[0].webhookCode).toBe("SYNC_UPDATES_AVAILABLE");
    expect(dispatchWebhookSync).toHaveBeenCalledWith(env, wsId, pi.id, rows[0].id);
    await app.close();
  });

  it("invalid signature → 401, no row, no dispatch", async () => {
    const app = await buildApp(env);
    await seedItem();
    const body = { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "p_x" };
    const otherKeys = await generateWebhookKeys(keys.kid);
    const jwt = await signWebhook(Buffer.from(JSON.stringify(body)), otherKeys.privateKey, keys.kid);

    const res = await postWebhook(app, body, jwt);

    expect(res.statusCode).toBe(401);
    expect(await prisma.plaidWebhookEvent.count()).toBe(0);
    expect(dispatchWebhookSync).not.toHaveBeenCalled();
    await app.close();
  });

  it("unknown item_id → 200, row with plaidItemId=null, no dispatch", async () => {
    const app = await buildApp(env);
    const body = {
      webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "p_does_not_exist", environment: "sandbox",
    };
    const jwt = await signWebhook(Buffer.from(JSON.stringify(body)), keys.privateKey, keys.kid);

    const res = await postWebhook(app, body, jwt);

    expect(res.statusCode).toBe(200);
    const rows = await prisma.plaidWebhookEvent.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0].plaidItemId).toBeNull();
    expect(dispatchWebhookSync).not.toHaveBeenCalled();
    await app.close();
  });

  it("webhookType ITEM → 200, row stored, no dispatch", async () => {
    const app = await buildApp(env);
    const { pi } = await seedItem();
    const body = {
      webhook_type: "ITEM", webhook_code: "ERROR",
      item_id: pi.itemId, environment: "sandbox",
    };
    const jwt = await signWebhook(Buffer.from(JSON.stringify(body)), keys.privateKey, keys.kid);

    const res = await postWebhook(app, body, jwt);

    expect(res.statusCode).toBe(200);
    expect(await prisma.plaidWebhookEvent.count()).toBe(1);
    expect(dispatchWebhookSync).not.toHaveBeenCalled();
    await app.close();
  });

  it("non-JSON body → 400", async () => {
    const app = await buildApp(env);
    const jwt = await signWebhook(Buffer.from("not json"), keys.privateKey, keys.kid);
    const res = await app.inject({
      method: "POST",
      url: "/plaid/webhook",
      headers: { "content-type": "application/json", "plaid-verification": jwt },
      payload: "not json",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("same body twice → both rows stored, dispatch called twice (sync handles idempotency)", async () => {
    const app = await buildApp(env);
    const { pi } = await seedItem();
    const body = {
      webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: pi.itemId, environment: "sandbox",
    };
    const jwt1 = await signWebhook(Buffer.from(JSON.stringify(body)), keys.privateKey, keys.kid);
    const jwt2 = await signWebhook(Buffer.from(JSON.stringify(body)), keys.privateKey, keys.kid);

    const r1 = await postWebhook(app, body, jwt1);
    const r2 = await postWebhook(app, body, jwt2);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(await prisma.plaidWebhookEvent.count()).toBe(2);
    expect(dispatchWebhookSync).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
```

- [ ] **Step 5.2: Run — expect failure (route not registered)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run tests/plaid.webhook.routes.test.ts 2>&1 | tail -20
```
Expected: tests fail with 404 from the inject (route doesn't exist).

- [ ] **Step 5.3: Implement plaid-webhook.ts route**

Create `apps/api/src/routes/plaid-webhook.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { verifyPlaidWebhook, PlaidWebhookVerifyError } from "../plaid/webhook-jwks.js";
import { dispatchWebhookSync } from "../plaid/webhook-dispatch.js";

const WebhookBodySchema = z.object({
  webhook_type: z.string(),
  webhook_code: z.string(),
  item_id: z.string(),
}).passthrough();

export async function plaidWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Override the JSON parser to give us the raw buffer (we need the bytes
  // for SHA-256 hashing, which Fastify's default parser destroys by re-stringifying).
  // Scoped to this plugin's encapsulation context — does NOT affect other routes.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  app.post("/plaid/webhook", async (req, reply) => {
    const rawBody = req.body as Buffer;
    const jwt = req.headers["plaid-verification"];
    const jwtStr = Array.isArray(jwt) ? jwt[0] : jwt;

    try {
      await verifyPlaidWebhook(app.fina.env, rawBody, jwtStr);
    } catch (e) {
      if (e instanceof PlaidWebhookVerifyError) {
        return reply.code(401).send({ error: e.code });
      }
      throw e;
    }

    let parsed: z.infer<typeof WebhookBodySchema>;
    try {
      parsed = WebhookBodySchema.parse(JSON.parse(rawBody.toString("utf8")));
    } catch {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const item = await prisma.plaidItem.findUnique({
      where: { itemId: parsed.item_id },
      select: { id: true, workspaceId: true },
    });

    const event = await prisma.plaidWebhookEvent.create({
      data: {
        plaidItemId: item?.id ?? null,
        webhookType: parsed.webhook_type,
        webhookCode: parsed.webhook_code,
        body: parsed as object,
      },
      select: { id: true },
    });

    const isSyncRelevant =
      parsed.webhook_type === "TRANSACTIONS" &&
      parsed.webhook_code === "SYNC_UPDATES_AVAILABLE" &&
      item !== null;

    if (isSyncRelevant) {
      // Fire-and-forget. dispatchWebhookSync logs internally.
      void dispatchWebhookSync(app.fina.env, item.workspaceId, item.id, event.id).catch(() => {});
    } else {
      app.log.info(
        { webhookType: parsed.webhook_type, webhookCode: parsed.webhook_code, itemId: parsed.item_id },
        "webhook received but not dispatched",
      );
    }

    return reply.code(200).send({});
  });
}
```

- [ ] **Step 5.4: Register route in server.ts**

Open `apps/api/src/server.ts`. Add the import near the other route imports:

```typescript
import { plaidWebhookRoutes } from "./routes/plaid-webhook.js";
```

In `buildApp`, register the route plugin (order matters — register webhook routes BEFORE other plaid routes so the buffer parser is scoped correctly via Fastify's encapsulation):

```typescript
  await app.register(plaidWebhookRoutes);
```

Place this line right before `await app.register(plaidRoutes);`.

- [ ] **Step 5.5: Run test**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run tests/plaid.webhook.routes.test.ts 2>&1 | tail -20
```
Expected: all 6 tests PASS.

If the "non-JSON body → 400" test fails with a different code (e.g. 500), check that JSON.parse failure is caught and returns 400 explicitly.

- [ ] **Step 5.6: Run full API test suite to verify no regressions**

```bash
pnpm smoke:test --projects api 2>&1 | tail -10
```
Expected: 199 + 19 (new) = 218 tests pass.

- [ ] **Step 5.7: Commit**

```bash
git add apps/api/src/routes/plaid-webhook.ts apps/api/src/server.ts apps/api/tests/plaid.webhook.routes.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1b-webhooks): POST /plaid/webhook route

- Raw-buffer content-type parser scoped to this plugin (Fastify encapsulation)
- Signature verify → 401 on failure (Plaid sees its own key/rotation issue)
- Bad JSON → 400; unknown item_id → 200 with plaidItemId=null (no dispatch, prevents Plaid retry storm)
- TRANSACTIONS/SYNC_UPDATES_AVAILABLE → fire-and-forget dispatchWebhookSync
- Other webhook types → row stored + log, no dispatch

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Pass webhook URL to linkTokenCreate

**Files:**
- Modify: `apps/api/src/routes/plaid.ts`
- Modify: `apps/api/tests/plaid.routes.test.ts` (existing test that asserts on linkTokenCreate args)

- [ ] **Step 6.1: Update linkTokenCreate call**

Open `apps/api/src/routes/plaid.ts`. Find the `linkTokenCreate` call (around line 27-33). Add `webhook` field conditionally:

```typescript
      const res = await plaidClient(app.fina.env).linkTokenCreate({
        user: { client_user_id: ctx.session.userId },
        client_name: "Fina",
        products: PLAID_PRODUCTS,
        country_codes: PLAID_COUNTRY_CODES,
        language: "en",
        ...(app.fina.env.PLAID_WEBHOOK_URL ? { webhook: app.fina.env.PLAID_WEBHOOK_URL } : {}),
      });
```

- [ ] **Step 6.2: Add a test assertion for the webhook field**

Open `apps/api/tests/plaid.routes.test.ts`. Find an existing test for `POST /plaid/link-token` (look for `linkTokenCreate` or `link-token` in the file). Confirm `plaidMock` is already imported. Add this test after the existing link-token tests:

```typescript
  it("passes webhook URL to linkTokenCreate when PLAID_WEBHOOK_URL is set", async () => {
    const envWithUrl = { ...env, PLAID_WEBHOOK_URL: "https://example.com/plaid/webhook" };
    const app = await buildApp(envWithUrl);
    const u = await signUpAndGetCookie(app, { email: "wh-link@x.com", name: "WH" });
    const wsId = await getOwnerWorkspaceId(u.userId);

    plaidMock.linkTokenCreate.push({ data: { link_token: "link-tok", expiration: "2099-01-01" } });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);

    // Task 2.1 added linkTokenCreateCalls capture to plaid-mock.ts.
    expect(plaidMock.linkTokenCreateCalls[0][0]).toMatchObject({
      webhook: "https://example.com/plaid/webhook",
    });

    await app.close();
  });
```

- [ ] **Step 6.3: Add a negative test — no webhook field when env var absent**

In the same file:

```typescript
  it("omits webhook field when PLAID_WEBHOOK_URL is not set", async () => {
    const app = await buildApp(env); // env without PLAID_WEBHOOK_URL
    const u = await signUpAndGetCookie(app, { email: "wh-omit@x.com", name: "WO" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    plaidMock.linkTokenCreate.push({ data: { link_token: "t", expiration: "2099-01-01" } });

    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });

    expect(plaidMock.linkTokenCreateCalls[0][0]).not.toHaveProperty("webhook");
    await app.close();
  });
```

- [ ] **Step 6.4: Run**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run tests/plaid.routes.test.ts 2>&1 | tail -10
```
Expected: all existing tests + 2 new pass.

- [ ] **Step 6.5: Commit**

```bash
git add apps/api/src/routes/plaid.ts apps/api/tests/plaid.routes.test.ts apps/api/tests/helpers/plaid-mock.ts
git commit -m "feat(plan 1b-webhooks): pass PLAID_WEBHOOK_URL to linkTokenCreate

New items get the webhook URL registered explicitly. Omits the field when env var absent (Plaid Dashboard default applies).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Webhook URL backfill on startup

**Files:**
- Create: `apps/api/src/plaid/webhook-backfill.ts`
- Create: `apps/api/tests/plaid.webhook.backfill.test.ts`
- Modify: `apps/api/src/main.ts`

- [ ] **Step 7.1: Write failing test**

Create `apps/api/tests/plaid.webhook.backfill.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { resetPlaidMock, plaidMock } from "./helpers/plaid-mock.js";

const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
  async () => await import("./helpers/plaid-mock.js"),
);
vi.mock("plaid", hoistedPlaidMockFactory);

import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";

vi.mock("../src/plaid/items.js", async () => {
  return {
    readAccessToken: vi.fn().mockResolvedValue({
      accessToken: "decrypted-test-token",
      itemRow: { id: "stub", itemId: "stub" },
    }),
  };
});

import { backfillWebhookUrls } from "../src/plaid/webhook-backfill.js";

const baseEnv = { /* same minimal env literal */ } as any;

async function seedItem(opts: { webhookUrl?: string | null; status?: "active" | "error" } = {}) {
  const ws = await prisma.workspace.create({ data: { name: "W" } });
  return await prisma.plaidItem.create({
    data: {
      workspaceId: ws.id,
      accessTokenCiphertext: Buffer.from([1]),
      accessTokenIv: Buffer.from([2]),
      itemId: `pi_${Math.random()}`,
      institutionId: "ins_1",
      institutionName: "Bank",
      status: opts.status ?? "active",
      webhookUrl: opts.webhookUrl === undefined ? null : opts.webhookUrl,
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
});
afterAll(async () => { await disconnect(); });

describe("backfillWebhookUrls", () => {
  it("skips with log when PLAID_WEBHOOK_URL is absent", async () => {
    await seedItem({ webhookUrl: null });
    await backfillWebhookUrls(baseEnv); // env without PLAID_WEBHOOK_URL
    expect(plaidMock.itemWebhookUpdate.length).toBe(0); // no Plaid call attempted
  });

  it("updates items with NULL webhookUrl", async () => {
    const env = { ...baseEnv, PLAID_WEBHOOK_URL: "https://e.com/plaid/webhook" };
    const item = await seedItem({ webhookUrl: null });
    plaidMock.itemWebhookUpdate.push({ data: {} });

    await backfillWebhookUrls(env);

    expect(plaidMock.itemWebhookUpdate.length).toBe(0); // consumed
    const updated = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.webhookUrl).toBe("https://e.com/plaid/webhook");
  });

  it("updates items whose stored URL differs from current env URL", async () => {
    const env = { ...baseEnv, PLAID_WEBHOOK_URL: "https://new.com/plaid/webhook" };
    const item = await seedItem({ webhookUrl: "https://old.com/plaid/webhook" });
    plaidMock.itemWebhookUpdate.push({ data: {} });

    await backfillWebhookUrls(env);

    const updated = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.webhookUrl).toBe("https://new.com/plaid/webhook");
  });

  it("skips items already at the current URL", async () => {
    const env = { ...baseEnv, PLAID_WEBHOOK_URL: "https://e.com/plaid/webhook" };
    await seedItem({ webhookUrl: "https://e.com/plaid/webhook" });
    await backfillWebhookUrls(env);
    expect(plaidMock.itemWebhookUpdate.length).toBe(0);
  });

  it("skips non-active items", async () => {
    const env = { ...baseEnv, PLAID_WEBHOOK_URL: "https://e.com/plaid/webhook" };
    await seedItem({ webhookUrl: null, status: "error" });
    await backfillWebhookUrls(env);
    expect(plaidMock.itemWebhookUpdate.length).toBe(0);
  });

  it("logs and continues when one item fails", async () => {
    const env = { ...baseEnv, PLAID_WEBHOOK_URL: "https://e.com/plaid/webhook" };
    const a = await seedItem({ webhookUrl: null });
    const b = await seedItem({ webhookUrl: null });
    plaidMock.itemWebhookUpdate.push(new Error("plaid 500"));
    plaidMock.itemWebhookUpdate.push({ data: {} });

    await backfillWebhookUrls(env);

    const aRow = await prisma.plaidItem.findUniqueOrThrow({ where: { id: a.id } });
    const bRow = await prisma.plaidItem.findUniqueOrThrow({ where: { id: b.id } });
    // a's update failed → still null. b succeeded → set.
    expect(aRow.webhookUrl === null || bRow.webhookUrl === null).toBe(true);
    expect(aRow.webhookUrl !== null || bRow.webhookUrl !== null).toBe(true);
  });
});
```

- [ ] **Step 7.2: Run — expect failure**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run tests/plaid.webhook.backfill.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 7.3: Implement webhook-backfill.ts**

Create `apps/api/src/plaid/webhook-backfill.ts`:

```typescript
import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { plaidClient } from "./client.js";
import { readAccessToken } from "./items.js";

/**
 * One-shot startup task: ensure every active Plaid item has its current
 * PLAID_WEBHOOK_URL registered with Plaid. Runs items whose webhookUrl is
 * null (initial backfill) or differs from env.PLAID_WEBHOOK_URL (URL rotation
 * or domain migration).
 *
 * Best-effort: failures are logged, not thrown — startup must not be blocked
 * by a transient Plaid hiccup.
 */
export async function backfillWebhookUrls(env: Env): Promise<void> {
  if (!env.PLAID_WEBHOOK_URL) {
    // eslint-disable-next-line no-console
    console.warn("backfillWebhookUrls: PLAID_WEBHOOK_URL not set, skipping");
    return;
  }
  const wantUrl = env.PLAID_WEBHOOK_URL;

  const items = await prisma.plaidItem.findMany({
    where: {
      status: "active",
      OR: [{ webhookUrl: null }, { webhookUrl: { not: wantUrl } }],
    },
    select: { id: true, workspaceId: true, itemId: true },
  });

  for (const item of items) {
    try {
      const { accessToken } = await readAccessToken(env, item.workspaceId, item.id);
      await plaidClient(env).itemWebhookUpdate({
        access_token: accessToken,
        webhook: wantUrl,
      });
      await prisma.plaidItem.update({
        where: { id: item.id },
        data: { webhookUrl: wantUrl },
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("backfillWebhookUrls: failed for item", { itemId: item.id, err: e });
    }
  }
}
```

Note: `readAccessToken(env, workspaceId, plaidItemId)` from `./items.js` returns `{ accessToken, itemRow }` after decrypting via `../crypto/aes-gcm.ts`. This is the same helper `syncTransactions` uses — don't duplicate the decrypt logic.

- [ ] **Step 7.4: Run test — expect pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run tests/plaid.webhook.backfill.test.ts 2>&1 | tail -20
```
Expected: all 6 tests PASS.

- [ ] **Step 7.5: Wire backfill into main.ts**

Open `apps/api/src/main.ts`. Update to:

```typescript
import { loadEnv } from "./env.js";
import { buildApp } from "./server.js";
import { backfillWebhookUrls } from "./plaid/webhook-backfill.js";

async function start(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);
  await app.listen({ host: "0.0.0.0", port: env.PORT });

  // Detached — don't block server start. Backfill logs internally.
  void backfillWebhookUrls(env).catch((err) => {
    console.error("webhook backfill failed", err);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 7.6: Run full API test suite**

```bash
pnpm smoke:test --projects api 2>&1 | tail -10
```
Expected: all tests pass.

- [ ] **Step 7.7: Commit**

```bash
git add apps/api/src/plaid/webhook-backfill.ts apps/api/src/main.ts apps/api/tests/plaid.webhook.backfill.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1b-webhooks): startup backfill of PlaidItem.webhookUrl

- backfillWebhookUrls runs on startup for active items where webhookUrl IS NULL OR != env.PLAID_WEBHOOK_URL
- Skips with warning log when PLAID_WEBHOOK_URL absent (no throw)
- Best-effort: per-item failures logged, don't block other items or startup
- Detached from app.listen — server doesn't wait for backfill

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Smoke test doc + README

**Files:**
- Create: `docs/superpowers/smoke-tests/2026-05-12-plan-1b-webhooks.md`
- Modify: `README.md`

- [ ] **Step 8.1: Write smoke test doc**

Create `docs/superpowers/smoke-tests/2026-05-12-plan-1b-webhooks.md`:

````markdown
# Plan 1B-webhooks Smoke Test

**Date:** 2026-05-12
**Builds on:** Plan 1B-categorize smoke test

---

## Prerequisites

```bash
# All Plan 1B-categorize prerequisites + new:
sudo tailscale funnel --bg 4000          # one-time per machine
tailscale funnel status                   # confirm public URL like https://brian.tail-scale.ts.net

export PLAID_WEBHOOK_URL=https://<your>.<tailnet>.ts.net/plaid/webhook
pnpm smoke:db:start
pnpm smoke:api                            # Terminal A — must include PLAID_WEBHOOK_URL
pnpm smoke:web                            # Terminal B
```

Plaid Dashboard: webhook URL already registered as fallback. Per-item URL set automatically by `linkTokenCreate` for new items + startup backfill for old items.

---

## Part 1: Backfill + linkTokenCreate registration

```bash
# Verify backfill ran for any pre-existing items
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT id, \"institutionName\", \"webhookUrl\" FROM plaid_items WHERE status = 'active';"
# Expected: webhookUrl matches PLAID_WEBHOOK_URL

# Connect a new bank via web (sign in → Banks → Connect → Tartan-Dominion)
# Then verify the new item has the URL set immediately:
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT id, \"institutionName\", \"webhookUrl\" FROM plaid_items ORDER BY \"createdAt\" DESC LIMIT 1;"
```

---

## Part 2: Webhook receipt + sync trigger

```bash
# Get an item_id and access_token
ITEM_ID=$(docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT \"itemId\" FROM plaid_items WHERE status = 'active' LIMIT 1;")
echo "Item: $ITEM_ID"

# Fire webhook from Plaid sandbox (need a Plaid sandbox access token — get via API)
# This bypasses the encryption layer; use the encrypted access token via your API:
curl -s -X POST https://sandbox.plaid.com/sandbox/item/fire_webhook \
  -H "content-type: application/json" \
  -d "{\"client_id\":\"$PLAID_CLIENT_ID\",\"secret\":\"$PLAID_SECRET\",\"access_token\":\"<from-DB-after-decrypt>\",\"webhook_code\":\"SYNC_UPDATES_AVAILABLE\"}"

# Within 10 seconds:
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT id, \"webhookCode\", \"plaidItemId\", \"processedAt\", \"processError\" \
   FROM plaid_webhook_events ORDER BY \"receivedAt\" DESC LIMIT 5;"
# Expected: 1 new row with webhookCode=SYNC_UPDATES_AVAILABLE, processedAt set, processError null
```

---

## Part 3: Negative — invalid signature

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "$PLAID_WEBHOOK_URL" \
  -H "content-type: application/json" \
  -H "plaid-verification: not.a.real.jwt" \
  -d '{"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE","item_id":"x"}'
# Expected: 401

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT count(*) FROM plaid_webhook_events WHERE \"webhookType\" = 'TRANSACTIONS' AND \"plaidItemId\" IS NULL;"
# Expected: 0 (invalid sig means no row stored)
```

---

## Exit Criteria

- [ ] Funnel URL accessible from public internet (curl from another network returns 401 for unsigned POST)
- [ ] Existing items have `webhookUrl` populated after API restart (backfill)
- [ ] New Plaid Link → item has webhookUrl immediately
- [ ] Plaid `fire_webhook` → row in `plaid_webhook_events` within 10s, `processedAt` set within 15s
- [ ] New transactions appear (+ get categories) without manual Refresh
- [ ] Invalid signature → 401, no row, no sync triggered
````

- [ ] **Step 8.2: Update README**

Open `README.md`. Find the section listing Plan completions. Replace the line about Plan 1B-categorize being complete with both lines:

```markdown
- ✅ Plan 1B-categorize complete: <existing description>
- ✅ Plan 1B-webhooks complete: Plaid webhook handler — POST /plaid/webhook with ES256 JWT verify (jose, JWK cache respecting expired_at, iat 5min window), plaid_webhook_events audit table (no body-hash dedup; sync's cursor + row-level lock handles duplicates), detached sync+categorize dispatch, lock_held leaves processedAt NULL for cron retry, PlaidItem.webhookUrl with linkTokenCreate registration + startup backfill for items connected before this feature, PLAID_WEBHOOK_URL optional env var. **API: <N> tests passing.**
- 🚧 Next options: Plan 1B-cron (daily refresh + webhook event TTL cleanup + lock_held retry), Plan 1B-mobile (transactions UI). See spec §11.
```

Replace `<N>` with the actual count from `pnpm smoke:test --projects api 2>&1 | grep "Tests "` (expected ~224 = 199 baseline + ~25 new across Tasks 3/4/5/6/7).

- [ ] **Step 8.3: Commit**

```bash
git add docs/superpowers/smoke-tests/2026-05-12-plan-1b-webhooks.md README.md
git commit -m "docs(plan 1b-webhooks): smoke test + README progress

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: E2E test (Playwright, skip-guarded)

**Files:**
- Create: `e2e/plan-1b-webhooks.spec.ts`

- [ ] **Step 9.1: Write E2E spec**

Create `e2e/plan-1b-webhooks.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { Pool } from "pg";

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const PLAID_WEBHOOK_URL = process.env.PLAID_WEBHOOK_URL;

test.describe("Plan 1B-webhooks E2E", () => {
  test.skip(
    !PLAID_CLIENT_ID || !PLAID_SECRET || !PLAID_WEBHOOK_URL,
    "Requires real PLAID_CLIENT_ID / PLAID_SECRET / PLAID_WEBHOOK_URL (Funnel URL).",
  );

  test("Plaid sandbox fires SYNC_UPDATES_AVAILABLE → webhook event row created within 10s, processedAt set within 15s", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    // Get a Plaid item ID + decrypted access token via the API.
    // For E2E we assume one item already exists from a prior test run or manual setup.
    const itemRow = await pool.query(`
      SELECT "itemId", "accessTokenCiphertext", "accessTokenIv", "workspaceId"
      FROM plaid_items
      WHERE status = 'active'
      ORDER BY "createdAt" DESC
      LIMIT 1
    `);
    if (itemRow.rows.length === 0) {
      test.skip(true, "No active Plaid item in DB — run categorize smoke test first");
    }
    const { itemId } = itemRow.rows[0];

    // We can't decrypt server-side from here easily; use Plaid sandbox public token
    // exchange to create a fresh test item if needed, or call our own API endpoint to
    // trigger the fire_webhook. For now, hit the sandbox endpoint with the access_token
    // we'd need to fetch from a helper API. Simplest: create a fresh sandbox item here.
    const createRes = await fetch("https://sandbox.plaid.com/sandbox/public_token/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET,
        institution_id: "ins_109508", initial_products: ["transactions"],
        options: { webhook: PLAID_WEBHOOK_URL },
      }),
    }).then((r) => r.json());

    const exchangeRes = await fetch("https://sandbox.plaid.com/item/public_token/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET,
        public_token: createRes.public_token,
      }),
    }).then((r) => r.json());

    const fireBefore = new Date();
    await fetch("https://sandbox.plaid.com/sandbox/item/fire_webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET,
        access_token: exchangeRes.access_token,
        webhook_code: "SYNC_UPDATES_AVAILABLE",
      }),
    });

    // Poll plaid_webhook_events for receivedAt > fireBefore.
    let row: any = null;
    for (let i = 0; i < 20 && !row; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const q = await pool.query(
        `SELECT id, "processedAt", "processError" FROM plaid_webhook_events WHERE "receivedAt" > $1 LIMIT 1`,
        [fireBefore],
      );
      row = q.rows[0];
    }
    expect(row).toBeTruthy();

    // Wait up to 15s for processedAt
    let processed = row;
    for (let i = 0; i < 30 && !processed.processedAt; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const q = await pool.query(`SELECT "processedAt", "processError" FROM plaid_webhook_events WHERE id = $1`, [row.id]);
      processed = q.rows[0];
    }
    expect(processed.processedAt).not.toBeNull();
    expect(processed.processError).toBeNull();

    await pool.end();
  });
});
```

- [ ] **Step 9.2: Verify the spec at least parses (no run — requires real creds)**

```bash
npx playwright test e2e/plan-1b-webhooks.spec.ts --list 2>&1 | tail -10
```
Expected: lists the test (will skip without creds).

- [ ] **Step 9.3: Commit**

```bash
git add e2e/plan-1b-webhooks.spec.ts
git commit -m "test(plan 1b-webhooks): E2E spec — Plaid sandbox fire_webhook → DB row + processedAt

Skip-guarded on PLAID_CLIENT_ID / PLAID_SECRET / PLAID_WEBHOOK_URL. Creates a
fresh sandbox item with the Funnel webhook URL, fires SYNC_UPDATES_AVAILABLE,
asserts plaid_webhook_events row appears within 10s and processedAt within 15s.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Step 10.1: Full API suite**

```bash
pnpm smoke:test --projects api 2>&1 | tail -5
```
Expected: all tests pass (199 + new ones).

- [ ] **Step 10.2: Type check + lint**

```bash
pnpm typecheck 2>&1 | tail -5
pnpm lint 2>&1 | tail -10
```
Expected: clean.

- [ ] **Step 10.3: Verify no uncommitted changes**

```bash
git status
```
Expected: clean tree.
