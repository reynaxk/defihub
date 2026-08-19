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
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          setRawResults(data.results ?? []);
          setHighlightedIndex(-1);
        }
      } catch {
        // Aborted by a newer query, or a real network failure - either way
        // there's nothing to show for this specific request.
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
  const groups = groupResults(results);
  // Keyboard nav and aria-activedescendant index into rendering order
  // (grouped by kind), not the raw API response order - those can differ,
  // and a mismatch there would highlight one item while Enter selects
  // another.
  const flatResults = groups.flatMap((g) => g.items);
  const flatIndexByKey = new Map(flatResults.map((item, i) => [`${item.kind}-${item.href}`, i]));

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
    groups,
    flatResults,
    flatIndexByKey,
    highlightedIndex,
    setHighlightedIndex,
    selectResult,
    handleKeyDown,
    reset,
    KIND_LABELS,
  };
}

export type UseEntitySearch = ReturnType<typeof useEntitySearch>;
