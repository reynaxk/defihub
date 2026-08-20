"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SearchResult } from "@/lib/database/queries/search";

const KIND_LABELS: Record<SearchResult["kind"], string> = {
  protocol: "Protocols",
  chain: "Chains",
  token: "Tokens",
};

function groupResults(results: SearchResult[]) {
  const groups: { kind: SearchResult["kind"]; items: SearchResult[] }[] = [];
  for (const kind of ["protocol", "chain", "token"] as const) {
    const items = results.filter((r) => r.kind === kind);
    if (items.length > 0) groups.push({ kind, items });
  }
  return groups;
}

// Shared search/select/keyboard-nav logic behind SearchBox (the inline
// dropdown variant, still used in the mobile Sheet) and CommandPalette
// (the ⌘K modal). Deliberately does NOT own "is the results UI visible"
// (open/blur state) or Escape handling - those differ per presentation
// (the inline variant closes+blurs on Escape; the modal variant lets the
// Dialog's own Escape-to-close take over) and belong to each consumer.
export function useEntitySearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [rawResults, setRawResults] = useState<SearchResult[]>([]);
  const [rawLoading, setRawLoading] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queryLongEnough = query.trim().length >= 2;

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Below the search threshold there's no async operation to start - the
    // derived `results`/`loading` below already read as empty/false in
    // that case, so there's nothing to clear via setState here.
    if (!queryLongEnough) return;

    // Without this, a slow response to an earlier query can resolve after a
    // faster response to a later one and overwrite it with stale results
    // that no longer match what's in the input - reproduced this live
    // (typed "uniswap" then quickly "aave"; a delayed "uniswap" response
    // clobbered the correct "aave" results a moment later) before adding
    // the abort.
    const controller = new AbortController();
    debounceRef.current = setTimeout(async () => {
      setRawLoading(true);
      setSearchFailed(false);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!res.ok) {
          // A real failure (rate limit, 500, etc.) reads very differently
          // from "no matches" - conflating the two would tell the user
          // their search came up empty when the request never actually
          // completed. Whatever the previous successful query's results
          // were stays on screen rather than being cleared.
          setSearchFailed(true);
          return;
        }
        const data = await res.json();
        setRawResults(data.results ?? []);
        setHighlightedIndex(-1);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Superseded by a newer query - that request's own run of this
          // effect owns updating state from here. Explicitly a no-op: the
          // previous (still valid) results and highlight stay exactly as
          // they were, not cleared just because this stale request didn't
          // finish.
          return;
        }
        // A genuine network failure (offline, DNS, CORS, etc.), not abort.
        setSearchFailed(true);
      } finally {
        setRawLoading(false);
      }
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      controller.abort();
    };
  }, [query, queryLongEnough]);

  const results = queryLongEnough ? rawResults : [];
  const loading = queryLongEnough && rawLoading;
  const failed = queryLongEnough && searchFailed;
  const groups = groupResults(results);
  // Keyboard nav and aria-activedescendant index into rendering order
  // (grouped by kind), not the raw API response order - those can differ,
  // and a mismatch there would highlight one item while Enter selects
  // another. Keyed by object identity (the same SearchResult reference
  // appears in both `flatResults` and its group's `items`), not a
  // `kind-href` string: two results could in principle collide on that
  // composite (e.g. a data quality issue upstream returning the same
  // entity twice), which would corrupt this lookup and duplicate React
  // keys. Identity can't collide - every entry is a distinct object.
  const flatResults = groups.flatMap((g) => g.items);
  const flatIndexByItem = new Map(flatResults.map((item, i) => [item, i]));

  function reset() {
    setQuery("");
    setHighlightedIndex(-1);
  }

  function selectResult(item: SearchResult) {
    reset();
    router.push(item.href);
  }

  function handleKeyDown(e: React.KeyboardEvent, onEscape?: () => void) {
    if (e.key === "Escape") {
      onEscape?.();
      return;
    }
    if (flatResults.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => (i + 1) % flatResults.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => (i <= 0 ? flatResults.length - 1 : i - 1));
    } else if (e.key === "Enter" && highlightedIndex >= 0) {
      e.preventDefault();
      selectResult(flatResults[highlightedIndex]);
    }
  }

  return {
    query,
    setQuery,
    queryLongEnough,
    loading,
    failed,
    groups,
    flatResults,
    flatIndexByItem,
    highlightedIndex,
    setHighlightedIndex,
    selectResult,
    handleKeyDown,
    reset,
    KIND_LABELS,
  };
}

export type UseEntitySearch = ReturnType<typeof useEntitySearch>;
