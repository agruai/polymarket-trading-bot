import * as fs from "fs";
import * as path from "path";

/** Written by PredictiveArbBot for the config dashboard; safe to delete when bot is off. */
export const BOT_LIVE_STATUS_PATH = path.resolve(process.cwd(), "src/data/bot-live-status.json");

export type BotLiveMarketRow = {
    market: string;
    slug: string;
    ready: boolean;
    upAsk: number | null;
    downAsk: number | null;
    sum: number | null;
    poolStartMs: number;
    poolEndMs: number;
    secsToEnd: number;
    /** Rough phase label for the current interval window */
    poolPhase: "waiting" | "active" | "ended";
    /** True when bandwidth gate disabled trading for this pool (btc only) */
    bandwidthDisabled: boolean;
};

export type BotLiveStatusJson = {
    updatedAt: string;
    botRunning: boolean;
    intervalMinutes: number;
    /** Local balance estimate from CLOB (may be Infinity if unset) */
    balanceUsdcEstimate: number | null;
    markets: BotLiveMarketRow[];
};

export function writeBotLiveStatus(payload: BotLiveStatusJson): void {
    try {
        fs.mkdirSync(path.dirname(BOT_LIVE_STATUS_PATH), { recursive: true });
        fs.writeFileSync(BOT_LIVE_STATUS_PATH, JSON.stringify(payload, null, 2), "utf8");
    } catch {
        // Never break trading on dashboard I/O failure
    }
}
