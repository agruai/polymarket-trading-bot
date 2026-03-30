import { logger } from "./logger";
import { config } from "../config";

/**
 * Lightweight counters for observability. Enable verbose summaries with DEBUG=true.
 */
export const metrics = {
    predictionPoles: 0,
    firstSideOrdersPlaced: 0,
    secondSideOrdersPlaced: 0,
    poolEndExitSells: 0,
};

let lastSummary = Date.now();

export function bumpMetric<K extends keyof typeof metrics>(key: K): void {
    metrics[key]++;
}

/** Periodic DEBUG log (at most once per 60s) to avoid hot-path overhead. */
export function maybeLogMetricsSummary(): void {
    if (!config.debug) return;
    const now = Date.now();
    if (now - lastSummary < 60_000) return;
    lastSummary = now;
    logger.debug(
        `metrics: poles=${metrics.predictionPoles} firstSide=${metrics.firstSideOrdersPlaced} secondSide=${metrics.secondSideOrdersPlaced} poolExit=${metrics.poolEndExitSells}`
    );
}
