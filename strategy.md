# Trading Strategy

This document describes the complete trading strategy implemented in this bot, including the mathematical basis for profitability, execution mechanics, safety systems, risk analysis, and expected returns.

---

## 1. Executive Summary

This bot trades **Polymarket crypto Up/Down markets** (5-minute or 15-minute BTC/ETH pools). The core strategy is **conditional token pair arbitrage**: buying shares on BOTH outcomes (Up and Down) of a single market for a combined cost of less than $1.00 per share pair, then collecting the $1.00 payout at resolution.

The bot uses an adaptive price predictor to choose which side to buy first, but **the predictor's accuracy does not determine profitability** — what matters is that both legs fill at a combined cost below $1.00.

---

## 2. The Core Math: Why This Works

### 2.1 Polymarket Binary Market Mechanics

Each Up/Down pool has exactly two outcomes. At resolution:
- The **winning** outcome pays **$1.00** per share
- The **losing** outcome pays **$0.00** per share

Since exactly one outcome wins, if you hold 1 share of BOTH outcomes, you are guaranteed to receive exactly **$1.00** regardless of which side wins.

### 2.2 The Arbitrage Condition

If you can buy 1 share of Up at price `P_up` and 1 share of Down at price `P_down`, your total cost is:

```
Total Cost = P_up + P_down
```

Your guaranteed payout is $1.00. Therefore:

```
Profit per share pair = $1.00 - P_up - P_down - Fees
```

**The arb condition**: `P_up + P_down + Fees < $1.00`

When this condition holds, the profit is **mathematically guaranteed** regardless of which outcome wins.

### 2.3 Concrete Example

```
Up ask price:    $0.48
Down ask price:  $0.49
─────────────────────────
Pair cost:       $0.97
Fee (0 bps):     $0.00
Net cost:        $0.97
─────────────────────────
Payout:          $1.00
Gross profit:    $0.03 per share pair (3.09% return)
```

With 5 shares per side:
- Capital deployed: $0.97 × 5 = $4.85
- Guaranteed return: $1.00 × 5 = $5.00
- Profit: $0.15 per pool (if the arb condition held)

---

## 3. Execution Flow (Step by Step)

### 3.1 Market Data (Real-Time)

The bot subscribes to Polymarket's WebSocket orderbook for live best-bid/best-ask prices on both the Up and Down tokens. The `AdaptivePricePredictor` processes these price updates.

### 3.2 Signal Generation

Only at **pole points** (local peaks/troughs in the smoothed price series), the predictor outputs:
- `direction`: `"up"` or `"down"`
- `confidence`: 0.0 to ~0.92
- `signal`: `"BUY_UP"`, `"BUY_DOWN"`, or `"HOLD"`

The signal requires alignment of trend, momentum, volatility, and confidence thresholds. The signal determines **which side to buy first** — it does NOT determine profitability.

### 3.3 Pre-Trade Safety Gates (all must pass)

| # | Gate | What It Checks |
|---|------|----------------|
| 1 | **Confidence** | `prediction.confidence >= 0.50` |
| 2 | **Signal** | Not `"HOLD"` |
| 3 | **Market not paused** | Per-side buy cap not reached |
| 4 | **Arb condition** | `(upAsk + tick) + (downAsk + tick) + fees < 1.00` (uses actual execution prices, not raw asks) |
| 5 | **Spread guard** | Bid-ask spread < `COPYTRADE_MAX_SPREAD` |
| 6 | **Balance check** | USDC balance >= pair cost + reserve |
| 7 | **Session limit** | Cumulative spend < `COPYTRADE_MAX_SESSION_SPEND_USDC` |
| 8 | **Window limit** | Per-pool spend < `COPYTRADE_MAX_SPEND_PER_WINDOW_USDC` |
| 9 | **End-of-window freeze** | Time remaining > `COPYTRADE_END_OF_WINDOW_FREEZE_SECONDS` |
| 10 | **Trading lock** | No other trade in progress for this market |

**Gate #4 is the most important**: if the arb doesn't exist in the live orderbook right now, the bot does nothing. Zero capital is risked.

### 3.4 Leg 1 — First Side (GTC Limit)

