import { AssetType, ClobClient, CreateOrderOptions, OrderType, Side, UserOrder } from "@polymarket/clob-client";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { config } from "../config";
import { WebSocketOrderBook, TokenPrice } from "../providers/websocketOrderbook";
import { AdaptivePricePredictor, PricePrediction } from "../utils/pricePredictor";
import {
    isMarketFullyPaused,
    isSideCapReached,
    limitFillWouldExceedCap,
} from "../trading/limits";
import { bumpMetric, maybeLogMetricsSummary } from "../utils/metrics";
import { isMinuteAtIntervalBoundary, msUntilSlotEnd, slugForCryptoUpdown } from "../utils/marketInterval";

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
    previousUpPrice: number | null;
    lastUpdatedMs: number;
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
    endOfWindowFreezeSeconds: number;
    maxSpread: number;
    maxSessionSpendUsdc: number;
    maxSpendPerWindowUsdc: number;
};

const STATE_FILE = "src/data/predictive-arb-state.json";

function statePath(): string {
    return path.resolve(process.cwd(), STATE_FILE);
}

function emptyRow(): SimpleStateRow {
    return {
        previousUpPrice: null,
        lastUpdatedMs: Date.now(),
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
                    lastUpdatedMs: typeof row.lastUpdatedMs === "number"
                        ? row.lastUpdatedMs
                        : (row.lastUpdatedIso ? new Date(row.lastUpdatedIso).getTime() : Date.now()),
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

// Debounced async state save — non-blocking I/O to avoid stalling the event loop
let saveStateTimer: NodeJS.Timeout | null = null;
let stateWriteInFlight = false;
function saveState(state: SimpleStateFile): void {
    if (saveStateTimer) clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(async () => {
        if (stateWriteInFlight) return; // skip if previous write is still in progress
        stateWriteInFlight = true;
        try {
            const p = statePath();
            await fs.promises.mkdir(path.dirname(p), { recursive: true });
            await fs.promises.writeFile(p, JSON.stringify(state));
        } catch (e) {
            logger.error(`Failed to save state: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            stateWriteInFlight = false;
        }
        saveStateTimer = null;
    }, 500);
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
    private pricePredictors: Map<string, AdaptivePricePredictor> = new Map(); // Price predictors per market
    private lastPredictions: Map<string, { prediction: PricePrediction; actualPrice: number; timestamp: number }> = new Map(); // Track predictions for accuracy
    private marketStartTimeBySlug: Map<string, number> = new Map();

    // Slug cache: avoid recomputing slugForCryptoUpdown on every tick
    private slugCache: Map<string, { slug: string; validUntilMs: number }> = new Map();

    // Limit order second side strategy tracking
    private tokenCountsByMarket: Map<string, { upTokenCount: number; downTokenCount: number }> = new Map();
    private pausedMarkets: Set<string> = new Set();
    private readonly MAX_BUY_COUNTS_PER_SIDE: number;
    private tradingLock: Set<string> = new Set(); // Per-market lock to prevent concurrent trade execution

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

    // Local balance tracker — seeded at startup, decremented on each trade to gate capital
    private lastKnownBalance: number = Infinity;
    private lastBalanceRefreshTs: number = 0;

    // Session-level circuit breaker: cumulative USDC spent since bot start
    private sessionSpendUsdc: number = 0;

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
            const allowance = parseFloat(resp.allowance || "0") / 1e6;
            // Conservative estimate to avoid over-spending against allowance constraints.
            this.lastKnownBalance = Math.max(0, Math.min(balance, allowance));
            this.lastBalanceRefreshTs = now;
        } catch {
            // Keep previous estimate on refresh errors.
        }
    }

    static async fromEnv(client: ClobClient): Promise<PredictiveArbBot> {
        const {
            markets, marketIntervalMinutes, sharesPerSide, tickSize, negRisk, minBalanceUsdc,
            endOfWindowFreezeSeconds, maxSpread, maxSessionSpendUsdc, maxSpendPerWindowUsdc,
        } = config.predictiveArb;
        const bot = new PredictiveArbBot(client, {
            markets,
            marketIntervalMinutes,
            sharesPerSide,
            tickSize: tickSize as CreateOrderOptions["tickSize"],
            negRisk,
            minBalanceUsdc,
            endOfWindowFreezeSeconds,
            maxSpread,
            maxSessionSpendUsdc,
            maxSpendPerWindowUsdc,
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
     * SAFETY: Cancel all open orders for a market's current token IDs.
     * Called on market rotation to prevent orphaned GTC limits from expired windows.
     */
    private async cancelOrdersForMarket(market: string): Promise<void> {
        const t = this.tokenIdsByMarket[market];
        if (!t) return;
        try {
            await this.client.cancelMarketOrders({ asset_id: t.upTokenId });
            await this.client.cancelMarketOrders({ asset_id: t.downTokenId });
            logger.info(`Cancelled open orders for ${market} (slug: ${t.slug})`);
        } catch (e) {
            logger.error(`Failed to cancel orders for ${market}: ${e instanceof Error ? e.message : String(e)}`);
        }
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
    }

    stop(): void {
        this.isStopped = true;

        // Force-generate summaries regardless of interval boundary
        logger.info("\n🛑 Generating final prediction summaries...");
        this.generateAllPredictionSummaries(true);

        if (this.wsOrderBook) {
            this.wsOrderBook.disconnect();
        }
        logger.info("PredictiveArbBot stopped");
    }

    private async initializeMarkets(): Promise<void> {
        for (const market of this.cfg.markets) {
            await this.initializeMarket(market);
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
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            const slug = slugForCryptoUpdown(market, this.cfg.marketIntervalMinutes);
            logger.error(`⚠️  Market ${market} not available yet (${slug}): ${errorMsg}. Will retry on next price update.`);
            // Don't throw - allow the bot to continue and retry later
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

        queueMicrotask(() => {
            this.processPrice(market, tokenIds).catch((err) => {
                logger.error(`Unhandled error in processPrice for ${market}: ${err instanceof Error ? err.message : String(err)}`);
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
        const minPriceChange = 0.0001;
        if (lastPrice !== undefined && Math.abs(upAsk - lastPrice) < minPriceChange) {
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
            this.generatePredictionScoreSummary(prevSlug, market);

            const prevScoreKey = `${market}-${prevSlug}`;
            this.tokenCountsByMarket.delete(prevScoreKey);
            this.pausedMarkets.delete(prevScoreKey);

            logger.info(`🔄 Re-initializing market ${market} with new slug ${slug}`);
            try {
                // SAFETY: Cancel unfilled orders from the previous market cycle
                await this.cancelOrdersForMarket(market);
                this.detachMarketWebSocketFeeds(market);
                const newTokenIds = await fetchTokenIdsForSlug(slug);
                this.tokenIdsByMarket[market] = { slug, ...newTokenIds };

                if (this.wsOrderBook) {
                    this.wireMarketWebSocketFeeds(market, { slug, ...newTokenIds });
                }

                currentTokenIds = { slug, ...newTokenIds };
                logger.info(`✅ Market ${market} re-initialized with new token IDs`);
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
        row.lastUpdatedMs = Date.now();

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

        const lastPred = this.lastPredictions.get(market);
        if (lastPred) {
            const priceDiff = upAsk - lastPred.actualPrice;
            const actualDirection = Math.abs(priceDiff) >= 0.02
                ? (priceDiff > 0 ? "up" : "down")
                : (priceDiff >= 0 ? "up" : "down");
            const wasCorrect = lastPred.prediction.direction === actualDirection;
            const timeDiff = Date.now() - lastPred.timestamp;

            logger.info(`🔮 Prediction: ${lastPred.prediction.direction.toUpperCase()} (conf: ${lastPred.prediction.confidence.toFixed(2)}) | Actual: ${actualDirection.toUpperCase()} | ${wasCorrect ? "✅ CORRECT" : "❌ WRONG"} | Time: ${timeDiff}ms`);
            this.updatePredictionScore(market, slug, lastPred.prediction, lastPred.actualPrice, upAsk, wasCorrect);
        }

        this.lastPredictions.set(market, {
            prediction,
            actualPrice: upAsk,
            timestamp: Date.now(),
        });

        logger.info(`🔮 PREDICT [POLE]: ${prediction.predictedPrice.toFixed(4)} (current: ${upAsk.toFixed(4)}) | Direction: ${prediction.direction.toUpperCase()} | Confidence: ${(prediction.confidence * 100).toFixed(1)}% | Signal: ${prediction.signal} | Momentum: ${prediction.features.momentum.toFixed(3)} | Vol: ${prediction.features.volatility.toFixed(3)} | Trend: ${prediction.features.trend.toFixed(3)}`);

        // SAFETY: End-of-window freeze — skip trading when too close to market resolution
        const msRemaining = msUntilSlotEnd(this.cfg.marketIntervalMinutes);
        if (this.cfg.endOfWindowFreezeSeconds > 0 && msRemaining < this.cfg.endOfWindowFreezeSeconds * 1000) {
            logger.info(`⏳ End-of-window freeze: ${(msRemaining / 1000).toFixed(0)}s remaining < ${this.cfg.endOfWindowFreezeSeconds}s freeze — skipping trade`);
            row.previousUpPrice = upAsk;
            return;
        }

        // Per-market lock: prevent a second price tick from entering executePredictionTrade
        // while the first is still awaiting the CLOB API.
        if (this.tradingLock.has(market)) {
            return;
        }
        this.tradingLock.add(market);
        try {
            await this.executePredictionTrade(market, slug, prediction, upAsk, downAsk, currentTokenIds, state, k, row);
        } finally {
            this.tradingLock.delete(market);
        }

        const stats = predictor.getAccuracyStats();
        if (stats.totalPredictions > 0) {
            if (stats.totalPredictions % 25 === 0 ||
                [10, 50, 100, 200, 500, 1000].includes(stats.totalPredictions)) {
                logger.info(`📊 Prediction Accuracy: ${(stats.accuracy * 100).toFixed(1)}% (${stats.correctPredictions}/${stats.totalPredictions})`);
            }
        }

        row.previousUpPrice = upAsk;
        saveState(state);
    }

    private getSlugForMarket(market: string): string {
        const now = Date.now();
        const cached = this.slugCache.get(market);
        if (cached && now < cached.validUntilMs) return cached.slug;
        const slug = slugForCryptoUpdown(market, this.cfg.marketIntervalMinutes);
        const validUntilMs = now + msUntilSlotEnd(this.cfg.marketIntervalMinutes);
        this.slugCache.set(market, { slug, validUntilMs });
        return slug;
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

        // Generate prediction score summary for previous market
        this.generatePredictionScoreSummary(prevSlug, market);

        // Reset token counts and paused state for previous market
        const prevScoreKey = `${market}-${prevSlug}`;
        this.tokenCountsByMarket.delete(prevScoreKey);
        this.pausedMarkets.delete(prevScoreKey);

        try {
            // SAFETY: Cancel unfilled orders from the previous market cycle
            await this.cancelOrdersForMarket(market);
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
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            logger.error(`⚠️  Failed to re-initialize market ${market} with new slug ${newSlug}: ${errorMsg}. Will retry on next check.`);
        }
    }

    /**
     * Place first-side limit buy with one retry on transient failure.
     * Limit price is best-ask + one tick (matches the configured tickSize).
     */
    private async buyFirstSide(
        leg: "YES" | "NO",
        tokenID: string,
        askPrice: number,
        size: number
    ): Promise<boolean> {
        const tick = parseFloat(this.cfg.tickSize as string) || 0.01;
        const limitPrice = askPrice + tick;
        const orderAmount = limitPrice * size;

        const limitOrder: UserOrder = {
            tokenID,
            side: Side.BUY,
            price: limitPrice,
            size,
        };

        logger.info(`BUY: ${leg} ${size} shares @ limit ${limitPrice.toFixed(4)} (${orderAmount.toFixed(2)} USDC)`);

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const response = await this.client.createAndPostOrder(
                    limitOrder,
                    { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk },
                    OrderType.GTC
                );

                const orderID = response?.orderID;
                if (!orderID) {
                    logger.error(`BUY failed for ${leg} - no orderID returned (attempt ${attempt})`);
                    if (attempt < 2) continue;
                    return false;
                }
                logger.info(`First-Side Order placed: ${leg} orderID ${orderID.substring(0, 10)}... @ ${limitPrice.toFixed(4)}`);

                // SAFETY: Verify the order actually filled before proceeding to second-side.
                // Poll up to ~2s; if not filled, cancel to avoid orphaned unhedged positions.
                const filled = await this.verifyOrderFilled(orderID, 4, 500);
                if (filled) {
                    logger.info(`✅ First-Side FILLED: ${leg} orderID ${orderID.substring(0, 10)}...`);
                    bumpMetric("firstSideOrdersPlaced");
                    return true;
                }

                // Not filled within verification window — cancel to avoid naked exposure
                logger.error(`First-Side NOT FILLED within 2s — cancelling ${orderID.substring(0, 10)}...`);
                try {
                    await this.client.cancelOrder({ orderID });
                } catch (cancelErr) {
                    logger.error(`Failed to cancel unfilled first-side: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`);
                }
                return false;
            } catch (e) {
                logger.error(`BUY failed for ${leg} (attempt ${attempt}): ${e instanceof Error ? e.message : String(e)}`);
                if (attempt < 2) {
                    await new Promise(r => setTimeout(r, 200));
                }
            }
        }
        return false;
    }

    /**
     * Poll order status to verify fill. Returns true if FILLED within the given attempts.
     */
    private async verifyOrderFilled(orderID: string, maxChecks: number, intervalMs: number): Promise<boolean> {
        for (let i = 0; i < maxChecks; i++) {
            await new Promise(r => setTimeout(r, intervalMs));
            try {
                const order = await this.client.getOrder(orderID);
                if (order?.status === "FILLED") return true;
                if (order?.status === "CANCELLED" || order?.status === "REJECTED") return false;
            } catch {
                // Transient API error — continue polling
            }
        }
        return false;
    }

    /**
     * Execute prediction-based trading strategy.
     * First-side must succeed before second-side is placed.
     * Balance is checked before committing capital.
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
    ): Promise<void> {
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

        const minConfidenceForTrade = 0.50;

        if (prediction.confidence < minConfidenceForTrade) {
            return;
        }

        if (prediction.signal === "HOLD") {
            return;
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

        if (!buyToken) return;

        if (this.pausedMarkets.has(scoreKey)) {
            return;
        }

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
            return;
        }

        const tick = parseFloat(this.cfg.tickSize as string) || 0.01;
        const firstLegPrice = buyPrice + tick;
        const secondLegPrice = 0.98 - buyPrice;
        const firstLegCost = firstLegPrice * this.cfg.sharesPerSide;
        const secondLegCost = (secondLegPrice > 0 && secondLegPrice < 1) ? secondLegPrice * this.cfg.sharesPerSide : 0;
        const totalPairCost = firstLegCost + secondLegCost;
        const limitLabel = this.MAX_BUY_COUNTS_PER_SIDE > 0 ? String(this.MAX_BUY_COUNTS_PER_SIDE) : "unlimited";

        // SAFETY: Spread guard — skip if bid-ask spread is too wide
        if (this.cfg.maxSpread > 0) {
            const tokenPrice = this.wsOrderBook?.getPrice(tokenId);
            if (tokenPrice?.bestBid != null && tokenPrice?.bestAsk != null) {
                const spread = tokenPrice.bestAsk - tokenPrice.bestBid;
                if (spread > this.cfg.maxSpread) {
                    logger.info(`⛔ Spread too wide: ${spread.toFixed(4)} > max ${this.cfg.maxSpread} — skipping trade`);
                    return;
                }
            }
        }

        await this.refreshBalanceEstimate();

        // SAFETY: Pre-flight affordability — verify bot can cover BOTH legs plus reserve
        if (this.lastKnownBalance < totalPairCost + this.cfg.minBalanceUsdc) {
            logger.error(`⛔ Pre-flight: balance ${this.lastKnownBalance.toFixed(2)} < pair cost ${totalPairCost.toFixed(2)} + reserve ${this.cfg.minBalanceUsdc} — skipping trade`);
            return;
        }

        // SAFETY: Session spending limit (circuit breaker)
        if (this.cfg.maxSessionSpendUsdc > 0 && this.sessionSpendUsdc + totalPairCost > this.cfg.maxSessionSpendUsdc) {
            logger.error(`⛔ Session limit: spent ${this.sessionSpendUsdc.toFixed(2)} + pair ${totalPairCost.toFixed(2)} > max ${this.cfg.maxSessionSpendUsdc} — skipping trade`);
            return;
        }

        // SAFETY: Per-window spending limit
        if (this.cfg.maxSpendPerWindowUsdc > 0) {
            const windowSpend = score.upTokenCost + score.downTokenCost;
            if (windowSpend + totalPairCost > this.cfg.maxSpendPerWindowUsdc) {
                logger.info(`⛔ Window limit: spent ${windowSpend.toFixed(2)} + pair ${totalPairCost.toFixed(2)} > max ${this.cfg.maxSpendPerWindowUsdc} — skipping trade`);
                return;
            }
        }

        logger.info(`🎯 FIRST-SIDE Trade: ${buyToken} @ ${buyPrice.toFixed(4)} (${firstLegCost.toFixed(2)} USDC, pair total ${totalPairCost.toFixed(2)}) | UP ${tokenCounts.upTokenCount}/${limitLabel}, DOWN ${tokenCounts.downTokenCount}/${limitLabel}`);

        const firstSideOk = await this.buyFirstSide(
            buyToken === "UP" ? "YES" : "NO",
            tokenId,
            buyPrice,
            this.cfg.sharesPerSide
        );

        if (!firstSideOk) {
            logger.error(`❌ First-side order failed for ${buyToken} - skipping second-side`);
            return;
        }

        // Increment counts only after confirmed fill (buyFirstSide now verifies fill)
        score.totalPredictions++;
        if (buyToken === "UP") {
            tokenCounts.upTokenCount++;
            score.upTokenCount++;
            score.upTokenCost += firstLegCost;
        } else {
            tokenCounts.downTokenCount++;
            score.downTokenCount++;
            score.downTokenCost += firstLegCost;
        }

        // Deduct estimated cost from local balance tracker and accumulate session spend
        this.lastKnownBalance = Math.max(0, this.lastKnownBalance - firstLegCost);
        this.sessionSpendUsdc += firstLegCost;

        // Place second-side limit order (only after first-side confirmed)
        this.placeSecondSideLimitOrder(
            buyToken,
            buyPrice,
            tokenIds,
            market,
            slug,
            scoreKey,
            tokenCounts
        );

        score.trades.push({
            prediction: prediction.direction,
            predictedPrice: prediction.predictedPrice,
            actualPrice: buyPrice,
            buyToken,
            buyPrice,
            buyCost: firstLegCost,
            timestamp: Date.now(),
            wasCorrect: null,
        });

        // Persist state after successful trade
        saveState(this.state);

        if (isMarketFullyPaused(this.MAX_BUY_COUNTS_PER_SIDE, tokenCounts.upTokenCount, tokenCounts.downTokenCount)) {
            this.pausedMarkets.add(scoreKey);
            logger.info(`⏸️  Market ${scoreKey} PAUSED: Reached limit (UP: ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, DOWN: ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE})`);
        }

        maybeLogMetricsSummary();
    }

    /**
     * Place limit order for second side (opposite token) at price (0.98 - firstSidePrice)
     */
    private async placeSecondSideLimitOrder(
        firstSide: "UP" | "DOWN",
        firstSidePrice: number,
        tokenIds: { upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number },
        market: string,
        slug: string,
        scoreKey: string,
        tokenCounts: { upTokenCount: number; downTokenCount: number }
    ): Promise<void> {
        // Determine opposite side
        const oppositeSide = firstSide === "UP" ? "DOWN" : "UP";
        const oppositeTokenId = firstSide === "UP" ? tokenIds.downTokenId : tokenIds.upTokenId;

        // CRITICAL: Check if market is paused FIRST
        if (this.pausedMarkets.has(scoreKey)) {
            return; // Market is paused, don't place limit orders
        }

        // Paired hedge limit on opposite outcome (see strategy.md)
        const limitPrice = 0.98 - firstSidePrice;

        // Ensure limit price is valid (between 0 and 1)
        if (limitPrice <= 0 || limitPrice >= 1) {
            logger.error(`⚠️  Invalid limit price calculated: ${limitPrice.toFixed(4)} (from first side price ${firstSidePrice.toFixed(4)})`);
            return;
        }

        const limitOrder: UserOrder = {
            tokenID: oppositeTokenId,
            side: Side.BUY,
            price: limitPrice,
            size: this.cfg.sharesPerSide,
        };
        const limitLabel = this.MAX_BUY_COUNTS_PER_SIDE > 0 ? String(this.MAX_BUY_COUNTS_PER_SIDE) : "unlimited";

        try {
            // Place order IMMEDIATELY (await to ensure it's placed within 50ms of first order)
            const response = await this.client.createAndPostOrder(
                limitOrder,
                { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk },
                OrderType.GTC // Good-Till-Cancel for limit orders
            );
            
            const orderID = response?.orderID;
            // Log second-side limit order placement clearly with limit info
            const limitCost = limitPrice * this.cfg.sharesPerSide;
            if (orderID) {
                bumpMetric("secondSideOrdersPlaced");
                logger.info(`📋 SECOND-SIDE Limit Order: ${oppositeSide} @ ${limitPrice.toFixed(4)} (${limitCost.toFixed(2)} USDC) | First-Side: ${firstSide} @ ${firstSidePrice.toFixed(4)} | Current: UP ${tokenCounts.upTokenCount}/${limitLabel}, DOWN ${tokenCounts.downTokenCount}/${limitLabel} | Limit: ${limitLabel} per side | OrderID: ${orderID.substring(0, 10)}...`);
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
                    tokenCounts
                ).catch(() => { /* fire-and-forget */ });
            } else {
                logger.error(`⚠️  Second-side limit order placement returned no orderID`);
            }
        } catch (e) {
            logger.error(`❌ Failed to place limit order for ${oppositeSide} token: ${e instanceof Error ? e.message : String(e)}`);
        }
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
        tokenCounts: { upTokenCount: number; downTokenCount: number }
    ): Promise<void> {
        try {
            // Optimized polling with exponential backoff
            let attempts = 0;
            const maxAttempts = 30; // Reduced from 60 to 30 (30 seconds max)
            let pollInterval = 500; // Start with 500ms, increase gradually
            const maxInterval = 3000; // Max 3 seconds between checks

            while (attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));
                attempts++;

                try {
                    const order = await this.client.getOrder(orderID);

                    if (order && order.status === "FILLED") {
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

                        // Order filled - update token counts and session spend
                        const fillCost = limitPrice * estimatedShares;
                        this.lastKnownBalance = Math.max(0, this.lastKnownBalance - fillCost);
                        this.sessionSpendUsdc += fillCost;
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

                        logger.info(`✅ Limit order filled: ${leg} @ ${limitPrice.toFixed(4)} | UP ${tokenCounts.upTokenCount}/${limitLabel}, DOWN ${tokenCounts.downTokenCount}/${limitLabel}`);

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
            logger.error(`⚠️  No prediction score found for ${scoreKey} - cannot generate summary`);
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

        // Remove from active tracking (summary generated) and clean up stale maps
        this.predictionScores.delete(scoreKey);
        this.marketStartTimeBySlug.delete(prevSlug);
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
