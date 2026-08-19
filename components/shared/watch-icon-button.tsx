"use client";

import { Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWatchToggle, type WatchTarget } from "@/components/shared/use-watch-toggle";

// Compact icon-only star toggle for table rows - WatchlistButton (a full
// labeled button) is meant for detail-page headers, too wide for a table
// cell. One component parameterized by target kind rather than one per
// entity type, since the toggle logic is identical either way.
export function WatchIconButton({
  target,
  isSignedIn,
  initialWatching,
  label,
}: {
  target: WatchTarget;
  isSignedIn: boolean;
  initialWatching: boolean;
  label: string;
}) {
  const { watching, isPending, toggle } = useWatchToggle({ target, isSignedIn, initialWatching });

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={isPending}
      aria-label={watching ? `Remove ${label} from watchlist` : `Add ${label} to watchlist`}
      aria-pressed={watching}
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
    >
      <Star
        key={watching ? "watching" : "not-watching"}
        className={cn(
          "size-4 transition-colors",
          watching && "motion-safe:animate-in motion-safe:zoom-in-50 fill-primary text-primary duration-300",
        )}
      />
    </button>
  );
}
