import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EntityLogo } from "@/components/shared/entity-logo";
import { PercentChange } from "@/components/shared/percent-change";
import { formatUsd } from "@/lib/format";
import type { ProtocolListItem } from "@/lib/database/queries/protocols";

export function ProtocolsTable({
  protocols,
  rankOffset = 0,
}: {
  protocols: ProtocolListItem[];
  rankOffset?: number;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">#</TableHead>
            <TableHead>Protocol</TableHead>
            <TableHead className="hidden sm:table-cell">Category</TableHead>
            <TableHead className="text-right">TVL</TableHead>
            <TableHead className="hidden text-right sm:table-cell">24h</TableHead>
            <TableHead className="hidden text-right md:table-cell">7d</TableHead>
            <TableHead className="hidden text-right md:table-cell">24h Volume</TableHead>
            <TableHead className="hidden text-right lg:table-cell">24h Fees</TableHead>
            <TableHead className="hidden text-right lg:table-cell">24h Revenue</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {protocols.map((protocol, i) => (
            <TableRow key={protocol.id}>
              <TableCell className="text-muted-foreground">{rankOffset + i + 1}</TableCell>
              <TableCell>
                <Link href={`/protocol/${protocol.slug}`} className="flex items-center gap-2 font-medium">
                  <EntityLogo src={protocol.logoUrl} name={protocol.name} size={24} />
                  {protocol.name}
                </Link>
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                {protocol.category && <Badge variant="secondary">{protocol.category}</Badge>}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatUsd(protocol.tvl)}</TableCell>
              <TableCell className="hidden text-right tabular-nums sm:table-cell">
                <PercentChange value={protocol.tvlChange1d} />
              </TableCell>
              <TableCell className="hidden text-right tabular-nums md:table-cell">
                <PercentChange value={protocol.tvlChange7d} />
              </TableCell>
              <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">
                {formatUsd(protocol.volume24h)}
              </TableCell>
              <TableCell className="hidden text-right tabular-nums text-muted-foreground lg:table-cell">
                {formatUsd(protocol.fees24h)}
              </TableCell>
              <TableCell className="hidden text-right tabular-nums text-muted-foreground lg:table-cell">
                {formatUsd(protocol.revenue24h)}
              </TableCell>
            </TableRow>
          ))}
          {protocols.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                No protocols match these filters yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
