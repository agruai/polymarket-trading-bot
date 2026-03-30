import { AssetType, ClobClient, CreateOrderOptions, OrderType, Side, UserOrder, UserMarketOrder, Chain, getContractConfig } from "@polymarket/clob-client";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { config } from "../config";
import { WebSocketOrderBook, TokenPrice } from "../providers/websocketOrderbook";
import { AdaptivePricePredictor, PricePrediction } from "../utils/pricePredictor";
import { redeemAllWinningMarketsFromAPI, redeemMarket } from "../utils/redeem";
import {
    isMarketFullyPaused,
    isSideCapReached,
    limitFillWouldExceedCap,
} from "../trading/limits";
import { bumpMetric, maybeLogMetricsSummary } from "../utils/metrics";
import { isMinuteAtIntervalBoundary, slugForCryptoUpdown, slotStartUnixSeconds } from "../utils/marketInterval";
import { ExternalSpotFeed, fetchBtcBandwidth } from "../utils/externalSpot";

function parseJsonArray<T>(raw: unknown, ctx: string): T[] {
    if (typeof raw !== "string") throw new Error(`${ctx}: expected JSON string`);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${ctx}: expected JSON array`);
    return parsed as T[];
}

async function fetchTokenIdsForSlug(
    slug: string
): Promise<{ upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number }> {
    const url = `https://gamma-api.polymarket.com/markets/slug/${slug}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Gamma API ${response.status} ${response.statusText} for slug=${slug}`);
    }

    const data = (await response.json()) as any;
    const outcomes = parseJsonArray<string>(data.outcomes, "data.outcomes");
    const tokenIds = parseJsonArray<string>(data.clobTokenIds, "data.clobTokenIds");
    const conditionId = data.conditionId as string;

    const upIdx = outcomes.indexOf("Up");
    const downIdx = outcomes.indexOf("Down");
    if (upIdx < 0 || downIdx < 0) throw new Error(`Missing Up/Down outcomes for slug=${slug}`);
    if (!tokenIds[upIdx] || !tokenIds[downIdx]) throw new Error(`Missing token ids for slug=${slug}`);

    return { upTokenId: tokenIds[upIdx], downTokenId: tokenIds[downIdx], conditionId, upIdx, downIdx };
}

type SimpleStateRow = {
    previousUpPrice: number | null; // Previous cycle's UP token price
    lastUpdatedIso: string;
    // Holdings tracking (for redemption)
    conditionId?: string;
    slug?: string;
    market?: string;
    upIdx?: number;
    downIdx?: number;
};

type SimpleStateFile = Record<string, SimpleStateRow>;

type SimpleConfig = {
    markets: string[];
    marketIntervalMinutes: number;
    sharesPerSide: number;
    tickSize: CreateOrderOptions["tickSize"];
    negRisk: boolean;
    minBalanceUsdc: number;
};

/** Unhedged leg-1 inventory tracked for pool-end stop-loss exit. */
type OpenPosition = {
    market: string;
    slug: string;
    scoreKey: string;
    buyToken: "UP" | "DOWN";
    tokenId: string;
    /** Leg-1 limit price paid per share (cost basis). */
    buyPrice: number;
    shares: number;
    buyCost: number;
    leg2OrderId: string | undefined;
    poolEndMs: number;
    createdAt: number;
};

const STATE_FILE = "src/data/predictive-arb-state.json";

function statePath(): string {
    return path.resolve(process.cwd(), STATE_FILE);
}

function emptyRow(): SimpleStateRow {
    return {
        previousUpPrice: null,
        lastUpdatedIso: new Date().toISOString(),
    };
}

