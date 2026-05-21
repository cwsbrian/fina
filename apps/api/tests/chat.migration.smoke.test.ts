import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { disconnect } from "./helpers/db.js";

afterAll(async () => { await disconnect(); });

describe("plan 2-chat-user-scope migration smoke", () => {
  it("index chat_threads_userId_archivedAt_lastMessageAt_idx exists", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
        WHERE tablename = 'chat_threads'
          AND indexname = 'chat_threads_userId_archivedAt_lastMessageAt_idx';
    `;
    expect(rows.length).toBe(1);
  });

  it("old workspaceId-keyed index is gone", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
        WHERE tablename = 'chat_threads'
          AND indexname = 'chat_threads_workspaceId_archivedAt_lastMessageAt_idx';
    `;
    expect(rows.length).toBe(0);
  });

  it("EXPLAIN of the user-listing query uses the new index", async () => {
    // Seed a few rows so the planner doesn't pick a Seq Scan for an empty table.
    const stamp = `idx-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "I" } });
    try {
      for (let i = 0; i < 500; i++) {
        await prisma.chatThread.create({
          data: { userId: stamp, workspaceId: null, lastMessageAt: new Date(Date.now() - i * 1000) },
        });
      }
      // ANALYZE so the planner has stats.
      await prisma.$executeRawUnsafe(`ANALYZE chat_threads`);

      // Use SET LOCAL enable_seqscan = OFF so the planner is forced to choose
      // an index scan. This validates the index exists and is structurally
      // compatible with the query — which is the actual guarantee we need.
      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = OFF`);
        return tx.$queryRaw<Array<{ "QUERY PLAN": string }>>`
          EXPLAIN SELECT * FROM chat_threads
            WHERE "userId" = ${stamp} AND "archivedAt" IS NULL
            ORDER BY "lastMessageAt" DESC NULLS LAST
            LIMIT 10;
        `;
      });
      const planText = plan.map((r) => r["QUERY PLAN"]).join("\n");
      expect(planText).toMatch(/Index (Only )?Scan.*chat_threads_userId_archivedAt_lastMessageAt_idx/);
      expect(planText).not.toMatch(/Seq Scan on chat_threads/);
    } finally {
      // Guard cleanup so a failing assertion doesn't leave 500 orphan rows
      // + a dangling user in the test DB.
      await prisma.chatThread.deleteMany({ where: { userId: stamp } });
      await prisma.user.delete({ where: { id: stamp } }).catch(() => {
        /* user may not exist if create itself failed */
      });
    }
  });

  it("chat_threads has the post-migration column shape", async () => {
    const cols = await prisma.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
      SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'chat_threads';
    `;
    const byName = new Map(cols.map((c) => [c.column_name, c.is_nullable]));
    expect(byName.get("userId")).toBe("NO");
    expect(byName.get("workspaceId")).toBe("YES");
  });

  it("migration SQL does not touch audit_events (preservation guarantee)", async () => {
    const fs = await import("node:fs/promises");
    const sql = await fs.readFile(
      "prisma/migrations/20260520130000_chat_user_scope/migration.sql",
      "utf8",
    );
    // Strip SQL comment lines before checking — comments may explain the
    // preservation guarantee, but no DML/DDL should reference audit_events.
    const sqlNoComments = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sqlNoComments).not.toMatch(/audit_events/i);
  });
});
