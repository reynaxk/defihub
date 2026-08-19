"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { EntityLogo } from "@/components/shared/entity-logo";
import { cn } from "@/lib/utils";
import { useEntitySearch } from "./use-entity-search";

// The inline dropdown search variant - still used inside the mobile Sheet
// (a full-screen overlay already), where a second modal (CommandPalette)
// would fight Base UI's focus trap. Desktop uses CommandPalette instead;
// both share the same search/select/keyboard-nav logic via
// useEntitySearch.
export function SearchBox({ className }: { className?: string }) {
  const {
    query,
    setQuery,
    queryLongEnough,
    loading,
    groups,
    flatIndexByKey,
    highlightedIndex,
    handleKeyDown,
    reset,
    KIND_LABELS,
  } = useEntitySearch();

  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  // Cmd/Ctrl+K focuses search from anywhere, always (even mid-typing, the
  // standard convention). "/" is a secondary shortcut that backs off if the
  // user is already typing somewhere else. CommandPalette owns its own
  // global ⌘K listener for opening the modal on desktop; this one only
  // matters while this inline variant is actually mounted (inside the
  // mobile Sheet).
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

  const showDropdown = focused && queryLongEnough;

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full", className)}
      onBlur={(e) => {
        if (!containerRef.current?.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => handleKeyDown(e, () => inputRef.current?.blur())}
          placeholder="Search protocols, chains, tokens..."
          aria-label="Search"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={highlightedIndex >= 0 ? `${listboxId}-option-${highlightedIndex}` : undefined}
          className="h-8 w-full rounded-lg border border-border bg-background py-1.5 pr-10 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          ⌘K
        </kbd>
      </div>

      {showDropdown && (
        <div
          id={listboxId}
          role="listbox"
          className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 absolute top-full left-0 z-50 mt-1.5 w-full min-w-72 overflow-hidden rounded-lg border border-border bg-popover shadow-lg duration-150"
        >
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
              {group.items.map((item) => {
                const flatIndex = flatIndexByKey.get(`${item.kind}-${item.href}`);
                return (
                  <Link
                    key={`${item.kind}-${item.href}`}
                    id={`${listboxId}-option-${flatIndex}`}
                    role="option"
                    aria-selected={highlightedIndex === flatIndex}
                    href={item.href}
                    onClick={() => {
                      reset();
                      inputRef.current?.blur();
                    }}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted",
                      highlightedIndex === flatIndex && "bg-muted",
                    )}
                  >
                    <EntityLogo src={item.logoUrl} name={item.name} size={20} />
                    <span className="font-medium">{item.name}</span>
                    {item.subtitle && <span className="text-muted-foreground">{item.subtitle}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
