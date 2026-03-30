import { ALL_SCHEMA_KEYS } from "./configSchema";

/**
 * Fallback defaults when a key is missing from `.env` on disk.
 * Kept in sync with `src/config/index.ts` fallbacks (same literals as envNumber/envBool defaults).
 */
const STATIC_DEFAULTS: Record<string, string> = {
    DEBUG: "false",
    LOG_PREDICTIONS: "false",
    CHAIN_ID: "137",
    CLOB_API_URL: "https://clob.polymarket.com",
    RPC_URL: "",
    RPC_TOKEN: "",
    USE_PROXY_WALLET: "false",
    PRIVATE_KEY: "",
    PROZY_WALLET_ADDRESS: "0xcbb677eBF16eB7B1d372499eDaF01Cb6B083De9B",
    NEG_RISK: "false",
    BOT_MIN_USDC_BALANCE: "1",
    COPYTRADE_WAIT_FOR_NEXT_MARKET_START: "false",
    LOG_FILE_PATH: "",
    LOG_DIR: "logs",
    LOG_FILE_PREFIX: "bot",
    COPYTRADE_MARKET_INTERVAL_MINUTES: "5",
    COPYTRADE_MARKETS: "btc",
    COPYTRADE_SHARES: "5",
    COPYTRADE_TICK_SIZE: "0.01",
    COPYTRADE_NEG_RISK: "false",
    COPYTRADE_MIN_BALANCE_USDC: "1",
    COPYTRADE_MAX_BUY_COUNTS_PER_SIDE: "0",
    COPYTRADE_MIN_CONFIDENCE: "0.38",
    COPYTRADE_MIN_BUY_PRICE: "0.52",
    COPYTRADE_MIN_UP_PRICE_DELTA: "0.00005",
    COPYTRADE_RESET_PRICE_DELTA_AFTER_TRADE: "true",
    COPYTRADE_MAX_ROUNDS_PER_POOL: "0",
    COPYTRADE_MIN_MS_BETWEEN_LEG1: "0",
    COPYTRADE_POOL_TRADE_DELAY_SECS: "90",
    COPYTRADE_HEDGE_PAIR_SUM: "0.96",
    COPYTRADE_HEDGE_DYNAMIC_ADJUST: "true",
    COPYTRADE_HEDGE_PROFIT_BIAS: "0",
    COPYTRADE_LEG1_FILL_POLL_MS: "0",
    COPYTRADE_LEG1_FILL_MAX_ATTEMPTS: "50",
    COPYTRADE_MAX_LEG1_ASK: "0.58",
    COPYTRADE_MIN_LEG2_LIMIT: "0.03",
    COPYTRADE_STOP_TRADES_MS_BEFORE_END: "60000",
    COPYTRADE_MAX_BID_ASK_SUM: "1.12",
    COPYTRADE_EXTERNAL_SPOT_ENABLED: "false",
    COPYTRADE_EXTERNAL_SPOT_POLL_MS: "400",
    COPYTRADE_EXTERNAL_SPOT_WINDOW_MS: "3000",
    COPYTRADE_EXTERNAL_SPOT_BPS_UP: "8",
    COPYTRADE_EXTERNAL_SPOT_BPS_DOWN: "8",
    COPYTRADE_EXTERNAL_SPOT_CONFIDENCE_RELAX: "0.12",
    COPYTRADE_EXTERNAL_SPOT_BYPASS_POOL_DELAY_BPS: "0",
    COPYTRADE_EXTERNAL_SPOT_HISTORY_MS: "30000",
    COPYTRADE_AUTO_REDEEM_SWEEP_HOURS: "6",
    COPYTRADE_REDEEM_SWEEP_DELAY_MS: "500",
    COPYTRADE_POOL_REDEEM_POLL_MS: "6000",
    COPYTRADE_POOL_REDEEM_MAX_WAIT_MS: "600000",
    COPYTRADE_POOL_REDEEM_TX_RETRY_MS: "800",
    COPYTRADE_BANDWIDTH_CHECK_ENABLED: "true",
    COPYTRADE_BANDWIDTH_THRESHOLD_USD: "100",
    COPYTRADE_BANDWIDTH_LOOKBACK_MINUTES: "10",
    COPYTRADE_EXIT_ENABLED: "true",
    COPYTRADE_EXIT_WINDOW_SECS: "25",
    COPYTRADE_EXIT_MONITOR_POLL_MS: "3000",
    COPYTRADE_EXIT_PRICE_FACTOR: "0.75",
    COPYTRADE_EXIT_ABSOLUTE_THRESHOLD: "0.3",
    COPYTRADE_EXIT_SELL_DISCOUNT: "0.02",
    RULE_STRATEGY_ENABLED: "false",
    RULE_STRATEGY_ENTRY_SECS_BEFORE_END: "30",
    RULE_STRATEGY_CUTOFF_SECS_BEFORE_END: "5",
    RULE_STRATEGY_MIN_PRICE_LEAD: "0.1",
    RULE_STRATEGY_MIN_WINNER_ASK: "0.58",
    RULE_STRATEGY_MAX_WINNER_ASK: "0.92",
    RULE_STRATEGY_SHARES: "5",
    RULE_STRATEGY_MAX_TRADES_PER_POOL: "1",
    RULE_STRATEGY_USE_MARKET_ORDER: "false",
    CONDITION_ID: "",
    INDEX_SETS: "",
    REDEEM_POOLS_WITHIN_HOURS: "0",
    REDEEM_API_REDEEMABLE_ONLY: "",
};

/**
 * Merge raw `.env` file values with static defaults for any key not set (or empty) in the file.
 * Used so the UI always shows sensible defaults matching the bot's `config` fallbacks.
 */
export function mergeEnvWithStaticDefaults(fileValues: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of ALL_SCHEMA_KEYS) {
        const raw = fileValues[key];
        if (raw !== undefined && raw.trim() !== "") {
            out[key] = raw;
        } else if (STATIC_DEFAULTS[key] !== undefined) {
            out[key] = STATIC_DEFAULTS[key];
        } else {
            out[key] = "";
        }
    }
    return out;
}
