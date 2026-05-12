import { Page } from "@playwright/test";

const API = process.env.API_URL ?? "http://localhost:4000";
// Proxy path on the web server — browser calls this same-origin URL and
// Next.js forwards to the API. This keeps cookies on the web origin so
// SameSite=Lax works without cross-port issues in Playwright Chromium.
const WEB = process.env.WEB_URL ?? "http://localhost:3100";
const PROXY = `${WEB}/api-proxy`;

let counter = 0;

export function uniqueEmail(prefix = "e2e") {
  return `${prefix}+${Date.now()}${++counter}@example.com`;
}

/**
 * Sign up via the web's /api-proxy so the session cookie is set on the web
 * origin (localhost:3100). This avoids the cross-port SameSite cookie issue
 * where Playwright's Chromium blocks cookies sent from localhost:3100 to
 * localhost:4000 on cross-origin fetches.
 */
export async function signUp(page: Page, email: string, password = "password123", name = "E2E User") {
  // Retry up to 3x with a short back-off — the API can return transient 500s
  // immediately after Plaid-sandbox tests that stress the connection pool.
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await page.waitForTimeout(1_000 * attempt);
    const resp = await page.request.post(`${PROXY}/api/auth/sign-up/email`, {
      headers: { "content-type": "application/json" },
      data: { email, password, name },
    });
    if (resp.ok()) {
      await page.goto("/home");
      await page.waitForLoadState("networkidle", { timeout: 10_000 });
      return;
    }
    lastErr = new Error(`Sign-up failed: ${resp.status()} ${await resp.text()}`);
  }
  throw lastErr!;
}

export async function signIn(page: Page, email: string, password = "password123") {
  const resp = await page.request.post(`${PROXY}/api/auth/sign-in/email`, {
    headers: { "content-type": "application/json" },
    data: { email, password },
  });
  if (!resp.ok()) throw new Error(`Sign-in failed: ${resp.status()} ${await resp.text()}`);
  await page.goto("/home");
  await page.waitForLoadState("networkidle", { timeout: 10_000 });
}

/** Expire the trial for a user via direct DB query using the Prisma CLI. */
export async function expireTrial(email: string) {
  const { execSync } = await import("child_process");
  // Use psql with single-quoted column names (double-quoted would be eaten by
  // the shell's outer double-quoted string). Instead we use a heredoc-style
  // approach via stdin (-c with the SQL as a separate argument).
  execSync(
    `docker exec fina-postgres-dev psql -U fina -d fina -c 'UPDATE users SET "trialEndsAt"=NOW()-INTERVAL '"'"'1 day'"'"', "trialConsumed"=true WHERE email='"'"'${email}'"'"';'`,
    { stdio: "pipe" },
  );
}

/** Get workspace id for signed-in session via API. */
export async function getWorkspaceId(page: Page): Promise<string> {
  const resp = await page.request.get(`${API}/workspaces`);
  if (!resp.ok()) throw new Error(`getWorkspaceId failed: ${resp.status()}`);
  const data = await resp.json();
  return data.workspaces?.[0]?.id as string;
}
