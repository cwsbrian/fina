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
# Get an item_id
ITEM_ID=$(docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT \"itemId\" FROM plaid_items WHERE status = 'active' LIMIT 1;")
echo "Item: $ITEM_ID"

# Fire webhook from Plaid sandbox
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
  "SELECT count(*) FROM plaid_webhook_events WHERE \"webhookType\" = 'TRANSACTIONS';"
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
