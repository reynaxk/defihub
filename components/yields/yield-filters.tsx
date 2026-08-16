"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

const ALL = "__all__";

export function YieldFilters({ chains }: { chains: { slug: string; name: string }[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function updateParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== ALL) params.set(key, value);
    else params.delete(key);
    startTransition(() => router.push(`/yields?${params.toString()}`));
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

      <div className="flex items-center gap-2">
        <Switch
          id="stablecoin-only"
          defaultChecked={searchParams.get("stable") === "1"}
          onCheckedChange={(checked) => updateParam("stable", checked ? "1" : null)}
        />
        <Label htmlFor="stablecoin-only" className="text-sm text-muted-foreground">
          Stablecoins only
        </Label>
      </div>
    </div>
  );
}
