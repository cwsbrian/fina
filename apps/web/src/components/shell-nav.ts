import type { UserRole } from "@fina/shared";

export type NavItem = {
  id: string;
  label: string;
  path: string;
};

export const NAV_ITEMS: NavItem[] = [
  { id: "home", label: "Home", path: "/home" },
  { id: "banks", label: "Banks", path: "/settings/banks" },
  { id: "workspace", label: "Workspace", path: "/settings/workspace" },
  { id: "plan", label: "Plan", path: "/settings/plan" },
  { id: "account", label: "Account", path: "/settings/account" },
];

export const ADMIN_NAV_ITEM: NavItem = {
  id: "admin",
  label: "Admin",
  path: "/admin",
};

export function navItemsForRole(role: UserRole | null | undefined): NavItem[] {
  return role === "admin" ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;
}
