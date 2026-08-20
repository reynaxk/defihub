// Postgres's LIKE/ILIKE treats `%`, `_`, and its own escape character `\`
// as pattern metacharacters even when the value is a bound parameter -
// parameterization prevents SQL injection, but doesn't stop Postgres from
// still interpreting those characters as wildcards once the query runs.
// Without this, searching for a literal underscore (a real, common
// character in on-chain token symbols) silently matches "any single
// character" in that position instead, and a query like "50%" collapses to
// effectively `%50%%`, over-matching anything containing "50". Escaping the
// backslash first is required - otherwise the backslashes inserted for
// `%`/`_` would themselves become part of what needs escaping.
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
