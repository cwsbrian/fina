# Smoke Test — Plan 1C-scheduled-spend

**Goal:** validate ScheduledSpend end-to-end against a running local API.

**Pre-req:** `pnpm --filter @fina/api dev` running. Have a workspace
membership cookie for an `editor+` user. Substitute `$WS`, `$COOKIE`,
`$CAT_ID` below.

## Setup — create a category

```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/categories" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"name":"Dental"}'
```
Capture id → `$CAT_ID`.

## 1. POST create schedule

```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/schedules" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$CAT_ID\",\"amount\":300,\"scheduledDate\":\"2099-12-25\",\"note\":\"dental visit\"}"
```
Expected: 201, body has `schedule.id`, `amount: "300"`, `scheduledDate: "2099-12-25"`.
Capture id → `$SCH`.

## 2. GET list — derived status

```bash
curl -sS "http://localhost:3001/workspaces/$WS/schedules?status=all" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```
Expected: the schedule appears with `status: "upcoming"`.

## 3. Manual tx in same category + date

Create a manual tx matching the schedule's category + date:
```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/transactions/manual" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"merchantRaw\":\"Dentist\",\"amount\":300,\"occurredAt\":\"2099-12-25\",\"categoryId\":\"$CAT_ID\"}"
```
Expected: 201.

## 4. Trigger cron manually

Open the API process, OR temporarily call the match function via a one-shot script. **Important**: pass a `today` Date that's clearly AFTER the schedule's date in the workspace owner's tz — using midnight UTC like `new Date('2099-12-25')` can leave the schedule on Dec 24 in Toronto, causing the candidate filter `scheduledDate <= today` to skip it. Use noon UTC of the day after:

```bash
# pnpm --filter sets cwd to apps/api, so paths are RELATIVE to apps/api/
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina pnpm --filter @fina/api exec tsx -e "import('./src/schedules/match.js').then(({matchScheduledSpends}) => matchScheduledSpends('$WS', new Date('2099-12-26T12:00:00Z')))"
```
(Or restart the dev server with cron enabled and wait until 09:05 UTC.)

## 5. GET list again — matched status

```bash
curl -sS "http://localhost:3001/workspaces/$WS/schedules?status=all" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```
Expected: schedule's `status` is `"resolved-matched"`, `matchedTxId` is set.

## 6. Dismiss flow on a different schedule

Create a second past schedule and dismiss it.
```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/schedules" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$CAT_ID\",\"amount\":50,\"scheduledDate\":\"2020-01-01\"}"
# capture id → $SCH2
curl -sS -X POST "http://localhost:3001/workspaces/$WS/schedules/$SCH2/dismiss" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```
Expected: 200, `schedule.dismissedAt` set. GET shows `status: "resolved-dismissed"`.

## 7. Idempotent dismiss

```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/schedules/$SCH2/dismiss" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```
Expected: 200, `{ dismissed: false, alreadyDismissed: true }`.

## 8. DELETE schedule

```bash
curl -sS -X DELETE "http://localhost:3001/workspaces/$WS/schedules/$SCH" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```
Expected: 200, `{ removed: true }`.

## 9. DELETE idempotent

```bash
curl -sS -X DELETE "http://localhost:3001/workspaces/$WS/schedules/$SCH" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```
Expected: 200, `{ removed: false, alreadyRemoved: true }`.

## 10. Budget shows `planned`

Set a budget for `$CAT_ID`, then create an upcoming schedule and call `compare-spending-vs-budget`:
```bash
# Set budget for Dental this_month
curl -sS -X POST "http://localhost:3001/workspaces/$WS/budgets" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$CAT_ID\",\"amount\":500,\"period\":\"this_month\"}"

# Add an upcoming schedule for this month (date = today + 1, in current month)
curl -sS -X POST "http://localhost:3001/workspaces/$WS/schedules" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$CAT_ID\",\"amount\":150,\"scheduledDate\":\"<tomorrow YYYY-MM-DD>\"}"

# Call compareSpendingVsBudget directly via tsx (no dedicated HTTP chat-tool endpoint;
# the chat tool is invoked from the chat thread or via this one-shot)
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api exec tsx -e "
import('./src/budgets/service.js').then(async ({ compareSpendingVsBudgetService }) => {
  const r = await compareSpendingVsBudgetService(
    { workspaceId: '$WS', userId: '<your-user-id>' },
    { period: 'this_month' },
  );
  console.log(JSON.stringify(r, null, 2));
});
"
```
Expected: the Dental item has `planned: "150.00"` and `plannedPct: 30`. Alternatively, send a chat message in the dev web UI ("how's my budget this month?") — the LLM will invoke the `compareSpendingVsBudget` tool internally and return the result inline.

## Result

Record PASS/FAIL for each of the 10 steps. All PASS = ship.
