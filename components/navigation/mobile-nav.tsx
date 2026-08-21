"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SearchBox } from "@/components/search/search-box";

// The account menu (avatar dropdown) and the sign-in/register buttons
// already render outside the `hidden xl:flex` nav, so they're reachable on
// mobile without this. This just surfaces the browse links that aren't.
export function MobileNav({ links }: { links: { href: string; label: string; soon?: boolean }[] }) {
  // Deliberately not SheetClose for the nav items: Base UI's Close
  // primitive sets role="button" on whatever it composes with, which is
  // the wrong accessible role for a real navigational <a href> - screen
  // readers would announce "button" for something that just links to a
  // page. Controlled open state + a plain Link keeps the native link role.
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const lastPathname = useRef(pathname);

  // Closes on any navigation, not just the plain browse links below - the
  // embedded SearchBox's own results are real <Link>s too (selecting one
  // navigates via next/link), but SearchBox has no idea it's nested inside
  // a sheet, so it can't close this on its own. Driving this off the route
  // itself covers every current and future way to navigate from in here,
  // rather than threading a close callback through each one individually.
  useEffect(() => {
    if (lastPathname.current !== pathname) {
      lastPathname.current = pathname;
      setOpen(false);
    }
  }, [pathname]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={<Button variant="ghost" size="icon" className="xl:hidden" />}
        aria-label="Open menu"
      >
        <Menu className="size-5" />
      </SheetTrigger>
      <SheetContent side="left" className="w-64">
        <SheetHeader>
          <SheetTitle>Menu</SheetTitle>
        </SheetHeader>
        <div className="px-4">
          <SearchBox />
        </div>
        <nav className="flex flex-col gap-1 px-4">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="flex items-center gap-1.5 rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {link.label}
              {link.soon && (
                <span className="rounded-sm bg-muted px-1 py-px text-[9px] font-medium tracking-wide text-muted-foreground uppercase">
                  Soon
                </span>
              )}
            </Link>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
