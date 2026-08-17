"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ALL = "__all__";

const SORT_LABELS: Record<string, string> = {
  marketCap: "Market cap",
  price: "Price",
  volume24h: "24h volume",
  priceChange24h: "24h change",
};

export function TokenFilters({ chains }: { chains: { slug: string; name: string }[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function updateParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== ALL) params.set(key, value);
    else params.delete(key);
    // A filter/sort change can invalidate the current page number (e.g.
    // page 5 of an unfiltered list may not exist once a filter narrows it).
    params.delete("page");
    startTransition(() => router.push(`/tokens?${params.toString()}`));
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <Select defaultValue={searchParams.get("chain") ?? ALL} onValueChange={(value) => updateParam("chain", value)}>
        <SelectTrigger aria-label="Filter by chain" className="w-44">
          <SelectValue placeholder="Chain">
            {(value: string) => (value === ALL ? "All chains" : (chains.find((c) => c.slug === value)?.name ?? value))}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All chains</SelectItem>
          {chains.map((chain) => (
            <SelectItem key={chain.slug} value={chain.slug}>
              {chain.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        defaultValue={searchParams.get("sort") ?? "marketCap"}
        onValueChange={(value) => updateParam("sort", value)}
      >
        <SelectTrigger aria-label="Sort by" className="w-44">
          <SelectValue placeholder="Sort by">
            {(value: string) => `Sort: ${SORT_LABELS[value] ?? "Market cap"}`}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="marketCap">Market cap</SelectItem>
          <SelectItem value="price">Price</SelectItem>
          <SelectItem value="volume24h">24h volume</SelectItem>
          <SelectItem value="priceChange24h">24h change</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
