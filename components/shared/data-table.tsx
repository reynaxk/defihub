import type { ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  headClassName?: string;
  cellClassName?: string;
  render: (row: T, index: number) => ReactNode;
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
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyMessage: string;
  // Rendered as its own leading w-8 column when provided - matches every
  // existing table's `{watchedIds && <TableHead className="w-8" />}`
  // pattern, just centralized.
  watchColumn?: (row: T, index: number) => ReactNode;
}) {
  const totalColumns = columns.length + (watchColumn ? 1 : 0);

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {watchColumn && <TableHead className="w-8" />}
            {columns.map((column) => (
              <TableHead key={column.key} className={column.headClassName}>
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={rowKey(row)}>
              {watchColumn && <TableCell>{watchColumn(row, index)}</TableCell>}
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
