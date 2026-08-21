import Link from "next/link";
import { Activity } from "lucide-react";
import { auth, signOut } from "@/lib/auth/config";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ThemeToggle } from "@/components/navigation/theme-toggle";
import { MobileNav } from "@/components/navigation/mobile-nav";
import { CommandPalette } from "@/components/search/command-palette";

export interface NavLink {
  href: string;
  label: string;
  // Nav entries the spec asked for that have no backing data/logic yet
  // (Stablecoins, Bridges, Trade) - the pages exist and are honest about
  // their own state, but the nav itself flags it up front too, rather
  // than only revealing "not available" after a click.
  soon?: boolean;
}

export const NAV_LINKS: NavLink[] = [
  { href: "/", label: "Overview" },
  { href: "/protocols", label: "Protocols" },
  { href: "/chains", label: "Chains" },
  { href: "/tokens", label: "Tokens" },
  { href: "/yields", label: "Yields" },
  { href: "/stablecoins", label: "Stablecoins", soon: true },
  { href: "/bridges", label: "Bridges", soon: true },
  { href: "/research", label: "Research" },
  { href: "/trade", label: "Trade", soon: true },
];

function SoonTag() {
  return (
    <span className="rounded-sm bg-muted px-1 py-px text-[9px] font-medium tracking-wide text-muted-foreground uppercase">
      Soon
    </span>
  );
}

export async function Navbar() {
  const session = await auth();
  const mobileLinks = session?.user
    ? [...NAV_LINKS, { href: "/dashboard", label: "Dashboard" }, { href: "/wallet", label: "Wallet" }]
    : NAV_LINKS;

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3 xl:gap-6">
          <MobileNav links={mobileLinks} />
          <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
            <Activity className="size-5 text-primary" strokeWidth={2.5} />
            <span>
              DeFi<span className="text-primary">Hub</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-4 text-sm text-muted-foreground xl:flex">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="flex items-center gap-1.5 whitespace-nowrap transition-colors hover:text-foreground"
              >
                {link.label}
                {link.soon && <SoonTag />}
              </Link>
            ))}
            {session?.user && (
              <>
                <Link href="/dashboard" className="whitespace-nowrap transition-colors hover:text-foreground">
                  Dashboard
                </Link>
                <Link href="/wallet" className="whitespace-nowrap transition-colors hover:text-foreground">
                  Wallet
                </Link>
              </>
            )}
          </nav>
        </div>

        <div className="hidden flex-1 justify-center px-6 sm:flex">
          <CommandPalette />
        </div>

        <div className="flex items-center gap-3">
          <ThemeToggle />
          {session?.user ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Account menu"
                className="flex items-center gap-2 rounded-full outline-none ring-ring/50 focus-visible:ring-2"
              >
                <Avatar className="size-8">
                  {session.user.image && (
                    // referrerPolicy is required - Google's image CDN 403s on
                    // requests carrying a referrer header pointing back here,
                    // which would otherwise silently fail to a broken image.
                    <AvatarImage src={session.user.image} alt="" referrerPolicy="no-referrer" />
                  )}
                  <AvatarFallback className="text-xs">
                    {(session.user.name ?? session.user.email ?? "?").slice(0, 1).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <div className="truncate px-2 py-1.5 text-sm text-muted-foreground">{session.user.email}</div>
                <DropdownMenuSeparator />
                <DropdownMenuItem render={<Link href="/dashboard">Dashboard</Link>} />
                <DropdownMenuItem render={<Link href="/alerts">Alerts</Link>} />
                <DropdownMenuItem render={<Link href="/settings">Settings</Link>} />
                <DropdownMenuSeparator />
                <form
                  action={async () => {
                    "use server";
                    await signOut({ redirectTo: "/" });
                  }}
                >
                  <button type="submit" className="w-full px-2 py-1.5 text-left text-sm">
                    Sign out
                  </button>
                </form>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" render={<Link href="/login">Sign in</Link>} />
              <Button size="sm" render={<Link href="/register">Get started</Link>} />
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
