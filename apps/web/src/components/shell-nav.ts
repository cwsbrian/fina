export type NavItem = {
  id: string;
  label: string;
  path: string;
};

export const NAV_ITEMS: NavItem[] = [
  { id: "home", label: "Home", path: "/home" },
  { id: "chat", label: "Ask Fina", path: "/chat" },
  { id: "activity", label: "Activity", path: "/activity" },
  { id: "analysis", label: "Analysis", path: "/analysis" },
  { id: "budget", label: "Budget", path: "/budget" },
  { id: "goals", label: "Goals", path: "/goals" },
  { id: "review", label: "Review inbox", path: "/review" },
  { id: "categories", label: "Categories", path: "/categories" },
  { id: "scheduled", label: "Scheduled", path: "/scheduled" },
  { id: "subscriptions", label: "Subscriptions", path: "/subscriptions" },
  { id: "accounts", label: "Accounts", path: "/accounts" },
  { id: "banks", label: "Banks", path: "/settings/banks" },
  { id: "workspace", label: "Workspace", path: "/settings/workspace" },
  { id: "brief", label: "Brief", path: "/brief" },
  { id: "notifications", label: "Notifications", path: "/notifications" },
  { id: "categorization", label: "Categorization", path: "/categorization" },
  { id: "plan", label: "Plan", path: "/settings/plan" },
  { id: "account", label: "Account", path: "/settings/account" },
  { id: "support", label: "Support", path: "/support" },
];
