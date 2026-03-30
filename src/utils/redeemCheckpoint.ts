import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { logger } from "./logger";

type RedeemCheckpointMarket = {
    /** Last time we attempted to check resolved status for this condition. */
    lastCheckedAt?: number;
    /** Last time we observed the market as resolved. */
    lastResolvedAt?: number;
    /** Last time redeem succeeded (or we decided there's nothing to redeem). */
    lastRedeemedAt?: number;
    /** Next time we're allowed to check again (simple backoff). */
    nextCheckAt?: number;
    /** Last error string (trimmed). */
    lastError?: string;
};

export type RedeemCheckpoint = {
    version: 1;
    updatedAt: number;
    markets: Record<string, RedeemCheckpointMarket>;
};

const CHECKPOINT_FILE = resolve(process.cwd(), "src/data/redeem-checkpoint.json");

export function loadRedeemCheckpoint(): RedeemCheckpoint {
    if (!existsSync(CHECKPOINT_FILE)) {
        return { version: 1, updatedAt: Date.now(), markets: {} };
    }
    try {
        const raw = readFileSync(CHECKPOINT_FILE, "utf-8");
        const parsed = JSON.parse(raw) as Partial<RedeemCheckpoint>;
        if (parsed?.version !== 1 || typeof parsed?.markets !== "object" || !parsed.markets) {
            return { version: 1, updatedAt: Date.now(), markets: {} };
        }
        return {
            version: 1,
            updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
            markets: parsed.markets as Record<string, RedeemCheckpointMarket>,
        };
    } catch (e) {
        logger.error(`Failed to load redeem checkpoint: ${e instanceof Error ? e.message : String(e)}`);
        return { version: 1, updatedAt: Date.now(), markets: {} };
    }
}

export function saveRedeemCheckpoint(cp: RedeemCheckpoint): void {
    try {
        cp.updatedAt = Date.now();
        writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
    } catch (e) {
        logger.error(`Failed to save redeem checkpoint: ${e instanceof Error ? e.message : String(e)}`);
    }
}

export function pruneRedeemCheckpoint(
    cp: RedeemCheckpoint,
    opts?: { maxEntries?: number; dropOlderThanDays?: number }
): RedeemCheckpoint {
    const maxEntries = opts?.maxEntries ?? 1500;
    const dropOlderThanDays = opts?.dropOlderThanDays ?? 30;
    const cutoff = Date.now() - dropOlderThanDays * 24 * 60 * 60 * 1000;

    const entries = Object.entries(cp.markets);
    // Drop very old entries first
    for (const [conditionId, row] of entries) {
        const t = row.lastCheckedAt ?? row.lastRedeemedAt ?? row.lastResolvedAt ?? 0;
        if (t > 0 && t < cutoff) delete cp.markets[conditionId];
    }

    const after = Object.entries(cp.markets);
    if (after.length <= maxEntries) return cp;

    // Keep the newest by last activity timestamp
    after.sort((a, b) => {
        const ta = a[1].lastCheckedAt ?? a[1].lastRedeemedAt ?? a[1].lastResolvedAt ?? 0;
        const tb = b[1].lastCheckedAt ?? b[1].lastRedeemedAt ?? b[1].lastResolvedAt ?? 0;
        return tb - ta;
    });
    const keep = after.slice(0, maxEntries);
    cp.markets = Object.fromEntries(keep);
    return cp;
}

export function getRedeemCheckpointRow(cp: RedeemCheckpoint, conditionId: string): RedeemCheckpointMarket {
    if (!cp.markets[conditionId]) cp.markets[conditionId] = {};
    return cp.markets[conditionId]!;
}

