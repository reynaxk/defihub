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
export function EntityBadges({ items }: { items: EntityBadgeItem[] }) {
  if (items.length === 0) return <span className="text-muted-foreground">—</span>;
  const shown = items.slice(0, MAX_BADGES);
  const overflow = items.length - shown.length;
  return (
    <span className="flex items-center -space-x-1.5">
      {shown.map((item) => (
        <span key={item.key} className="rounded-full ring-2 ring-card" title={item.name}>
          <EntityLogo src={item.logoUrl} name={item.name} size={18} />
        </span>
      ))}
      {overflow > 0 && <span className="ml-1.5 text-xs text-muted-foreground">+{overflow}</span>}
    </span>
  );
}
