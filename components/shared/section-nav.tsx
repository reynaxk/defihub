"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface SectionNavItem {
  id: string;
  label: string;
}

// Sticky in-page section nav for long single-scroll pages (chain/token
// detail) that have no other nav pattern - protocol detail already has a
// tab switcher and should not get this, it would compete with it.
// IntersectionObserver-based rather than a scroll listener, so there's no
// per-frame scroll-position polling.
export function SectionNav({ sections }: { sections: SectionNavItem[] }) {
  const [activeId, setActiveId] = useState(sections[0]?.id);

  useEffect(() => {
    const elements = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    // A given callback's `entries` only contains targets whose intersection
    // state *changed* since the last callback, not every currently-
    // intersecting target - so picking straight from `entries` can miss a
    // section that's still intersecting from an earlier callback, or (when
    // several targets change in one batch) pick one that isn't actually
    // the topmost. Maintaining the full current set across callbacks and
    // re-deriving "closest to top" from it every time - by walking
    // `sections` in its given (document/visual) order and taking the first
    // id present in the set - is robust to both.
    const intersectingIds = new Set<string>();

    function updateActiveFromIntersecting() {
      const topmost = sections.find((s) => intersectingIds.has(s.id));
      if (topmost) setActiveId(topmost.id);
    }

    // rootMargin biases toward the upper portion of the viewport (below
    // the sticky navbar + this nav itself) so a section is marked active
    // once it reaches that band, not only once it's the sole thing
    // visible.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) intersectingIds.add(entry.target.id);
          else intersectingIds.delete(entry.target.id);
        }
        updateActiveFromIntersecting();
      },
      { rootMargin: "-112px 0px -70% 0px" },
    );
    for (const el of elements) observer.observe(el);

    // The observer's activation band never reaches the last section if the
    // page doesn't have enough room below it to scroll that far - without
    // this, scrolling all the way to the bottom of the page can leave a
    // non-last section marked active. Bottom-of-page is checked directly
    // instead, overriding the observer's result in just that case.
    function onScroll() {
      const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (nearBottom) setActiveId(sections[sections.length - 1].id);
    }
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  }, [sections]);

  // Keeps the highlighted pill in sync with browser Back/Forward: this
  // component updates the URL itself via history.pushState (see
  // scrollToSection below), which doesn't fire a hashchange event and
  // isn't guaranteed to re-trigger the IntersectionObserver in every
  // browser's scroll-restoration timing - reading the hash directly off a
  // popstate event is the authoritative signal independent of that.
  useEffect(() => {
    function onPopState() {
      const hash = window.location.hash.slice(1);
      if (hash && sections.some((s) => s.id === hash)) {
        setActiveId(hash);
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [sections]);

  function scrollToSection(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    // Syncs the URL to the section without the browser's own instant-jump
    // side effect that setting location.hash (or letting a native anchor
    // navigation run) would cause - the scrollIntoView above already
    // handles the actual (smooth) scroll; this only makes the section
    // shareable/bookmarkable and restorable via back/forward.
    history.pushState(null, "", `#${id}`);
  }

  if (sections.length < 2) return null;

  return (
    <nav
      aria-label="Section navigation"
      className="no-scrollbar sticky top-14 z-30 -mx-4 overflow-x-auto border-b border-border bg-background/85 px-4 py-2 backdrop-blur supports-backdrop-filter:bg-background/60 sm:-mx-6 sm:px-6"
    >
      <div className="flex w-max gap-1">
        {sections.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            onClick={(e) => {
              // Only intercept a plain, unmodified primary-button click.
              // Cmd/Ctrl/Shift/Alt-modified clicks (open in new tab/window)
              // and non-primary-button clicks must fall through to the
              // browser's native anchor behavior untouched.
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              scrollToSection(s.id);
            }}
            aria-current={activeId === s.id ? "location" : undefined}
            className={cn(
              "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150",
              activeId === s.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {s.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
