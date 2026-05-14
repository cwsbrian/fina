import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import { plaidClient, mapPlaidError, PLAID_PRODUCTS, PLAID_COUNTRY_CODES } from "../plaid/client.js";
import { storeAccessToken } from "../plaid/items.js";
import { syncTransactions } from "../plaid/sync.js";
import { categorizeNewTransactions } from "../categorize/service.js";

const ExchangeBody = z.object({
  publicToken: z.string().min(1),
  institutionId: z.string().min(1),
  institutionName: z.string().min(1),
});

async function checkPlaidItemLimit(
  userId: string,
  workspaceId: string,
): Promise<{ error: string } | null> {
  const t = await effectiveTier(userId);
  if (t.plaidItemLimit === 0) return { error: "upgrade_required" };

  const count = await prisma.plaidItem.count({
    where: { workspaceId, status: { not: "disconnected" } },
  });
  if (count >= t.plaidItemLimit) return { error: "plaid_item_limit_reached" };
  return null;
}

export async function plaidRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:id/plaid/link-token", async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const limitErr = await checkPlaidItemLimit(ctx.session.userId, params.id);
      if (limitErr) return reply.code(402).send(limitErr);
      const res = await plaidClient(app.fina.env).linkTokenCreate({
        user: { client_user_id: ctx.session.userId },
        client_name: "Fina",
        products: PLAID_PRODUCTS,
        country_codes: PLAID_COUNTRY_CODES,
        language: "en",
        ...(app.fina.env.PLAID_WEBHOOK_URL ? { webhook: app.fina.env.PLAID_WEBHOOK_URL } : {}),
      });
      return { linkToken: res.data.link_token, expiration: res.data.expiration };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapPlaidError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });

  app.post("/workspaces/:id/plaid/exchange", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = ExchangeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    let plaidItemId: string;
    let accountCount: number;
    let verifiedWsId: string; // hoisted so Step 3 uses the ctx-verified value, not a raw header re-read
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      verifiedWsId = ctx.membership.workspaceId;
      const limitErr = await checkPlaidItemLimit(ctx.session.userId, verifiedWsId);
      if (limitErr) return reply.code(402).send(limitErr);

      // ---- Step 1: Plaid exchange + accounts/get ----
      const exch = await plaidClient(app.fina.env).itemPublicTokenExchange({
        public_token: parsed.data.publicToken,
      });
      const accountsRes = await plaidClient(app.fina.env).accountsGet({
        access_token: exch.data.access_token,
      });

      // ---- Step 2: Item + accounts in one tx ----
      const result = await prisma.$transaction(async (tx) => {
        const itemRowId = await storeAccessToken(app.fina.env, tx, {
          workspaceId: ctx.membership.workspaceId,
          connectedBy: ctx.session.userId,
          itemId: exch.data.item_id,
          institutionId: parsed.data.institutionId,
          institutionName: parsed.data.institutionName,
          accessToken: exch.data.access_token,
          webhookUrl: app.fina.env.PLAID_WEBHOOK_URL ?? null,
        });
        for (const a of accountsRes.data.accounts) {
          await tx.bankAccount.create({
            data: {
              workspaceId: ctx.membership.workspaceId,
              plaidItemId: itemRowId,
              plaidAccountId: a.account_id,
              name: a.name,
              officialName: a.official_name ?? null,
              mask: a.mask ?? null,
              type: a.type,
              subtype: a.subtype ?? null,
              currency: a.balances?.iso_currency_code ?? "CAD",
              balanceCurrent: a.balances?.current ?? null,
              balanceAvailable: a.balances?.available ?? null,
              balanceLimit: a.balances?.limit ?? null,
              lastBalanceSyncAt: new Date(),
            },
          });
        }
        return { itemRowId, accountCount: accountsRes.data.accounts.length };
      });

      plaidItemId = result.itemRowId;
      accountCount = result.accountCount;
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return reply.code(422).send({ error: "already_connected" });
      }
      const m = mapPlaidError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }

    // ---- Step 3: Initial sync — separate, partial-failure tolerant + soft timeout ----
    // The connect flow blocks on this; if Plaid sandbox or a slow institution
    // takes >30s to first-page sync, we'd hang the user's browser. Race against
    // a 30s deadline and report `syncOk: false` (the item is durable, the user
    // can hit Refresh later or wait for the next cron tick once that ships).
    //
    // Deadline is overridable via `app.fina.env.PLAID_SYNC_TIMEOUT_MS` so the
    // test suite can exercise the timeout path with a real (small) timer
    // instead of fighting vi.useFakeTimers + fastify.inject.
    const SYNC_DEADLINE_MS = app.fina.env.PLAID_SYNC_TIMEOUT_MS ?? 30_000;
    let transactionCount = 0;
    let syncOk = true;
    try {
      const r = await Promise.race([
        syncTransactions(app.fina.env, verifiedWsId, plaidItemId),
        new Promise<{ skipped: "deadline" }>((resolve) =>
          setTimeout(() => resolve({ skipped: "deadline" }), SYNC_DEADLINE_MS),
        ),
      ]);
      if ("skipped" in r) {
        syncOk = false;
        if (r.skipped === "deadline") {
          // Spec §7: a deadline-hit initial sync leaves the item in `error`
          // with `errorCode = "sync_timeout"` so the UI knows to prompt the
          // user to retry (vs. the vanishingly-rare `lock_held` on a brand-
          // new item, which we leave alone — the racing sync will set its
          // own status when it finishes).
          await prisma.plaidItem.update({
            where: { id: plaidItemId },
            data: { status: "error", errorCode: "sync_timeout" },
          });
        }
      } else {
        transactionCount = r.added;
      }

      // Detached categorize — keeps the response fast. Errors are logged.
      if ("newTxIds" in r && r.newTxIds.length > 0) {
        const newTxIds = r.newTxIds;
        void categorizeNewTransactions(app.fina.env, verifiedWsId, newTxIds).catch((e) => {
          app.log.error({ err: e, plaidItemId, workspace: verifiedWsId }, "categorize after exchange failed");
        });
      }
    } catch {
      // Status was already persisted inside syncTransactions's catch.
      syncOk = false;
    }

    return reply.code(200).send({ plaidItemId, accountCount, transactionCount, syncOk });
  });
}
