import type { Ionicons } from "@expo/vector-icons";
import type { GoalDTO } from "@fina/shared";
import { colors } from "../design/tokens";

type IoniconName = keyof typeof Ionicons.glyphMap;

/** Curated icon options the user picks from when creating a goal. */
export const GOAL_ICON_CHOICES: ReadonlyArray<IoniconName> = [
  "airplane-outline",
  "home-outline",
  "car-outline",
  "school-outline",
  "gift-outline",
  "heart-outline",
  "cafe-outline",
  "fitness-outline",
  "book-outline",
  "musical-notes-outline",
  "game-controller-outline",
  "camera-outline",
];

/** Curated color palette — same set as category creation. */
export const GOAL_COLOR_CHOICES: ReadonlyArray<string> = [
  "#1f8c44", "#c25a25", "#5fc4a1", "#9f6420", "#6a4dba", "#19957f", "#b54590",
  "#c93c64", "#3a4cd4", "#0f7c3a", "#1d8aab", "#d97757", "#a05cd1", "#4a8fbf",
];

export const DEFAULT_GOAL_ICON: IoniconName = "flag-outline";
export const DEFAULT_GOAL_COLOR = colors.primary;

export function goalAccent(g: Pick<GoalDTO, "color">): string {
  return g.color ?? DEFAULT_GOAL_COLOR;
}

export function goalIcon(g: Pick<GoalDTO, "icon">): IoniconName {
  return (g.icon as IoniconName | null) ?? DEFAULT_GOAL_ICON;
}

export function withAlpha(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  if (m.length !== 6) return hex;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export type GoalStatus = "on-track" | "behind" | "done" | "paused";

/** Derive status from progress vs time elapsed. v1 simple heuristic:
 *  - 100% saved → done
 *  - past due unfunded → behind
 *  - pct elapsed > pct saved by >10pp → behind
 *  - otherwise → on-track */
export function goalStatus({
  saved,
  target,
  due,
  now,
}: {
  saved: number;
  target: number;
  due: Date;
  now: Date;
}): GoalStatus {
  if (target > 0 && saved >= target) return "done";
  // Use createdAt as start. We don't have it here; assume a 30-day baseline
  // so a future goal isn't immediately "behind" on day 1. Caller can pass
  // explicit start later if needed.
  const totalMs = Math.max(1, due.getTime() - (now.getTime() - 30 * 86400_000));
  const elapsedMs = Math.max(0, now.getTime() - (now.getTime() - 30 * 86400_000));
  const elapsedPct = elapsedMs / totalMs;
  const savedPct = target > 0 ? saved / target : 0;
  if (now > due && savedPct < 1) return "behind";
  if (elapsedPct - savedPct > 0.1) return "behind";
  return "on-track";
}

/** "Due in 13 days · May 25" / "Due Sep 1 (4 months)" / "Past due 3 days". */
export function formatDue(due: Date, now: Date): string {
  const ms = due.getTime() - now.getTime();
  const days = Math.round(ms / 86400_000);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (Math.abs(days) > 365 * 1.5) {
    const yrs = Math.round((days / 365) * 10) / 10;
    return `Due in ${yrs} years · ${due.toLocaleDateString(undefined, {
      month: "short",
      year: "numeric",
    })}`;
  }
  if (days >= 60) {
    const months = Math.round(days / 30);
    return `Due in ${months} months · ${due.toLocaleDateString(undefined, opts)}`;
  }
  if (days > 1) return `Due in ${days} days · ${due.toLocaleDateString(undefined, opts)}`;
  if (days === 1) return `Due tomorrow · ${due.toLocaleDateString(undefined, opts)}`;
  if (days === 0) return `Due today`;
  return `Past due ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}`;
}
