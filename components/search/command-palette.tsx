"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import { EntityLogo } from "@/components/shared/entity-logo";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { useEntitySearch } from "./use-entity-search";

// Desktop's search surface: a self-contained trigger button + ⌘K-triggered
// modal, sharing one Dialog.Root so both control paths open the same
// instance. Built on the same search/select/keyboard-nav logic SearchBox's
// inline variant uses (see useEntitySearch) - a Dialog rather than a
// custom overlay so it inherits Base UI's focus trap, outside-click-to-
// close, and open/close animation for free, no cmdk dependency needed.
export function CommandPalette({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const {
    query,
    setQuery,
    queryLongEnough,
    loading,
    groups,
    flatIndexByKey,
    highlightedIndex,
    selectResult,
    handleKeyDown,
    reset,
    KIND_LABELS,
  } = useEntitySearch();

  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  // Global ⌘K listener toggles the same Dialog.Root state the trigger
  // button below controls. "/" is deliberately not bound here (unlike the
  // inline SearchBox variant used in the mobile Sheet): a bare "/" bound
  // globally on desktop would fight typing "/" into any other input on
  // the page.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((wasOpen) => !wasOpen);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else reset();
    // reset() is intentionally omitted from deps - it's stable in
    // behavior (always just clears query/highlight) and including it
    // would re-run this effect on every keystroke's derived re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Arrow-key navigation moves the highlight, but the listbox scrolls
  // independently of it - without this, highlighting an option outside the
  // current scroll position leaves it selectable (Enter still works) but
  // invisible. `block: "nearest"` only scrolls if the option isn't already
  // in view, so it doesn't fight manual mouse scrolling.
  useEffect(() => {
    if (highlightedIndex < 0) return;
    document
      .getElementById(`${listboxId}-option-${highlightedIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, listboxId]);

  const showDropdown = queryLongEnough;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn("w-full justify-start gap-2 text-muted-foreground sm:w-64", className)}
          />
        }
      >
        <Search className="size-4" />
        <span className="flex-1 text-left">Search…</span>
        <kbd className="pointer-events-none rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
          ⌘K
        </kbd>
      </DialogTrigger>

      <DialogContent
        showCloseButton={false}
        className="top-24 max-w-lg -translate-y-0 gap-0 p-0 sm:max-w-lg"
        aria-label="Search"
      >
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => handleKeyDown(e, () => setOpen(false))}
            placeholder="Search protocols, chains, tokens..."
            aria-label="Search"
            role="combobox"
            aria-expanded={showDropdown}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={highlightedIndex >= 0 ? `${listboxId}-option-${highlightedIndex}` : undefined}
            className="h-12 w-full border-0 bg-transparent py-3 pr-4 pl-10 text-base outline-none placeholder:text-muted-foreground"
          />
        </div>

        {showDropdown && (
          <div className="max-h-80 overflow-y-auto border-t border-border">
            {loading && groups.length === 0 && (
              <div role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
                Searching…
              </div>
            )}
            {!loading && groups.length === 0 && (
              <div role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
                No matches for &ldquo;{query}&rdquo;
              </div>
            )}
            {/* role="listbox" requires its owned elements to be options (or
                groups of options) only - the status messages above are
                deliberately siblings, not children, of this div. */}
            <div id={listboxId} role="listbox" aria-label="Search results">
              {groups.map((group) => {
                const groupLabelId = `${listboxId}-group-${group.kind}`;
                return (
                  <div
                    key={group.kind}
                    role="group"
                    aria-labelledby={groupLabelId}
                    className="border-b border-border py-1.5 last:border-b-0"
                  >
                    <div
                      id={groupLabelId}
                      className="px-3 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
                    >
                      {KIND_LABELS[group.kind]}
                    </div>
                    {group.items.map((item) => {
                      const flatIndex = flatIndexByKey.get(`${item.kind}-${item.href}`);
                      return (
                        <button
                          key={`${item.kind}-${item.href}`}
                          id={`${listboxId}-option-${flatIndex}`}
                          role="option"
                          type="button"
                          aria-selected={highlightedIndex === flatIndex}
                          onClick={() => {
                            selectResult(item);
                            setOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted",
                            highlightedIndex === flatIndex && "bg-muted",
                          )}
                        >
                          <EntityLogo src={item.logoUrl} name={item.name} size={20} />
                          <span className="font-medium">{item.name}</span>
                          {item.subtitle && <span className="text-muted-foreground">{item.subtitle}</span>}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
