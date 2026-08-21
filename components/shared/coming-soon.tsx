import type { ReactNode } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Construction } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

// Shared shell for nav destinations the redesign spec asked for that have
// no backing data or logic yet (Stablecoins, Bridges, Trade, and parts of
// Research) - deliberately honest rather than a placeholder that could be
// mistaken for a working feature: no numbers, no fake charts, just what
// it will show once real ingestion/execution exists behind it.
export function ComingSoon({
  icon: Icon = Construction,
  eyebrow,
  title,
  description,
  planned,
  children,
}: {
  icon?: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
  planned?: string[];
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <div className="flex flex-col items-start gap-4">
        <span className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-primary uppercase">
          <Icon className="size-3.5" />
          {eyebrow}
        </span>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="max-w-xl text-muted-foreground">{description}</p>
      </div>

      {planned && planned.length > 0 && (
        <Card className="mt-8 p-5">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Planned for this page
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {planned.map((item) => (
              <li key={item} className="flex gap-2 text-sm text-foreground">
                <span className="text-primary">–</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {children}

      <div className="mt-8 flex flex-wrap gap-3">
        <Button variant="outline" render={<Link href="/protocols">Explore protocols</Link>} />
        <Button variant="outline" render={<Link href="/">Back to overview</Link>} />
      </div>
    </div>
  );
}
