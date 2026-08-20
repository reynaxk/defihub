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

// Deliberately broad and substring-based (case-insensitive) rather than an
// exact-key allowlist - a false-positive redaction (dropping an innocuous
// field whose name happens to contain "key") is a far smaller cost than a
// false negative that leaks a real secret into logs.
const SENSITIVE_KEY_PATTERN = /password|secret|token|key|authorization|credential/i;

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return err;
}

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = key === "error" ? serializeError(value) : value;
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

function emit(level: LogLevel, message: string, fields: LogFields): void {
  const { component, ...rest } = fields;
  const safeFields = redact(rest);
  const entry = { timestamp: new Date().toISOString(), level, component, message, ...safeFields };

  const line = isProduction
    ? JSON.stringify(entry)
    : formatForDevelopment(level, component, message, safeFields);

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
  const extra = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  return `[${level.toUpperCase()}] [${component}] ${message}${extra}`;
}

export const logger = {
  debug: (message: string, fields: LogFields) => emit("debug", message, fields),
  info: (message: string, fields: LogFields) => emit("info", message, fields),
  warn: (message: string, fields: LogFields) => emit("warn", message, fields),
  error: (message: string, fields: LogFields) => emit("error", message, fields),
};
