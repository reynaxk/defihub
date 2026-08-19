"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export type WatchTarget =
  | { protocolId: string }
  | { chainId: string }
  | { tokenId: string }
  | { yieldPoolId: string };

// Shared toggle/resync/toast logic behind WatchIconButton (compact, for
// table rows) and WatchlistButton (labeled, for detail-page headers) -
// previously two near-identical copies of this same state machine.
export function useWatchToggle({
  target,
  isSignedIn,
  initialWatching,
}: {
  target: WatchTarget;
  isSignedIn: boolean;
  initialWatching: boolean;
}) {
  const router = useRouter();
  const [watching, setWatching] = useState(initialWatching);
  const [isPending, startTransition] = useTransition();
  const lastInitialWatching = useRef(initialWatching);

  // Resyncs local state when initialWatching changes for a reason other
  // than this component's own toggle below - e.g. a client-side <Link>
  // navigation between entities (WatchlistButton is reconciled as the same
  // component instance across that, not remounted, since nothing keys it
  // to the specific entity), or the account's watch state changing
  // elsewhere and this list re-fetching after a filter change
  // (WatchIconButton, keyed by the entity's stable id but not remounted
  // just because the surrounding table re-renders). The ref guard makes
  // this a no-op right after this component's own successful toggle,
  // since local state already matches by the time any later prop change
  // would arrive.
  useEffect(() => {
    if (lastInitialWatching.current !== initialWatching) {
      lastInitialWatching.current = initialWatching;
      setWatching(initialWatching);
    }
  }, [initialWatching]);

  function toggle(e?: React.SyntheticEvent) {
    // Guards needed when this is nested inside a <Link> (table rows) -
    // no-ops harmlessly when called from a plain Button (detail-page
    // headers) that isn't itself inside a link.
    e?.preventDefault();
    e?.stopPropagation();
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

  return { watching, isPending, toggle };
}
