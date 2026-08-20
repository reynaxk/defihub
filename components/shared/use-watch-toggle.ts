"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export type WatchTarget =
  | { protocolId: string }
  | { chainId: string }
  | { tokenId: string }
  | { yieldPoolId: string };

// A stable string identity for a target, independent of initialWatching's
// value - two different entities can coincidentally share the same
// initialWatching (e.g. both unwatched), which a value-only comparison
// can't tell apart from "still the same entity".
export function targetKey(target: WatchTarget): string {
  if ("protocolId" in target) return `protocol:${target.protocolId}`;
  if ("chainId" in target) return `chain:${target.chainId}`;
  if ("tokenId" in target) return `token:${target.tokenId}`;
  return `pool:${target.yieldPoolId}`;
}

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
  const key = targetKey(target);
  const lastSeen = useRef({ key, initialWatching });

  // Resyncs local state whenever either the target entity itself changes
  // (e.g. a client-side <Link> navigation between entities - WatchlistButton
  // is reconciled as the same component instance across that, not
  // remounted, since nothing keys it to the specific entity) or, for the
  // same entity, initialWatching's value changes (the account's watch state
  // changing elsewhere and this list re-fetching after a filter change -
  // WatchIconButton, keyed by the entity's stable id but not remounted just
  // because the surrounding table re-renders).
  //
  // Comparing the target's key here, not just initialWatching's value, is
  // required: two different entities can coincidentally share the same
  // initialWatching (e.g. both unwatched). A value-only comparison would
  // treat that as "nothing changed" and leave stale local state - from a
  // toggle on the PREVIOUS entity - applied to the new one. The ref guard
  // makes this a no-op right after this component's own successful toggle,
  // since local state already matches by the time any later prop change
  // would arrive.
  useEffect(() => {
    if (lastSeen.current.key !== key || lastSeen.current.initialWatching !== initialWatching) {
      lastSeen.current = { key, initialWatching };
      setWatching(initialWatching);
    }
  }, [key, initialWatching]);

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
      // fetch() itself (network failure) and res.json() (a non-JSON or
      // truncated body) can both throw - wrapping the whole thing keeps
      // either case from becoming an unhandled rejection inside the
      // transition and routes it to the same error toast as a non-ok
      // response.
      try {
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
        // Don't trust the response shape blindly - an unexpected payload
        // (e.g. a proxy/error page returned with a 200) shouldn't silently
        // set local state to something that isn't actually a boolean.
        if (typeof data?.watching !== "boolean") {
          toast.error("Couldn't update your watchlist");
          return;
        }
        setWatching(data.watching);
        toast.success(data.watching ? "Added to watchlist" : "Removed from watchlist");
      } catch {
        toast.error("Couldn't update your watchlist");
      }
    });
  }

  return { watching, isPending, toggle };
}
