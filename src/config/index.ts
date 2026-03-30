import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { assertMarketIntervalMinutes } from "../utils/marketInterval";

// Load `.env` once for the whole app. Safe if the file doesn't exist.
dotenvConfig({ path: resolve(process.cwd(), ".env") });

function envString(name: string, fallback?: string): string | undefined {
    const v = process.env[name];
    const t = typeof v === "string" ? v.trim() : "";
    if (t) return t;
    return fallback;
}

function envNumber(name: string, fallback: number): number {
    const raw = envString(name);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
    const raw = envString(name);
    if (!raw) return fallback;
    return raw.toLowerCase() === "true";
}

/** unset if env missing; true/false if explicitly set */
function envOptionalBool(name: string): boolean | undefined {
    const raw = envString(name);
    if (!raw) return undefined;
    const l = raw.toLowerCase();
    if (l === "true" || l === "1" || l === "yes") return true;
    if (l === "false" || l === "0" || l === "no") return false;
    return undefined;
}

function envCsvLower(name: string, fallbackCsv: string): string[] {
    const raw = envString(name, fallbackCsv) ?? fallbackCsv;
    return raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

function requireEnv(name: string): string {
    const v = envString(name);
    if (!v) throw new Error(`${name} not found`);
    return v;
}

export const config = {
    /** Enable verbose logs */
    debug: envBool("DEBUG", false),

    /**
     * Log pole/accuracy/prediction summaries and per-tick order-book lines (very noisy, high memory).
     * Default false: only operational lines (cycles, buys, balance, slim redeem). Set LOG_PREDICTIONS=true to enable.
     */
    logPredictions: envBool("LOG_PREDICTIONS", false),

    /** EVM chain id (Polygon mainnet = 137) */
    chainId: envNumber("CHAIN_ID", 137),

    /** Polymarket CLOB API base URL */
    clobApiUrl: envString("CLOB_API_URL", "https://clob.polymarket.com")!,

    /** Wallet private key (required for most scripts). Use config.requirePrivateKey() when needed. */
    privateKey: envString("PRIVATE_KEY"),
    requirePrivateKey: () => requireEnv("PRIVATE_KEY"),

    /** Use Polymarket proxy/smart wallet (set true only if you trade via proxy; default EOA) */
    useProxyWallet: envBool("USE_PROXY_WALLET", false),
    /** Proxy/Polymarket profile address (where USDC is held); only used when USE_PROXY_WALLET=true */
    prozyWalletAddress: envString("PROZY_WALLET_ADDRESS", "0xcbb677eBF16eB7B1d372499eDaF01Cb6B083De9B")!,

    /** RPC configuration (used for on-chain calls like allowance/balance/redeem). */
    rpcUrl: envString("RPC_URL"),
    rpcToken: envString("RPC_TOKEN"),

    /** Global neg-risk toggle used by some on-chain allowance helpers */
    negRisk: envBool("NEG_RISK", false),

    /** Bot runner settings */
    bot: {
        minUsdcBalance: envNumber("BOT_MIN_USDC_BALANCE", 1),
        waitForNextMarketStart: envBool("COPYTRADE_WAIT_FOR_NEXT_MARKET_START", false),
    },

    /** Console file logging */
    logging: {
        logFilePath: envString("LOG_FILE_PATH"),
        logDir: envString("LOG_DIR", "logs")!,
        logFilePrefix: envString("LOG_FILE_PREFIX", "bot")!,
    },

    /** Predictive-arb bot settings (env vars keep COPYTRADE_ prefix for backward compat) */
    predictiveArb: {
        marketIntervalMinutes: assertMarketIntervalMinutes(
            envNumber("COPYTRADE_MARKET_INTERVAL_MINUTES", 5)
        ),
        markets: envCsvLower("COPYTRADE_MARKETS", envString("GABAGOOL_MARKETS", "btc")!),
        sharesPerSide: envNumber("COPYTRADE_SHARES", envNumber("GABAGOOL_SHARES", 5)),
        tickSize: (envString("COPYTRADE_TICK_SIZE", envString("GABAGOOL_TICK_SIZE", "0.01")!) ??
            "0.01") as "0.01" | "0.001" | "0.0001" | string,
        negRisk: envBool("COPYTRADE_NEG_RISK", envBool("GABAGOOL_NEG_RISK", false)),
        minBalanceUsdc: envNumber("COPYTRADE_MIN_BALANCE_USDC", 1),
        maxBuyCountsPerSide: envNumber("COPYTRADE_MAX_BUY_COUNTS_PER_SIDE", 0), // Maximum buy counts per side (UP/DOWN) per market before pausing
        /**
         * Min model confidence [0–1] to fire leg-1. Lower = more trades (aggressive). BTC 5m default 0.38.
         */
        minConfidenceForTrade: envNumber("COPYTRADE_MIN_CONFIDENCE", 0.38),
        /** Only buy when token ask price > this (0 = off). ~0.52 allows more entries than 0.58 while filtering dust. */
        minBuyPrice: envNumber("COPYTRADE_MIN_BUY_PRICE", 0.52),
        /** Skip processPrice unless UP ask moves at least this much (more ticks = more signals on 5m BTC). */
        minUpPriceDelta: envNumber("COPYTRADE_MIN_UP_PRICE_DELTA", 0.00005),
        /**
         * After a full leg-1+leg-2 cycle completes, clear the UP-ask baseline so the next tick can pass `minUpPriceDelta`
         * without waiting for another price move (enables multiple rounds per pool like aggressive copy bots). Off = stricter throttle.
         */
        resetPriceDeltaAfterTrade: envBool("COPYTRADE_RESET_PRICE_DELTA_AFTER_TRADE", true),
        /** Max completed hedge rounds per pool (slug); 0 = unlimited. Use with side caps / balance limits. */
        maxRoundsPerPool: envNumber("COPYTRADE_MAX_ROUNDS_PER_POOL", 0),
        /** Min ms between starting new leg-1 in the same pool (0 = off). Throttles re-entry after a round. */
        minMsBetweenLeg1: envNumber("COPYTRADE_MIN_MS_BETWEEN_LEG1", 0),
        /** Seconds after pool start before leg-1 (0 = immediate). ~90s skips worst opening noise on 5m. */
        poolTradeDelaySecs: envNumber("COPYTRADE_POOL_TRADE_DELAY_SECS", 90),
        /**
         * Leg-2 limit = hedgePairSum − leg1Price. Pair cost = this sum → locked edge = 1 − sum per share.
         * 0.96 → 4¢ edge. 0.95 → 5¢ (tighter leg-2). 0.97 → 3¢ (easier leg-2 fill).
         */
        hedgePairSum: envNumber("COPYTRADE_HEDGE_PAIR_SUM", 0.96),
        /**
         * When true: if leg-1 price is high (expensive side), lower pair-sum slightly for more profit; if leg-1 is cheap,
         * raise pair-sum slightly so leg-2 limit is more competitive (better fill probability).
         */
        hedgeDynamicAdjust: envBool("COPYTRADE_HEDGE_DYNAMIC_ADJUST", true),
        /** Extra subtract from pair-sum (e.g. 0.005 = 0.5¢ more edge per share if both legs fill). Max 0.03 clamped in code. */
        hedgeProfitBias: envNumber("COPYTRADE_HEDGE_PROFIT_BIAS", 0),
        /** Poll CLOB for leg-1 fill (ms). */
        leg1FillPollMs: envNumber("COPYTRADE_LEG1_FILL_POLL_MS", 350),
        /** Max polls waiting for leg-1 fill (~poll × attempts ≈ max wait). */
        leg1FillMaxAttempts: envNumber("COPYTRADE_LEG1_FILL_MAX_ATTEMPTS", 50),
        /** Max leg-1 **ask** before skipping (0 = off). High asks → tiny leg-2 limit → poor hedge. */
        maxLeg1Ask: envNumber("COPYTRADE_MAX_LEG1_ASK", 0.84),
        /** Skip if computed leg-2 limit would be below this (0 = off). Avoids unfillable dust hedges. */
        minLeg2Limit: envNumber("COPYTRADE_MIN_LEG2_LIMIT", 0.03),
        /**
         * Stop opening new leg-1 this many ms before the pool ends (0 = off).
         * Reduces risk of leg-1 fill without time for leg-2 to work.
         */
        stopNewTradesMsBeforePoolEnd: envNumber("COPYTRADE_STOP_TRADES_MS_BEFORE_END", 60_000),
        /**
         * Skip if UP ask + DOWN ask > this (0 = off). Stale/wide books often sum > 1; cap avoids bad entries.
         * Example: 1.10 means skip when sum > 1.10.
         */
        maxBidAskSum: envNumber("COPYTRADE_MAX_BID_ASK_SUM", 1.12),
        /**
         * External BTC spot (Binance BTCUSDT) for momentum — can relax min confidence / pool delay when aligned with prediction.
         * Only applies to `btc` market. Off by default.
         */
        externalSpotEnabled: envBool("COPYTRADE_EXTERNAL_SPOT_ENABLED", false),
        externalSpotPollMs: envNumber("COPYTRADE_EXTERNAL_SPOT_POLL_MS", 400),
        externalSpotWindowMs: envNumber("COPYTRADE_EXTERNAL_SPOT_WINDOW_MS", 3000),
        /** Min |bps| move in `externalSpotWindowMs` to treat as “spot moving” for UP (positive bps). */
        externalSpotBpsUp: envNumber("COPYTRADE_EXTERNAL_SPOT_BPS_UP", 8),
        /** Min |bps| for DOWN (negative bps). */
        externalSpotBpsDown: envNumber("COPYTRADE_EXTERNAL_SPOT_BPS_DOWN", 8),
        /** When spot momentum aligns with prediction, lower `minConfidenceForTrade` by this much (floored ~0.15). */
        externalSpotConfidenceRelax: envNumber("COPYTRADE_EXTERNAL_SPOT_CONFIDENCE_RELAX", 0.12),
        /**
         * If > 0: when |spot bps| ≥ this and direction aligns with prediction, skip `poolTradeDelaySecs` (trade earlier in the pool).
         * 0 = never bypass delay via spot.
         */
        externalSpotBypassPoolDelayBps: envNumber("COPYTRADE_EXTERNAL_SPOT_BYPASS_POOL_DELAY_BPS", 0),
        /** Keep ~30s of spot samples for momentum. */
        externalSpotHistoryMs: envNumber("COPYTRADE_EXTERNAL_SPOT_HISTORY_MS", 30_000),
        /**
         * After each completed pool, run a background Polymarket API redeem sweep for positions in the last N hours
         * (same logic as `redeem:auto --api --no-redeemable-filter --pools-within-hours N`). 0 = disabled.
         */
        autoRedeemSweepHours: envNumber("COPYTRADE_AUTO_REDEEM_SWEEP_HOURS", 6),
        /** Ms before background API redeem sweep runs after a pool ends (0 = next macrotask; trading never awaits this). */
        redeemSweepDelayMs: envNumber("COPYTRADE_REDEEM_SWEEP_DELAY_MS", 500),
        /** How often to retry `redeemMarket` while “not resolved” / RPC flake (bot auto-redeem loop). */
        poolRedeemPollMs: envNumber("COPYTRADE_POOL_REDEEM_POLL_MS", 6_000),
        /** Max time to keep retrying pool redeem before giving up. */
        poolRedeemMaxWaitMs: envNumber("COPYTRADE_POOL_REDEEM_MAX_WAIT_MS", 10 * 60_000),
        /** Initial backoff between on-chain `redeemPositions` attempts after resolution (bot pool path). */
        poolRedeemTxRetryInitialMs: envNumber("COPYTRADE_POOL_REDEEM_TX_RETRY_MS", 800),

        /** Pool-end exit: sell unhedged leg-1 before expiry when price looks like a loser (stop-loss). */
        exitEnabled: envBool("COPYTRADE_EXIT_ENABLED", true),
        /** Seconds before pool end to start evaluating exits (e.g. 25 = last 25s of the window). */
        exitWindowSecs: envNumber("COPYTRADE_EXIT_WINDOW_SECS", 25),
        /** How often the exit monitor polls open positions (ms). */
        exitMonitorPollMs: envNumber("COPYTRADE_EXIT_MONITOR_POLL_MS", 3000),
        /**
         * Exit if best bid < buyPrice * this factor (e.g. 0.75 = bid dropped 25%+ vs entry).
         * Set > 1 to effectively disable relative trigger (use absolute threshold only).
         */
        exitPriceFactor: envNumber("COPYTRADE_EXIT_PRICE_FACTOR", 0.75),
        /** Exit if best bid below this absolute price (0 = off). */
        exitAbsoluteThreshold: envNumber("COPYTRADE_EXIT_ABSOLUTE_THRESHOLD", 0.3),
        /**
         * Optional limit price floor for market sell: bestBid minus this (clamped to tick).
         * Ignored when using pure FAK without explicit price; kept for future limit-fallback tuning.
         */
        exitSellDiscount: envNumber("COPYTRADE_EXIT_SELL_DISCOUNT", 0.02),
    },

    /** Redeem script args via env */
    redeem: {
        conditionId: envString("CONDITION_ID"),
        indexSets: envString("INDEX_SETS"),
        /** If > 0, API position fetch only keeps pools whose `endDate` is not older than this many hours (see getMarketsWithUserPositions). 0 = off. */
        poolsEndedWithinHours: envNumber("REDEEM_POOLS_WITHIN_HOURS", 0),
        /**
         * If set, overrides default API redeemable-only behavior for `redeemAllWinningMarketsFromAPI` / `bun src/auto-redeem.ts --api`.
         * Unset: when `poolsEndedWithinHours` is used, API fetch uses redeemable=true; otherwise all positions.
         */
        apiRedeemableOnly: envOptionalBool("REDEEM_API_REDEEMABLE_ONLY"),
    },
};


