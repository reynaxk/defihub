import { DetailPageSkeleton } from "@/components/shared/detail-page-skeleton";

export default function Loading() {
  return (
    <DetailPageSkeleton
      titleWidth="w-40"
      subtitleWidth="w-56"
      actionWidth="w-20"
      descriptionWidth="w-full max-w-2xl"
      statTiles={6}
    />
  );
}
