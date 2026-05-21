import { ACTIVE_WORKSPACE_STORAGE_KEY } from "@fina/shared";

const COOKIE = ACTIVE_WORKSPACE_STORAGE_KEY;
const ONE_YEAR = 60 * 60 * 24 * 365;

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split("=").slice(1).join("=")) : null;
}

export function getActiveWorkspaceId(): string | null {
  return readCookie(COOKIE);
}

export function setActiveWorkspaceId(id: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax`;
}

export function clearActiveWorkspaceId(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}
