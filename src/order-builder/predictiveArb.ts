import { AssetType, ClobClient, CreateOrderOptions, Chain, getContractConfig } from "@polymarket/clob-client";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { config } from "../config";
import { WebSocketOrderBook, TokenPrice } from "../providers/websocketOrderbook";
import { AdaptivePricePredictor, PricePrediction } from "../utils/pricePredictor";
import { redeemAllWinningMarketsFromAPI, redeemMarket } from "../utils/redeem";
import { bumpMetric } from "../utils/metrics";
import { isMinuteAtIntervalBoundary, slugForCryptoUpdown, slotStartUnixSeconds } from "../utils/marketInterval";
import { ExternalSpotFeed, fetchBtcBandwidth } from "../utils/externalSpot";
import type { TradingStrategy, TickContext, BotServices } from "../strategies";
import { PredictorHedgeStrategy, RuleBasedStrategy } from "../strategies";
import { writeBotLiveStatus, type BotLiveMarketRow } from "../utils/botLiveStatus";

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
    lastUpdatedIso: string;
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
    }, 500);
}

// ══════════════════════════════════════════════════════════════════════════
//  PredictiveArbBot — thin orchestrator
//  All trading logic lives in src/strategies/ via the TradingStrategy interface.
// ══════════════════════════════════════════════════════════════════════════

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

    private pricePredictors: Map<string, AdaptivePricePredictor> = new Map();
    private lastPredictions: Map<string, { prediction: PricePrediction; actualPrice: number; timestamp: number }> = new Map();

    /** Only one processPrice per market at a time; new WS ticks wait until it finishes. */
    private processPriceCoalesceScheduled: Set<string> = new Set();
    /** Throttle very chatty pole / eval logs. */
    private lastVerbosePredictionLogAt: Map<string, number> = new Map();
    private static readonly PREDICTION_LOG_THROTTLE_MS = 20_000;

    private initializationPromise: Promise<void> | null = null;
    private readonly redeemInProgress = new Set<string>();
    private readonly redeemedConditionIds = new Set<string>();
    private static readonly MAX_REDEEMED_IDS_TRACKED = 500;
    private apiRedeemSweepRunning = false;

    private externalSpotFeed: ExternalSpotFeed | null = null;
    /** Pools where trading is disabled due to low BTC bandwidth. */
    private poolTradingDisabledBySlug: Set<string> = new Set();

    // Local balance tracker — seeded at startup, decremented on each trade to gate capital
    private lastKnownBalance: number = Infinity;
    private lastBalanceRefreshTs: number = 0;

    /** Registered trading strategies. */
    private strategies: TradingStrategy[] = [];
    /** Strategies signal trade completion so the bot can reset price-delta throttle. */
    private tradeCompletedSignal: Set<string> = new Set();
    /** Shared services adapter exposed to strategies. */
    private services: BotServices;

    /** Debounced write of `bot-live-status.json` for the config dashboard. */
    private liveStatusTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private client: ClobClient, private cfg: SimpleConfig) {
        const self = this;
        this.services = {
            client: this.client,
            tickSize: this.cfg.tickSize,
            negRisk: this.cfg.negRisk,
            sharesPerSide: this.cfg.sharesPerSide,
            minBalanceUsdc: this.cfg.minBalanceUsdc,
            marketIntervalMinutes: this.cfg.marketIntervalMinutes,
            get isStopped() { return self.isStopped; },
            get lastKnownBalance() { return self.lastKnownBalance; },
            refreshBalance: (force) => this.refreshBalanceEstimate(force),
            deductBalance: (amount) => { this.lastKnownBalance = Math.max(0, this.lastKnownBalance - amount); },
            clampLimitPrice: (price) => this.clampLimitPrice(price),
            extractOrderId: (resp) => this.extractOrderId(resp),
            getOrderPostError: (resp) => this.getOrderPostError(resp),
            isLikelyAcceptedWithoutOrderId: (resp) => this.isLikelyAcceptedWithoutOrderId(resp),
            shortResponse: (resp) => this.shortResponse(resp),
            getTokenPrice: (tokenId) => this.wsOrderBook?.getPrice(tokenId) ?? null,
            getExternalSpotMomentum: (windowMs) => {
                if (!this.externalSpotFeed) return null;
                return this.externalSpotFeed.getMomentumBps(windowMs);
            },
            signalTradeCompleted: (market) => { this.tradeCompletedSignal.add(market); },
        };

        this.initializationPromise = this.initializeWebSocket();
    }

    private registerStrategies(): void {
        this.strategies.push(new RuleBasedStrategy(this.services));
        this.strategies.push(new PredictorHedgeStrategy(this.services));
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

        try {
            await bot.refreshBalanceEstimate(true);
            logger.info(`Balance tracker seeded: ${bot.lastKnownBalance.toFixed(2)} USDC`);
        } catch {
            logger.error("Could not seed balance tracker — minBalanceUsdc gate will be skipped until first refresh");
        }

        bot.registerStrategies();
        return bot;
    }

    // ──────────────────────────────────────────────────────────────────────
    //  WebSocket management
    // ──────────────────────────────────────────────────────────────────────

    private detachMarketWebSocketFeeds(market: string): void {
        const t = this.tokenIdsByMarket[market];
        if (!t || !this.wsOrderBook) return;
        this.wsOrderBook.detachTokenSubscriptions([t.upTokenId, t.downTokenId]);
    }

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

    // ──────────────────────────────────────────────────────────────────────
    //  Lifecycle
    // ──────────────────────────────────────────────────────────────────────

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

        // Periodic summary at each interval boundary
        setInterval(() => {
            const now = new Date();
            const minutes = now.getMinutes();
            const seconds = now.getSeconds();
            const iv = this.cfg.marketIntervalMinutes;
            if (isMinuteAtIntervalBoundary(minutes, iv) && seconds < 5) {
                for (const strategy of this.strategies) {
                    strategy.onIntervalBoundary?.();
                }
            }
        }, 60 * 1000);

        // Detect market slug rotation even when the orderbook is quiet
        setInterval(() => {
            this.checkAndHandleMarketCycleChanges();
        }, 10 * 1000);

        for (const strategy of this.strategies) {
            strategy.start?.();
        }

        setTimeout(() => this.scheduleLiveStatusWrite(), 500);
    }

    stop(): void {
        this.isStopped = true;
        try {
            this.writeLiveStatusSnapshot();
        } catch {
            /* ignore */
        }

        logger.info("\n🛑 Generating final prediction summaries...");
        for (const strategy of this.strategies) {
            strategy.stop?.();
        }

        if (this.externalSpotFeed) {
            this.externalSpotFeed.stop();
            this.externalSpotFeed = null;
        }
        if (this.wsOrderBook) {
            this.wsOrderBook.disconnect();
        }
        logger.info("PredictiveArbBot stopped");
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Market initialization & slug rotation
    // ──────────────────────────────────────────────────────────────────────

    private async initializeMarkets(): Promise<void> {
        for (const market of this.cfg.markets) {
            await this.initializeMarket(market);
        }
        this.pruneStaleStateRows();
    }

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

            for (const strategy of this.strategies) {
                strategy.onPoolStart?.(market, slug);
            }
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            const slug = slugForCryptoUpdown(market, this.cfg.marketIntervalMinutes);
            logger.error(`⚠️  Market ${market} not available yet (${slug}): ${errorMsg}. Will retry on next price update.`);
        }
    }

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

    private async checkAndHandleMarketCycleChanges(): Promise<void> {
        if (this.isStopped) return;

        for (const market of this.cfg.markets) {
            const currentSlug = this.getSlugForMarket(market);
            if (!currentSlug) continue;

            const prevSlug = this.lastSlugByMarket[market];
            if (prevSlug && prevSlug !== currentSlug) {
                logger.info(`🔄 Market cycle change detected via periodic check for ${market}: ${prevSlug} → ${currentSlug}`);
                await this.reinitializeMarketForNewCycle(market, prevSlug, currentSlug);
            }
        }
    }

    private async reinitializeMarketForNewCycle(market: string, prevSlug: string, newSlug: string): Promise<void> {
        logger.info(`🔄 Re-initializing market ${market} with new slug ${newSlug} (from periodic check)`);

        const completedConditionId = this.state[prevSlug]?.conditionId;

        for (const strategy of this.strategies) {
            strategy.onPoolEnd?.(market, prevSlug);
        }

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

            const predictor = this.pricePredictors.get(market);
            if (predictor) {
                predictor.reset();
            }
            this.lastPredictions.delete(market);
            this.lastVerbosePredictionLogAt.delete(market);

            logger.info(`✅ Market ${market} re-initialized with new token IDs for cycle ${newSlug}`);

            await this.runBandwidthCheck(market, newSlug);

            for (const strategy of this.strategies) {
                strategy.onPoolStart?.(market, newSlug);
            }
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            logger.error(`⚠️  Failed to re-initialize market ${market} with new slug ${newSlug}: ${errorMsg}. Will retry on next check.`);
        }
    }

    private evictMemoryForCompletedPool(market: string, prevSlug: string): void {
        this.poolTradingDisabledBySlug.delete(prevSlug);
        if (this.state[prevSlug] !== undefined) {
            delete this.state[prevSlug];
            saveState(this.state);
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Price pipeline
    // ──────────────────────────────────────────────────────────────────────

    private handlePriceUpdate(
        market: string,
        tokenIds: { slug: string; upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number },
        price: TokenPrice
    ): void {
        if (this.isStopped) return;
        if (!price.bestAsk || !Number.isFinite(price.bestAsk)) return;

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

        // ── Slug rotation ────────────────────────────────────────────────
        const prevSlug = this.lastSlugByMarket[market];
        if (prevSlug && prevSlug !== slug) {
            logger.info(`🔄 New market cycle detected for ${market}: ${prevSlug} → ${slug}`);
            const completedConditionId = this.state[prevSlug]?.conditionId;

            for (const strategy of this.strategies) {
                strategy.onPoolEnd?.(market, prevSlug);
            }

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
            this.lastPredictions.delete(market);
            this.lastVerbosePredictionLogAt.delete(market);

            for (const strategy of this.strategies) {
                strategy.onPoolStart?.(market, slug);
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

        // ── Update state row ─────────────────────────────────────────────
        row.conditionId = currentTokenIds.conditionId;
        row.slug = slug;
        row.market = market;
        row.upIdx = currentTokenIds.upIdx;
        row.downIdx = currentTokenIds.downIdx;
        row.lastUpdatedIso = new Date().toISOString();

        // ── Prediction ───────────────────────────────────────────────────
        let predictor = this.pricePredictors.get(market);
        if (!predictor) {
            predictor = new AdaptivePricePredictor();
            this.pricePredictors.set(market, predictor);
        }

        const prediction = predictor.updateAndPredict(upAsk, Date.now());

        // Evaluate previous prediction accuracy (before strategies run)
        if (prediction) {
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
                for (const strategy of this.strategies) {
                    strategy.recordPredictionOutcome?.(market, slug, wasCorrect);
                }
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
        }

        // ── Build context & run strategies ────────────────────────────────
        const poolStartMs = slotStartUnixSeconds(this.cfg.marketIntervalMinutes) * 1000;
        const intervalMs = this.cfg.marketIntervalMinutes * 60 * 1000;
        const poolEndMs = poolStartMs + intervalMs;

        const ctx: TickContext = {
            market,
            slug,
            scoreKey: `${market}-${slug}`,
            upAsk,
            downAsk,
            tokenIds: currentTokenIds,
            poolStartMs,
            poolEndMs,
            prediction: prediction ?? null,
            isPoolDisabledByBandwidth: this.poolTradingDisabledBySlug.has(slug),
        };

        for (const strategy of this.strategies) {
            await strategy.onTick(ctx);
        }

        // ── Post-strategy housekeeping ────────────────────────────────────
        if (this.tradeCompletedSignal.has(market)) {
            if (config.predictiveArb.resetPriceDeltaAfterTrade) {
                this.lastProcessedPrice.delete(market);
            }
            this.tradeCompletedSignal.delete(market);
        }

        if (prediction) {
            const stats = predictor.getAccuracyStats();
            if (
                config.logPredictions &&
                stats.totalPredictions > 0 &&
                (stats.totalPredictions % 25 === 0 ||
                    [10, 50, 100, 200, 500, 1000].includes(stats.totalPredictions))
            ) {
                logger.info(`📊 Prediction Accuracy: ${(stats.accuracy * 100).toFixed(1)}% (${stats.correctPredictions}/${stats.totalPredictions})`);
            }
        }

        row.previousUpPrice = upAsk;
        saveState(state);
        this.scheduleLiveStatusWrite();
    }

    private scheduleLiveStatusWrite(): void {
        if (this.liveStatusTimer) clearTimeout(this.liveStatusTimer);
        this.liveStatusTimer = setTimeout(() => {
            this.liveStatusTimer = null;
            try {
                this.writeLiveStatusSnapshot();
            } catch {
                /* ignore */
            }
        }, 300);
    }

    private writeLiveStatusSnapshot(): void {
        const now = Date.now();
        const poolStartMs = slotStartUnixSeconds(this.cfg.marketIntervalMinutes) * 1000;
        const intervalMs = this.cfg.marketIntervalMinutes * 60 * 1000;
        const poolEndMs = poolStartMs + intervalMs;
        const secsToEnd = (poolEndMs - now) / 1000;

        const markets: BotLiveMarketRow[] = [];
        for (const market of this.cfg.markets) {
            const ids = this.tokenIdsByMarket[market];
            const slug = this.getSlugForMarket(market);
            const bw = this.poolTradingDisabledBySlug.has(slug);

            if (!ids || !this.wsOrderBook) {
                let phase: BotLiveMarketRow["poolPhase"] = "waiting";
                if (secsToEnd <= 0) phase = "ended";
                markets.push({
                    market,
                    slug,
                    ready: false,
                    upAsk: null,
                    downAsk: null,
                    sum: null,
                    poolStartMs,
                    poolEndMs,
                    secsToEnd,
                    poolPhase: phase,
                    bandwidthDisabled: bw,
                });
                continue;
            }

            const up = this.wsOrderBook.getPrice(ids.upTokenId);
            const down = this.wsOrderBook.getPrice(ids.downTokenId);
            const ua = up?.bestAsk != null && Number.isFinite(up.bestAsk) ? up.bestAsk : null;
            const da = down?.bestAsk != null && Number.isFinite(down.bestAsk) ? down.bestAsk : null;
            const sum = ua != null && da != null ? ua + da : null;

            let phase: BotLiveMarketRow["poolPhase"] = "active";
            if (secsToEnd <= 0) phase = "ended";
            else if (ua == null || da == null) phase = "waiting";

            markets.push({
                market,
                slug,
                ready: ua != null && da != null,
                upAsk: ua,
                downAsk: da,
                sum,
                poolStartMs,
                poolEndMs,
                secsToEnd,
                poolPhase: phase,
                bandwidthDisabled: bw,
            });
        }

        const bal = this.lastKnownBalance;
        writeBotLiveStatus({
            updatedAt: new Date().toISOString(),
            botRunning: !this.isStopped,
            intervalMinutes: this.cfg.marketIntervalMinutes,
            balanceUsdcEstimate: Number.isFinite(bal) && bal !== Infinity ? bal : null,
            markets,
        });
    }

    private getSlugForMarket(market: string): string {
        return slugForCryptoUpdown(market, this.cfg.marketIntervalMinutes);
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Order helpers (shared via BotServices)
    // ──────────────────────────────────────────────────────────────────────

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
        const tick = parseFloat(this.cfg.tickSize as string) || 0.01;
        const min = tick;
        const max = 1 - tick;
        if (!Number.isFinite(price)) return min;
        return Math.min(max, Math.max(min, price));
    }

    private isLikelyAcceptedWithoutOrderId(response: any): boolean {
        if (!response || typeof response !== "object") return false;
        if ((response as any).success === true) return true;
        const status = String((response as any).status || "").toLowerCase();
        return status === "live" || status === "matched" || status === "pending";
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Auto-redeem
    // ──────────────────────────────────────────────────────────────────────

    private trimRedeemedConditionIds(): void {
        if (this.redeemedConditionIds.size <= PredictiveArbBot.MAX_REDEEMED_IDS_TRACKED) return;
        const arr = [...this.redeemedConditionIds];
        const toDrop = arr.length - Math.floor(PredictiveArbBot.MAX_REDEEMED_IDS_TRACKED / 2);
        for (let i = 0; i < toDrop; i++) this.redeemedConditionIds.delete(arr[i]);
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
        if (this.redeemedConditionIds.has(conditionId)) {
            this.scheduleBackgroundRecentPoolsRedeemSweep();
            return;
        }
        if (this.redeemInProgress.has(conditionId)) {
            this.scheduleBackgroundRecentPoolsRedeemSweep();
            return;
        }

        this.redeemInProgress.add(conditionId);
        void this.autoRedeemCompletedMarket(market, prevSlug, conditionId);
        this.scheduleBackgroundRecentPoolsRedeemSweep();
    }

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
}
