import { OrderType, Side, UserOrder, UserMarketOrder } from "@polymarket/clob-client";
import { config } from "../config";
import { logger } from "../utils/logger";
import { bumpMetric, maybeLogMetricsSummary } from "../utils/metrics";
import {
    isMarketFullyPaused,
    isSideCapReached,
    limitFillWouldExceedCap,
} from "../trading/limits";
import { slotStartUnixSeconds, isMinuteAtIntervalBoundary } from "../utils/marketInterval";
import type { BotServices, TickContext, TokenIds, TradingStrategy } from "./types";

type OpenPosition = {
    market: string;
    slug: string;
    scoreKey: string;
    buyToken: "UP" | "DOWN";
    tokenId: string;
    buyPrice: number;
    shares: number;
    buyCost: number;
    leg2OrderId: string | undefined;
    poolEndMs: number;
    createdAt: number;
};

type PredictionScore = {
    market: string;
    slug: string;
    startTime: number;
    endTime: number | null;
    upTokenCost: number;
    downTokenCost: number;
    upTokenCount: number;
    downTokenCount: number;
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
        wasCorrect: boolean | null;
    }>;
};

export class PredictorHedgeStrategy implements TradingStrategy {
    readonly name = "PredictorHedge";

    private readonly MAX_BUY_COUNTS_PER_SIDE: number;
    private openPositions = new Map<string, OpenPosition>();
    private exitMonitorTimer: ReturnType<typeof setInterval> | null = null;
    private exitInFlight = new Set<string>();

    private tokenCountsByMarket = new Map<string, { upTokenCount: number; downTokenCount: number }>();
    private pausedMarkets = new Set<string>();
    private tradingLock = new Set<string>();
    private predictionScores = new Map<string, PredictionScore>();
    private marketStartTimeBySlug = new Map<string, number>();
    private lastLeg1RoundAt = new Map<string, number>();

    constructor(private readonly services: BotServices) {
        this.MAX_BUY_COUNTS_PER_SIDE = config.predictiveArb.maxBuyCountsPerSide;
    }

    start(): void {
        this.startExitMonitorLoop();
    }

    async onTick(ctx: TickContext): Promise<void> {
        if (!ctx.prediction) return;
        if (this.tradingLock.has(ctx.market)) return;

        this.tradingLock.add(ctx.market);
        try {
            const didTrade = await this.executePredictionTrade(ctx);
            if (didTrade) {
                this.services.signalTradeCompleted(ctx.market);
                maybeLogMetricsSummary();
            }
        } finally {
            this.tradingLock.delete(ctx.market);
        }
    }

    onPoolStart(market: string, slug: string): void {
        const scoreKey = `${market}-${slug}`;
        this.marketStartTimeBySlug.set(scoreKey, Date.now());
    }

    onPoolEnd(market: string, slug: string): void {
        this.generatePredictionScoreSummary(slug, market);
        const scoreKey = `${market}-${slug}`;
        this.predictionScores.delete(scoreKey);
        this.tokenCountsByMarket.delete(scoreKey);
        this.pausedMarkets.delete(scoreKey);
        this.lastLeg1RoundAt.delete(scoreKey);
        this.marketStartTimeBySlug.delete(scoreKey);
        for (const [pid, pos] of this.openPositions) {
            if (pos.scoreKey === scoreKey) {
                this.openPositions.delete(pid);
            }
        }
    }

    onIntervalBoundary(): void {
        this.generateAllPredictionSummaries();
    }

    recordPredictionOutcome(market: string, slug: string, wasCorrect: boolean): void {
        const scoreKey = `${market}-${slug}`;
        const score = this.predictionScores.get(scoreKey);
        if (!score) return;
        const lastTrade = score.trades[score.trades.length - 1];
        if (lastTrade && lastTrade.wasCorrect === null) {
            lastTrade.wasCorrect = wasCorrect;
            if (wasCorrect) {
                score.correctPredictions++;
            }
        }
    }

