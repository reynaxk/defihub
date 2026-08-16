export type AlertCondition = "above" | "below" | "percent_change_up" | "percent_change_down";

/**
 * Pure condition evaluation, kept separate from DB/notification I/O so it's
 * cheap to unit test exhaustively - this is the one piece of alert logic
 * that's easy to get subtly wrong (off-by-sign on percent change, div by 0).
 */
export function evaluateCondition(
  condition: AlertCondition,
  current: number,
  threshold: number,
  previous: number | null,
): boolean {
  switch (condition) {
    case "above":
      return current > threshold;
    case "below":
      return current < threshold;
    case "percent_change_up": {
      if (previous == null || previous === 0) return false;
      const pctChange = ((current - previous) / previous) * 100;
      return pctChange >= threshold;
    }
    case "percent_change_down": {
      if (previous == null || previous === 0) return false;
      const pctChange = ((current - previous) / previous) * 100;
      return pctChange <= -threshold;
    }
    default:
      return false;
  }
}
