import type { ClobClient, CreateOrderOptions } from "@polymarket/clob-client";
import type { TokenPrice } from "../providers/websocketOrderbook";
import type { PricePrediction } from "../utils/pricePredictor";

export interface TokenIds {
    upTokenId: string;
    downTokenId: string;
    conditionId: string;
    upIdx: number;
    downIdx: number;
}

export interface TickContext {
    market: string;
    slug: string;
    scoreKey: string;
    upAsk: number;
    downAsk: number;
    tokenIds: TokenIds;
    poolStartMs: number;
    poolEndMs: number;
    prediction: PricePrediction | null;
    isPoolDisabledByBandwidth: boolean;
}

export interface BotServices {
    readonly client: ClobClient;
    readonly tickSize: CreateOrderOptions["tickSize"];
    readonly negRisk: boolean;
    readonly sharesPerSide: number;
    readonly minBalanceUsdc: number;
    readonly marketIntervalMinutes: number;
    readonly isStopped: boolean;
    readonly lastKnownBalance: number;

    refreshBalance(force?: boolean): Promise<void>;
    deductBalance(amount: number): void;

    clampLimitPrice(price: number): number;
    extractOrderId(response: any): string | undefined;
    getOrderPostError(response: any): string | undefined;
    isLikelyAcceptedWithoutOrderId(response: any): boolean;
    shortResponse(response: any): string;

    getTokenPrice(tokenId: string): TokenPrice | null;
    getExternalSpotMomentum(windowMs: number): { bps: number; lastPrice: number; stale: boolean } | null;
    signalTradeCompleted(market: string): void;
}

/**
 * Every trading strategy implements this interface.
 * The orchestrator (PredictiveArbBot) calls these hooks at the right time.
 * To add a new strategy: create a class implementing TradingStrategy,
 * register it in PredictiveArbBot.registerStrategies().
 */
export interface TradingStrategy {
    readonly name: string;

    /** One-time startup (e.g. launch background timers). Called after bot.start(). */
    start?(): void;

    /** Called on every significant WS price tick. Each strategy decides internally whether to act. */
    onTick(ctx: TickContext): Promise<void>;

    /** Called when a new pool begins (market init or slug rotation). */
    onPoolStart?(market: string, slug: string): void;

    /** Called when a pool ends (before eviction). Clean up per-pool state here. */
    onPoolEnd?(market: string, slug: string): void;

    /** Called at market-interval boundaries (e.g. :00, :05 for 5m pools). */
    onIntervalBoundary?(): void;

    /** Called when the predictor evaluates a previous prediction as correct/wrong. */
    recordPredictionOutcome?(market: string, slug: string, wasCorrect: boolean): void;

    /** Called on bot shutdown. Tear down timers, generate final summaries. */
    stop?(): void;
}
