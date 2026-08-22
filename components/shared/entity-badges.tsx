import { EntityLogo } from "@/components/shared/entity-logo";

export interface EntityBadgeItem {
  key: string;
  name: string;
  logoUrl: string | null;
}

const MAX_BADGES = 3;

// Compact overlapping-logo stack ("+N" for the rest) - originally built
// inline for the protocols list table's Chains column, extracted here so
// the stablecoins page's "chains tracked" column can reuse the identical
// treatment instead of a second implementation.
export function EntityBadges({
  items,
  // Each logo is decorative and per-item `title` attributes aren't exposed
  // to assistive tech as a group, so the stack has no accessible name on
  // its own - `groupLabel` names what these items are (e.g. "Chains") so
  // the aggregate aria-label reads correctly regardless of which entity
  // type a future caller passes.
  groupLabel = "Items",
}: {
  items: EntityBadgeItem[];
  groupLabel?: string;
}) {
  if (items.length === 0) return <span className="text-muted-foreground">—</span>;
  const shown = items.slice(0, MAX_BADGES);
  const overflow = items.length - shown.length;
  return (
    <span
      role="img"
      aria-label={`${groupLabel}: ${items.map((item) => item.name).join(", ")}`}
      className="flex items-center -space-x-1.5"
    >
      {shown.map((item) => (
        <span key={item.key} className="rounded-full ring-2 ring-card" title={item.name}>
          <EntityLogo src={item.logoUrl} name={item.name} size={18} />
        </span>
      ))}
      {overflow > 0 && <span className="ml-1.5 text-xs text-muted-foreground">+{overflow}</span>}
    </span>
  );
}
