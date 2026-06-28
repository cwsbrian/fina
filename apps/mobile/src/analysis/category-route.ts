export type AnalysisCategoryRouteInput = {
  categoryId: string;
  categoryName: string;
  year: number;
  month: number;
};

export function analysisCategoryRoute({
  categoryId,
  categoryName,
  year,
  month,
}: AnalysisCategoryRouteInput): {
  pathname: "/analysis/category/[id]";
  params: { id: string; name: string; year: string; month: string };
} {
  return {
    pathname: "/analysis/category/[id]",
    params: {
      id: categoryId,
      name: categoryName,
      year: String(year),
      month: String(month),
    },
  };
}
