import type { FastifyInstance } from "fastify";
import { prisma } from "../../src/db.js";

export type SignedUpUser = {
  userId: string;
  email: string;
  cookie: string;
};

let counter = 0;

export async function signUpAndGetCookie(
  app: FastifyInstance,
  opts?: { name?: string; email?: string; password?: string },
): Promise<SignedUpUser> {
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

export async function getOwnerWorkspaceId(userId: string): Promise<string> {
  const m = await prisma.membership.findFirstOrThrow({
    where: { userId, role: "owner" },
  });
  return m.workspaceId;
}
