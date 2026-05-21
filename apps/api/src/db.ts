import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __fina_prisma: PrismaClient | undefined;
}

function buildDatasourceUrl(): string {
  const raw = process.env.DATABASE_URL ?? "";
  if (!raw) return raw;
  const limit = Number(process.env.PRISMA_CONNECTION_LIMIT ?? 10);
  try {
    const url = new URL(raw);
    if (!url.searchParams.has("connection_limit")) {
      url.searchParams.set("connection_limit", String(limit));
    }
    return url.toString();
  } catch {
    return raw;
  }
}

export const prisma: PrismaClient =
  globalThis.__fina_prisma ??
  new PrismaClient({
    datasources: { db: { url: buildDatasourceUrl() } },
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__fina_prisma = prisma;
}