function loadState(): SimpleStateFile {
    const p = statePath();
    try {
        if (fs.existsSync(p)) {
            const raw = fs.readFileSync(p, "utf8").trim();
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            // Normalize state
            const normalized: SimpleStateFile = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (typeof v !== "object" || !v) continue;
                const row = v as any;
                normalized[k] = {
                    previousUpPrice: typeof row.previousUpPrice === "number" ? row.previousUpPrice : null,
                    lastUpdatedIso: String(row.lastUpdatedIso ?? new Date().toISOString()),
                    conditionId: typeof row.conditionId === "string" ? row.conditionId : undefined,
                    slug: typeof row.slug === "string" ? row.slug : undefined,
                    market: typeof row.market === "string" ? row.market : undefined,
                    upIdx: Number.isFinite(Number(row.upIdx)) ? Number(row.upIdx) : undefined,
                    downIdx: Number.isFinite(Number(row.downIdx)) ? Number(row.downIdx) : undefined,
                };
            }
            return normalized;
        }
    } catch (e) {
        logger.error(`Failed to read state: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {};
}

// Debounced state save
let saveStateTimer: NodeJS.Timeout | null = null;
function saveState(state: SimpleStateFile): void {
    if (saveStateTimer) {
        clearTimeout(saveStateTimer);
    }
    saveStateTimer = setTimeout(() => {
        try {
            const p = statePath();
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify(state, null, 2));
        } catch (e) {
            logger.error(`Failed to save state: ${e instanceof Error ? e.message : String(e)}`);
        }
        saveStateTimer = null;
    }, 500); // Debounce saves by 500ms
}

export class PredictiveArbBot {
    private lastSlugByMarket: Record<string, string> = {};
    private tokenIdsByMarket: Record<
        string,
        { slug: string; upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number }
    > = {};
    private state: SimpleStateFile = loadState();
    private isStopped: boolean = false;
    private wsOrderBook: WebSocketOrderBook | null = null;
    private lastProcessedPrice: Map<string, number> = new Map();
    /** Last time a full leg-1→leg-2 round finished for `market-slug` (cooldown for multi-round). */
    private lastLeg1RoundAt: Map<string, number> = new Map();

    /** Leg-1 fills awaiting hedge or pool-end exit (deleted when leg-2 fills or position is sold). */
    private openPositions: Map<string, OpenPosition> = new Map();
    private exitMonitorTimer: ReturnType<typeof setInterval> | null = null;
    /** Prevent concurrent exit attempts for the same position id. */
    private exitInFlight: Set<string> = new Set();
    private pricePredictors: Map<string, AdaptivePricePredictor> = new Map(); // Price predictors per market
    private lastPredictions: Map<string, { prediction: PricePrediction; actualPrice: number; timestamp: number }> = new Map(); // Track predictions for accuracy
    private marketStartTimeBySlug: Map<string, number> = new Map(); // Track when each market slug started

    // Limit order second side strategy tracking
    private tokenCountsByMarket: Map<string, { upTokenCount: number; downTokenCount: number }> = new Map();
    private pausedMarkets: Set<string> = new Set();
    private readonly MAX_BUY_COUNTS_PER_SIDE: number;
    private tradingLock: Set<string> = new Set(); // Per-market lock to prevent concurrent trade execution

    /** Only one processPrice per market at a time; new WS ticks wait until it finishes (prevents overlap + pile-up). */
    private processPriceCoalesceScheduled: Set<string> = new Set();
    /** Throttle very chatty pole / eval logs (string + chalk + tee pressure). */
    private lastVerbosePredictionLogAt: Map<string, number> = new Map();
    private static readonly PREDICTION_LOG_THROTTLE_MS = 20_000;

    // Prediction scoring system
    private predictionScores: Map<string, {
        market: string;
        slug: string;
        startTime: number;
        endTime: number | null;
        upTokenCost: number; // Total cost of UP token purchases
        downTokenCost: number; // Total cost of DOWN token purchases
        upTokenCount: number; // Number of UP token purchases
        downTokenCount: number; // Number of DOWN token purchases
        totalPredictions: number;
        correctPredictions: number;
        trades: Array<{
            prediction: "up" | "down";
            predictedPrice: number;
            actualPrice: number;
            buyToken: "UP" | "DOWN";
            buyPrice: number;
            buyCost: number;
            timestamp: number;
            wasCorrect: boolean | null; // null = not evaluated yet
        }>;
        // Removed: lastBuyToken tracking - no longer alternating between sides
    }> = new Map();

    private initializationPromise: Promise<void> | null = null;
    // Tracks conditionIds that have an active background redeem loop running
    private readonly redeemInProgress = new Set<string>();
    // Tracks conditionIds that have been fully redeemed (or are unwinnable); trimmed to bound memory.
    private readonly redeemedConditionIds = new Set<string>();
    private static readonly MAX_REDEEMED_IDS_TRACKED = 500;
    /** Single-flight Polymarket API redeem sweep after each pool (see COPYTRADE_AUTO_REDEEM_SWEEP_HOURS). */
    private apiRedeemSweepRunning = false;

    /** Binance BTCUSDT momentum (optional); only used when `btc` is in markets and COPYTRADE_EXTERNAL_SPOT_ENABLED. */
    private externalSpotFeed: ExternalSpotFeed | null = null;

    /** Pools where trading is disabled due to low BTC bandwidth (slug → true means disabled). */
    private poolTradingDisabledBySlug: Set<string> = new Set();

    private trimRedeemedConditionIds(): void {
        if (this.redeemedConditionIds.size <= PredictiveArbBot.MAX_REDEEMED_IDS_TRACKED) return;
        const arr = [...this.redeemedConditionIds];
        const toDrop = arr.length - Math.floor(PredictiveArbBot.MAX_REDEEMED_IDS_TRACKED / 2);
        for (let i = 0; i < toDrop; i++) this.redeemedConditionIds.delete(arr[i]);
    }

    // Local balance tracker — seeded at startup, decremented on each trade to gate capital
    private lastKnownBalance: number = Infinity;
    private lastBalanceRefreshTs: number = 0;

    constructor(private client: ClobClient, private cfg: SimpleConfig) {
        this.MAX_BUY_COUNTS_PER_SIDE = config.predictiveArb.maxBuyCountsPerSide;
        this.initializationPromise = this.initializeWebSocket();
    }

    private async refreshBalanceEstimate(force: boolean = false): Promise<void> {
        const now = Date.now();
        if (!force && now - this.lastBalanceRefreshTs < 15_000) return;
        try {
            const resp = await this.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
            const balance = parseFloat(resp.balance || "0") / 1e6;
            const chainId = (config.chainId || Chain.POLYGON) as Chain;
            const contractConfig = getContractConfig(chainId);
            const spender = this.cfg.negRisk ? contractConfig.negRiskExchange : contractConfig.exchange;
            const allowances: Record<string, string> = (resp as any).allowances ?? {};
            const allowanceWei = allowances[spender] ?? "0";
            const allowance = parseFloat(allowanceWei) / 1e6;
            // Conservative estimate to avoid over-spending against allowance constraints.
            this.lastKnownBalance = Math.max(0, Math.min(balance, allowance));
            this.lastBalanceRefreshTs = now;
        } catch {
            // Keep previous estimate on refresh errors.
        }
    }

    static async fromEnv(client: ClobClient): Promise<PredictiveArbBot> {
        const { markets, marketIntervalMinutes, sharesPerSide, tickSize, negRisk, minBalanceUsdc } = config.predictiveArb;
        const bot = new PredictiveArbBot(client, {
            markets,
            marketIntervalMinutes,
            sharesPerSide,
            tickSize: tickSize as CreateOrderOptions["tickSize"],
            negRisk,
            minBalanceUsdc,
        });
        await bot.initializationPromise;

        // Seed local balance tracker from CLOB so minBalanceUsdc gate works at runtime
        try {
            await bot.refreshBalanceEstimate(true);
            logger.info(`Balance tracker seeded: ${bot.lastKnownBalance.toFixed(2)} USDC`);
        } catch {
            logger.error("Could not seed balance tracker — minBalanceUsdc gate will be skipped until first refresh");
        }

        return bot;
    }

    /**
     * Drop WS callbacks + server subscription for a market's previous token IDs (interval rotation).
     */
    private detachMarketWebSocketFeeds(market: string): void {
        const t = this.tokenIdsByMarket[market];
        if (!t || !this.wsOrderBook) return;
        this.wsOrderBook.detachTokenSubscriptions([t.upTokenId, t.downTokenId]);
    }

    /**
     * Subscribe and register exactly one Up/Down handler pair per market (idempotent if detach was called first).
     */
    private wireMarketWebSocketFeeds(
        market: string,
        tokenIds: {
            slug: string;
            upTokenId: string;
            downTokenId: string;
            conditionId: string;
            upIdx: number;
            downIdx: number;
        }
    ): void {
        if (!this.wsOrderBook) return;
        const ws = this.wsOrderBook;
        ws.subscribeToTokenIds([tokenIds.upTokenId, tokenIds.downTokenId]);
        ws.setTokenLabel(tokenIds.upTokenId, "Up");
        ws.setTokenLabel(tokenIds.downTokenId, "Down");
        ws.onPriceUpdate(tokenIds.upTokenId, (_tokenId, price) => {
            this.handlePriceUpdate(market, tokenIds, price);
        });
        ws.onPriceUpdate(tokenIds.downTokenId, (_tokenId, price) => {
            this.handlePriceUpdate(market, tokenIds, price);
        });
    }

    async initializeWebSocket(): Promise<void> {
        try {
            this.wsOrderBook = new WebSocketOrderBook("market", [], null);
            await this.wsOrderBook.connect();
            logger.info("WebSocket orderbook initialized");
        } catch (e) {
            logger.error(`Failed to initialize WebSocket: ${e instanceof Error ? e.message : String(e)}`);
            throw e;
        }
    }

    async start(): Promise<void> {
        if (this.isStopped) {
            logger.error("Bot is stopped, cannot start");
            return;
        }

        if (!this.wsOrderBook) {
            logger.error("Fatal error: WebSocket orderbook not initialized - cannot start bot");
            return;
        }

        logger.info(
            `Starting PredictiveArbBot for markets: ${this.cfg.markets.join(", ")} (${this.cfg.marketIntervalMinutes}m Up/Down windows)`
        );
        const pa = config.predictiveArb;
        if (pa.externalSpotEnabled && this.cfg.markets.includes("btc")) {
            this.externalSpotFeed = new ExternalSpotFeed(pa.externalSpotPollMs, pa.externalSpotHistoryMs);
            this.externalSpotFeed.start();
            logger.info("External BTC spot feed (Binance) enabled for btc market");
        }
        await this.initializeMarkets();

        // Periodic summary at each interval boundary (e.g. :00,:05,:10 for 5m; :00,:15,:30,:45 for 15m)
        setInterval(() => {
            const now = new Date();
            const minutes = now.getMinutes();
            const seconds = now.getSeconds();
            const iv = this.cfg.marketIntervalMinutes;
            if (isMinuteAtIntervalBoundary(minutes, iv) && seconds < 5) {
                this.generateAllPredictionSummaries();
            }
        }, 60 * 1000);

        // Detect market slug rotation even when the orderbook is quiet
        setInterval(() => {
            this.checkAndHandleMarketCycleChanges();
        }, 10 * 1000); // Check every 10 seconds

        this.startExitMonitorLoop();
    }

    stop(): void {
        this.isStopped = true;

        if (this.exitMonitorTimer) {
            clearInterval(this.exitMonitorTimer);
            this.exitMonitorTimer = null;
        }

        // Force-generate summaries regardless of interval boundary
        logger.info("\n🛑 Generating final prediction summaries...");
        this.generateAllPredictionSummaries(true);

        if (this.externalSpotFeed) {
            this.externalSpotFeed.stop();
            this.externalSpotFeed = null;
        }
        if (this.wsOrderBook) {
            this.wsOrderBook.disconnect();
        }
        logger.info("PredictiveArbBot stopped");
    }

    private async initializeMarkets(): Promise<void> {
        for (const market of this.cfg.markets) {
            await this.initializeMarket(market);
        }
        this.pruneStaleStateRows();
    }

    /**
     * On boot, drop persisted state rows for past interval slugs so predictive-arb-state.json
     * does not grow without bound across days of uptime (each row is duplicated in RAM).
     */
    private pruneStaleStateRows(): void {
        let changed = false;
        for (const market of this.cfg.markets) {
            const currentSlug = slugForCryptoUpdown(market, this.cfg.marketIntervalMinutes);
            for (const key of Object.keys(this.state)) {
                const row = this.state[key];
                if (row?.market !== market) continue;
                if (key !== currentSlug) {
                    delete this.state[key];
                    changed = true;
                }
            }
        }
        if (changed) {
            logger.info("🧹 Pruned stale pool rows from on-disk state (frees RAM after reload)");
            saveState(this.state);
        }
    }

    private async initializeMarket(market: string): Promise<void> {
        try {
            const slug = slugForCryptoUpdown(market, this.cfg.marketIntervalMinutes);
            logger.info(`Initializing market ${market} with slug ${slug}`);
            const tokenIds = await fetchTokenIdsForSlug(slug);
            this.tokenIdsByMarket[market] = { slug, ...tokenIds };
            this.lastSlugByMarket[market] = slug;

            if (this.wsOrderBook) {
                this.wireMarketWebSocketFeeds(market, { slug, ...tokenIds });
            }

            await this.runBandwidthCheck(market, slug);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            const slug = slugForCryptoUpdown(market, this.cfg.marketIntervalMinutes);
            logger.error(`⚠️  Market ${market} not available yet (${slug}): ${errorMsg}. Will retry on next price update.`);
        }
    }

    /**
     * At the start of each pool, fetch recent BTC price range from Binance.
     * If bandwidth (max − min) is below the threshold, disable trading for this pool
     * to avoid losses in low-volatility / choppy conditions.
     */
    private async runBandwidthCheck(market: string, slug: string): Promise<void> {
        const pa = config.predictiveArb;
        if (!pa.bandwidthCheckEnabled) return;
        if (market !== "btc") return;

        try {
            const result = await fetchBtcBandwidth(pa.bandwidthLookbackMinutes);
            if (result.stale) {
                logger.warning(`[Bandwidth] Could not fetch BTC data for ${slug} — trading allowed (fail-open)`);
                return;
            }

            if (result.bandwidth < pa.bandwidthThresholdUsd) {
                this.poolTradingDisabledBySlug.add(slug);
                logger.info(
                    `⛔ [Bandwidth] TRADING DISABLED for pool ${slug} | BTC range $${result.bandwidth.toFixed(2)} < $${pa.bandwidthThresholdUsd} threshold (high=$${result.high.toFixed(2)} low=$${result.low.toFixed(2)}, last ${pa.bandwidthLookbackMinutes}min)`
                );
            } else {
                this.poolTradingDisabledBySlug.delete(slug);
                logger.info(
                    `✅ [Bandwidth] Trading ENABLED for pool ${slug} | BTC range $${result.bandwidth.toFixed(2)} >= $${pa.bandwidthThresholdUsd} threshold (high=$${result.high.toFixed(2)} low=$${result.low.toFixed(2)}, last ${pa.bandwidthLookbackMinutes}min)`
                );
            }
        } catch (e) {
            logger.warning(`[Bandwidth] Check failed for ${slug}: ${e instanceof Error ? e.message : String(e)} — trading allowed (fail-open)`);
        }
    }

    /**
     * Handle price updates from WebSocket.
     * Defers to processPrice via queueMicrotask to avoid blocking the WS message loop.
     */
    private handlePriceUpdate(
        market: string,
        tokenIds: { slug: string; upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number },
        price: TokenPrice
    ): void {
        if (this.isStopped) return;
        if (!price.bestAsk || !Number.isFinite(price.bestAsk)) return;

        // Coalesce: WS emits many best_bid_ask msgs/sec; hold the gate until processPrice completes so we
        // never overlap async runs and never queue one microtask per message (major RAM/CPU saver).
        if (this.processPriceCoalesceScheduled.has(market)) return;
        this.processPriceCoalesceScheduled.add(market);
        queueMicrotask(() => {
            void this.processPrice(market, tokenIds)
                .catch((err) => {
                    logger.error(`Unhandled error in processPrice for ${market}: ${err instanceof Error ? err.message : String(err)}`);
                })
                .finally(() => {
                    this.processPriceCoalesceScheduled.delete(market);
                });
        });
    }

    /**
     * Core price-processing pipeline.
     * Holds a per-market lock so two concurrent price ticks can't both enter the trading path.
     */
    private async processPrice(
        market: string,
        tokenIds: { slug: string; upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number }
    ): Promise<void> {
        const slug = this.getSlugForMarket(market);

        let currentTokenIds = tokenIds;
        const cachedTokenIds = this.tokenIdsByMarket[market];
        if (cachedTokenIds && cachedTokenIds.slug === slug) {
            currentTokenIds = cachedTokenIds;
        }

        const upPrice = this.wsOrderBook?.getPrice(currentTokenIds.upTokenId);
        const downPrice = this.wsOrderBook?.getPrice(currentTokenIds.downTokenId);

        if (!upPrice?.bestAsk || !downPrice?.bestAsk ||
            !Number.isFinite(upPrice.bestAsk) || !Number.isFinite(downPrice.bestAsk)) {
            return;
        }

        let upAsk = upPrice.bestAsk;
        let downAsk = downPrice.bestAsk;

        const lastPrice = this.lastProcessedPrice.get(market);
        const minDelta = config.predictiveArb.minUpPriceDelta;
        if (
            minDelta > 0 &&
            lastPrice !== undefined &&
            Math.abs(upAsk - lastPrice) < minDelta
        ) {
            return;
        }
        this.lastProcessedPrice.set(market, upAsk);

        const state = this.state;
        const k = slug;
        const row = state[k] ?? emptyRow();
        state[k] = row;

        if (!this.lastSlugByMarket[market]) {
            this.lastSlugByMarket[market] = slug;
        }

        const prevSlug = this.lastSlugByMarket[market];
        if (prevSlug && prevSlug !== slug) {
            logger.info(`🔄 New market cycle detected for ${market}: ${prevSlug} → ${slug}`);
            const completedConditionId = this.state[prevSlug]?.conditionId;
            this.generatePredictionScoreSummary(prevSlug, market);
            this.triggerAutoRedeemForCompletedSlug(market, prevSlug, completedConditionId);
            this.evictMemoryForCompletedPool(market, prevSlug);

            logger.info(`🔄 Re-initializing market ${market} with new slug ${slug}`);
            try {
                this.detachMarketWebSocketFeeds(market);
                const newTokenIds = await fetchTokenIdsForSlug(slug);
                this.tokenIdsByMarket[market] = { slug, ...newTokenIds };

                if (this.wsOrderBook) {
                    this.wireMarketWebSocketFeeds(market, { slug, ...newTokenIds });
                }

                currentTokenIds = { slug, ...newTokenIds };
                logger.info(`✅ Market ${market} re-initialized with new token IDs`);

                await this.runBandwidthCheck(market, slug);
            } catch (e) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                logger.error(`⚠️  Failed to re-initialize market ${market} with new slug ${slug}: ${errorMsg}. Will retry on next price update.`);
                return;
            }

            this.lastSlugByMarket[market] = slug;
            const predictor = this.pricePredictors.get(market);
            if (predictor) {
                predictor.reset();
            }

            const newUpPrice = this.wsOrderBook?.getPrice(currentTokenIds.upTokenId);
            const newDownPrice = this.wsOrderBook?.getPrice(currentTokenIds.downTokenId);
            if (!newUpPrice?.bestAsk || !newDownPrice?.bestAsk ||
                !Number.isFinite(newUpPrice.bestAsk) || !Number.isFinite(newDownPrice.bestAsk)) {
                return;
            }
            upAsk = newUpPrice.bestAsk;
            downAsk = newDownPrice.bestAsk;
        }

        row.conditionId = currentTokenIds.conditionId;
        row.slug = slug;
        row.market = market;
        row.upIdx = currentTokenIds.upIdx;
        row.downIdx = currentTokenIds.downIdx;
        row.lastUpdatedIso = new Date().toISOString();

        let predictor = this.pricePredictors.get(market);
        if (!predictor) {
            predictor = new AdaptivePricePredictor();
            this.pricePredictors.set(market, predictor);
        }

        const prediction = predictor.updateAndPredict(upAsk, Date.now());

        if (!prediction) {
            row.previousUpPrice = upAsk;
            return;
        }

        bumpMetric("predictionPoles");

        const now = Date.now();
        const lastVerbose = this.lastVerbosePredictionLogAt.get(market) ?? 0;
        const logPredictionVerbose =
            config.logPredictions &&
            (config.debug || now - lastVerbose >= PredictiveArbBot.PREDICTION_LOG_THROTTLE_MS);

        const lastPred = this.lastPredictions.get(market);
        if (lastPred) {
            const priceDiff = upAsk - lastPred.actualPrice;
            const actualDirection = Math.abs(priceDiff) >= 0.02
                ? (priceDiff > 0 ? "up" : "down")
                : (priceDiff >= 0 ? "up" : "down");
            const wasCorrect = lastPred.prediction.direction === actualDirection;
            const timeDiff = Date.now() - lastPred.timestamp;

            if (logPredictionVerbose) {
                logger.info(
                    `🔮 Prediction: ${lastPred.prediction.direction.toUpperCase()} (conf: ${lastPred.prediction.confidence.toFixed(2)}) | Actual: ${actualDirection.toUpperCase()} | ${wasCorrect ? "✅ CORRECT" : "❌ WRONG"} | Time: ${timeDiff}ms`
                );
            }
            this.updatePredictionScore(market, slug, lastPred.prediction, lastPred.actualPrice, upAsk, wasCorrect);
        }

        this.lastPredictions.set(market, {
            prediction,
            actualPrice: upAsk,
            timestamp: Date.now(),
        });

        if (logPredictionVerbose) {
            this.lastVerbosePredictionLogAt.set(market, now);
            logger.info(
                `🔮 PREDICT [POLE]: ${prediction.predictedPrice.toFixed(4)} (current: ${upAsk.toFixed(4)}) | Direction: ${prediction.direction.toUpperCase()} | Confidence: ${(prediction.confidence * 100).toFixed(1)}% | Signal: ${prediction.signal} | Momentum: ${prediction.features.momentum.toFixed(3)} | Vol: ${prediction.features.volatility.toFixed(3)} | Trend: ${prediction.features.trend.toFixed(3)}`
            );
        }

        // Per-market lock: prevent a second price tick from entering executePredictionTrade
        // while the first is still awaiting the CLOB API.
        if (this.tradingLock.has(market)) {
            return;
        }
        this.tradingLock.add(market);
        let didTrade = false;
        try {
            didTrade = await this.executePredictionTrade(market, slug, prediction, upAsk, downAsk, currentTokenIds, state, k, row);
        } finally {
            this.tradingLock.delete(market);
        }
        if (didTrade && config.predictiveArb.resetPriceDeltaAfterTrade) {
            this.lastProcessedPrice.delete(market);
        }

        const stats = predictor.getAccuracyStats();
        if (
            config.logPredictions &&
            stats.totalPredictions > 0 &&
            (stats.totalPredictions % 25 === 0 ||
                [10, 50, 100, 200, 500, 1000].includes(stats.totalPredictions))
        ) {
            logger.info(`📊 Prediction Accuracy: ${(stats.accuracy * 100).toFixed(1)}% (${stats.correctPredictions}/${stats.totalPredictions})`);
        }

        row.previousUpPrice = upAsk;
        saveState(state);
    }

    private getSlugForMarket(market: string): string {
        return slugForCryptoUpdown(market, this.cfg.marketIntervalMinutes);
    }

    /**
     * Periodically check for market cycle changes and handle them
     * This ensures we detect cycle changes even when there are no price updates
     */
    private async checkAndHandleMarketCycleChanges(): Promise<void> {
        if (this.isStopped) return;

        for (const market of this.cfg.markets) {
            const currentSlug = this.getSlugForMarket(market);
            if (!currentSlug) continue;

            const prevSlug = this.lastSlugByMarket[market];
            if (prevSlug && prevSlug !== currentSlug) {
                logger.info(`🔄 Market cycle change detected via periodic check for ${market}: ${prevSlug} → ${currentSlug}`);

                // Directly re-initialize to avoid duplicate work
                await this.reinitializeMarketForNewCycle(market, prevSlug, currentSlug);
            }
        }
    }

    /**
     * Re-initialize market for a new cycle
     */
    private async reinitializeMarketForNewCycle(market: string, prevSlug: string, newSlug: string): Promise<void> {
        logger.info(`🔄 Re-initializing market ${market} with new slug ${newSlug} (from periodic check)`);

        const completedConditionId = this.state[prevSlug]?.conditionId;
        this.generatePredictionScoreSummary(prevSlug, market);
        this.triggerAutoRedeemForCompletedSlug(market, prevSlug, completedConditionId);
        this.evictMemoryForCompletedPool(market, prevSlug);

        try {
            this.detachMarketWebSocketFeeds(market);
            const newTokenIds = await fetchTokenIdsForSlug(newSlug);
            this.tokenIdsByMarket[market] = { slug: newSlug, ...newTokenIds };

            if (this.wsOrderBook) {
                this.wireMarketWebSocketFeeds(market, { slug: newSlug, ...newTokenIds });
            }

            this.lastSlugByMarket[market] = newSlug;

            // Reset price predictor for new market cycle
            const predictor = this.pricePredictors.get(market);
            if (predictor) {
                predictor.reset();
            }

            // Track market start time
            const scoreKey = `${market}-${newSlug}`;
            this.marketStartTimeBySlug.set(scoreKey, Date.now());
            logger.info(`✅ Market ${market} re-initialized with new token IDs for cycle ${newSlug}`);

            await this.runBandwidthCheck(market, newSlug);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            logger.error(`⚠️  Failed to re-initialize market ${market} with new slug ${newSlug}: ${errorMsg}. Will retry on next check.`);
        }
    }

    /**
     * Drop in-memory (and persisted) data for a finished pool so the process does not
     * accumulate one state blob + maps entry per 5m window — major cause of long-run RAM growth.
     * Call only after summary + auto-redeem have read whatever they need from `state[prevSlug]`.
     */
    private evictMemoryForCompletedPool(market: string, prevSlug: string): void {
        const prevScoreKey = `${market}-${prevSlug}`;
        this.predictionScores.delete(prevScoreKey);
        this.tokenCountsByMarket.delete(prevScoreKey);
        this.pausedMarkets.delete(prevScoreKey);
        this.lastLeg1RoundAt.delete(prevScoreKey);
        this.poolTradingDisabledBySlug.delete(prevSlug);
        for (const [pid, pos] of this.openPositions) {
            if (pos.scoreKey === prevScoreKey) {
                this.openPositions.delete(pid);
            }
        }
        this.marketStartTimeBySlug.delete(prevScoreKey);
        if (this.state[prevSlug] !== undefined) {
            delete this.state[prevSlug];
            saveState(this.state);
        }
    }

    private triggerAutoRedeemForCompletedSlug(
        market: string,
        prevSlug: string,
        conditionIdHint?: string | null
    ): void {
        const conditionId = conditionIdHint ?? this.state[prevSlug]?.conditionId;
        if (!conditionId) {
            if (config.debug) {
                logger.info(`Auto-redeem skip ${market}/${prevSlug} (no conditionId)`);
            }
            this.scheduleBackgroundRecentPoolsRedeemSweep();
            return;
        }
        // Already done or already a loop is running — still sweep other recent pools in background
        if (this.redeemedConditionIds.has(conditionId)) {
            this.scheduleBackgroundRecentPoolsRedeemSweep();
            return;
        }
        if (this.redeemInProgress.has(conditionId)) {
            this.scheduleBackgroundRecentPoolsRedeemSweep();
            return;
        }

        this.redeemInProgress.add(conditionId);
        // Fire background polling loop — never awaited, runs fully in parallel
        void this.autoRedeemCompletedMarket(market, prevSlug, conditionId);
        this.scheduleBackgroundRecentPoolsRedeemSweep();
    }

    /**
     * After a pool ends, redeem any other winning positions from recent windows (async, non-blocking).
     * Same behavior as `redeem:auto --api --no-redeemable-filter --pools-within-hours <N>` with quiet logs.
     */
    private scheduleBackgroundRecentPoolsRedeemSweep(): void {
        const hours = config.predictiveArb.autoRedeemSweepHours;
        if (hours <= 0) return;
        void this.runBackgroundRecentPoolsRedeemSweep(hours);
    }

    private async runBackgroundRecentPoolsRedeemSweep(sweepHours: number): Promise<void> {
        if (this.apiRedeemSweepRunning) return;
        this.apiRedeemSweepRunning = true;
        try {
            const stagger = Math.max(0, config.predictiveArb.redeemSweepDelayMs);
            if (stagger > 0) {
                await new Promise<void>((r) => setTimeout(r, stagger));
            } else {
                await new Promise<void>((r) => setImmediate(r));
            }
            logger.info(
                `[AutoRedeem] background API sweep starting (last ${sweepHours}h pools; async, does not block trading)`
            );
            const res = await redeemAllWinningMarketsFromAPI({
                maxMarkets: 250,
                dryRun: false,
                poolsEndedWithinHours: sweepHours,
                redeemablePositionsOnly: false,
                quiet: true,
            });
            if (res.redeemed > 0 || res.failed > 0) {
                logger.info(
                    `[AutoRedeem] background sweep done: redeemed=${res.redeemed} failed=${res.failed} winners=${res.withWinningTokens}`
                );
            }
            for (const row of res.results) {
                if (row.redeemed) {
                    this.redeemedConditionIds.add(row.conditionId);
                }
            }
            this.trimRedeemedConditionIds();
        } catch (e) {
            logger.error(
                `[AutoRedeem] background sweep error: ${e instanceof Error ? e.message : String(e)}`
            );
        } finally {
            this.apiRedeemSweepRunning = false;
        }
    }

    /**
     * Redeem **only** the completed pool identified by `conditionId` (from `state[prevSlug]`).
     * Does not scan all holdings or Polymarket `/positions` — calls `redeemMarket` with
     * `poolRedeemOnly` so on-chain balance checks are limited to binary indexSets 1–2.
     * Poll interval / max wait from config (defaults tuned for speed). Never awaited by the trading loop.
     */
    private async autoRedeemCompletedMarket(
        market: string,
        prevSlug: string,
        conditionId: string
    ): Promise<void> {
        const RETRY_INTERVAL_MS = Math.max(2_000, config.predictiveArb.poolRedeemPollMs);
        const MAX_WAIT_MS = Math.max(RETRY_INTERVAL_MS, config.predictiveArb.poolRedeemMaxWaitMs);
        const NOT_RESOLVED_LOG_THROTTLE_MS = 45_000;
        const startedAt = Date.now();
        let lastNotResolvedLogAt = 0;

        if (config.debug) {
            logger.info(
                `[AutoRedeem] loop ${market}/${prevSlug} (${conditionId.slice(0, 10)}…) retry every ${RETRY_INTERVAL_MS / 1000}s`
            );
        }

        try {
            while (Date.now() - startedAt < MAX_WAIT_MS) {
                try {
                    const receipt = await redeemMarket(conditionId, undefined, 3, {
                        quiet: true,
                        poolRedeemOnly: true,
                        txRetryInitialDelayMs: config.predictiveArb.poolRedeemTxRetryInitialMs,
                    });
                    this.redeemedConditionIds.add(conditionId);
                    this.trimRedeemedConditionIds();
                    const txHash =
                        (receipt && typeof (receipt as any).hash === "string" && (receipt as any).hash) ||
                        (receipt && typeof (receipt as any).transactionHash === "string" && (receipt as any).transactionHash) ||
                        "";
                    logger.info(
                        `✅ Redeem OK ${prevSlug} | tx=${txHash ? String(txHash).slice(0, 14) + "…" : "n/a"}`
                    );
                    return;
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    const waitedSec = Math.round((Date.now() - startedAt) / 1000);

                    if (/don't hold any winning tokens/i.test(msg) || /don't have any tokens/i.test(msg)) {
                        // We held the losing side — nothing to redeem, mark done so we never retry
                        logger.info(`ℹ️ Redeem skip ${prevSlug} — no winning tokens`);
                        this.redeemedConditionIds.add(conditionId);
                        this.trimRedeemedConditionIds();
                        return;
                    }

                    if (/not yet resolved/i.test(msg)) {
                        const t = Date.now();
                        if (config.debug || t - lastNotResolvedLogAt >= NOT_RESOLVED_LOG_THROTTLE_MS) {
                            lastNotResolvedLogAt = t;
                            logger.info(
                                `⏳ Redeem wait ${prevSlug} (market not resolved yet, ${waitedSec}s) — retry ${RETRY_INTERVAL_MS / 1000}s`
                            );
                        }
                    } else {
                        if (config.logPredictions || config.debug) {
                            logger.warning(
                                `⚠️ Redeem retry ${prevSlug} (${waitedSec}s): ${msg.slice(0, 120)}`
                            );
                        }
                    }

                    await new Promise<void>(r => setTimeout(r, RETRY_INTERVAL_MS));
                }
            }

            logger.warning(
                `⌛ Redeem gave up ${prevSlug} after ${MAX_WAIT_MS / 60_000} min — run npm run redeem:auto if needed`
            );
        } finally {
            this.redeemInProgress.delete(conditionId);
        }
    }

    private extractOrderId(response: any): string | undefined {
        return (
            response?.orderID ??
            response?.orderId ??
            response?.id ??
            response?.data?.orderID ??
            response?.data?.orderId ??
            response?.order?.id ??
            response?.data?.id ??
            response?.data?.order?.id
        );
    }

    private getOrderPostError(response: any): string | undefined {
        if (!response || typeof response !== "object") return undefined;
        const status = (response as any).status;
        if ((response as any).success === false) {
            const msg = (response as any).errorMsg || (response as any).error || "order post failed";
            return status ? `status=${status} ${msg}` : String(msg);
        }

        if ("error" in response) {
            const rawError = (response as any).error;
            const msg =
                typeof rawError === "string"
                    ? rawError
                    : rawError?.error ||
                      rawError?.message ||
                      JSON.stringify(rawError);
            return status ? `status=${status} ${msg}` : msg;
        }

        return undefined;
    }

    private shortResponse(response: any): string {
        try {
            const s = JSON.stringify(response);
            return s.length > 240 ? `${s.slice(0, 240)}...` : s;
        } catch {
            return String(response);
        }
    }

    private clampLimitPrice(price: number): number {
        // CLOB orders must remain strictly inside [tickSize, 1 - tickSize].
        // We clamp here so extreme asks (e.g. 0.99 + 0.01) do not create invalid orders.
        const tick = parseFloat(this.cfg.tickSize as string) || 0.01;
        const min = tick;
        const max = 1 - tick;
        if (!Number.isFinite(price)) return min;
        return Math.min(max, Math.max(min, price));
    }

    /** Leg-1 limit matches `buyFirstSide`: best ask + one tick, clamped. */
    private leg1LimitFromAsk(askPrice: number): number {
        const tick = parseFloat(this.cfg.tickSize as string) || 0.01;
        return this.clampLimitPrice(askPrice + tick);
    }

    private isLikelyAcceptedWithoutOrderId(response: any): boolean {
        if (!response || typeof response !== "object") return false;
        if ((response as any).success === true) return true;
        const status = String((response as any).status || "").toLowerCase();
        return status === "live" || status === "matched" || status === "pending";
    }

    private async waitForOrderFilled(orderID: string): Promise<boolean> {
        const maxAttempts = Math.max(5, config.predictiveArb.leg1FillMaxAttempts);
        const pollIntervalMs = Math.max(50, config.predictiveArb.leg1FillPollMs);
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            try {
                const order = await this.client.getOrder(orderID);
                if (order?.status === "FILLED") {
                    return true;
                }
                if (order?.status === "CANCELLED" || order?.status === "REJECTED") {
                    return false;
                }
            } catch {
                // Keep polling; order may not be queryable immediately after post.
            }
        }
        return false;
    }

    /**
     * Place first-side limit buy with one retry on transient failure.
     * Limit price is best-ask + one tick (matches the configured tickSize).
     * Returns order metadata so caller can gate leg-2 on leg-1 fill.
     */
    private async buyFirstSide(
        leg: "YES" | "NO",
        tokenID: string,
        askPrice: number,
        size: number
    ): Promise<{ accepted: boolean; orderID?: string }> {
        const tick = parseFloat(this.cfg.tickSize as string) || 0.01;
        const rawLimitPrice = askPrice + tick;
        const limitPrice = this.clampLimitPrice(rawLimitPrice);
        const orderAmount = limitPrice * size;

        const limitOrder: UserOrder = {
            tokenID,
            side: Side.BUY,
            price: limitPrice,
            size,
        };

        if (config.logPredictions) {
            logger.info(`BUY: ${leg} ${size} shares @ limit ${limitPrice.toFixed(4)} (${orderAmount.toFixed(2)} USDC)`);
        }

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const response = await this.client.createAndPostOrder(
                    limitOrder,
                    { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk },
                    OrderType.GTC
                );

                const postError = this.getOrderPostError(response);
                if (postError) {
                    throw new Error(postError);
                }

                const orderID = this.extractOrderId(response);
                if (!orderID) {
                    if (this.isLikelyAcceptedWithoutOrderId(response)) {
                        if (config.logPredictions) {
                            logger.info(`✅ First-Side Order accepted for ${leg} (response had no orderID)`);
                        } else {
                            logger.info(`✅ Buy ${leg} (accepted, no orderID)`);
                        }
                        bumpMetric("firstSideOrdersPlaced");
                        return { accepted: true };
                    }
                    logger.error(
                        `BUY failed for ${leg} - no orderID returned (attempt ${attempt}) response=${this.shortResponse(response)}`
                    );
                    if (attempt < 2) continue;
                    return { accepted: false };
                }
                if (config.logPredictions) {
                    logger.info(`✅ First-Side Order placed: ${leg} orderID ${orderID.substring(0, 10)}... @ ${limitPrice.toFixed(4)}`);
                } else {
                    logger.info(`✅ Buy ${leg} order=${orderID.substring(0, 10)}… @ ${limitPrice.toFixed(4)}`);
                }
                bumpMetric("firstSideOrdersPlaced");
                return { accepted: true, orderID };
            } catch (e) {
                logger.error(`BUY failed for ${leg} (attempt ${attempt}): ${e instanceof Error ? e.message : String(e)}`);
                if (attempt < 2) {
                    await new Promise(r => setTimeout(r, 200));
                }
            }
        }
        return { accepted: false };
    }

    /**
     * Execute prediction-based trading strategy.
     * First-side must succeed before second-side is placed.
     * Balance is checked before committing capital.
     * @returns true if a full leg-1+leg-2 round completed (caller may reset price-delta throttle).
     */
    private async executePredictionTrade(
        market: string,
        slug: string,
        prediction: PricePrediction,
        upAsk: number,
        downAsk: number,
        tokenIds: { upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number },
        state: SimpleStateFile,
        k: string,
        row: SimpleStateRow
    ): Promise<boolean> {
        if (this.poolTradingDisabledBySlug.has(slug)) {
            return false;
        }

        const scoreKey = `${market}-${slug}`;
        if (!this.predictionScores.has(scoreKey)) {
            this.predictionScores.set(scoreKey, {
                market,
                slug,
                startTime: Date.now(),
                endTime: null,
                upTokenCost: 0,
                downTokenCost: 0,
                upTokenCount: 0,
                downTokenCount: 0,
                totalPredictions: 0,
                correctPredictions: 0,
                trades: [],
            });
            if (!this.marketStartTimeBySlug.has(scoreKey)) {
                this.marketStartTimeBySlug.set(scoreKey, Date.now());
            }
        }

        const score = this.predictionScores.get(scoreKey)!;

        const pa = config.predictiveArb;
        if (pa.maxRoundsPerPool > 0 && score.trades.length >= pa.maxRoundsPerPool) {
            return false;
        }
        if (pa.minMsBetweenLeg1 > 0) {
            const t = this.lastLeg1RoundAt.get(scoreKey);
            if (t !== undefined && Date.now() - t < pa.minMsBetweenLeg1) {
                return false;
            }
        }
        let minConfidenceForTrade = pa.minConfidenceForTrade;
        let spotBypassPoolDelay = false;

        if (pa.externalSpotEnabled && market === "btc" && this.externalSpotFeed) {
            const mom = this.externalSpotFeed.getMomentumBps(pa.externalSpotWindowMs);
            if (!mom.stale) {
                const upTh = pa.externalSpotBpsUp;
                const downTh = pa.externalSpotBpsDown;
                const bypassBps = pa.externalSpotBypassPoolDelayBps;
                let aligned = false;
                if (prediction.direction === "up" && mom.bps >= upTh) aligned = true;
                else if (prediction.direction === "down" && mom.bps <= -downTh) aligned = true;

                if (aligned) {
                    minConfidenceForTrade = Math.max(0.15, minConfidenceForTrade - pa.externalSpotConfidenceRelax);
                    if (bypassBps > 0 && Math.abs(mom.bps) >= bypassBps) {
                        spotBypassPoolDelay = true;
                    }
                }
            }
        }

        if (prediction.confidence < minConfidenceForTrade) {
            return false;
        }

        if (prediction.signal === "HOLD") {
            return false;
        }

        let buyToken: "UP" | "DOWN" | null = null;
        let buyPrice = 0;
        let tokenId = "";

        if (prediction.direction === "up") {
            buyToken = "UP";
            buyPrice = upAsk;
            tokenId = tokenIds.upTokenId;
        } else if (prediction.direction === "down") {
            buyToken = "DOWN";
            buyPrice = downAsk;
            tokenId = tokenIds.downTokenId;
        }

        if (!buyToken) return false;

        if (this.pausedMarkets.has(scoreKey)) {
            return false;
        }

        const poolStartSec = slotStartUnixSeconds(this.cfg.marketIntervalMinutes);
        const poolStartMs = poolStartSec * 1000;
        const intervalMs = this.cfg.marketIntervalMinutes * 60 * 1000;
        const poolEndMs = poolStartMs + intervalMs;

        // --- Rule: no trading until COPYTRADE_POOL_TRADE_DELAY_SECS after pool start (optional bypass via external spot) ---
        const poolTradeDelaySecs = pa.poolTradeDelaySecs;
        if (poolTradeDelaySecs > 0 && !spotBypassPoolDelay) {
            const elapsed = Date.now() - poolStartMs;
            if (elapsed < poolTradeDelaySecs * 1000) {
                return false;
            }
        }

        // --- Stop new leg-1 when the pool is about to end (no time for hedge) ---
        const stopBeforeEndMs = config.predictiveArb.stopNewTradesMsBeforePoolEnd;
        if (stopBeforeEndMs > 0 && Date.now() >= poolEndMs - stopBeforeEndMs) {
            return false;
        }

        const maxBidAskSum = config.predictiveArb.maxBidAskSum;
        if (maxBidAskSum > 0 && upAsk + downAsk > maxBidAskSum) {
            return false;
        }

        // --- Rule: minimum buy price threshold ---
        const minBuyPrice = config.predictiveArb.minBuyPrice;
        if (minBuyPrice > 0 && buyPrice <= minBuyPrice) {
            return false;
        }

        const maxLeg1Ask = config.predictiveArb.maxLeg1Ask;
        if (maxLeg1Ask > 0 && buyPrice > maxLeg1Ask) {
            return false;
        }

        const leg1LimitPrice = this.leg1LimitFromAsk(buyPrice);
        const pairSumPreview = this.computeHedgePairSum(leg1LimitPrice);
        const rawLeg2Limit = pairSumPreview - leg1LimitPrice;
        const minLeg2Limit = config.predictiveArb.minLeg2Limit;
        if (minLeg2Limit > 0 && rawLeg2Limit < minLeg2Limit) {
            return false;
        }

        const tick = parseFloat(this.cfg.tickSize as string) || 0.01;

        let tokenCounts = this.tokenCountsByMarket.get(scoreKey);
        if (!tokenCounts) {
            tokenCounts = { upTokenCount: 0, downTokenCount: 0 };
            this.tokenCountsByMarket.set(scoreKey, tokenCounts);
        }

        const side: "up" | "down" = buyToken === "UP" ? "up" : "down";
        if (isSideCapReached(this.MAX_BUY_COUNTS_PER_SIDE, side, tokenCounts.upTokenCount, tokenCounts.downTokenCount)) {
            logger.info(
                `⛔ LIMIT REACHED: ${buyToken} count is ${side === "up" ? tokenCounts.upTokenCount : tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE || "∞"} - skipping trade`
            );
            return false;
        }

        const maxValidPrice = 1 - tick;
        if (buyPrice >= maxValidPrice) {
            logger.info(
                `⏭️  Skipping ${buyToken} first-side buy at extreme ask ${buyPrice.toFixed(4)} (max allowed < ${maxValidPrice.toFixed(4)})`
            );
            return false;
        }

        const buyCost = leg1LimitPrice * this.cfg.sharesPerSide;
        const estPairCost = pairSumPreview * this.cfg.sharesPerSide;
        const limitLabel = this.MAX_BUY_COUNTS_PER_SIDE > 0 ? String(this.MAX_BUY_COUNTS_PER_SIDE) : "unlimited";

        await this.refreshBalanceEstimate();

        // Enforce minimum balance before placing any order
        if (this.cfg.minBalanceUsdc > 0 && this.lastKnownBalance < this.cfg.minBalanceUsdc) {
            logger.error(`⛔ Balance gate: estimated available ${this.lastKnownBalance.toFixed(2)} USDC < min ${this.cfg.minBalanceUsdc} USDC - skipping trade`);
            return false;
        }

        if (this.lastKnownBalance < estPairCost) {
            logger.error(
                `⛔ Balance gate: need ~${estPairCost.toFixed(2)} USDC for full hedge (pair≈${pairSumPreview.toFixed(4)} × ${this.cfg.sharesPerSide} sh) but have ~${this.lastKnownBalance.toFixed(2)} USDC — skipping`
            );
            return false;
        }

        logger.info(
            `🎯 BUY ${buyToken} ask ${buyPrice.toFixed(4)} → limit ${leg1LimitPrice.toFixed(4)} | leg1 ~${buyCost.toFixed(2)} USDC | hedge cap ~${estPairCost.toFixed(2)} USDC | balance ~${this.lastKnownBalance.toFixed(2)} USDC | UP ${tokenCounts.upTokenCount}/${limitLabel} DOWN ${tokenCounts.downTokenCount}/${limitLabel}`
        );

        const firstSideOrder = await this.buyFirstSide(
            buyToken === "UP" ? "YES" : "NO",
            tokenId,
            buyPrice,
            this.cfg.sharesPerSide
        );

        if (!firstSideOrder.accepted) {
            logger.error(`❌ First-side order failed for ${buyToken} - skipping second-side`);
            return false;
        }

        // Leg-2 must fire only after leg-1 is complete (filled), not merely accepted.
        if (firstSideOrder.orderID) {
            const firstSideFilled = await this.waitForOrderFilled(firstSideOrder.orderID);
            if (!firstSideFilled) {
                logger.warning(
                    `⏭️  First-side ${buyToken} order ${firstSideOrder.orderID.substring(0, 10)}… not filled in time - skipping second-side`
                );
                return false;
            }
        } else {
            // If exchange accepted without orderID, we cannot reliably verify fill status.
            logger.warning(`⏭️  First-side ${buyToken} accepted without orderID - cannot confirm fill, skipping second-side`);
            return false;
        }

        // Increment counts only after confirmed placement
        score.totalPredictions++;
        if (buyToken === "UP") {
            tokenCounts.upTokenCount++;
            score.upTokenCount++;
            score.upTokenCost += buyCost;
        } else {
            tokenCounts.downTokenCount++;
            score.downTokenCount++;
            score.downTokenCost += buyCost;
        }

        // Deduct estimated cost from local balance tracker
        this.lastKnownBalance = Math.max(0, this.lastKnownBalance - buyCost);

        const poolEndMsForExit =
            slotStartUnixSeconds(this.cfg.marketIntervalMinutes) * 1000 +
            this.cfg.marketIntervalMinutes * 60 * 1000;
        const openPositionId = `${scoreKey}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        this.openPositions.set(openPositionId, {
            market,
            slug,
            scoreKey,
            buyToken,
            tokenId,
            buyPrice: leg1LimitPrice,
            shares: this.cfg.sharesPerSide,
            buyCost,
            leg2OrderId: undefined,
            poolEndMs: poolEndMsForExit,
            createdAt: Date.now(),
        });

        // Place second-side limit order (only after first-side confirmed)
        const leg2OrderId = await this.placeSecondSideLimitOrder(
            buyToken,
            leg1LimitPrice,
            tokenIds,
            market,
            slug,
            scoreKey,
            tokenCounts,
            openPositionId
        );
        const opRow = this.openPositions.get(openPositionId);
        if (opRow && leg2OrderId) {
            opRow.leg2OrderId = leg2OrderId;
        }

        score.trades.push({
            prediction: prediction.direction,
            predictedPrice: prediction.predictedPrice,
            actualPrice: buyPrice,
            buyToken,
            buyPrice,
            buyCost,
            timestamp: Date.now(),
            wasCorrect: null,
        });

        // Persist state after successful trade
        saveState(this.state);

        if (isMarketFullyPaused(this.MAX_BUY_COUNTS_PER_SIDE, tokenCounts.upTokenCount, tokenCounts.downTokenCount)) {
            this.pausedMarkets.add(scoreKey);
            logger.info(`⏸️  Market ${scoreKey} PAUSED: Reached limit (UP: ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, DOWN: ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE})`);
        }

        this.lastLeg1RoundAt.set(scoreKey, Date.now());
        maybeLogMetricsSummary();
        return true;
    }

    /** Periodic poll: near pool end, sell unhedged leg-1 if best bid implies likely loser. */
    private startExitMonitorLoop(): void {
        const pa = config.predictiveArb;
        if (!pa.exitEnabled) {
            logger.info("Pool-end exit monitor disabled (COPYTRADE_EXIT_ENABLED=false)");
            return;
        }
        const pollMs = Math.max(500, pa.exitMonitorPollMs);
        this.exitMonitorTimer = setInterval(() => {
            void this.tickExitMonitor().catch((err) => {
                logger.error(`Exit monitor error: ${err instanceof Error ? err.message : String(err)}`);
            });
        }, pollMs);
        logger.info(
            `Pool-end exit monitor on (every ${pollMs}ms, last ${pa.exitWindowSecs}s of pool; factor=${pa.exitPriceFactor}, abs<${pa.exitAbsoluteThreshold || "off"})`
        );
    }

    private async tickExitMonitor(): Promise<void> {
        if (this.isStopped || !config.predictiveArb.exitEnabled) return;
        if (!this.wsOrderBook || this.openPositions.size === 0) return;

        const pa = config.predictiveArb;
        const exitWindowMs = Math.max(1, pa.exitWindowSecs) * 1000;
        const now = Date.now();
        const tick = parseFloat(this.cfg.tickSize as string) || 0.01;

        for (const [positionId, pos] of [...this.openPositions.entries()]) {
            if (this.exitInFlight.has(positionId)) continue;

            const msToEnd = pos.poolEndMs - now;
            if (msToEnd > exitWindowMs) continue;
            if (msToEnd <= 0) continue;

            const px = this.wsOrderBook.getPrice(pos.tokenId);
            const bestBid = px?.bestBid;
            if (bestBid === null || bestBid === undefined || !Number.isFinite(bestBid) || bestBid < tick) {
                continue;
            }

            const relTrigger = pa.exitPriceFactor > 0 && bestBid < pos.buyPrice * pa.exitPriceFactor;
            const absTrigger =
                pa.exitAbsoluteThreshold > 0 && bestBid < pa.exitAbsoluteThreshold;
            if (!relTrigger && !absTrigger) continue;

            await this.attemptExitUnhedgedPosition(positionId, pos, bestBid);
        }
    }

    /**
     * Cancel pending leg-2 (if any), then market-sell leg-1 with FAK.
     */
    private async attemptExitUnhedgedPosition(
        positionId: string,
        pos: OpenPosition,
        referenceBid: number
    ): Promise<void> {
        if (this.exitInFlight.has(positionId)) return;
        if (!this.openPositions.has(positionId)) return;
        if (this.isStopped) return;

        this.exitInFlight.add(positionId);
        try {
            if (!this.openPositions.has(positionId)) return;

            if (pos.leg2OrderId) {
                try {
                    await this.client.cancelOrder({ orderID: pos.leg2OrderId });
                } catch (e) {
                    logger.warning(
                        `Exit: cancel leg-2 ${pos.leg2OrderId.substring(0, 10)}… failed (may already be filled): ${e instanceof Error ? e.message : String(e)}`
                    );
                }
                try {
                    const leg2 = await this.client.getOrder(pos.leg2OrderId);
                    if (leg2?.status === "FILLED") {
                        this.openPositions.delete(positionId);
                        return;
                    }
                } catch {
                    // ignore
                }
            }

            const pa = config.predictiveArb;
            const marketOrder: UserMarketOrder = {
                tokenID: pos.tokenId,
                side: Side.SELL,
                amount: pos.shares,
            };
            const exitTick = parseFloat(this.cfg.tickSize as string) || 0.01;
            if (pa.exitSellDiscount > 0 && referenceBid > pa.exitSellDiscount + exitTick) {
                marketOrder.price = this.clampLimitPrice(referenceBid - pa.exitSellDiscount);
            }

            const response = await this.client.createAndPostMarketOrder(
                marketOrder,
                { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk },
                OrderType.FAK
            );

            const ok =
                response &&
                typeof response === "object" &&
                (response as { success?: boolean }).success === true;

            if (ok) {
                const approxRecovery = referenceBid * pos.shares;
                logger.info(
                    `🛟 EXIT unhedged ${pos.buyToken} | bid≈${referenceBid.toFixed(4)} vs paid≈${pos.buyPrice.toFixed(4)} | ~${approxRecovery.toFixed(2)} USDC recovery on ${pos.shares} sh | pool ends in ${Math.round((pos.poolEndMs - Date.now()) / 1000)}s`
                );

                const tc = this.tokenCountsByMarket.get(pos.scoreKey);
                if (tc) {
                    if (pos.buyToken === "UP") {
                        tc.upTokenCount = Math.max(0, tc.upTokenCount - 1);
                    } else {
                        tc.downTokenCount = Math.max(0, tc.downTokenCount - 1);
                    }
                }
                const score = this.predictionScores.get(pos.scoreKey);
                if (score) {
                    if (pos.buyToken === "UP") {
                        score.upTokenCount = Math.max(0, score.upTokenCount - 1);
                    } else {
                        score.downTokenCount = Math.max(0, score.downTokenCount - 1);
                    }
                }

                bumpMetric("poolEndExitSells");
                this.openPositions.delete(positionId);
                await this.refreshBalanceEstimate(true);
            } else {
                const errMsg =
                    (response && typeof response === "object" && (response as { error?: string }).error) ||
                    this.shortResponse(response);
                logger.error(`❌ Pool-end exit sell failed for ${pos.buyToken}: ${errMsg}`);
            }
        } catch (e) {
            logger.error(`❌ Pool-end exit error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.exitInFlight.delete(positionId);
        }
    }

    /**
     * Target pair cost (leg1 + leg2) for the hedge. Lower = more profit per share if both fill.
     * Dynamic mode: expensive leg-1 → shave pair-sum (more edge); cheap leg-1 → add a little (leg-2 fills more often).
     */
    private computeHedgePairSum(firstSidePrice: number): number {
        let pairSum = Math.min(0.995, Math.max(0.88, config.predictiveArb.hedgePairSum));
        if (config.predictiveArb.hedgeDynamicAdjust) {
            if (firstSidePrice >= 0.6) {
                pairSum = Math.max(0.88, pairSum - 0.012);
            } else if (firstSidePrice <= 0.42) {
                pairSum = Math.min(0.995, pairSum + 0.008);
            }
        }
        const bias = Math.min(0.03, Math.max(0, config.predictiveArb.hedgeProfitBias));
        pairSum -= bias;
        return Math.min(0.995, Math.max(0.88, pairSum));
    }

    /**
     * Place limit order for second side (opposite token) at hedgePairSum − firstSidePrice.
     * @returns leg-2 CLOB order id when known (for cancel on pool-end exit).
     */
    private async placeSecondSideLimitOrder(
        firstSide: "UP" | "DOWN",
        firstSidePrice: number,
        tokenIds: { upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number },
        market: string,
        slug: string,
        scoreKey: string,
        tokenCounts: { upTokenCount: number; downTokenCount: number },
        openPositionId: string
    ): Promise<string | undefined> {
        // Determine opposite side
        const oppositeSide = firstSide === "UP" ? "DOWN" : "UP";
        const oppositeTokenId = firstSide === "UP" ? tokenIds.downTokenId : tokenIds.upTokenId;

        // CRITICAL: Check if market is paused FIRST
        if (this.pausedMarkets.has(scoreKey)) {
            return undefined; // Market is paused, don't place limit orders
        }

        const pairSum = this.computeHedgePairSum(firstSidePrice);
        const rawLimitPrice = pairSum - firstSidePrice;
        const limitPrice = this.clampLimitPrice(rawLimitPrice);

        if (config.debug) {
            const edge = 1 - pairSum;
            logger.info(
                `[Hedge] pairSum=${pairSum.toFixed(4)} leg1=${firstSidePrice.toFixed(4)} leg2→${limitPrice.toFixed(4)} edge≈${(edge * 100).toFixed(2)}¢/share`
            );
        }

        // Ensure limit price is valid (between 0 and 1)
        if (limitPrice <= 0 || limitPrice >= 1) {
            logger.error(`⚠️  Invalid limit price calculated: ${limitPrice.toFixed(4)} (from first side price ${firstSidePrice.toFixed(4)})`);
            return undefined;
        }

        const limitOrder: UserOrder = {
            tokenID: oppositeTokenId,
            side: Side.BUY,
            price: limitPrice,
            size: this.cfg.sharesPerSide,
        };
        const limitLabel = this.MAX_BUY_COUNTS_PER_SIDE > 0 ? String(this.MAX_BUY_COUNTS_PER_SIDE) : "unlimited";

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                // Place order IMMEDIATELY (await to ensure it's placed within 50ms of first order)
                const response = await this.client.createAndPostOrder(
                    limitOrder,
                    { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk },
                    OrderType.GTC // Good-Till-Cancel for limit orders
                );

                const postError = this.getOrderPostError(response);
                if (postError) {
                    throw new Error(postError);
                }

                const orderID = this.extractOrderId(response);
                // Log second-side limit order placement clearly with limit info
                const limitCost = limitPrice * this.cfg.sharesPerSide;
                if (orderID) {
                    bumpMetric("secondSideOrdersPlaced");
                    if (config.logPredictions) {
                        logger.info(
                            `📋 SECOND-SIDE Limit Order: ${oppositeSide} @ ${limitPrice.toFixed(4)} (${limitCost.toFixed(2)} USDC) | First-Side: ${firstSide} @ ${firstSidePrice.toFixed(4)} | Current: UP ${tokenCounts.upTokenCount}/${limitLabel}, DOWN ${tokenCounts.downTokenCount}/${limitLabel} | Limit: ${limitLabel} per side | OrderID: ${orderID.substring(0, 10)}...`
                        );
                    } else {
                        logger.info(
                            `📋 Hedge ${oppositeSide} @ ${limitPrice.toFixed(4)} (${limitCost.toFixed(2)} USDC) | id=${orderID.substring(0, 10)}…`
                        );
                    }
                    // Track second-side limit so fills update score (downTokenCost/upTokenCost and counts)
                    const leg = oppositeSide === "UP" ? "YES" : "NO";
                    this.trackLimitOrderAsync(
                        orderID,
                        leg,
                        oppositeTokenId,
                        tokenIds.conditionId,
                        this.cfg.sharesPerSide,
                        limitPrice,
                        market,
                        slug,
                        tokenIds.upIdx,
                        tokenIds.downIdx,
                        scoreKey,
                        tokenCounts,
                        openPositionId
                    ).catch(() => { /* fire-and-forget */ });
                    return orderID;
                }

                if (this.isLikelyAcceptedWithoutOrderId(response)) {
                    bumpMetric("secondSideOrdersPlaced");
                    if (config.logPredictions) {
                        logger.info(
                            `📋 SECOND-SIDE Limit Order accepted: ${oppositeSide} @ ${limitPrice.toFixed(4)} (${limitCost.toFixed(2)} USDC) | First-Side: ${firstSide} @ ${firstSidePrice.toFixed(4)} | Current: UP ${tokenCounts.upTokenCount}/${limitLabel}, DOWN ${tokenCounts.downTokenCount}/${limitLabel} | Limit: ${limitLabel} per side | OrderID: n/a`
                        );
                    } else {
                        logger.info(`📋 Hedge ${oppositeSide} @ ${limitPrice.toFixed(4)} (accepted, no id)`);
                    }
                    return undefined;
                }

                logger.error(
                    `⚠️ Second-side placement returned no orderID (attempt ${attempt}) response=${this.shortResponse(response)}`
                );
                if (attempt < 2) {
                    await new Promise(r => setTimeout(r, 200));
                }
            } catch (e) {
                logger.error(`❌ Failed to place limit order for ${oppositeSide} token (attempt ${attempt}): ${e instanceof Error ? e.message : String(e)}`);
                if (attempt < 2) {
                    await new Promise(r => setTimeout(r, 200));
                }
            }
        }
        return undefined;
    }

    /**
     * Track limit order asynchronously and update token counts when filled
     */
    private async trackLimitOrderAsync(
        orderID: string,
        leg: "YES" | "NO",
        tokenID: string,
        conditionId: string,
        estimatedShares: number,
        limitPrice: number,
        market: string,
        slug: string,
        upIdx: number,
        downIdx: number,
        scoreKey: string,
        tokenCounts: { upTokenCount: number; downTokenCount: number },
        openPositionId?: string
    ): Promise<void> {
        try {
            // Optimized polling with exponential backoff
            let attempts = 0;
            const maxAttempts = Math.max(5, config.predictiveArb.leg1FillMaxAttempts);
            let pollInterval = Math.max(50, config.predictiveArb.leg1FillPollMs);
            const maxInterval = 3000; // Max 3 seconds between checks

            while (attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));
                attempts++;

                try {
                    const order = await this.client.getOrder(orderID);

                    if (order && order.status === "FILLED") {
                        if (openPositionId) {
                            this.openPositions.delete(openPositionId);
                        }
                        // CRITICAL: Check limit BEFORE incrementing to prevent exceeding limit
                        // This prevents race conditions where multiple limit orders fill simultaneously
                        const wouldExceedLimit = limitFillWouldExceedCap(
                            this.MAX_BUY_COUNTS_PER_SIDE,
                            leg,
                            tokenCounts.upTokenCount,
                            tokenCounts.downTokenCount
                        );

                        if (wouldExceedLimit) {
                            logger.error(`⚠️  Limit order ${orderID} filled but would exceed limit - cancelling count update (${leg}: ${leg === "YES" ? tokenCounts.upTokenCount : tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE})`);
                            return; // Don't increment count if it would exceed limit
                        }

                        // Order filled - update token counts
                        const fillCost = limitPrice * estimatedShares;
                        this.lastKnownBalance = Math.max(0, this.lastKnownBalance - fillCost);
                        const limitLabel = this.MAX_BUY_COUNTS_PER_SIDE > 0 ? String(this.MAX_BUY_COUNTS_PER_SIDE) : "unlimited";

                        if (leg === "YES") {
                            tokenCounts.upTokenCount++;
                            const score = this.predictionScores.get(scoreKey);
                            if (score) {
                                score.upTokenCost += fillCost;
                                score.upTokenCount++;
                            }
                        } else {
                            tokenCounts.downTokenCount++;
                            const score = this.predictionScores.get(scoreKey);
                            if (score) {
                                score.downTokenCost += fillCost;
                                score.downTokenCount++;
                            }
                        }

                        if (config.logPredictions) {
                            logger.info(
                                `✅ Limit order filled: ${leg} @ ${limitPrice.toFixed(4)} | UP ${tokenCounts.upTokenCount}/${limitLabel}, DOWN ${tokenCounts.downTokenCount}/${limitLabel}`
                            );
                        } else {
                            logger.info(`✅ Hedge filled ${leg} @ ${limitPrice.toFixed(4)} | balance ~${this.lastKnownBalance.toFixed(2)} USDC`);
                        }

                        // Check if we've reached the limit after this fill
                        if (isMarketFullyPaused(this.MAX_BUY_COUNTS_PER_SIDE, tokenCounts.upTokenCount, tokenCounts.downTokenCount)) {
                            this.pausedMarkets.add(scoreKey);
                            logger.info(`⏸️  Market ${scoreKey} PAUSED after limit order fill: UP: ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, DOWN: ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}`);
                        }

                        return; // Order filled, stop tracking
                    } else if (order && (order.status === "CANCELLED" || order.status === "REJECTED")) {
                        return; // Order cancelled/rejected, stop tracking silently
                    }
                } catch (e) {
                    // Order might not be found yet, continue polling with backoff
                    // Increase interval gradually (exponential backoff)
                    if (pollInterval < maxInterval) {
                        pollInterval = Math.min(pollInterval * 1.5, maxInterval);
                    }
                    // Silent polling - no logging to reduce noise
                }
            }

            // Silent timeout - limit orders may fill later, no need to log
        } catch (e) {
            logger.error(`❌ Error tracking limit order ${orderID}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Update prediction score with previous prediction result
     * Only evaluates trades that were actually made (not skipped)
     */
    private updatePredictionScore(
        market: string,
        slug: string,
        prediction: PricePrediction,
        previousPrice: number,
        currentPrice: number,
        wasCorrect: boolean
    ): void {
        const scoreKey = `${market}-${slug}`;
        const score = this.predictionScores.get(scoreKey);
        if (!score) return;

        // Find the last trade that hasn't been evaluated yet
        const lastTrade = score.trades[score.trades.length - 1];
        if (lastTrade && lastTrade.wasCorrect === null) {
            lastTrade.wasCorrect = wasCorrect;
            if (wasCorrect) {
                score.correctPredictions++;
            }
            // Note: totalPredictions already incremented when trade was made
            // correctPredictions is updated here based on actual result
        }
    }

    /**
     * Generate prediction score summary when market cycle ends
     */
    private generatePredictionScoreSummary(prevSlug: string, market: string): void {
        const scoreKey = `${market}-${prevSlug}`;
        const score = this.predictionScores.get(scoreKey);
        if (!score) {
            if (config.debug) {
                logger.info(`No trades recorded for ${scoreKey} — no pool summary`);
            }
            return;
        }

        // Don't generate summary if already generated
        if (score.endTime !== null) {
            return;
        }

        score.endTime = Date.now();
        const duration = (score.endTime - score.startTime) / 1000; // seconds

        const successRate = score.totalPredictions > 0
            ? (score.correctPredictions / score.totalPredictions) * 100
            : 0;

        const totalCost = score.upTokenCost + score.downTokenCost;

        if (config.logPredictions) {
            logger.info(`\n${"=".repeat(80)}`);
            logger.info(`📊 PREDICTION SCORE SUMMARY - Market: ${market} | Slug: ${prevSlug}`);
            logger.info(`${"=".repeat(80)}`);
            logger.info(`⏱️  Duration: ${(duration / 60).toFixed(2)} minutes`);
            logger.info(`📈 Total Predictions: ${score.totalPredictions}`);
            logger.info(`✅ Correct Predictions: ${score.correctPredictions}`);
            logger.info(`❌ Wrong Predictions: ${score.totalPredictions - score.correctPredictions}`);
            logger.info(`🎯 Success Rate: ${successRate.toFixed(2)}%`);
            logger.info(`\n💰 TOKEN PURCHASES:`);
            logger.info(`   UP Token:`);
            logger.info(`      - Buy Count: ${score.upTokenCount}`);
            logger.info(`      - Total Cost: ${score.upTokenCost.toFixed(2)} USDC`);
            logger.info(`   DOWN Token:`);
            logger.info(`      - Buy Count: ${score.downTokenCount}`);
            logger.info(`      - Total Cost: ${score.downTokenCost.toFixed(2)} USDC`);
            logger.info(`\n💵 TOTAL COST: ${totalCost.toFixed(2)} USDC`);
            logger.info(`${"=".repeat(80)}\n`);
        } else {
            logger.info(
                `📌 Pool ended | ${market} | ${prevSlug} | ${(duration / 60).toFixed(1)}m | fills=${score.totalPredictions} | spend≈${totalCost.toFixed(2)} USDC`
            );
        }

        // Remove from active tracking (summary generated)
        this.predictionScores.delete(scoreKey);
    }

    /**
     * Generate prediction score summaries for all active markets
     * Called on shutdown or periodically
     */
    private generateAllPredictionSummaries(force: boolean = false): void {
        if (!force) {
            const minutes = new Date().getMinutes();
            if (!isMinuteAtIntervalBoundary(minutes, this.cfg.marketIntervalMinutes)) {
                return;
            }
        }

        const scores = Array.from(this.predictionScores.entries());
        for (const [scoreKey, score] of scores) {
            if (score.endTime === null && score.totalPredictions > 0) {
                // Market is still active and has predictions, generate summary now
                // Use stored market and slug from score object
                this.generatePredictionScoreSummary(score.slug, score.market);
            }
        }
    }

}
