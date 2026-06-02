export type HomeAnalysisGlance = {
  year?: number;
  month?: number;
  label: string;
  income: number;
  spend: number;
  net: number;
  prevNet: number | null;
};

export function shouldShowAnalysisGlance(
  analysis: HomeAnalysisGlance | null,
): analysis is HomeAnalysisGlance {
  if (!analysis) return false;
  return analysis.income !== 0 || analysis.spend !== 0 || analysis.net !== 0;
}

export function analysisGlanceTitle(analysis: HomeAnalysisGlance): string {
  return analysis.label;
}

const MONTH_MAP: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

export function parseYearMonthFromAnalysisLabel(
  label: string,
): { year: number; month: number } | null {
  const m = /^([a-zA-ZÀ-ÿ]+)\s+(\d{4})$/u.exec(label.trim());
  if (!m) return null;
  const monthName = m[1]?.toLowerCase();
  const month = monthName ? MONTH_MAP[monthName] : undefined;
  const year = Number(m[2]);
  if (!month || !Number.isFinite(year) || year < 1970 || year > 2100) return null;
  return { year, month };
}