    stop(): void {
        if (this.exitMonitorTimer) {
            clearInterval(this.exitMonitorTimer);
            this.exitMonitorTimer = null;
        }
        this.generateAllPredictionSummaries(true);
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Core trade execution
    // ──────────────────────────────────────────────────────────────────────

    private async executePredictionTrade(ctx: TickContext): Promise<boolean> {
        const { market, slug, prediction, upAsk, downAsk, tokenIds, poolStartMs, poolEndMs } = ctx;
        if (!prediction) return false;
        if (ctx.isPoolDisabledByBandwidth) return false;

        const scoreKey = ctx.scoreKey;
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

        if (pa.maxRoundsPerPool > 0 && score.trades.length >= pa.maxRoundsPerPool) return false;
        if (pa.minMsBetweenLeg1 > 0) {
            const t = this.lastLeg1RoundAt.get(scoreKey);
            if (t !== undefined && Date.now() - t < pa.minMsBetweenLeg1) return false;
        }

        let minConfidenceForTrade = pa.minConfidenceForTrade;
        let spotBypassPoolDelay = false;

        if (pa.externalSpotEnabled && market === "btc") {
            const mom = this.services.getExternalSpotMomentum(pa.externalSpotWindowMs);
            if (mom && !mom.stale) {
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

        if (prediction.confidence < minConfidenceForTrade) return false;
        if (prediction.signal === "HOLD") return false;

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
        if (this.pausedMarkets.has(scoreKey)) return false;

        const poolTradeDelaySecs = pa.poolTradeDelaySecs;
        if (poolTradeDelaySecs > 0 && !spotBypassPoolDelay) {
            const elapsed = Date.now() - poolStartMs;
            if (elapsed < poolTradeDelaySecs * 1000) return false;
        }

        const stopBeforeEndMs = pa.stopNewTradesMsBeforePoolEnd;
        if (stopBeforeEndMs > 0 && Date.now() >= poolEndMs - stopBeforeEndMs) return false;

        const maxBidAskSum = pa.maxBidAskSum;
        if (maxBidAskSum > 0 && upAsk + downAsk > maxBidAskSum) return false;

        const minBuyPrice = pa.minBuyPrice;
        if (minBuyPrice > 0 && buyPrice <= minBuyPrice) return false;

        const maxLeg1Ask = pa.maxLeg1Ask;
        if (maxLeg1Ask > 0 && buyPrice > maxLeg1Ask) return false;

        const tick = parseFloat(this.services.tickSize as string) || 0.01;
        const leg1LimitPrice = this.services.clampLimitPrice(buyPrice + tick);
        const pairSumPreview = this.computeHedgePairSum(leg1LimitPrice);
        const rawLeg2Limit = pairSumPreview - leg1LimitPrice;
        const minLeg2Limit = pa.minLeg2Limit;
        if (minLeg2Limit > 0 && rawLeg2Limit < minLeg2Limit) return false;

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

        const buyCost = leg1LimitPrice * this.services.sharesPerSide;
        const estPairCost = pairSumPreview * this.services.sharesPerSide;
        const limitLabel = this.MAX_BUY_COUNTS_PER_SIDE > 0 ? String(this.MAX_BUY_COUNTS_PER_SIDE) : "unlimited";

        await this.services.refreshBalance();

        if (this.services.minBalanceUsdc > 0 && this.services.lastKnownBalance < this.services.minBalanceUsdc) {
            logger.error(`⛔ Balance gate: estimated available ${this.services.lastKnownBalance.toFixed(2)} USDC < min ${this.services.minBalanceUsdc} USDC - skipping trade`);
            return false;
        }

        if (this.services.lastKnownBalance < estPairCost) {
            logger.error(
                `⛔ Balance gate: need ~${estPairCost.toFixed(2)} USDC for full hedge (pair≈${pairSumPreview.toFixed(4)} × ${this.services.sharesPerSide} sh) but have ~${this.services.lastKnownBalance.toFixed(2)} USDC — skipping`
            );
            return false;
        }

        logger.info(
            `🎯 BUY ${buyToken} ask ${buyPrice.toFixed(4)} → limit ${leg1LimitPrice.toFixed(4)} | leg1 ~${buyCost.toFixed(2)} USDC | hedge cap ~${estPairCost.toFixed(2)} USDC | balance ~${this.services.lastKnownBalance.toFixed(2)} USDC | UP ${tokenCounts.upTokenCount}/${limitLabel} DOWN ${tokenCounts.downTokenCount}/${limitLabel}`
        );

        const firstSideOrder = await this.buyFirstSide(
            buyToken === "UP" ? "YES" : "NO",
            tokenId,
            buyPrice,
            this.services.sharesPerSide
        );

        if (!firstSideOrder.accepted) {
            logger.error(`❌ First-side order failed for ${buyToken} - skipping second-side`);
            return false;
        }

        if (firstSideOrder.orderID) {
            const firstSideFilled = await this.waitForOrderFilled(firstSideOrder.orderID);
            if (!firstSideFilled) {
                logger.warning(
                    `⏭️  First-side ${buyToken} order ${firstSideOrder.orderID.substring(0, 10)}… not filled in time - cancelling & skipping second-side`
                );
                try {
                    await this.services.client.cancelOrder({ orderID: firstSideOrder.orderID });
                } catch (e) {
                    logger.warning(`Cancel unfilled leg-1 ${firstSideOrder.orderID.substring(0, 10)}… failed (may have filled): ${e instanceof Error ? e.message : String(e)}`);
                }
                return false;
            }
        } else {
            logger.warning(`⏭️  First-side ${buyToken} accepted without orderID - cannot confirm fill, skipping second-side`);
            return false;
        }

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

        this.services.deductBalance(buyCost);

        const poolEndMsForExit =
            slotStartUnixSeconds(this.services.marketIntervalMinutes) * 1000 +
            this.services.marketIntervalMinutes * 60 * 1000;
        const openPositionId = `${scoreKey}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        this.openPositions.set(openPositionId, {
            market,
            slug,
            scoreKey,
            buyToken,
            tokenId,
            buyPrice: leg1LimitPrice,
            shares: this.services.sharesPerSide,
            buyCost,
            leg2OrderId: undefined,
            poolEndMs: poolEndMsForExit,
            createdAt: Date.now(),
        });

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

        if (isMarketFullyPaused(this.MAX_BUY_COUNTS_PER_SIDE, tokenCounts.upTokenCount, tokenCounts.downTokenCount)) {
            this.pausedMarkets.add(scoreKey);
            logger.info(`⏸️  Market ${scoreKey} PAUSED: Reached limit (UP: ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, DOWN: ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE})`);
        }

        this.lastLeg1RoundAt.set(scoreKey, Date.now());
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Order helpers
    // ──────────────────────────────────────────────────────────────────────

    private async buyFirstSide(
        leg: "YES" | "NO",
        tokenID: string,
        askPrice: number,
        size: number
    ): Promise<{ accepted: boolean; orderID?: string }> {
        const tick = parseFloat(this.services.tickSize as string) || 0.01;
        const limitPrice = this.services.clampLimitPrice(askPrice + tick);
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
                const response = await this.services.client.createAndPostOrder(
                    limitOrder,
                    { tickSize: this.services.tickSize, negRisk: this.services.negRisk },
                    OrderType.GTC
                );

                const postError = this.services.getOrderPostError(response);
                if (postError) throw new Error(postError);

                const orderID = this.services.extractOrderId(response);
                if (!orderID) {
                    if (this.services.isLikelyAcceptedWithoutOrderId(response)) {
                        if (config.logPredictions) {
                            logger.info(`✅ First-Side Order accepted for ${leg} (response had no orderID)`);
                        } else {
                            logger.info(`✅ Buy ${leg} (accepted, no orderID)`);
                        }
                        bumpMetric("firstSideOrdersPlaced");
                        return { accepted: true };
                    }
                    logger.error(
                        `BUY failed for ${leg} - no orderID returned (attempt ${attempt}) response=${this.services.shortResponse(response)}`
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

    private async waitForOrderFilled(orderID: string): Promise<boolean> {
        const maxAttempts = Math.max(5, config.predictiveArb.leg1FillMaxAttempts);
        const pollIntervalMs = Math.max(50, config.predictiveArb.leg1FillPollMs);
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            try {
                const order = await this.services.client.getOrder(orderID);
                if (order?.status === "FILLED") return true;
                if (order?.status === "CANCELLED" || order?.status === "REJECTED") return false;
            } catch {
                // Keep polling; order may not be queryable immediately after post.
            }
        }
        return false;
    }

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

    private async placeSecondSideLimitOrder(
        firstSide: "UP" | "DOWN",
        firstSidePrice: number,
        tokenIds: TokenIds,
        market: string,
        slug: string,
        scoreKey: string,
        tokenCounts: { upTokenCount: number; downTokenCount: number },
        openPositionId: string
    ): Promise<string | undefined> {
        const oppositeSide = firstSide === "UP" ? "DOWN" : "UP";
        const oppositeTokenId = firstSide === "UP" ? tokenIds.downTokenId : tokenIds.upTokenId;

        if (this.pausedMarkets.has(scoreKey)) return undefined;

        const pairSum = this.computeHedgePairSum(firstSidePrice);
        const rawLimitPrice = pairSum - firstSidePrice;
        const limitPrice = this.services.clampLimitPrice(rawLimitPrice);

        if (config.debug) {
            const edge = 1 - pairSum;
            logger.info(
                `[Hedge] pairSum=${pairSum.toFixed(4)} leg1=${firstSidePrice.toFixed(4)} leg2→${limitPrice.toFixed(4)} edge≈${(edge * 100).toFixed(2)}¢/share`
            );
        }

        if (limitPrice <= 0 || limitPrice >= 1) {
            logger.error(`⚠️  Invalid limit price calculated: ${limitPrice.toFixed(4)} (from first side price ${firstSidePrice.toFixed(4)})`);
            return undefined;
        }

        const limitOrder: UserOrder = {
            tokenID: oppositeTokenId,
            side: Side.BUY,
            price: limitPrice,
            size: this.services.sharesPerSide,
        };
        const limitLabel = this.MAX_BUY_COUNTS_PER_SIDE > 0 ? String(this.MAX_BUY_COUNTS_PER_SIDE) : "unlimited";

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const response = await this.services.client.createAndPostOrder(
                    limitOrder,
                    { tickSize: this.services.tickSize, negRisk: this.services.negRisk },
                    OrderType.GTC
                );

                const postError = this.services.getOrderPostError(response);
                if (postError) throw new Error(postError);

                const orderID = this.services.extractOrderId(response);
                const limitCost = limitPrice * this.services.sharesPerSide;
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
                    const leg = oppositeSide === "UP" ? "YES" : "NO";
                    this.trackLimitOrderAsync(
                        orderID,
                        leg,
                        this.services.sharesPerSide,
                        limitPrice,
                        scoreKey,
                        tokenCounts,
                        openPositionId
                    ).catch(() => { /* fire-and-forget */ });
                    return orderID;
                }

                if (this.services.isLikelyAcceptedWithoutOrderId(response)) {
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
                    `⚠️ Second-side placement returned no orderID (attempt ${attempt}) response=${this.services.shortResponse(response)}`
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

    private async trackLimitOrderAsync(
        orderID: string,
        leg: "YES" | "NO",
        estimatedShares: number,
        limitPrice: number,
        scoreKey: string,
        tokenCounts: { upTokenCount: number; downTokenCount: number },
        openPositionId?: string
    ): Promise<void> {
        try {
            let attempts = 0;
            const maxAttempts = Math.max(5, config.predictiveArb.leg1FillMaxAttempts);
            let pollInterval = Math.max(50, config.predictiveArb.leg1FillPollMs);
            const maxInterval = 3000;

            while (attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));
                attempts++;

                try {
                    const order = await this.services.client.getOrder(orderID);

                    if (order && order.status === "FILLED") {
                        if (openPositionId) {
                            this.openPositions.delete(openPositionId);
                        }
                        const wouldExceedLimit = limitFillWouldExceedCap(
                            this.MAX_BUY_COUNTS_PER_SIDE,
                            leg,
                            tokenCounts.upTokenCount,
                            tokenCounts.downTokenCount
                        );

                        if (wouldExceedLimit) {
                            logger.error(`⚠️  Limit order ${orderID} filled but would exceed limit - cancelling count update (${leg}: ${leg === "YES" ? tokenCounts.upTokenCount : tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE})`);
                            return;
                        }

                        const fillCost = limitPrice * estimatedShares;
                        this.services.deductBalance(fillCost);
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
                            logger.info(`✅ Hedge filled ${leg} @ ${limitPrice.toFixed(4)} | balance ~${this.services.lastKnownBalance.toFixed(2)} USDC`);
                        }

                        if (isMarketFullyPaused(this.MAX_BUY_COUNTS_PER_SIDE, tokenCounts.upTokenCount, tokenCounts.downTokenCount)) {
                            this.pausedMarkets.add(scoreKey);
                            logger.info(`⏸️  Market ${scoreKey} PAUSED after limit order fill: UP: ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, DOWN: ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}`);
                        }

                        return;
                    } else if (order && (order.status === "CANCELLED" || order.status === "REJECTED")) {
                        return;
                    }
                } catch (e) {
                    if (pollInterval < maxInterval) {
                        pollInterval = Math.min(pollInterval * 1.5, maxInterval);
                    }
                }
            }
        } catch (e) {
            logger.error(`❌ Error tracking limit order ${orderID}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Pool-end exit monitor
    // ──────────────────────────────────────────────────────────────────────

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
        if (this.services.isStopped || !config.predictiveArb.exitEnabled) return;
        if (this.openPositions.size === 0) return;

        const pa = config.predictiveArb;
        const exitWindowMs = Math.max(1, pa.exitWindowSecs) * 1000;
        const now = Date.now();
        const tick = parseFloat(this.services.tickSize as string) || 0.01;

        for (const [positionId, pos] of [...this.openPositions.entries()]) {
            if (this.exitInFlight.has(positionId)) continue;

            const msToEnd = pos.poolEndMs - now;
            if (msToEnd > exitWindowMs) continue;
            if (msToEnd <= 0) continue;

            const px = this.services.getTokenPrice(pos.tokenId);
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

    private async attemptExitUnhedgedPosition(
        positionId: string,
        pos: OpenPosition,
        referenceBid: number
    ): Promise<void> {
        if (this.exitInFlight.has(positionId)) return;
        if (!this.openPositions.has(positionId)) return;
        if (this.services.isStopped) return;

        this.exitInFlight.add(positionId);
        try {
            if (!this.openPositions.has(positionId)) return;

            if (pos.leg2OrderId) {
                try {
                    await this.services.client.cancelOrder({ orderID: pos.leg2OrderId });
                } catch (e) {
                    logger.warning(
                        `Exit: cancel leg-2 ${pos.leg2OrderId.substring(0, 10)}… failed (may already be filled): ${e instanceof Error ? e.message : String(e)}`
                    );
                }
                try {
                    const leg2 = await this.services.client.getOrder(pos.leg2OrderId);
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
            const exitTick = parseFloat(this.services.tickSize as string) || 0.01;
            if (pa.exitSellDiscount > 0 && referenceBid > pa.exitSellDiscount + exitTick) {
                marketOrder.price = this.services.clampLimitPrice(referenceBid - pa.exitSellDiscount);
            }

            const response = await this.services.client.createAndPostMarketOrder(
                marketOrder,
                { tickSize: this.services.tickSize, negRisk: this.services.negRisk },
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
                await this.services.refreshBalance(true);
            } else {
                const errMsg =
                    (response && typeof response === "object" && (response as { error?: string }).error) ||
                    this.services.shortResponse(response);
                logger.error(`❌ Pool-end exit sell failed for ${pos.buyToken}: ${errMsg}`);
            }
        } catch (e) {
            logger.error(`❌ Pool-end exit error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.exitInFlight.delete(positionId);
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Prediction scoring & summaries
    // ──────────────────────────────────────────────────────────────────────

    private generatePredictionScoreSummary(prevSlug: string, market: string): void {
        const scoreKey = `${market}-${prevSlug}`;
        const score = this.predictionScores.get(scoreKey);
        if (!score) {
            if (config.debug) {
                logger.info(`No trades recorded for ${scoreKey} — no pool summary`);
            }
            return;
        }

        if (score.endTime !== null) return;

        score.endTime = Date.now();
        const duration = (score.endTime - score.startTime) / 1000;

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

        this.predictionScores.delete(scoreKey);
    }

    private generateAllPredictionSummaries(force: boolean = false): void {
        if (!force) {
            const minutes = new Date().getMinutes();
            if (!isMinuteAtIntervalBoundary(minutes, this.services.marketIntervalMinutes)) {
                return;
            }
        }

        const scores = Array.from(this.predictionScores.entries());
        for (const [scoreKey, score] of scores) {
            if (score.endTime === null && score.totalPredictions > 0) {
                this.generatePredictionScoreSummary(score.slug, score.market);
            }
        }
    }
}
