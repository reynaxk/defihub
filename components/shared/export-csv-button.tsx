"use client";

import { useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

// A plain <a>, not next/link - this navigates to a route that returns a
// file (Content-Disposition: attachment), not a page, so it shouldn't go
// through Next's client-side router. The browser's native download
// handling is exactly what's wanted here.
export function ExportCsvButton({ endpoint }: { endpoint: string }) {
  const searchParams = useSearchParams();
  const href = `${endpoint}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;

  return (
    <Button
      variant="outline"
      size="sm"
      render={<a href={href} />}
    >
      <Download className="size-4" />
      Export CSV
    </Button>
  );
}
