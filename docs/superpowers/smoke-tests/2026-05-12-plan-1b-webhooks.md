# Plan 1B-webhooks Smoke Test

**Date:** 2026-05-12
**Builds on:** Plan 1B-categorize smoke test

---

## Prerequisites

```bash
# All Plan 1B-categorize prerequisites + new:
sudo tailscale funnel --bg 4000          # one-time per machine
tailscale funnel status                   # confirm public URL like https://brian-1.tail49be41.ts.net

# Load .env into the shell so curls in Part 2/3 see PLAID_CLIENT_ID,
# PLAID_SECRET, etc. (pnpm smoke:api also picks these up — nx run-commands
# auto-loads .env — but the curls in this doc run in the bare shell.)
set -a; source .env; set +a
export PLAID_WEBHOOK_URL=https://<your>.<tailnet>.ts.net/plaid/webhook   # override .env value if needed

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

# Connect a new bank via web (sign in → Banks → Connect → any sandbox bank)
# Then verify the new item has the URL set immediately:
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT id, \"institutionName\", \"webhookUrl\" FROM plaid_items ORDER BY \"createdAt\" DESC LIMIT 1;"
```

> **Note — legacy items**: items created under a different `ENCRYPTION_KEY` will fail
> backfill silently. Look for `backfillWebhookUrls: failed for item` in the API log;
> the sanitized err will have all-null fields because the throw is from
> `readAccessToken` (decryption), not from a Plaid axios response. This does not
> affect new connections — only the historical items can't have their webhook
> URL re-registered without the original key.

---

## Part 2: Webhook receipt + sync trigger

`fire_webhook` needs the **raw** (decrypted) access_token, which our DB never
exposes. There are two paths depending on what you want to verify:

### Part 2a — receipt only (any sandbox token)

This confirms Funnel → JWT verify → row stored. The webhook arrives for an
item that's NOT in our DB, so `plaidItemId` is null and `dispatchWebhookSync`
is skipped (you'll see `"webhook received but not dispatched"` in the API log).

```bash
# 1) Mint a fresh sandbox access_token and register our Funnel URL on it.
PUBLIC_TOKEN=$(curl -s -X POST https://sandbox.plaid.com/sandbox/public_token/create \
  -H "content-type: application/json" \
  -d "{\"client_id\":\"$PLAID_CLIENT_ID\",\"secret\":\"$PLAID_SECRET\",\"institution_id\":\"ins_109508\",\"initial_products\":[\"transactions\"]}" \
  | jq -r .public_token)
ACCESS_TOKEN=$(curl -s -X POST https://sandbox.plaid.com/item/public_token/exchange \
  -H "content-type: application/json" \
  -d "{\"client_id\":\"$PLAID_CLIENT_ID\",\"secret\":\"$PLAID_SECRET\",\"public_token\":\"$PUBLIC_TOKEN\"}" \
  | jq -r .access_token)
curl -s -X POST https://sandbox.plaid.com/item/webhook/update \
  -H "content-type: application/json" \
  -d "{\"client_id\":\"$PLAID_CLIENT_ID\",\"secret\":\"$PLAID_SECRET\",\"access_token\":\"$ACCESS_TOKEN\",\"webhook\":\"$PLAID_WEBHOOK_URL\"}" \
  | jq -r '.item.webhook // .error_message'

# 2) Fire the webhook.
curl -s -X POST https://sandbox.plaid.com/sandbox/item/fire_webhook \
  -H "content-type: application/json" \
  -d "{\"client_id\":\"$PLAID_CLIENT_ID\",\"secret\":\"$PLAID_SECRET\",\"access_token\":\"$ACCESS_TOKEN\",\"webhook_code\":\"SYNC_UPDATES_AVAILABLE\"}"

# 3) Within 10s a row appears.
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT id, \"webhookCode\", \"plaidItemId\", \"processedAt\", \"processError\" \
   FROM plaid_webhook_events ORDER BY \"receivedAt\" DESC LIMIT 5;"
# Expected: 1 new row with webhookCode=SYNC_UPDATES_AVAILABLE.
# plaidItemId=null and processedAt=null are expected here (unknown item).
```

### Part 2b — full sync trigger (item known to our DB)

`processedAt` only flips to non-null when the webhook is for an item our DB
knows about (`plaidItemId` non-null → `dispatchWebhookSync` runs → row updated
on success). Currently there is no helper to expose a connected item's raw
access_token for sandbox fire, so this leg is verified via the E2E spec
(`e2e/plan-1b-webhooks.spec.ts`) which mints + registers a fresh token, OR by
manually following Part 2a but using a token that ALSO exists in our DB.

A pragmatic shortcut: run Part 2a, then in a separate terminal POST
`/workspaces/<id>/plaid/exchange` with the same `$PUBLIC_TOKEN` — but Plaid
rejects re-exchange. Easier path is a one-off `tsx` script that decrypts a
DB-stored token; tracked as follow-up, not blocking this smoke run.

---

## Part 3: Negative — invalid signature

```bash
# Capture the current TRANSACTIONS row count.
BEFORE=$(docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT count(*) FROM plaid_webhook_events WHERE \"webhookType\" = 'TRANSACTIONS';")

curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "$PLAID_WEBHOOK_URL" \
  -H "content-type: application/json" \
  -H "plaid-verification: not.a.real.jwt" \
  -d '{"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE","item_id":"x"}'
# Expected: 401

AFTER=$(docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT count(*) FROM plaid_webhook_events WHERE \"webhookType\" = 'TRANSACTIONS';")
echo "before=$BEFORE after=$AFTER"
# Expected: before == after (invalid sig means no row stored)
```

---

## Exit Criteria

- [ ] Funnel URL accessible from public internet (curl from another network returns 401 for unsigned POST)
- [ ] Existing items (created with the current `ENCRYPTION_KEY`) have `webhookUrl` populated after API restart (backfill). Legacy items can fail silently — see Part 1 note.
- [ ] New Plaid Link → item has `webhookUrl` immediately
- [ ] Plaid `fire_webhook` → row in `plaid_webhook_events` within 10s (Part 2a, any sandbox token)
- [ ] Plaid `fire_webhook` for a known item → `processedAt` set within 15s, new tx appear with categories (Part 2b — currently covered by E2E)
- [ ] Invalid signature → 401, row count unchanged, no sync triggered
