/**
 * Polymarket crypto Up/Down markets use fixed windows (e.g. 5m, 15m).
 * Slug format: `{coin}-updown-{N}m-{startUnixSeconds}`.
 */

export const MARKET_INTERVAL_OPTIONS = [5, 15] as const;
export type MarketIntervalMinutes = (typeof MARKET_INTERVAL_OPTIONS)[number];

export function assertMarketIntervalMinutes(n: number): MarketIntervalMinutes {
    if (n === 5 || n === 15) return n;
    throw new Error(`Invalid market interval: ${n}. Use 5 or 15 (minutes).`);
}

/** Start of current window in Unix seconds (aligned to interval). */
export function slotStartUnixSeconds(intervalMinutes: number, now: Date = new Date()): number {
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setMilliseconds(0);
    const m = d.getMinutes();
    const slotMin = Math.floor(m / intervalMinutes) * intervalMinutes;
    d.setMinutes(slotMin, 0, 0);
    return Math.floor(d.getTime() / 1000);
}

/** Gamma API slug for crypto up/down markets. */
export function slugForCryptoUpdown(market: string, intervalMinutes: number): string {
    const ts = slotStartUnixSeconds(intervalMinutes);
    return `${market}-updown-${intervalMinutes}m-${ts}`;
}

/** Ms until the next interval boundary (e.g. next :00, :05, :10 for 5m). */
export function msUntilNextIntervalBoundary(intervalMinutes: number, now: Date = new Date()): number {
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setMilliseconds(0);
    const m = d.getMinutes();
    const nextMin = (Math.floor(m / intervalMinutes) + 1) * intervalMinutes;
    d.setMinutes(nextMin, 0, 0);
    return Math.max(0, d.getTime() - now.getTime());
}

/** Ms remaining until the current market window closes. */
export function msUntilSlotEnd(intervalMinutes: number, now: Date = new Date()): number {
    const startSec = slotStartUnixSeconds(intervalMinutes, now);
    const endMs = (startSec + intervalMinutes * 60) * 1000;
    return Math.max(0, endMs - now.getTime());
}

/** Whether `minutes` is on a boundary for this interval (e.g. 0,5,10… for 5m). */
export function isMinuteAtIntervalBoundary(minutes: number, intervalMinutes: number): boolean {
    return minutes % intervalMinutes === 0;
}
