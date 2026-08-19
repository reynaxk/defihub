"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type WatchTarget =
  | { protocolId: string }
  | { chainId: string }
  | { tokenId: string }
  | { yieldPoolId: string };

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
  const router = useRouter();
  const [watching, setWatching] = useState(initialWatching);
  const [isPending, startTransition] = useTransition();
  const lastInitialWatching = useRef(initialWatching);

  // Resyncs local state when initialWatching changes because the parent
  // Server Component re-rendered with fresh data (e.g. the account's watch
  // state changed in another tab, then this list re-fetched after a filter
  // change) - this button is keyed by the entity's stable id, so it isn't
  // remounted just because the surrounding table re-renders, and a stale
  // `watching` value from first paint would otherwise persist indefinitely.
  // The ref guard makes this a no-op right after this component's own
  // successful toggle below, since local state already matches by the time
  // any later prop change would arrive.
  useEffect(() => {
    if (lastInitialWatching.current !== initialWatching) {
      lastInitialWatching.current = initialWatching;
      setWatching(initialWatching);
    }
  }, [initialWatching]);

  function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!isSignedIn) {
      router.push("/login");
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target),
      });
      if (!res.ok) {
        toast.error("Couldn't update your watchlist");
        return;
      }
      const data = await res.json();
      setWatching(data.watching);
      toast.success(data.watching ? "Added to watchlist" : "Removed from watchlist");
    });
  }

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
