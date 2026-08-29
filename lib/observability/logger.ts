// A small, dependency-free structured logger. Every worker/route call site
// listed in the final report was migrated from an ad hoc `console.log
// "[tag] message"` to this - same console.* destinations underneath
// (still readable in Vercel's log viewer), but every line now carries a
// consistent, greppable shape instead of free-text.
//
// No external provider (Sentry/Axiom/etc.) is wired in here - see
// setErrorHook below for the documented integration point instead of
// adding that dependency speculatively.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  component: string;
  operation?: string;
  chain?: string;
  protocol?: string;
  durationMs?: number;
  runId?: string;
  error?: unknown;
  [key: string]: unknown;
}

// Substring-based (case-insensitive) rather than an exact-key allowlist,
// but NOT simply "contains key/token" - this app's own domain vocabulary
// is full of legitimate non-secret fields shaped exactly like that
// (onchainVerifications.key, tokens/tokenId/tokenBalance everywhere in the
// wallet and price-sync code). A bare "key"/"token" match redacted real,
// harmless identifiers in exactly that shape the first time this ran
// against a real worker (workers/onchain/verify.ts's `key` field) - caught
// via live verification, not a hypothetical. "key"/"token" only count when
// compounded with a word that actually signals a secret (apiKey,
// privateKey, accessToken, sessionToken, etc.); password/secret/
// authorization/credential still match standalone, since those aren't
// legitimate field-name components anywhere in this app.
const SENSITIVE_KEY_PATTERN =
  /password|secret|credential|authorization|(?:api|private|access|encryption|session|refresh|bearer|csrf|auth)[-_]?(?:key|token)/i;

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      // The resilient RPC client wraps provider errors - the wrapped cause
      // usually holds the actual reason, and dropping it here would hide
      // it from every log line that logs a wrapping error.
      ...(err.cause !== undefined ? { cause: serializeError(err.cause) } : {}),
    };
  }
  return err;
}

// Managed RPC endpoints and database connection strings carry credentials
// in the URL itself (an Alchemy/Infura-style key in the path, a Postgres
// password in the userinfo section), so a field-name check alone misses
// them - this app's RPC failover logging is exactly the call site that
// would otherwise leak one. Best-effort: values that don't parse as a URL
// are returned unchanged.
function redactUrlCredentials(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) url.password = "[redacted]";
    if (url.username) url.username = "[redacted]";
    // Provider API keys usually sit in the last path segment.
    url.pathname = url.pathname.replace(/\/[^/]{16,}$/, "/[redacted]");
    url.search = "";
    return url.toString();
  } catch {
    return value;
  }
}

// Bounded so a deeply nested or accidentally self-referencing object can't
// cause unbounded recursion - four levels comfortably covers this app's
// actual log shapes (e.g. a wrapped RPC error's cause chain) without
// walking an arbitrarily deep structure.
const MAX_REDACT_DEPTH = 4;

// Phase 5.8 hardening: matches a URL ANYWHERE within a string, not just
// when the whole value IS a URL - the earlier whole-string-only check
// (`^scheme://...$`) missed a URL embedded mid-message (e.g. "request to
// https://foo.com/v2/<key> failed: timeout"), which would pass through
// completely unredacted since the string doesn't itself start with a
// scheme. No known production call site does this today - the one
// highest-risk site (lib/chains/rpc-resilient-client.ts, provider error
// messages that embed the full request URL) already has its own dedicated,
// narrower redaction applied before anything reaches this logger - but this
// closes the gap for any future call site that logs/throws a message with
// an embedded URL, matching the "the logger itself is the backstop" role
// SENSITIVE_KEY_PATTERN already plays for field names. Global so every
// embedded URL in one string is caught, not just the first.
const EMBEDDED_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

function redactUrlsInString(value: string): string {
  return value.replace(EMBEDDED_URL_PATTERN, (match) => redactUrlCredentials(match));
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return redactUrlsInString(value);
  }
  // By value type, not by the field name "error" - any field can hold an
  // Error (cause, lastError, rpcError, ...), and JSON.stringify(new
  // Error(...)) otherwise serializes to "{}" since name/message/stack
  // aren't enumerable.
  if (value instanceof Error) return serializeError(value);
  if (depth <= 0 || value === null || typeof value !== "object") return value;
  // Arrays need their own branch, not the plain-object one below - an
  // array of objects (e.g. a logged list of per-provider attempts) was
  // previously returned unchanged, entirely skipping redaction for
  // whatever sensitive fields or URLs its elements held. Depth is still
  // shared with the object recursion below, so a cyclic array (`a.push(a)`)
  // is bounded the same way a cyclic object is.
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth - 1));
  return redact(value as Record<string, unknown>, depth - 1);
}

function redact(fields: Record<string, unknown>, depth = MAX_REDACT_DEPTH): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redactValue(value, depth);
  }
  return out;
}

let errorHook: ((entry: Record<string, unknown>) => void) | null = null;

// Single, documented extension point for a future error-monitoring
// integration (Sentry, Axiom, Logtail, etc.) - called with the same
// redacted entry that gets logged, once per error-level log. Not wired to
// anything by default.
export function setErrorHook(fn: ((entry: Record<string, unknown>) => void) | null): void {
  errorHook = fn;
}

const isProduction = process.env.NODE_ENV === "production";

// JSON.stringify throws on a bigint field (block numbers, balances, and
// supplies are passed as bigint throughout this codebase) and on a
// circular reference - either would turn a log statement into an uncaught
// exception, which in a worker's catch block replaces a recoverable error
// with an opaque logger crash. A logger must never be able to throw.
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, v) => {
        if (typeof v === "bigint") return v.toString();
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[circular]";
          seen.add(v);
        }
        return v;
      }) ?? ""
    );
  } catch {
    return "[unserializable log fields]";
  }
}

function emit(level: LogLevel, message: string, fields: LogFields): void {
  const { component, ...rest } = fields;
  const safeFields = redact(rest);
  // Phase 5.8 hardening: `message` used to reach the log line completely
  // unredacted - only `fields` went through redact(). A call site that
  // builds its own message string with an embedded URL (e.g.
  // `logger.error("fetch failed: " + url, ...)`) would have leaked it
  // regardless of how well-redacted every other field was.
  const safeMessage = redactUrlsInString(message);
  const entry = { timestamp: new Date().toISOString(), level, component, message: safeMessage, ...safeFields };

  const line = isProduction
    ? safeStringify(entry)
    : formatForDevelopment(level, component, safeMessage, safeFields);

  const write = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  write(line);

  if (level === "error" && errorHook) {
    try {
      errorHook(entry);
    } catch {
      // The hook itself must never be able to break the caller's actual
      // work - a broken integration is a lost log line, not a crashed sync.
    }
  }
}

function formatForDevelopment(
  level: LogLevel,
  component: string,
  message: string,
  fields: Record<string, unknown>,
): string {
  const extra = Object.keys(fields).length > 0 ? ` ${safeStringify(fields)}` : "";
  return `[${level.toUpperCase()}] [${component}] ${message}${extra}`;
}

export const logger = {
  debug: (message: string, fields: LogFields) => emit("debug", message, fields),
  info: (message: string, fields: LogFields) => emit("info", message, fields),
  warn: (message: string, fields: LogFields) => emit("warn", message, fields),
  error: (message: string, fields: LogFields) => emit("error", message, fields),
};
