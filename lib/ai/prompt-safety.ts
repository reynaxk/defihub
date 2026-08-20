// A crafted field containing a literal "</protocol_description>" (or any of
// the other delimiter tags protocol-summary.ts wraps untrusted fields in)
// could otherwise close that section of the prompt early and place injected
// text outside it - verified this actually happens before adding the strip,
// not just assumed. Neutralizing the exact tag strings (never legitimately
// needed in real protocol data) closes that without touching any other
// content. All three tag names are handled here, not just
// protocol_description: name and category come from the exact same
// external, loosely-controlled DefiLlama ingestion pipeline as description
// (lib/providers/defillama.ts - anyone can submit a listing there), so a
// crafted protocol *name* is just as capable of injecting a fake delimiter
// as a crafted description is.
//
// Kept in its own module, separate from protocol-summary.ts, because that
// file also imports the DB client - which throws eagerly at import time
// without DATABASE_URL (see lib/database/client.ts), and vitest doesn't load
// .env.local. This pure helper needs to be importable in tests without that
// side effect, same reasoning as lib/database/queries/tvl-change.ts being
// split out from its sibling DB-touching query functions.
const DELIMITER_TAG_NAMES = ["protocol_name", "protocol_category", "protocol_description"];
// Optional whitespace around the tag name (`</protocol_name >`,
// `< protocol_name>`) is still a real closing/opening tag as far as an LLM
// reading it is concerned, even though it wouldn't match a strict HTML/XML
// parser - the original tight pattern (`</?(?:...)>` with no `\s*`) let a
// crafted field bypass the strip entirely just by adding a space before the
// bracket. Since the whole point of stripping is to not have to rely on how
// leniently the model happens to parse near-tag text, the pattern needs to
// be at least as lenient as the model is, not as strict as a real parser.
const DELIMITER_TAG_PATTERN = new RegExp(`</?\\s*(?:${DELIMITER_TAG_NAMES.join("|")})\\s*>`, "gi");

export function stripDelimiterTags(text: string): string {
  return text.replace(DELIMITER_TAG_PATTERN, "");
}
