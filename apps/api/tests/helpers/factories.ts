import { prisma } from "../../src/db.js";

let counter = 0;

export async function createTestUser(prefix = "u"): Promise<string> {
  counter++;
  const u = await prisma.user.create({
    data: {
      id: `${prefix}-${Date.now()}-${counter}`,
      email: `${prefix}-${Date.now()}-${counter}@t.co`,
      name: `Test ${prefix} ${counter}`,
    },
  });
  return u.id;
}

export async function setupWorkspaceWithRoles(
  roles: Array<"owner" | "editor" | "viewer">,
  prefix = "w",
): Promise<{ wsId: string; userIds: string[] }> {
  counter++;
  const ws = await prisma.workspace.create({
    data: {
      id: `${prefix}-${Date.now()}-${counter}`,
      name: `Test WS ${counter}`,
      currency: "CAD",
    },
  });
  const userIds: string[] = [];
  for (const role of roles) {
    const userId = await createTestUser(`${prefix}-u`);
    await prisma.membership.create({
      data: { userId, workspaceId: ws.id, role },
    });
    userIds.push(userId);
  }
  return { wsId: ws.id, userIds };
}

export async function createTestCategory(wsId: string, name = "Test Cat"): Promise<string> {
  counter++;
  const c = await prisma.category.create({
    data: { workspaceId: wsId, name: `${name} ${counter}` },
  });
  return c.id;
}

/** Returns the Prisma User object (callers do `u.id`).
 *  Optional notificationPrefs JSON merged in via update. */
export async function makeUserWithDevices(
  tokens: Array<{ token: string; platform: "ios" | "android" }>,
  notificationPrefs?: Record<string, boolean>,
): Promise<import("@prisma/client").User> {
  counter++;
  const u = await prisma.user.create({
    data: {
      id: `dev-u-${Date.now()}-${counter}`,
      email: `dev-${Date.now()}-${counter}@t.co`,
      name: `Dev User ${counter}`,
    },
  });
  for (const t of tokens) {
    await prisma.userDevice.create({
      data: { userId: u.id, expoPushToken: t.token, platform: t.platform },
    });
  }
  if (notificationPrefs) {
    return await prisma.user.update({
      where: { id: u.id },
      data: { notificationPrefs },
    });
  }
  return u;
}
