/**
 * Pure helpers for per-side buy caps (MAX_BUY_COUNTS_PER_SIDE).
 * When maxPerSide <= 0, caps are disabled (unlimited).
 */

export function isSideCapReached(
    maxPerSide: number,
    side: "up" | "down",
    upCount: number,
    downCount: number
): boolean {
    if (maxPerSide <= 0) return false;
    return side === "up" ? upCount >= maxPerSide : downCount >= maxPerSide;
}

export function isMarketFullyPaused(
    maxPerSide: number,
    upCount: number,
    downCount: number
): boolean {
    if (maxPerSide <= 0) return false;
    return upCount >= maxPerSide && downCount >= maxPerSide;
}

/** Limit-order fill would exceed cap for that outcome leg (YES = UP token). */
export function limitFillWouldExceedCap(
    maxPerSide: number,
    leg: "YES" | "NO",
    upCount: number,
    downCount: number
): boolean {
    if (maxPerSide <= 0) return false;
    return leg === "YES" ? upCount >= maxPerSide : downCount >= maxPerSide;
}