- **Side**: UP or DOWN per predictor signal
- **Price**: Best ask + 1 tick (aggressive, crosses the spread for fast fill)
- **Size**: `COPYTRADE_SHARES` shares
- **Order type**: GTC (Good-Till-Cancel) limit via `createAndPostOrder`
- **Fill verification**: Polls order status up to 4 times (500ms intervals). If not filled within ~2 seconds, the order is cancelled.
- **Race detection**: After cancellation, re-checks the order one more time to detect fill-during-cancel races.

If the first leg fails or isn't filled → **no capital is at risk, no second leg is placed.**

### 3.5 Leg 2 — Second Side (FOK Aggressive)

- **Side**: The OPPOSITE outcome to Leg 1
- **Price**: Opposite token's current best ask + 1 tick (aggressive market-crossing order), capped at the **maximum profitable price** = `(1.00 / feeMultiplier) - actualFirstFillPrice`
- **Size**: Same `COPYTRADE_SHARES` shares
- **Order type**: FOK (Fill-or-Kill) via `createAndPostMarketOrder`
- **Retry**: Up to 2 attempts with 150ms delay

FOK means the order **fills entirely or is rejected entirely** — there are no partial fills or dangling orders.

**Implementation detail (important):** Leg B is submitted as a **market-style order** (`UserMarketOrder`) where:
- For **BUY**, `amount` is the **USDC amount to spend** (not “shares”), and `price` is used as a **max price cap**
- This is why Leg B uses `createAndPostMarketOrder(..., OrderType.FOK)` rather than `createAndPostOrder` (which only supports `GTC/GTD`)

**Legacy note:** Older versions of this repo used a passive second-leg **GTC limit** such as `0.98 - firstSidePrice` and optionally tracked fills asynchronously. That is **not** the current strategy and is intentionally avoided because it can leave unhedged exposure.

The price cap guarantees that even if the second leg fills at the maximum allowed price, the pair is still profitable:
```
actualFirstPrice + maxSecondPrice < 1.00 / feeMultiplier
→ pair cost after fees < $1.00
→ guaranteed profit
```

### 3.6 Bail-Out (If Second Leg Fails)

If the FOK second leg fails (e.g., liquidity disappeared between legs):
1. The bot immediately attempts to **sell the first-leg shares back** at the best bid - 1 tick
2. This sell also uses FOK (fill entirely or not at all)
3. Loss is limited to the round-trip spread (buy at ask, sell at bid) — typically $0.01–$0.03 per share

If even the bail-out fails (no bid liquidity), the position remains as naked directional exposure until pool resolution.

### 3.7 Post-Resolution: Auto-Redemption

When the pool ends and a new pool starts:
1. The bot detects the slug change (new 5m/15m window)
2. Immediately begins polling the CTF smart contract for resolution status
3. Once resolved, calls `redeemPositions` on-chain to convert winning shares → USDC
4. USDC is available for the next pool

Configuration: `COPYTRADE_AUTO_REDEEM=true`, polls every `COPYTRADE_REDEEM_POLL_INTERVAL_SECONDS` (default 15s), up to `COPYTRADE_REDEEM_MAX_ATTEMPTS` (default 20).

---

## 4. Expected Benefit Analysis

### 4.1 Per-Pair Profit

| Pair Sum (P_up + P_down) | Fee (0 bps) | Net Profit/Share | Return % |
|--------------------------|-------------|------------------|----------|
| 0.95                     | $0.000      | $0.050           | 5.26%    |
| 0.96                     | $0.000      | $0.040           | 4.17%    |
| 0.97                     | $0.000      | $0.030           | 3.09%    |
| 0.98                     | $0.000      | $0.020           | 2.04%    |
| 0.99                     | $0.000      | $0.010           | 1.01%    |

With fees configured (example 20 bps = 0.2%):

| Pair Sum (P_up + P_down) | Fee (20 bps) | Net Profit/Share | Return % |
|--------------------------|--------------|------------------|----------|
| 0.95                     | $0.0019      | $0.0481          | 5.06%    |
| 0.96                     | $0.0019      | $0.0381          | 3.97%    |
| 0.97                     | $0.0019      | $0.0281          | 2.90%    |
| 0.98                     | $0.0019      | $0.0181          | 1.85%    |
| 0.99                     | $0.0020      | $0.0080          | 0.81%    |

### 4.2 Per-Pool Estimate (5-minute BTC pool)

