# Plan 1K-cleanup-chat-index Design

**Status:** Draft → User review pending
**Predecessor:** Plan 1K-cleanup (shipped) — addressed env.test.ts STRIPE fixtures + chat.tools.registry duplicate count assertion. Did NOT address the recurring `chat_threads_userId_archivedAt_lastMessageAt_idx` drop pattern.

## 1. Goal & scope

`chat_threads_userId_archivedAt_lastMessageAt_idx` index가 매 `prisma migrate dev` 자동생성 시 silent하게 DROP되는 패턴 종료. Prisma 5.22의 `nulls: "Last"` @@index 지원으로 schema에 index를 명시하면 Prisma가 인지 상태 → auto-DROP 자체가 생성되지 않음.

**문제 history:**
- Plan 2B `_plan_2b_daily_brief` migration이 schema에 없던 index를 auto-DROP → `_ensure_chat_listing_index`로 복구.
- Plan billing-pending-tier (`_billing_pending_tier`, 2026-05-22 17:15)이 동일 패턴 재발 → 현재 dev/test DB에 index 부재.
- 향후 누구든 `prisma migrate dev` 돌리면 똑같이 발생. 재발 가드 없으면 무한 반복.

**Out of scope:**
- `plaid.routes.test.ts` deadlock 조사 (단독 36/36 pass, 동시 실행만 deadlock — 별도 plan, scope #4 잔여).
- Migration template / CI lint (schema fix가 근본 + Prisma 5.5+의 `nulls` keyword 지원으로 자연 해결).
- 다른 raw-SQL-only indexes audit — codebase에 더 없음 확인.

## 2. Shared library touchpoints

**없음.** API 내부 schema + migration만 변경. `@fina/shared` 영향 0. `libs/shared/src/logging.ts` LogContext 추가 0. 사용자 facing 변경 0.

## 3. Schema 변경

`apps/api/prisma/schema.prisma` ChatThread model에 `@@index` 추가:

```prisma
model ChatThread {
  id            String    @id @default(cuid())
  userId        String
  workspaceId   String?
  title         String?
  lastMessageAt DateTime?
  archivedAt    DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  user      User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  workspace Workspace?    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  messages  ChatMessage[]

  // Supports the chat-thread listing query at apps/api/src/chat/threads.ts:
  //   findMany WHERE userId = ? ORDER BY archivedAt ASC, lastMessageAt DESC NULLS LAST.
  // Prisma 5.5+ supports the `nulls` keyword in @@index — that's why this
  // can finally live in schema instead of raw migration SQL.
  @@index([userId, archivedAt, lastMessageAt(sort: Desc, nulls: Last)])
  @@map("chat_threads")
}
```

기존 comment `// Index lives in the migration SQL because @@index can't express NULLS LAST.` 제거.

## 4. Migration

새 migration `apps/api/prisma/migrations/<timestamp>_chat_listing_index_in_schema/migration.sql`:

```sql
-- Plan 1K-cleanup-chat-index: schema-side @@index addition is idempotent
-- on DBs that already have the index, restorative on DBs that don't (e.g.,
-- those affected by the billing-pending-tier auto-DROP). IF NOT EXISTS
-- keeps it safe in both cases.
CREATE INDEX IF NOT EXISTS "chat_threads_userId_archivedAt_lastMessageAt_idx"
  ON "chat_threads" ("userId", "archivedAt", "lastMessageAt" DESC NULLS LAST);
```

Timestamp via `date -u +%Y%m%d%H%M%S`.

**중요 detail**: index 이름 `chat_threads_userId_archivedAt_lastMessageAt_idx`은 Prisma 5.x의 @@index auto-naming convention (`<table>_<cols>_idx`)과 정확히 일치. 추가 인덱스 없이 schema-DB 동기화됨.

## 5. Verification gates

순서대로 진행:

1. **Schema validation**:
   ```bash
   pnpm --filter @fina/api exec prisma validate
   pnpm --filter @fina/api exec prisma format
   ```
   Expected: clean output (no syntax errors).

2. **Apply migration**:
   ```bash
   cd apps/api && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec prisma migrate deploy
   cd apps/api && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina pnpm exec prisma migrate deploy
   ```
   Expected: "1 migration applied".

3. **Schema-DB sync check**:
   ```bash
   cd apps/api && pnpm exec prisma migrate diff --from-url=postgresql://fina:fina@localhost:5433/fina --to-schema-datamodel prisma/schema.prisma --script
   ```
   Expected: `-- This is an empty migration.`

4. **Recurrence regression**:
   ```bash
   cd apps/api && pnpm exec prisma migrate dev --name regression_check --create-only
   ```
   Expected: "Already in sync, no schema change or pending migration was found." — confirms no auto-DROP generated.
   (Discard the generated migration dir if any was created — it should be empty/absent.)

5. **Test gate**:
   ```bash
   DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.migration.smoke.test.ts
   ```
   Expected: 5/5 pass (현재 2 fail).

## 6. Testing

기존 `apps/api/tests/chat.migration.smoke.test.ts` 5개 테스트 cover:
- "index chat_threads_userId_archivedAt_lastMessageAt_idx exists" (현재 fail)
- "EXPLAIN of the user-listing query uses the new index" (현재 fail)
- 3개 다른 케이스 (현재 pass — 변동 없음)

새 테스트 작성 불필요 — 이미 root cause regression이 잡힘. Fix 후 5/5 green.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Prisma 5.22의 `nulls: "Last"` 문법이 spec과 다름 (오타 / sub-key 잘못) | §5 step 1의 `prisma validate` + `prisma format` 통과 확인. 실패 시 spec 갱신 + 재시도. |
| @@index addition으로 Prisma migrate dev autogen이 별도 CREATE INDEX 만들어냄 | §5 step 4가 정확히 이걸 detect. "Already in sync"가 나와야 함. 그 외 출력 시 SQL 검토 후 hand-edit. |
| Production DB에 index 이미 존재 (대부분 케이스) | IF NOT EXISTS로 idempotent. 추가 작업 0. |
| `prisma format`이 index 줄 순서 재배치 → diff 노이즈 | format 후 git diff 확인하면 명확. 의도된 reformat은 commit에 포함. |
| Concurrent test execution이 chat_threads에 락 걸려 migration 실패 | dev/test DB은 단독 사용자라 락 충돌 없음. CI는 사용자 안 함. |

## 8. Success criteria

- `chat.migration.smoke.test.ts` 5/5 green.
- `prisma migrate diff` empty.
- `prisma migrate dev --create-only --name <anything>` 시 auto-DROP 명령 0건 — schema와 DB sync 상태.
- 단일 schema 변경 + 단일 migration commit.
- 향후 같은 시한폭탄 재발 가능성 0 (Prisma가 index 존재를 인지하기 때문).

## 9. Follow-ups (별도 plan)

- `plaid.routes.test.ts` deadlock 조사 (단독 pass / 동시 deadlock — singleFork mode row lock 경합 추정).
- 향후 raw-SQL-only index가 다시 필요해질 때 (예: GIN, BRIN 같은 Prisma 미지원 index 종류) 본 spec을 reference로 패턴 정립 — schema commit 비워두지 말고 comment로 명시할 것.
