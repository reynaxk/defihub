"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ALL = "__all__";

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
    startTransition(() => router.push(`/protocols?${params.toString()}`));
  }

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
    </div>
  );
}
