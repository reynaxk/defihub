/**
 * Picks x-axis tick values for a time-series chart with a category-typed
 * axis. Recharts auto-generates tick positions from chart width alone,
 * independent of how the underlying data is actually spaced - with hourly
 * sync data and a short real history, that can request more distinct tick
 * positions than there are distinct visible labels, so several collapse
 * onto the same formatted date and render duplicated (e.g. "Aug 18" shown
 * four times in a row - reproduced live before this existed).
 *
 * Dedupes by the FORMATTED label first (keeping the first timestamp for
 * each distinct label), then downsamples that list to maxTicks if it's
 * still wider than the chart needs.
 */
export function computeChartTicks(
  timestamps: string[],
  formatLabel: (timestamp: string) => string,
  maxTicks = 6,
): string[] {
  const distinctLabelTimestamps: string[] = [];
  let lastLabel: string | null = null;
  for (const timestamp of timestamps) {
    const label = formatLabel(timestamp);
    if (label !== lastLabel) {
      distinctLabelTimestamps.push(timestamp);
      lastLabel = label;
    }
  }

  const tickCount = Math.min(maxTicks, distinctLabelTimestamps.length);
  if (distinctLabelTimestamps.length <= tickCount) return distinctLabelTimestamps;

  return Array.from({ length: tickCount }, (_, i) => {
    const index = Math.round((i * (distinctLabelTimestamps.length - 1)) / (tickCount - 1));
    return distinctLabelTimestamps[index];
  });
}
