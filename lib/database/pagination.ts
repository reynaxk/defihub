export interface PaginationInput {
  page?: number;
  pageSize?: number;
}

export interface NormalizedPagination {
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * Clamps user-supplied page/pageSize (often straight from a URL search
 * param, so untrusted and possibly NaN/negative/absurdly large) to sane
 * bounds before they hit a query's LIMIT/OFFSET.
 */
export function normalizePagination({ page, pageSize }: PaginationInput): NormalizedPagination {
  const safePage = Number.isFinite(page) && (page as number) >= 1 ? Math.floor(page as number) : 1;
  const safePageSize =
    Number.isFinite(pageSize) && (pageSize as number) >= 1
      ? Math.min(MAX_PAGE_SIZE, Math.floor(pageSize as number))
      : DEFAULT_PAGE_SIZE;

  return { page: safePage, pageSize: safePageSize };
}

export function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
