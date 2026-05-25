export function isOtherCategory(category: { name: string; archivedAt: Date | null }): boolean {
  if (category.archivedAt !== null) return false;
  return category.name.trim().toLowerCase() === "other";
}
