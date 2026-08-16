import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EntityLogo } from "@/components/shared/entity-logo";
import { formatUsd } from "@/lib/format";
import type { ChainListItem } from "@/lib/database/queries/chains";

export function ChainsTable({ chains }: { chains: ChainListItem[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">#</TableHead>
            <TableHead>Chain</TableHead>
            <TableHead>Native token</TableHead>
            <TableHead className="text-right">TVL</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {chains.map((chain, i) => (
            <TableRow key={chain.id}>
              <TableCell className="text-muted-foreground">{i + 1}</TableCell>
              <TableCell>
                <Link href={`/chain/${chain.slug}`} className="flex items-center gap-2 font-medium">
                  <EntityLogo src={chain.logoUrl} name={chain.name} size={24} />
                  {chain.name}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{chain.nativeToken}</TableCell>
              <TableCell className="text-right tabular-nums">{formatUsd(chain.tvl)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
