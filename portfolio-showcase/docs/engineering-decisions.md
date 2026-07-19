# Engineering Decisions

This document records decisions visible in the current implementation. Where no original rationale is documented, the wording treats intent as an inference rather than a historical fact.

## Decision: Share API Contracts Across Clients

### Context

Fina has a Fastify API plus Next.js and Expo clients. Financial DTOs, role values, error codes, validation rules, and workspace transport behavior would drift if each application declared them independently.

### Decision

A workspace library is the source of truth for request schemas, response DTOs, constants, errors, roles, tier helpers, formatting, validation, and construction of the platform-specific API client.

### Rationale

Based on the current implementation, this structure appears designed to make incompatible client/server changes fail during type checking and to keep financial validation consistent before and after a request crosses the network.

### Trade-offs

- Shared contracts couple releases across applications and require disciplined package boundaries.
- Platform-specific UI and auth setup still need separate adapters.
- Type sharing does not replace runtime validation, so Zod schemas remain necessary at trust boundaries.

### Evidence in the Repository

- `libs/shared/src/dto`
- `libs/shared/src/schemas`
- `libs/shared/src/http/api-client.ts`
- `libs/shared/src/errors.ts`
- `apps/web/src/lib/api.ts`
- `apps/mobile/src/api/client.ts`
- `CLAUDE.md`

## Decision: Keep Sensitive Integrations Behind the API

### Context

Bank tokens, model credentials, webhook verification, email credentials, and subscription evidence must not be trusted to a public client. The same integrations also require shared authorization and persistence rules.

### Decision

The Fastify API owns provider credentials, token exchange, encrypted bank-token storage, model calls, webhook verification, email and push dispatch, purchase verification, and subscription normalization. Clients initiate workflows and render results but do not receive server credentials.

### Rationale

Based on the current implementation, this boundary appears designed to centralize trust decisions, keep provider secrets out of distributed clients, and ensure external events pass through the same database and authorization rules as interactive requests.

### Trade-offs

- Remote-only operations depend on API availability and network latency.
- The backend carries more integration complexity and provider-specific failure handling.
- Provider-controlled client SDKs are still needed for linking, social sign-in, and native purchase presentation.

### Evidence in the Repository

- `apps/api/src/plaid`
- `apps/api/src/crypto/aes-gcm.ts`
- `apps/api/src/llm/provider.ts`
- `apps/api/src/routes/billing-webhook.ts`
- `apps/api/src/routes/billing-iap-webhook.ts`
- `apps/api/src/email/send.ts`
- `apps/api/src/push/send.ts`

## Decision: Separate User-Owned Conversations from Workspace Authorization

### Context

Financial records are shared through workspaces, but conversation history is personal. A user may also begin a conversation before selecting the workspace that supplies financial context.

### Decision

Chat threads are owned by a user and can have an optional workspace association. A new thread can be created lazily and bind to a workspace on the first financial message. The API checks thread ownership and workspace membership independently.

### Rationale

Based on the current implementation, this structure appears designed to preserve private conversation ownership while still allowing tools to operate on shared, role-governed financial data. It also avoids persisting empty threads when a user opens and leaves the chat screen.

### Trade-offs

- Authorization has two dimensions: user ownership and workspace membership.
- Binding and mismatch behavior must be explicit to prevent cross-workspace context errors.
- Conversation listing and notification logic cannot rely on a workspace key alone.

### Evidence in the Repository

- `apps/api/src/routes/chat.ts`
- `apps/api/src/chat/threads.ts`
- `apps/api/prisma/schema.prisma`
- `apps/mobile/app/(tabs)/chat.tsx`
- `docs/superpowers/specs/2026-05-20-plan-2-chat-user-scope-design.md`

## Decision: Make Bank Synchronization Cursor-Driven and Idempotent

### Context

Bank updates can be paginated, replayed, modified after import, or triggered concurrently by interactive refresh, webhooks, and scheduled jobs. Provider access tokens also require stronger handling than ordinary application fields.

### Decision

The bank-sync service uses durable cursors, per-item and workspace locking, transactional page application, idempotent upserts, webhook event state, and retry jobs. Long-lived access tokens are encrypted before persistence and decrypted only in the server integration boundary.

### Rationale

Based on the current implementation, this structure appears designed to tolerate duplicate delivery and interrupted synchronization without advancing the cursor past uncommitted data or duplicating transactions.

### Trade-offs

- Locks and retry state add operational complexity.
- Per-page transactions favor recoverability over a single all-or-nothing import.
- Categorization is intentionally allowed to follow durable import, so classification can lag transaction arrival after a failure.

### Evidence in the Repository

- `apps/api/src/plaid/sync.ts`
- `apps/api/src/plaid/lock.ts`
- `apps/api/src/locks/workspace.ts`
- `apps/api/src/plaid/webhook-dispatch.ts`
- `apps/api/src/cron/jobs/retry-unprocessed.ts`
- `apps/api/src/plaid/items.ts`

## Decision: Constrain AI Through Registered Tools and Confirmation Intents

### Context

The advisor needs to read and sometimes change financial records, but generated output is probabilistic and natural-language requests can be ambiguous. Direct model access to the database would bypass validation and authorization.

### Decision

The API gives the model a registry of typed function declarations, dispatches requested tools through existing services, and records structured presentation blocks. Selected destructive or reconsiderable writes are represented as expiring action intents that execute only after a separate user confirmation.

### Rationale

Based on the current implementation, this structure appears designed to make model capabilities explicit, reuse server validation, and preserve user control over sensitive changes while still supporting direct execution for clearly specified, permitted actions.

### Trade-offs

- Tool schemas and presentation blocks must evolve together.
- Multi-round model/tool interaction adds latency and model cost.
- A confirmation layer reduces accidental actions but cannot resolve every ambiguous prompt automatically.

### Evidence in the Repository

- `apps/api/src/chat/turn.ts`
- `apps/api/src/chat/dispatcher.ts`
- `apps/api/src/chat/tools`
- `apps/api/src/intents/service.ts`
- `apps/api/src/routes/intents.ts`
- `apps/mobile/src/chat/PresentationBlock.tsx`

## Decision: Reconcile All Billing Channels Server-Side

### Context

Stripe, Apple, and Google expose different purchase identifiers, lifecycle states, notification formats, and recovery behavior. A client-visible purchase result alone is insufficient evidence for durable access.

### Decision

Provider events and app-initiated receipts are verified on the server, normalized into subscription records, and reduced through deterministic precedence to one effective entitlement. Webhook deduplication, environment checks, account binding, integrity records, refresh, restore, and recovery flows handle disagreement between local and server state.

### Rationale

Based on the current implementation, this structure appears designed to prevent a stale or manipulated client from granting access and to make overlapping payment channels resolve consistently.

### Trade-offs

- The backend must track three provider models and their asynchronous events.
- Deterministic precedence can surprise users with overlapping subscriptions, requiring clear recovery UI.
- Store API outages can delay entitlement refresh even after a valid purchase.

### Evidence in the Repository

- `apps/api/src/billing/precedence.ts`
- `apps/api/src/stripe/sync-sub.ts`
- `apps/api/src/iap/sync-sub.ts`
- `apps/api/src/iap/integrity.ts`
- `apps/api/src/routes/billing-webhook.ts`
- `apps/api/src/routes/billing-iap-webhook.ts`
- `apps/mobile/src/iap`
