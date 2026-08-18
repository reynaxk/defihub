import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <Skeleton className="h-8 w-16" />
      <Skeleton className="mt-3 h-4 w-full max-w-2xl" />
      <Skeleton className="mt-2 h-4 w-2/3 max-w-2xl" />
      <Skeleton className="mt-2 h-4 w-1/2 max-w-2xl" />

      <div className="mt-8 flex flex-col gap-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-border p-5">
            <div className="flex items-center gap-3">
              <Skeleton className="h-5 w-12" />
              <Skeleton className="h-4 w-48" />
            </div>
            <Skeleton className="mt-3 h-4 w-full max-w-md" />
            <Skeleton className="mt-4 h-24 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
