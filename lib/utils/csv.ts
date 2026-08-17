export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

function escapeCell(value: string | number | boolean | null | undefined): string {
  if (value == null) return "";
  const str = String(value);
  // RFC 4180: quote a field if it contains a comma, quote, or newline;
  // double up any quotes inside it.
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((c) => escapeCell(c.header)).join(",");
  const lines = rows.map((row) => columns.map((c) => escapeCell(c.value(row))).join(","));
  // CRLF line endings and a leading BOM are what Excel expects to render
  // UTF-8 (chain/token names, emoji in protocol names, etc.) correctly
  // instead of mojibake.
  return "﻿" + [header, ...lines].join("\r\n") + "\r\n";
}

export function csvResponse(filename: string, csv: string): Response {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
