"use client";

import { useState, useTransition } from "react";
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
