import type { CategoryDTO } from "@fina/shared";

import type { ActivityFilters } from "./CategoryFilterSheet";

type ActivityFilterNavigationRequest = {
  filters: ActivityFilters;
  categories: CategoryDTO[];
  onApply: (filters: ActivityFilters) => void;
};

let activeRequest: ActivityFilterNavigationRequest | null = null;

export function prepareActivityFilterNavigation(request: ActivityFilterNavigationRequest): void {
  activeRequest = {
    ...request,
    filters: {
      ...request.filters,
      range: { ...request.filters.range },
      selectedCategoryIds: [...request.filters.selectedCategoryIds],
    },
    categories: [...request.categories],
  };
}

export function getActivityFilterNavigation(): ActivityFilterNavigationRequest | null {
  return activeRequest;
}

export function clearActivityFilterNavigation(): void {
  activeRequest = null;
}
