"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function WatchlistButton({
  isSignedIn,
  initialWatching,
  protocolId,
  chainId,
  tokenId,
}: {
  isSignedIn: boolean;
  initialWatching: boolean;
  protocolId?: string;
  chainId?: string;
  tokenId?: string;
}) {
  const router = useRouter();
  const [watching, setWatching] = useState(initialWatching);
  const [isPending, startTransition] = useTransition();
  const lastInitialWatching = useRef(initialWatching);

  // Resyncs local state when initialWatching changes for a reason other
  // than this component's own toggle below - e.g. a client-side <Link>
  // navigation from one protocol/chain/token detail page to another. React
  // reconciles WatchlistButton as the same component instance across that
  // navigation (same type, same position in the tree - nothing keys it to
  // the specific entity), so without this, a stale `watching` value from
  // the first page visited would keep showing on every subsequent one
  // until a hard reload. The ref guard makes this a no-op right after this
  // component's own successful toggle, since local state already matches
  // by the time any later prop change would arrive.
  useEffect(() => {
    if (lastInitialWatching.current !== initialWatching) {
      lastInitialWatching.current = initialWatching;
      setWatching(initialWatching);
    }
  }, [initialWatching]);

  function toggle() {
    if (!isSignedIn) {
      router.push("/login");
      return;
    }

    startTransition(async () => {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocolId, chainId, tokenId }),
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
    <Button variant="outline" size="sm" onClick={toggle} disabled={isPending}>
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
