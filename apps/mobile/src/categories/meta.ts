import type { CategoryDTO } from "@fina/shared";
import type { Ionicons } from "@expo/vector-icons";
import { colors } from "../design/tokens";

type IoniconName = keyof typeof Ionicons.glyphMap;

/** Visual metadata for a category badge — icon + paired fg/bg colors. */
export type CategoryMeta = {
  icon: IoniconName;
  /** Foreground (icon stroke + amount accent if applicable). */
  fg: string;
  /** Filled badge background — fg color at low alpha. */
  bg: string;
};

/** Mirrors the API's DEFAULT_CATEGORIES seed (apps/api/src/categorize/seed.ts).
 *  Lets us style categories whose DB rows pre-date the icon/color columns
 *  being populated (existing dev workspaces) without a migration. */
const DEFAULTS_BY_NAME: Record<string, { icon: IoniconName; color: string }> = {
  Groceries:     { icon: "cart-outline",        color: "#1f8c44" },
  Dining:        { icon: "cafe-outline",        color: "#c25a25" },
  Transit:       { icon: "car-outline",         color: "#5fc4a1" },
  Housing:       { icon: "home-outline",        color: "#9f6420" },
  Utilities:     { icon: "flash-outline",       color: "#6a4dba" },
  Health:        { icon: "heart-outline",       color: "#19957f" },
  Shopping:      { icon: "bag-handle-outline",  color: "#b54590" },
  Entertainment: { icon: "film-outline",        color: "#c93c64" },
  Subscriptions: { icon: "pricetag-outline",    color: "#3a4cd4" },
  Income:        { icon: "trending-up",         color: "#0f7c3a" },
  Other:         { icon: "ellipsis-horizontal", color: "#7a8a86" },
};

const FALLBACK: { icon: IoniconName; color: string } = {
  icon: "pricetag-outline",
  color: colors.muted,
};

/** Curated palette used when the user creates a new category — we assign
 *  a random color so user-created categories visually distinguish from
 *  each other without making the user pick one up front. (Editing the
 *  color manually is a future PR.) */
const NEW_CATEGORY_PALETTE: ReadonlyArray<string> = [
  "#1f8c44", "#c25a25", "#5fc4a1", "#9f6420", "#6a4dba",
  "#19957f", "#b54590", "#c93c64", "#3a4cd4", "#0f7c3a",
  "#1d8aab", "#d97757", "#7a8a86", "#a05cd1", "#4a8fbf",
];

/** Default icon assigned to user-created categories until they edit it.
 *  Generic enough to fit any topic. */
export const DEFAULT_NEW_CATEGORY_ICON: IoniconName = "pricetag-outline";

export function pickRandomCategoryColor(): string {
  const i = Math.floor(Math.random() * NEW_CATEGORY_PALETTE.length);
  return NEW_CATEGORY_PALETTE[i]!;
}

function withAlpha(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Resolve a category's display metadata. Priority:
 *    1. Persisted icon/color on the CategoryDTO (when set).
 *    2. Name-matched default (for seed categories whose icon/color
 *       weren't persisted before the seed was updated).
 *    3. Muted fallback (user-created categories with no metadata). */
export function categoryMeta(cat: CategoryDTO | null | undefined): CategoryMeta {
  if (cat) {
    const named = DEFAULTS_BY_NAME[cat.name];
    const icon = (cat.icon as IoniconName | null) ?? named?.icon ?? FALLBACK.icon;
    const color = cat.color ?? named?.color ?? FALLBACK.color;
    return { icon, fg: color, bg: withAlpha(color, 0.14) };
  }
  return {
    icon: FALLBACK.icon,
    fg: FALLBACK.color,
    bg: colors.surfaceSoft,
  };
}