Assumptions:
- `COPYTRADE_SHARES = 5`
- `COPYTRADE_MAX_BUY_COUNTS_PER_SIDE = 1` (1 pair per pool)
- Average pair sum = $0.97 (typical for liquid BTC 5m markets)
- Fee rate = 0 bps

```
Per pool:   $0.03 × 5 = $0.15 profit
Per hour:   12 pools × $0.15 = $1.80
Per day:    288 pools × $0.15 = $43.20
Capital:    ~$4.85 deployed per pool (recycled via auto-redeem)
```

With higher shares (10 shares, same conditions):
```
Per pool:   $0.03 × 10 = $0.30
Per day:    288 × $0.30 = $86.40
Capital:    ~$9.70 per pool
```

**Important**: These numbers assume the arb condition exists in every pool. In practice, many pools will have `upAsk + downAsk >= 1.00` and the bot will skip them. The actual trade frequency depends on market liquidity and price dynamics.

### 4.3 Realistic Expectations

Based on typical Polymarket crypto Up/Down market behavior:

| Scenario | Arb Availability | Trades/Day | Est. Daily Profit | Notes |
|----------|-----------------|------------|-------------------|-------|
| **Optimistic** | 50% of pools | ~144 | $21.60 | Liquid market, tight spreads |
| **Moderate** | 25% of pools | ~72 | $10.80 | Normal conditions |
| **Conservative** | 10% of pools | ~29 | $4.35 | Wide spreads, thin books |
| **Dry** | <5% of pools | <15 | <$2.25 | Illiquid, no arb exists |

With 5 shares per side, 0 fee, average pair sum $0.97.

---

## 5. Risk Analysis

### 5.1 Risk Rating Summary

| Risk | Severity | Probability | Mitigation |
|------|----------|-------------|------------|
| **Second leg FOK rejected** | Medium | Low-Medium | Bail-out sell + only enters when arb verified |
| **Bail-out sell fails** | Medium | Very Low | Naked position held until resolution; loss = first-leg cost if wrong side |
| **Arb vanishes between legs** | Low | Low | maxSecondPrice cap prevents entering at a loss; bail-out activates |
| **Gas costs exceed profit** | Low | Low on Polygon | Polygon gas ~$0.01-0.05; only matters for very small positions |
| **API/WebSocket disconnection** | Medium | Low | Bot stops trading when disconnected; existing positions resolve at maturity |
| **Predictor makes bad call** | None | N/A | Direction choice doesn't affect profit IF both legs fill — this is the key insight |
| **Market liquidity dries up** | Low | Varies | Arb pre-check prevents entry; spread guard skips wide spreads |
| **Fee misconfiguration** | Medium | User error | Set `COPYTRADE_FEE_RATE_BPS` to match your actual Polymarket fee tier |

### 5.2 Detailed Risk Scenarios

#### Scenario A: Both Legs Fill (Happy Path) — RISK: NONE
```
Buy UP  @ $0.48,  Buy DOWN @ $0.49
Total cost: $0.97
Resolution: One side pays $1.00 → Profit: $0.03/share
```
This is the target state. Mathematically guaranteed profit.

#### Scenario B: First Leg Fills, Second Leg FOK Rejected, Bail-Out Succeeds — RISK: MINIMAL
```
Buy UP    @ $0.48 (filled)
Buy DOWN  @ FOK rejected (no liquidity at profitable price)
Sell UP   @ $0.47 (bail-out at bid)
Loss: $0.48 - $0.47 = $0.01/share (spread cost)
```
With 5 shares: $0.05 loss. This is the cost of one failed attempt.

#### Scenario C: First Leg Fills, Second Fails, Bail-Out Also Fails — RISK: MODERATE
```
Buy UP    @ $0.48 (filled)
Buy DOWN  @ FOK rejected
Sell UP   @ FOK rejected (no bid liquidity)
→ Holding naked UP position
If UP wins: receive $1.00, profit = $0.52/share
If UP loses: receive $0.00, loss = $0.48/share
```
This is pure directional risk. The predictor's accuracy matters here.
**Probability**: Very low — requires both opposite-side and same-side liquidity to vanish simultaneously.

