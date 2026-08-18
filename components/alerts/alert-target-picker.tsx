"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface TargetOption {
  value: string;
  label: string;
  meta: string | null;
}

const PLACEHOLDER_BY_TYPE: Record<string, string> = {
  protocol_tvl: "Search protocols...",
  chain_tvl: "Search chains...",
  token_price: "Search tokens...",
  pool_apy: "Search yield pools...",
};

export function AlertTargetPicker({
  type,
  value,
  onChange,
}: {
  type: string;
  value: string;
  onChange: (value: string) => void;
}) {
  // Separate from `value` (the stored slug/id) - this is what's shown in
  // the input, since a stored id like "usd-coin" isn't what a human typed.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TargetOption[]>([]);
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastType = useRef(type);
  const listboxId = useId();

  // Switching alert type invalidates whatever was searched/selected under
  // the previous type - a protocol slug is meaningless once you're
  // searching tokens.
  useEffect(() => {
    if (lastType.current !== type) {
      lastType.current = type;
      setQuery("");
      setResults([]);
      onChange("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const queryLongEnough = query.trim().length >= 1;

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Below the threshold there's no fetch to start - `results` below is
    // already derived to read as empty in that case, so there's nothing to
    // clear via setState here (a synchronous setState in an effect body is
    // flagged by react-hooks/set-state-in-effect either way).
    if (!queryLongEnough) return;

    debounceRef.current = setTimeout(async () => {
      const res = await fetch(`/api/alerts/target-search?type=${type}&q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const data = await res.json();
        setResults(data.results ?? []);
        setHighlightedIndex(-1);
      }
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, type, queryLongEnough]);

  const visibleResults = queryLongEnough ? results : [];

  function select(option: TargetOption) {
    onChange(option.value);
    setQuery(option.label);
    setOpen(false);
    setHighlightedIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open || visibleResults.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => (i + 1) % visibleResults.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => (i <= 0 ? visibleResults.length - 1 : i - 1));
    } else if (e.key === "Enter" && highlightedIndex >= 0) {
      e.preventDefault();
      select(visibleResults[highlightedIndex]);
    }
  }

  return (
    <div
      ref={containerRef}
      className="relative"
      onBlur={(e) => {
        if (!containerRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange("");
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={PLACEHOLDER_BY_TYPE[type] ?? "Search..."}
          aria-label="Alert target"
          role="combobox"
          aria-expanded={open && queryLongEnough}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={highlightedIndex >= 0 ? `${listboxId}-option-${highlightedIndex}` : undefined}
          className="pl-8"
          autoComplete="off"
        />
      </div>

      {open && queryLongEnough && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute top-full left-0 z-50 mt-1.5 max-h-64 w-full min-w-64 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg"
        >
          {visibleResults.length === 0 ? (
            <div className="px-3 py-3 text-center text-sm text-muted-foreground">
              No matches for &ldquo;{query}&rdquo;
            </div>
          ) : (
            visibleResults.map((option, index) => (
              <button
                key={option.value}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={value === option.value}
                type="button"
                onClick={() => select(option)}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-muted",
                  (value === option.value || highlightedIndex === index) && "bg-muted",
                )}
              >
                <span className="font-medium">{option.label}</span>
                {option.meta && <span className="text-xs text-muted-foreground">{option.meta}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
