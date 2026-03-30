import { OrderType, Side, UserOrder, UserMarketOrder } from "@polymarket/clob-client";
import { config } from "../config";
import { logger } from "../utils/logger";
import { bumpMetric } from "../utils/metrics";
import type { BotServices, TickContext, TradingStrategy } from "./types";

export class RuleBasedStrategy implements TradingStrategy {
    readonly name = "RuleBased";

    private tradeCountBySlug = new Map<string, number>();
    private lock = new Set<string>();

    constructor(private readonly services: BotServices) {}

    async onTick(ctx: TickContext): Promise<void> {
        const rs = config.ruleBasedStrategy;
        if (!rs.enabled) return;
        if (ctx.isPoolDisabledByBandwidth) return;
        if (this.lock.has(ctx.market)) return;

        const count = this.tradeCountBySlug.get(ctx.slug) ?? 0;
        if (rs.maxTradesPerPool > 0 && count >= rs.maxTradesPerPool) return;

        const now = Date.now();
        const secsToEnd = (ctx.poolEndMs - now) / 1000;
        if (secsToEnd > rs.entrySecsBeforeEnd || secsToEnd < rs.cutoffSecsBeforeEnd) return;

        const lead = Math.abs(ctx.upAsk - ctx.downAsk);
        if (lead < rs.minPriceLead) return;

        const upWinning = ctx.upAsk > ctx.downAsk;
        const winnerAsk = upWinning ? ctx.upAsk : ctx.downAsk;
        if (winnerAsk < rs.minWinnerAsk || winnerAsk > rs.maxWinnerAsk) return;

        await this.services.refreshBalance();
        const tick = parseFloat(this.services.tickSize as string) || 0.01;
        const limitPrice = this.services.clampLimitPrice(winnerAsk + tick);
        const cost = limitPrice * rs.shares;

        if (this.services.minBalanceUsdc > 0 && this.services.lastKnownBalance < this.services.minBalanceUsdc) return;
        if (this.services.lastKnownBalance < cost) return;

        const side: "UP" | "DOWN" = upWinning ? "UP" : "DOWN";
        const tokenId = upWinning ? ctx.tokenIds.upTokenId : ctx.tokenIds.downTokenId;

        logger.info(
            `📐 [RuleBased] ENTRY ${side} @ ${winnerAsk.toFixed(4)} → limit ${limitPrice.toFixed(4)} | lead ${lead.toFixed(4)} | ${secsToEnd.toFixed(0)}s to end | cost ~${cost.toFixed(2)} USDC | pool ${ctx.slug}`
        );

        this.lock.add(ctx.market);
        try {
            if (rs.useMarketOrder) {
                const marketOrder: UserMarketOrder = {
                    tokenID: tokenId,
                    side: Side.BUY,
                    amount: cost,
                };
                const response = await this.services.client.createAndPostMarketOrder(
                    marketOrder,
                    { tickSize: this.services.tickSize, negRisk: this.services.negRisk },
                    OrderType.FAK
                );
                const postError = this.services.getOrderPostError(response);
                if (postError) throw new Error(postError);
            } else {
                const limitOrder: UserOrder = {
                    tokenID: tokenId,
                    side: Side.BUY,
                    price: limitPrice,
                    size: rs.shares,
                };
                const response = await this.services.client.createAndPostOrder(
                    limitOrder,
                    { tickSize: this.services.tickSize, negRisk: this.services.negRisk },
                    OrderType.GTC
                );
                const postError = this.services.getOrderPostError(response);
                if (postError) throw new Error(postError);
            }

            this.tradeCountBySlug.set(ctx.slug, count + 1);
            this.services.deductBalance(cost);
            bumpMetric("ruleBasedBuys");

            logger.info(
                `✅ [RuleBased] ${side} bought | ${rs.shares} shares @ ${limitPrice.toFixed(4)} | balance ~${this.services.lastKnownBalance.toFixed(2)} USDC`
            );
        } catch (e) {
            logger.error(`❌ [RuleBased] Buy failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.lock.delete(ctx.market);
        }
    }

    onPoolEnd(_market: string, slug: string): void {
        this.tradeCountBySlug.delete(slug);
    }
}
