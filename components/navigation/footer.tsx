import Link from "next/link";

export function Footer() {
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          &copy; {new Date().getFullYear()} DeFiHub. Protocol, chain and yield data via{" "}
          <a
            href="https://defillama.com"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-foreground"
          >
            DefiLlama
          </a>
          . Price data via{" "}
          <a
            href="https://www.coingecko.com"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-foreground"
          >
            CoinGecko
          </a>
          .
        </p>
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link href="/protocols" className="hover:text-foreground">
            Protocols
          </Link>
          <Link href="/chains" className="hover:text-foreground">
            Chains
          </Link>
          <Link href="/yields" className="hover:text-foreground">
            Yields
          </Link>
          <Link href="/tokens" className="hover:text-foreground">
            Tokens
          </Link>
          <Link href="/research" className="hover:text-foreground">
            Research
          </Link>
          <Link href="/api-docs" className="hover:text-foreground">
            API
          </Link>
        </nav>
      </div>
    </footer>
  );
}
