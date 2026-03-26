import * as fs from "fs";
import { resolve } from "path";
import { logger } from "./logger";

export interface TokenHoldings {
    [marketId: string]: {
        [tokenId: string]: number;
    };
}

const HOLDINGS_FILE = resolve(process.cwd(), "src/data/token-holding.json");

// In-memory cache — avoids sync disk reads on every call
let cache: TokenHoldings | null = null;
let persistTimer: NodeJS.Timeout | null = null;
let writeInFlight = false;

function ensureCache(): TokenHoldings {
    if (cache !== null) return cache;
    if (!fs.existsSync(HOLDINGS_FILE)) {
        cache = {};
        return cache;
    }
    try {
        cache = JSON.parse(fs.readFileSync(HOLDINGS_FILE, "utf-8")) as TokenHoldings;
    } catch {
        logger.error("Failed to load holdings — starting fresh");
        cache = {};
    }
    return cache;
}

function schedulePersist(): void {
    if (persistTimer) return;
    persistTimer = setTimeout(async () => {
        persistTimer = null;
        if (writeInFlight || cache === null) return;
        writeInFlight = true;
        try {
            const dir = resolve(HOLDINGS_FILE, "..");
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.writeFile(HOLDINGS_FILE, JSON.stringify(cache));
        } catch (e) {
            logger.error(`Failed to persist holdings: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            writeInFlight = false;
        }
    }, 300);
}

export function loadHoldings(): TokenHoldings {
    return ensureCache();
}

export function saveHoldings(holdings: TokenHoldings): void {
    cache = holdings;
    schedulePersist();
}

export function addHoldings(marketId: string, tokenId: string, amount: number): void {
    const holdings = ensureCache();
    if (!holdings[marketId]) holdings[marketId] = {};
    holdings[marketId][tokenId] = (holdings[marketId][tokenId] || 0) + amount;
    schedulePersist();
    logger.info(`Added ${amount} tokens to holdings: ${marketId} -> ${tokenId}`);
}

export function getHoldings(marketId: string, tokenId: string): number {
    return ensureCache()[marketId]?.[tokenId] || 0;
}

export function removeHoldings(marketId: string, tokenId: string, amount: number): void {
    const holdings = ensureCache();
    if (!holdings[marketId] || !holdings[marketId][tokenId]) {
        logger.error(`No holdings found for ${marketId} -> ${tokenId}`);
        return;
    }
    const current = holdings[marketId][tokenId];
    const remaining = Math.max(0, current - amount);
    if (remaining === 0) {
        delete holdings[marketId][tokenId];
        if (Object.keys(holdings[marketId]).length === 0) delete holdings[marketId];
    } else {
        holdings[marketId][tokenId] = remaining;
    }
    schedulePersist();
    logger.info(`Removed ${amount} tokens from holdings: ${marketId} -> ${tokenId} (remaining: ${remaining})`);
}

export function getMarketHoldings(marketId: string): { [tokenId: string]: number } {
    return ensureCache()[marketId] || {};
}

export function getAllHoldings(): TokenHoldings {
    return ensureCache();
}

export function clearMarketHoldings(marketId: string): void {
    const holdings = ensureCache();
    if (holdings[marketId]) {
        delete holdings[marketId];
        schedulePersist();
        logger.info(`Cleared holdings for market: ${marketId}`);
    } else {
        logger.error(`No holdings found for market: ${marketId}`);
    }
}

export function clearHoldings(): void {
    cache = {};
    schedulePersist();
    logger.info("All holdings cleared");
}
