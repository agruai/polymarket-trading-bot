/**
 * All bot configuration keys exposed in the config UI, grouped for display.
 * Keys match process.env names used in src/config/index.ts.
 */

export type FieldType = "string" | "number" | "boolean" | "csv";

export type ConfigField = {
    key: string;
    label: string;
    type: FieldType;
    description?: string;
    /** If true, value is never sent to the browser; user must re-enter to change */
    sensitive?: boolean;
};

export type ConfigSection = {
    id: string;
    title: string;
    description?: string;
    fields: ConfigField[];
};

export const CONFIG_SCHEMA: ConfigSection[] = [
    {
        id: "general",
        title: "General & logging",
        fields: [
            { key: "DEBUG", label: "Debug mode", type: "boolean", description: "Verbose debug logs" },
            { key: "LOG_PREDICTIONS", label: "Log predictions", type: "boolean", description: "Pole/accuracy/order-book logs (noisy)" },
            { key: "CHAIN_ID", label: "Chain ID", type: "number", description: "EVM chain (Polygon mainnet = 137)" },
        ],
    },
    {
        id: "api",
        title: "API & RPC",
        fields: [
            { key: "CLOB_API_URL", label: "CLOB API URL", type: "string" },
            { key: "RPC_URL", label: "RPC URL", type: "string", description: "For on-chain balance / redeem" },
            { key: "RPC_TOKEN", label: "RPC token", type: "string", sensitive: true, description: "Optional Bearer token for RPC provider" },
        ],
    },
    {
        id: "wallet",
        title: "Wallet",
        fields: [
            { key: "PRIVATE_KEY", label: "Private key", type: "string", sensitive: true, description: "Leave blank in UI to keep existing value" },
            { key: "USE_PROXY_WALLET", label: "Use proxy wallet", type: "boolean" },
            { key: "PROZY_WALLET_ADDRESS", label: "Proxy wallet address", type: "string" },
        ],
    },
    {
        id: "risk",
        title: "Global risk",
        fields: [
            { key: "NEG_RISK", label: "Neg-risk (global)", type: "boolean" },
            { key: "BOT_MIN_USDC_BALANCE", label: "Min USDC to start bot", type: "number" },
            { key: "COPYTRADE_WAIT_FOR_NEXT_MARKET_START", label: "Wait for next interval start", type: "boolean" },
        ],
    },
    {
        id: "logging_files",
        title: "File logging",
        fields: [
            { key: "LOG_FILE_PATH", label: "Log file path", type: "string", description: 'Use "{date}" for daily rotation' },
            { key: "LOG_DIR", label: "Log directory", type: "string" },
            { key: "LOG_FILE_PREFIX", label: "Log file prefix", type: "string" },
        ],
    },
    {
        id: "predictive_market",
        title: "Trading — market & sizing",
        fields: [
            { key: "COPYTRADE_MARKET_INTERVAL_MINUTES", label: "Market interval (minutes)", type: "number", description: "5 or 15" },
            { key: "COPYTRADE_MARKETS", label: "Markets (CSV)", type: "csv", description: "e.g. btc" },
            { key: "COPYTRADE_SHARES", label: "Shares per side", type: "number" },
            { key: "COPYTRADE_TICK_SIZE", label: "Tick size", type: "string", description: "e.g. 0.01" },
            { key: "COPYTRADE_NEG_RISK", label: "Neg-risk (trading)", type: "boolean" },
            { key: "COPYTRADE_MIN_BALANCE_USDC", label: "Min balance USDC (gate)", type: "number" },
            { key: "COPYTRADE_MAX_BUY_COUNTS_PER_SIDE", label: "Max buys per side (0 = unlimited)", type: "number" },
        ],
    },
    {
        id: "predictive_model",
        title: "Trading — predictor & entry",
        fields: [
            { key: "COPYTRADE_MIN_CONFIDENCE", label: "Min confidence (0–1)", type: "number" },
            { key: "COPYTRADE_MIN_BUY_PRICE", label: "Min buy price", type: "number", description: "0 = off" },
            { key: "COPYTRADE_MIN_UP_PRICE_DELTA", label: "Min UP ask delta to process", type: "number" },
            { key: "COPYTRADE_RESET_PRICE_DELTA_AFTER_TRADE", label: "Reset price delta after trade", type: "boolean" },
            { key: "COPYTRADE_MAX_ROUNDS_PER_POOL", label: "Max rounds per pool (0 = unlimited)", type: "number" },
            { key: "COPYTRADE_MIN_MS_BETWEEN_LEG1", label: "Min ms between leg-1", type: "number" },
            { key: "COPYTRADE_POOL_TRADE_DELAY_SECS", label: "Pool trade delay (seconds)", type: "number" },
            { key: "COPYTRADE_MAX_LEG1_ASK", label: "Max leg-1 ask", type: "number", description: "0 = off" },
            { key: "COPYTRADE_MIN_LEG2_LIMIT", label: "Min leg-2 limit", type: "number", description: "0 = off" },
            { key: "COPYTRADE_STOP_TRADES_MS_BEFORE_END", label: "Stop new trades ms before end", type: "number" },
            { key: "COPYTRADE_MAX_BID_ASK_SUM", label: "Max UP+DOWN ask sum", type: "number", description: "0 = off" },
        ],
    },
    {
        id: "predictive_hedge",
        title: "Trading — hedge",
        fields: [
            { key: "COPYTRADE_HEDGE_PAIR_SUM", label: "Hedge pair sum", type: "number" },
            { key: "COPYTRADE_HEDGE_DYNAMIC_ADJUST", label: "Hedge dynamic adjust", type: "boolean" },
            { key: "COPYTRADE_HEDGE_PROFIT_BIAS", label: "Hedge profit bias", type: "number" },
            { key: "COPYTRADE_LEG1_FILL_POLL_MS", label: "Leg-1 fill poll (ms)", type: "number" },
            { key: "COPYTRADE_LEG1_FILL_MAX_ATTEMPTS", label: "Leg-1 fill max attempts", type: "number" },
        ],
    },
    {
        id: "external_spot",
        title: "External BTC spot",
        fields: [
            { key: "COPYTRADE_EXTERNAL_SPOT_ENABLED", label: "Enabled", type: "boolean" },
            { key: "COPYTRADE_EXTERNAL_SPOT_POLL_MS", label: "Poll ms", type: "number" },
            { key: "COPYTRADE_EXTERNAL_SPOT_WINDOW_MS", label: "Momentum window ms", type: "number" },
            { key: "COPYTRADE_EXTERNAL_SPOT_BPS_UP", label: "BPS threshold (up)", type: "number" },
            { key: "COPYTRADE_EXTERNAL_SPOT_BPS_DOWN", label: "BPS threshold (down)", type: "number" },
            { key: "COPYTRADE_EXTERNAL_SPOT_CONFIDENCE_RELAX", label: "Confidence relax when aligned", type: "number" },
            { key: "COPYTRADE_EXTERNAL_SPOT_BYPASS_POOL_DELAY_BPS", label: "Bypass pool delay if abs(bps) >= this", type: "number" },
            { key: "COPYTRADE_EXTERNAL_SPOT_HISTORY_MS", label: "Spot history ms", type: "number" },
        ],
    },
    {
        id: "redeem_auto",
        title: "Auto-redeem",
        fields: [
            { key: "COPYTRADE_AUTO_REDEEM_SWEEP_HOURS", label: "API sweep last N hours (0 = off)", type: "number" },
            { key: "COPYTRADE_REDEEM_SWEEP_DELAY_MS", label: "Sweep delay ms", type: "number" },
            { key: "COPYTRADE_POOL_REDEEM_POLL_MS", label: "Pool redeem poll ms", type: "number" },
            { key: "COPYTRADE_POOL_REDEEM_MAX_WAIT_MS", label: "Pool redeem max wait ms", type: "number" },
            { key: "COPYTRADE_POOL_REDEEM_TX_RETRY_MS", label: "Redeem tx retry initial ms", type: "number" },
        ],
    },
    {
        id: "bandwidth",
        title: "BTC bandwidth gate",
        fields: [
            { key: "COPYTRADE_BANDWIDTH_CHECK_ENABLED", label: "Enabled", type: "boolean" },
            { key: "COPYTRADE_BANDWIDTH_THRESHOLD_USD", label: "Threshold USD", type: "number" },
            { key: "COPYTRADE_BANDWIDTH_LOOKBACK_MINUTES", label: "Lookback minutes", type: "number" },
        ],
    },
    {
        id: "exit",
        title: "Pool-end exit",
        fields: [
            { key: "COPYTRADE_EXIT_ENABLED", label: "Enabled", type: "boolean" },
            { key: "COPYTRADE_EXIT_WINDOW_SECS", label: "Exit window (seconds)", type: "number" },
            { key: "COPYTRADE_EXIT_MONITOR_POLL_MS", label: "Monitor poll ms", type: "number" },
            { key: "COPYTRADE_EXIT_PRICE_FACTOR", label: "Exit price factor", type: "number" },
            { key: "COPYTRADE_EXIT_ABSOLUTE_THRESHOLD", label: "Exit absolute threshold", type: "number", description: "0 = off" },
            { key: "COPYTRADE_EXIT_SELL_DISCOUNT", label: "Exit sell discount", type: "number" },
        ],
    },
    {
        id: "rule",
        title: "Rule-based strategy",
        fields: [
            { key: "RULE_STRATEGY_ENABLED", label: "Enabled", type: "boolean" },
            { key: "RULE_STRATEGY_ENTRY_SECS_BEFORE_END", label: "Entry secs before end", type: "number" },
            { key: "RULE_STRATEGY_CUTOFF_SECS_BEFORE_END", label: "Cutoff secs before end", type: "number" },
            { key: "RULE_STRATEGY_MIN_PRICE_LEAD", label: "Min price lead", type: "number" },
            { key: "RULE_STRATEGY_MIN_WINNER_ASK", label: "Min winner ask", type: "number" },
            { key: "RULE_STRATEGY_MAX_WINNER_ASK", label: "Max winner ask", type: "number" },
            { key: "RULE_STRATEGY_SHARES", label: "Shares", type: "number" },
            { key: "RULE_STRATEGY_MAX_TRADES_PER_POOL", label: "Max trades per pool", type: "number" },
            { key: "RULE_STRATEGY_USE_MARKET_ORDER", label: "Use market order (FAK)", type: "boolean" },
        ],
    },
    {
        id: "redeem_scripts",
        title: "Redeem scripts (optional)",
        fields: [
            { key: "CONDITION_ID", label: "Condition ID", type: "string" },
            { key: "INDEX_SETS", label: "Index sets", type: "string" },
            { key: "REDEEM_POOLS_WITHIN_HOURS", label: "Pools within hours (API redeem)", type: "number" },
            { key: "REDEEM_API_REDEEMABLE_ONLY", label: "API redeemable only", type: "string", description: "true / false / empty for default" },
        ],
    },
];

export const SENSITIVE_KEYS = new Set(["PRIVATE_KEY", "RPC_TOKEN"]);

/** Keys managed by the UI (flat list) */
export const ALL_SCHEMA_KEYS: string[] = CONFIG_SCHEMA.flatMap((s) => s.fields.map((f) => f.key));

export function getFieldMeta(key: string): ConfigField | undefined {
    for (const sec of CONFIG_SCHEMA) {
        const f = sec.fields.find((x) => x.key === key);
        if (f) return f;
    }
    return undefined;
}