#### Scenario D: First Leg Not Filled — RISK: NONE
```
Buy UP @ GTC limit, not filled within 2s → cancelled
No capital deployed, no risk.
```

### 5.3 Overall Risk Score

**When the arb condition is verified and both legs fill: 0/10 risk** (mathematically guaranteed profit).

**Overall system risk accounting for all scenarios: 2/10.**

The dominant risk factor is the rare case where the second-leg FOK is rejected AND the bail-out sell also fails, leaving a naked directional position. The probability of this double failure is very low in liquid Polymarket crypto markets.

---

## 6. Configuration Reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `COPYTRADE_MARKETS` | `btc` | Which coins to trade (comma-separated) |
| `COPYTRADE_MARKET_INTERVAL_MINUTES` | `5` | Pool duration: `5` or `15` minutes |
| `COPYTRADE_SHARES` | `5` | Shares per leg (position size) |
| `COPYTRADE_TICK_SIZE` | `0.01` | CLOB tick size; must match the market |
| `COPYTRADE_NEG_RISK` | `false` | Must match market's neg-risk flag |
| `COPYTRADE_MIN_BALANCE_USDC` | `1` | Minimum USDC reserve to keep |
| `COPYTRADE_MAX_BUY_COUNTS_PER_SIDE` | `0` | Max pairs per pool per side (0 = unlimited) |
| `COPYTRADE_END_OF_WINDOW_FREEZE_SECONDS` | `45` | Stop trading N seconds before pool ends |
| `COPYTRADE_MAX_SPREAD` | `0.06` | Skip if bid-ask spread exceeds this |
| `COPYTRADE_MAX_SESSION_SPEND_USDC` | `0` | Circuit breaker: max total USDC spend (0 = unlimited) |
| `COPYTRADE_MAX_SPEND_PER_WINDOW_USDC` | `0` | Max USDC spend per pool window (0 = unlimited) |
| `COPYTRADE_FEE_RATE_BPS` | `0` | Your Polymarket fee rate in basis points (e.g. 20 = 0.2%) |
| `COPYTRADE_AUTO_REDEEM` | `true` | Auto-redeem winning shares after pool resolution |
| `COPYTRADE_REDEEM_POLL_INTERVAL_SECONDS` | `15` | How often to check if pool resolved |
| `COPYTRADE_REDEEM_MAX_ATTEMPTS` | `20` | Max resolution checks before giving up |

### Recommended Settings for Safe Operation

```env
COPYTRADE_SHARES=5
COPYTRADE_MAX_BUY_COUNTS_PER_SIDE=1
COPYTRADE_END_OF_WINDOW_FREEZE_SECONDS=45
COPYTRADE_MAX_SPREAD=0.06
COPYTRADE_FEE_RATE_BPS=0
COPYTRADE_AUTO_REDEEM=true
COPYTRADE_MIN_BALANCE_USDC=5
```

Setting `MAX_BUY_COUNTS_PER_SIDE=1` limits exposure to 1 pair per pool — the safest configuration with bounded maximum loss per pool.

---

## 7. Architecture Summary

```
WebSocket Orderbook (live prices)
        │
        ▼
AdaptivePricePredictor (pole detection → signal)
        │
        ▼
Pre-Trade Safety Gates (arb check, spread, balance, limits)
        │
        ▼
   ┌────┴────┐
   │  Leg 1  │  GTC limit @ ask + tick  →  verify fill
   └────┬────┘
        │ (filled with actual price)
        ▼
   ┌────┴────┐
   │  Leg 2  │  FOK @ opposite ask + tick (capped at max profitable price)
   └────┬────┘
        │
   ┌────┴────────────────┐
   │                     │
   ▼                     ▼
FILLED                REJECTED
   │                     │
   ▼                     ▼
Pair Complete        Bail-Out Sell
(guaranteed profit)  (FOK sell @ bid)
   │                     │
   ▼                     ▼
Auto-Redeem          Loss = spread
(after resolution)   (~$0.01/share)
```

---

## 8. Disclaimer

This document describes the strategy as implemented in code. It is not financial advice. Prediction markets involve risk of loss. The "guaranteed profit" described here depends on both legs of the trade executing successfully, which is not assured in all market conditions. Gas costs, fee changes, API outages, and liquidity conditions can affect actual results. Review Polymarket terms and your jurisdiction before trading.
