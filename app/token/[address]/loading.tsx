import { DetailPageSkeleton } from "@/components/shared/detail-page-skeleton";

export default function Loading() {
  return (
    <DetailPageSkeleton
      titleWidth="w-32"
      subtitleWidth="w-24"
      actionWidth="w-20"
      descriptionWidth="w-80"
      statTiles={4}
    />
  );
}
