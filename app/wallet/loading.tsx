import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <Skeleton className="h-8 w-28" />
      <Skeleton className="mt-2 h-5 w-72" />
      <Skeleton className="mt-6 h-24 w-full rounded-lg" />
    </div>
  );
}
