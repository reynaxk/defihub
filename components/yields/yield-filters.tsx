"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

const ALL = "__all__";

const SORT_OPTIONS = [
  { value: "apy-desc", label: "Highest APY" },
  { value: "apy-asc", label: "Lowest APY" },
  { value: "tvl-desc", label: "Highest TVL" },
  { value: "tvl-asc", label: "Lowest TVL" },
] as const;

export function YieldFilters({
  chains,
  categories,
}: {
  chains: { slug: string; name: string }[];
  categories: string[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [minTvl, setMinTvl] = useState(searchParams.get("minTvl") ?? "");
  const [, startTransition] = useTransition();

  function updateParams(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value && value !== ALL) params.set(key, value);
      else params.delete(key);
    }
    // Any filter/sort change invalidates the current page number.
    params.delete("page");
    startTransition(() => router.push(`/yields?${params.toString()}`));
  }

  const currentSort = `${searchParams.get("sort") ?? "apy"}-${searchParams.get("dir") ?? "desc"}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative sm:w-56">
          <Search aria-hidden="true" className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search pools"
            placeholder="Search pool or protocol..."
            value={search}
            className="pl-8"
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") updateParams({ q: search });
            }}
            onBlur={() => updateParams({ q: search })}
          />
        </div>

        <Select defaultValue={searchParams.get("chain") ?? ALL} onValueChange={(value) => updateParams({ chain: value })}>
          <SelectTrigger aria-label="Filter by chain" className="w-40">
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
          defaultValue={searchParams.get("category") ?? ALL}
          onValueChange={(value) => updateParams({ category: value })}
        >
          <SelectTrigger aria-label="Filter by category" className="w-44">
            <SelectValue placeholder="Category">{(value: string) => (value === ALL ? "All categories" : value)}</SelectValue>
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

        <Select
          defaultValue={searchParams.get("risk") ?? ALL}
          onValueChange={(value) => updateParams({ risk: value })}
        >
          <SelectTrigger aria-label="Filter by impermanent loss risk" className="w-36">
            <SelectValue placeholder="IL risk">
              {(value: string) => (value === ALL ? "Any IL risk" : value === "yes" ? "Has IL risk" : "No IL risk")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any IL risk</SelectItem>
            <SelectItem value="no">No IL risk</SelectItem>
            <SelectItem value="yes">Has IL risk</SelectItem>
          </SelectContent>
        </Select>

        <Select value={currentSort} onValueChange={(value) => {
          if (!value) return;
          const [sortBy, dir] = value.split("-");
          updateParams({ sort: sortBy, dir });
        }}>
          <SelectTrigger aria-label="Sort by" className="w-40">
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

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Switch
            id="stablecoin-only"
            defaultChecked={searchParams.get("stable") === "1"}
            onCheckedChange={(checked) => updateParams({ stable: checked ? "1" : null })}
          />
          <Label htmlFor="stablecoin-only" className="text-sm text-muted-foreground">
            Stablecoins only
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <Label htmlFor="min-tvl" className="text-sm text-muted-foreground">
            Min TVL
          </Label>
          <Input
            id="min-tvl"
            type="number"
            min={0}
            placeholder="$0"
            value={minTvl}
            className="w-28"
            onChange={(e) => setMinTvl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") updateParams({ minTvl: minTvl || null });
            }}
            onBlur={() => updateParams({ minTvl: minTvl || null })}
          />
        </div>
      </div>
    </div>
  );
}
