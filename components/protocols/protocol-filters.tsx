"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ALL = "__all__";

const SORT_OPTIONS = [
  { value: "tvl-desc", label: "Highest TVL" },
  { value: "tvl-asc", label: "Lowest TVL" },
  { value: "change1d-desc", label: "Biggest 24h gainers" },
  { value: "change1d-asc", label: "Biggest 24h losers" },
  { value: "change7d-desc", label: "Biggest 7d gainers" },
  { value: "change7d-asc", label: "Biggest 7d losers" },
  { value: "fees-desc", label: "Highest 24h fees" },
  { value: "revenue-desc", label: "Highest 24h revenue" },
  { value: "volume-desc", label: "Highest 24h volume" },
] as const;

export function ProtocolFilters({
  categories,
  chains,
}: {
  categories: string[];
  chains: { slug: string; name: string }[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [, startTransition] = useTransition();

  function updateParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== ALL) params.set(key, value);
    else params.delete(key);
    // Any filter change invalidates the current page number (e.g. page 5
    // of an unfiltered list may not exist once a filter narrows results).
    params.delete("page");
    startTransition(() => router.push(`/protocols?${params.toString()}`));
  }

  function updateSort(value: string | null) {
    if (!value) return;
    const [sortBy, dir] = value.split("-");
    const params = new URLSearchParams(searchParams.toString());
    if (sortBy === "tvl") params.delete("sort");
    else params.set("sort", sortBy);
    if (dir === "asc") params.set("dir", dir);
    else params.delete("dir");
    params.delete("page");
    startTransition(() => router.push(`/protocols?${params.toString()}`));
  }

  const currentSort = `${searchParams.get("sort") ?? "tvl"}-${searchParams.get("dir") ?? "desc"}`;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative sm:w-64">
        <Search
          aria-hidden="true"
          className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search protocols"
          placeholder="Search protocols..."
          value={search}
          className="pl-8"
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") updateParam("q", search);
          }}
          onBlur={() => updateParam("q", search)}
        />
      </div>

      <Select
        defaultValue={searchParams.get("category") ?? ALL}
        onValueChange={(value) => updateParam("category", value)}
      >
        <SelectTrigger aria-label="Filter by category" className="sm:w-44">
          <SelectValue placeholder="Category">
            {(value: string) => (value === ALL ? "All categories" : value)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All categories</SelectItem>
          {categories.map((category) => (
            <SelectItem key={category} value={category}>
              {category}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select defaultValue={searchParams.get("chain") ?? ALL} onValueChange={(value) => updateParam("chain", value)}>
        <SelectTrigger aria-label="Filter by chain" className="sm:w-44">
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

      <Select value={currentSort} onValueChange={updateSort}>
        <SelectTrigger aria-label="Sort by" className="sm:w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
