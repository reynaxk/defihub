"use client";

import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWatchToggle, type WatchTarget } from "@/components/shared/use-watch-toggle";

export function WatchlistButton({
  target,
  isSignedIn,
  initialWatching,
}: {
  target: WatchTarget;
  isSignedIn: boolean;
  initialWatching: boolean;
}) {
  const { watching, isPending, toggle } = useWatchToggle({ target, isSignedIn, initialWatching });

  return (
    <Button variant="outline" size="sm" onClick={() => toggle()} disabled={isPending}>
      <Star
        // Remounting on toggle (via `key`) replays the entrance animation
        // fresh each time, giving the "add to watchlist" action a small
        // satisfying pop - only on add, not remove, matching the usual
        // like-button convention of reserving the flourish for the
        // positive action.
        key={watching ? "watching" : "not-watching"}
        className={cn(
          "size-4 transition-colors",
          watching && "motion-safe:animate-in motion-safe:zoom-in-50 fill-primary text-primary duration-300",
        )}
      />
      {watching ? "Watching" : "Watch"}
    </Button>
  );
}
