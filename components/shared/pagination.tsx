import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Pagination({
  page,
  totalPages,
  buildHref,
}: {
  page: number;
  totalPages: number;
  buildHref: (page: number) => string;
}) {
  if (totalPages <= 1) return null;

  const hasPrevious = page > 1;
  const hasNext = page < totalPages;

  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-between">
      {hasPrevious ? (
        <Button
          variant="outline"
          size="sm"
          render={
            <Link href={buildHref(page - 1)}>
              <ChevronLeft className="size-4" /> Previous
            </Link>
          }
        />
      ) : (
        <Button variant="outline" size="sm" disabled>
          <ChevronLeft className="size-4" /> Previous
        </Button>
      )}

      <span className="text-sm text-muted-foreground">
        Page {page} of {totalPages}
      </span>

      {hasNext ? (
        <Button
          variant="outline"
          size="sm"
          render={
            <Link href={buildHref(page + 1)}>
              Next <ChevronRight className="size-4" />
            </Link>
          }
        />
      ) : (
        <Button variant="outline" size="sm" disabled>
          Next <ChevronRight className="size-4" />
        </Button>
      )}
    </nav>
  );
}
