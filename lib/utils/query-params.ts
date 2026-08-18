/**
 * Parses an optional numeric query param, treating a missing OR invalid
 * value (empty string, non-numeric garbage) the same way: absent, not a
 * filter. Without the isFinite guard, `Number("abc")` is NaN, which for a
 * threshold like `minApy` silently produces `apy >= 'NaN'` in Postgres -
 * not a crash, but NaN sorts above every real value there, so the query
 * matches zero rows with no indication why. Confirmed live against
 * /api/v1/yields?minApy=abc before adding this.
 */
export function parseOptionalNumber(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
