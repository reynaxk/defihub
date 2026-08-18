// A crafted description containing a literal "</protocol_description>" could
// otherwise close the prompt's delimiter early and place injected text
// outside it - verified this actually happens before adding the strip, not
// just assumed. Neutralizing the exact tag strings (never legitimately
// needed in a real protocol description) closes that without touching any
// other content.
//
// Kept in its own module, separate from protocol-summary.ts, because that
// file also imports the DB client - which throws eagerly at import time
// without DATABASE_URL (see lib/database/client.ts), and vitest doesn't load
// .env.local. This pure helper needs to be importable in tests without that
// side effect, same reasoning as lib/database/queries/tvl-change.ts being
// split out from its sibling DB-touching query functions.
export function stripDelimiterTags(text: string): string {
  return text.replace(/<\/?protocol_description>/gi, "");
}
