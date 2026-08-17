"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { EntityLogo } from "@/components/shared/entity-logo";
import { cn } from "@/lib/utils";
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

export function SearchBox({ className }: { className?: string }) {
  const [query, setQuery] = useState("");
  const [rawResults, setRawResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [rawLoading, setRawLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cmd/Ctrl+K focuses search from anywhere, always (even mid-typing, the
  // standard convention). "/" is a secondary shortcut that backs off if the
  // user is already typing somewhere else.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isCmdK) {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }
      if (e.key !== "/") return;
      const target = e.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (isTyping) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const queryLongEnough = query.trim().length >= 2;

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Below the search threshold there's no async operation to start - the
    // derived `results`/`loading` below already read as empty/false in
    // that case, so there's nothing to clear via setState here.
    if (!queryLongEnough) return;

    debounceRef.current = setTimeout(async () => {
      setRawLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const data = await res.json();
          setRawResults(data.results ?? []);
        }
      } finally {
        setRawLoading(false);
      }
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, queryLongEnough]);

  const results = queryLongEnough ? rawResults : [];
  const loading = queryLongEnough && rawLoading;
  const groups = groupResults(results);
  const showDropdown = open && queryLongEnough;

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full", className)}
      onBlur={(e) => {
        if (!containerRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              inputRef.current?.blur();
            }
          }}
          placeholder="Search protocols, chains, tokens..."
          aria-label="Search"
          className="h-8 w-full rounded-lg border border-border bg-background py-1.5 pr-10 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          ⌘K
        </kbd>
      </div>

      {showDropdown && (
        <div className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 absolute top-full left-0 z-50 mt-1.5 w-full min-w-72 overflow-hidden rounded-lg border border-border bg-popover shadow-lg duration-150">
          {loading && groups.length === 0 && (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">Searching…</div>
          )}
          {!loading && groups.length === 0 && (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              No matches for &ldquo;{query}&rdquo;
            </div>
          )}
          {groups.map((group) => (
            <div key={group.kind} className="border-b border-border py-1.5 last:border-b-0">
              <div className="px-3 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {KIND_LABELS[group.kind]}
              </div>
              {group.items.map((item) => (
                <Link
                  key={`${item.kind}-${item.href}`}
                  href={item.href}
                  onClick={() => {
                    setOpen(false);
                    setQuery("");
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted"
                >
                  <EntityLogo src={item.logoUrl} name={item.name} size={20} />
                  <span className="font-medium">{item.name}</span>
                  {item.subtitle && <span className="text-muted-foreground">{item.subtitle}</span>}
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
