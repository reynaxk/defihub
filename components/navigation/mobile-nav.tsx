"use client";

import Link from "next/link";
import { useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

// The account menu (avatar dropdown) and the sign-in/register buttons
// already render outside the `hidden sm:flex` nav, so they're reachable on
// mobile without this. This just surfaces the browse links that aren't.
export function MobileNav({ links }: { links: { href: string; label: string }[] }) {
  // Deliberately not SheetClose for the nav items: Base UI's Close
  // primitive sets role="button" on whatever it composes with, which is
  // the wrong accessible role for a real navigational <a href> - screen
  // readers would announce "button" for something that just links to a
  // page. Controlled open state + a plain Link keeps the native link role.
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={<Button variant="ghost" size="icon" className="sm:hidden" />}
        aria-label="Open menu"
      >
        <Menu className="size-5" />
      </SheetTrigger>
      <SheetContent side="left" className="w-64">
        <SheetHeader>
          <SheetTitle>Menu</SheetTitle>
        </SheetHeader>
        <nav className="flex flex-col gap-1 px-4">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
