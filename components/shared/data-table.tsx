import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  headClassName?: string;
  cellClassName?: string;
  render: (row: T, index: number) => ReactNode;
  // The sort param value this column corresponds to (must match whatever
  // convention the page's own sort UI already uses, e.g. "tvl"/"change1d").
  // Only meaningful when DataTable's own `sort` prop is also provided -
  // a column with no sortKey (or a table with no `sort` prop at all)
  // renders as a plain, unclickable header.
  sortKey?: string;
}

export interface DataTableSort {
  key: string;
  dir: "asc" | "desc";
  // Callers own the exact URL/param shape (each list page's existing
  // sort convention differs slightly) - DataTable only decides which
  // (key, direction) a header click should request.
  hrefFor: (key: string, dir: "asc" | "desc") => string;
}

// Shared wrapper/watch-column/empty-state shell behind ProtocolsTable,
// ChainsTable, TokensTable and YieldsTable, which previously each
// reimplemented the same overflow-x-auto/border wrapper, optional
// leading watch-icon column, and an empty-state row with a hand-computed
// colSpan. Column *content* stays owned by each table (passed in as
// `columns`), since it differs meaningfully enough (badges, sparklines,
// nested links) that a fully generic cell-type system would cost more
// than the duplication it removes.
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyMessage,
  watchColumn,
  sort,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyMessage: string;
  // Rendered as its own leading w-8 column when provided - matches every
  // existing table's `{watchedIds && <TableHead className="w-8" />}`
  // pattern, just centralized.
  watchColumn?: (row: T, index: number) => ReactNode;
  sort?: DataTableSort;
}) {
  const totalColumns = columns.length + (watchColumn ? 1 : 0);

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {watchColumn && <TableHead className="w-8" />}
            {columns.map((column) => {
              const isSortable = Boolean(sort && column.sortKey);
              const isActive = isSortable && sort!.key === column.sortKey;
              const ariaSort = isActive ? (sort!.dir === "desc" ? "descending" : "ascending") : isSortable ? "none" : undefined;

              if (!isSortable) {
                return (
                  <TableHead key={column.key} className={column.headClassName}>
                    {column.header}
                  </TableHead>
                );
              }

              // Toggles direction when the column is already the active
              // sort; a newly-clicked column defaults to descending
              // (biggest-first), matching this app's existing sort-select
              // default everywhere it appears.
              const nextDir = isActive && sort!.dir === "desc" ? "asc" : "desc";
              const isRightAligned = column.headClassName?.includes("text-right");

              return (
                <TableHead key={column.key} className={column.headClassName} aria-sort={ariaSort}>
                  <Link
                    href={sort!.hrefFor(column.sortKey!, nextDir)}
                    className={cn(
                      "group inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      isRightAligned && "flex-row-reverse",
                      isActive ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {column.header}
                    {isActive ? (
                      sort!.dir === "desc" ? (
                        <ArrowDown className="size-3.5" aria-hidden="true" />
                      ) : (
                        <ArrowUp className="size-3.5" aria-hidden="true" />
                      )
                    ) : (
                      <ChevronsUpDown className="size-3.5 opacity-0 group-hover:opacity-100" aria-hidden="true" />
                    )}
                  </Link>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            // `relative` gives a row-navigation link the stretched-link
            // treatment room to work (its after:absolute after:inset-0
            // needs a positioned ancestor to stretch against) - harmless
            // for tables/columns that don't use it.
            <TableRow key={rowKey(row)} className="relative">
              {watchColumn && (
                <TableCell className="relative z-10">{watchColumn(row, index)}</TableCell>
              )}
              {columns.map((column) => (
                <TableCell key={column.key} className={column.cellClassName}>
                  {column.render(row, index)}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={totalColumns} className="py-10 text-center text-muted-foreground">
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
