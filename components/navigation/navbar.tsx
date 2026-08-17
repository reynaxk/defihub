import Link from "next/link";
import { LineChart } from "lucide-react";
import { auth, signOut } from "@/lib/auth/config";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ThemeToggle } from "@/components/navigation/theme-toggle";
import { MobileNav } from "@/components/navigation/mobile-nav";
import { SearchBox } from "@/components/search/search-box";

const NAV_LINKS = [
  { href: "/protocols", label: "Protocols" },
  { href: "/chains", label: "Chains" },
  { href: "/yields", label: "Yields" },
  { href: "/tokens", label: "Tokens" },
];

export async function Navbar() {
  const session = await auth();
  const mobileLinks = session?.user ? [...NAV_LINKS, { href: "/dashboard", label: "Dashboard" }] : NAV_LINKS;

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-3 sm:gap-6">
          <MobileNav links={mobileLinks} />
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <LineChart className="size-5 text-primary" strokeWidth={2.5} />
            <span>DeFiHub</span>
          </Link>
          <nav className="hidden items-center gap-5 text-sm text-muted-foreground sm:flex">
            {NAV_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className="transition-colors hover:text-foreground">
                {link.label}
              </Link>
            ))}
            {session?.user && (
              <Link href="/dashboard" className="transition-colors hover:text-foreground">
                Dashboard
              </Link>
            )}
          </nav>
        </div>

        <div className="hidden max-w-xs flex-1 px-6 sm:block">
          <SearchBox />
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
