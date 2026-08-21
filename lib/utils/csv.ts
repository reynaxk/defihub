export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

const FORMULA_LEAD_CHARS = ["=", "+", "-", "@", "\t", "\r"];

function escapeCell(value: string | number | boolean | null | undefined): string {
  if (value == null) return "";
  let str = String(value);
  // Names/categories in these exports come from DefiLlama/CoinGecko - external,
  // only loosely-controlled content (same trust level as the alert-email
  // displayName this app already HTML-escapes). A cell starting with =, +, -,
  // @, or a tab/CR is interpreted as a formula by Excel/Sheets on open, which
  // is a known RCE/data-exfiltration vector (CSV/formula injection, CWE-1236).
  // Prefixing with a single quote neutralizes it in every major spreadsheet
  // app while staying human-readable.
  if (FORMULA_LEAD_CHARS.some((c) => str.startsWith(c))) str = `'${str}`;
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
      // Same short cache window as lib/api/response.ts's JSON API
      // responses - data refreshes on the hourly-ish ingestion schedule, so
      // this meaningfully cuts repeat-request DB load (these are
      // unauthenticated, rate-limited public export endpoints) without
      // serving stale-feeling data. Every other response type in this
      // codebase's public API already sets this; the CSV path was the one
      // gap.
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}
