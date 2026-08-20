import { ListPageSkeleton } from "@/components/shared/list-page-skeleton";

export default function Loading() {
  return <ListPageSkeleton maxWidth="max-w-5xl" columns={4} rows={5} />;
}
