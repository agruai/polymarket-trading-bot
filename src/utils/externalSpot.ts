/**
 * Poll external BTC spot (Binance BTCUSDT, no API key) for short-window momentum.
 * Used to react slightly earlier than Polymarket order-book–only signals when spot moves sharply.
 */

import { logger } from "./logger";

export type SpotMomentumSample = {
    /** Signed bps change over `windowMs` (approx). */
    bps: number;
    lastPrice: number;
    /** True if we have no recent samples or last HTTP fetch failed. */
    stale: boolean;
};

const BINANCE_URL = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";

async function fetchBinanceBtcUsdt(): Promise<number> {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 5000);
    let res: Response;
    try {
        res = await fetch(BINANCE_URL, { signal: ctrl.signal });
    } finally {
        clearTimeout(tid);
    }
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const j = (await res.json()) as { price?: string };
    const p = Number(j.price);
    if (!Number.isFinite(p) || p <= 0) throw new Error("Bad Binance price");
    return p;
}

export class ExternalSpotFeed {
    private timer: ReturnType<typeof setInterval> | null = null;
    /** Ring buffer of { t, price } for momentum; trimmed to maxHistoryMs. */
    private samples: Array<{ t: number; p: number }> = [];
    private lastPrice = 0;
    private lastOkAt = 0;
    private consecutiveErrors = 0;

    constructor(
        private readonly pollMs: number,
        private readonly maxHistoryMs: number
    ) {}

    start(): void {
        if (this.timer) return;
        void this.tick();
        this.timer = setInterval(() => void this.tick(), Math.max(200, this.pollMs));
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async tick(): Promise<void> {
        try {
            const p = await fetchBinanceBtcUsdt();
            const t = Date.now();
            this.lastPrice = p;
            this.lastOkAt = t;
            this.consecutiveErrors = 0;
            this.samples.push({ t, p });
            const cutoff = t - this.maxHistoryMs;
            while (this.samples.length > 0 && this.samples[0].t < cutoff) {
                this.samples.shift();
            }
        } catch (e) {
            this.consecutiveErrors++;
            if (this.consecutiveErrors === 1 || this.consecutiveErrors % 20 === 0) {
                logger.warning(
                    `[ExternalSpot] BTC fetch failed: ${e instanceof Error ? e.message : String(e)}`
                );
            }
        }
    }

    /**
     * Return signed bps move from oldest sample in window to last price.
     */
    getMomentumBps(windowMs: number): SpotMomentumSample {
        if (this.lastPrice <= 0 || this.samples.length < 2) {
            return { bps: 0, lastPrice: this.lastPrice, stale: true };
        }
        const now = Date.now();
        const t0 = now - Math.max(500, windowMs);
        let anchor = this.samples[0];
        for (const s of this.samples) {
            if (s.t >= t0) {
                anchor = s;
                break;
            }
            anchor = s;
        }
        const bps = anchor.p > 0 ? ((this.lastPrice - anchor.p) / anchor.p) * 10000 : 0;
        const stale = now - this.lastOkAt > 15_000;
        return { bps, lastPrice: this.lastPrice, stale };
    }
}
