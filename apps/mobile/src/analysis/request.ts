export type AnalysisPeriod = {
  year: number;
  month: number;
};

export function analysisRequestPath(
  workspaceId: string,
  period: AnalysisPeriod | null,
): string {
  if (!period) return `/workspaces/${workspaceId}/analysis`;
  return `/workspaces/${workspaceId}/analysis?year=${period.year}&month=${period.month}`;
}
