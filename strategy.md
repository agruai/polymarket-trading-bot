# Trading strategy (this repository)

This document describes the **strategies implemented in code**: what the default bot does, how signals are produced, how orders are placed, and what older alternate code paths exist but are **not** started by `npm start`.

---

## 1. Executive summary

The **live entrypoint** (`src/index.ts`) runs **`PredictiveArbBot`** (`src/order-builder/predictiveArb.ts`). It is:

1. **Directional signal** from an **adaptive price predictor** on the **Up** outcome’s best ask (with pole detection and feature-based confidence).
2. **Two-step limit order flow**: buy the predicted side first (aggressive limit at ask + one tick), then place a **hedge limit** on the opposite outcome at a **fixed structural price** derived from the first fill price.

A separate **legacy** module (`src/trade/decision.ts`) implements **rule-based** strategies (`trade_1`, `trade_2`) around time and price distance from 0.5; that stack is **not wired** to the current main entrypoint.

---

## 2. Active strategy: `PredictiveArbBot`

### 2.1 Market universe

- **Instruments:** Polymarket **crypto Up/Down** markets (e.g. BTC, ETH), configured via `COPYTRADE_MARKETS` env var.
- **Time windows:** `COPYTRADE_MARKET_INTERVAL_MINUTES` is **5 or 15** minutes. The bot builds Gamma API slugs of the form  
  `{coin}-updown-{5|15}m-{windowStartUnixSeconds}`  
  (see `src/utils/marketInterval.ts`).
- **Data:** Best bid/ask updates over **WebSocket** (`src/providers/websocketOrderbook.ts`). The predictor is driven primarily by the **Up token best ask**; both Up and Down asks are read when deciding execution prices.

### 2.2 When a prediction exists (signal engine)

Implementation: `src/utils/pricePredictor.ts` — class **`AdaptivePricePredictor`**.

**Inputs**

- New **Up** best ask (and timestamp), after basic validity checks (e.g. price inside a configured min/max band).

**Noise filter**

- Very small moves vs the last added price are ignored (no history update, no prediction).

**History**

- Smoothed prices are stored in a **fixed-size ring buffer** (efficient updates).

**Pole detection**

- Full predictions are emitted only at **pole-like** points: local **peaks** or **troughs** in the smoothed series, with extra rules so consecutive poles require sufficient move or a type flip (reduces spam).

**Model (high level)**

- Features include **lags**, **momentum**, **volatility**, **trend** (EMA-based combinations).
- A **linear-style** predictor combines weighted features; weights are updated with **online-style** learning from prior steps.
- **Confidence** is a calibrated blend of volatility, trend, momentum, prediction magnitude, rolling accuracy, stability penalties, caps, etc. (see `calculateConfidence`).

**Outputs**

- `direction`: `"up"` | `"down"` (always one of the two).
- `confidence`: typically capped (e.g. hard cap around 0.92) with conservative behavior when recent accuracy is poor.
- `signal`: `"BUY_UP"` | `"BUY_DOWN"` | `"HOLD"` from `generateSignal`, which requires alignment between direction, trend, momentum, volatility bands, and adaptive confidence thresholds.

If the predictor is **not** at a pole, `updateAndPredict` returns **`null`** — the bot does not trade on that tick.

### 2.3 When the bot is allowed to trade (execution gates)

Implementation: `executePredictionTrade` in `src/order-builder/predictiveArb.ts`.

All of the following must pass (non-exhaustive; order matters in code):

| Gate | Purpose |
|------|--------|
| **Confidence** | `prediction.confidence >= 0.50` |
| **Signal** | `prediction.signal !== "HOLD"` |
| **Direction** | Maps to buying **UP** or **DOWN** token at the corresponding **best ask** |
| **Paused market** | If this window’s `scoreKey` is in `pausedMarkets`, skip |
| **Per-side cap** | If `COPYTRADE_MAX_BUY_COUNTS_PER_SIDE > 0`, skip buying a side that already reached the cap (`src/trading/limits.ts`) |
| **Balance** | Refreshes CLOB balance/allowance estimate (throttled). If `COPYTRADE_MIN_BALANCE_USDC > 0`, estimated available must be **≥** that value |
| **Concurrency** | A per-market lock prevents overlapping `executePredictionTrade` while a prior run still awaits the API |

### 2.4 Order execution: two legs

#### Leg A — First side (directional)

- **Side:** UP or DOWN according to `prediction.direction` (and signal).
- **Size:** `COPYTRADE_SHARES` shares.
- **Price:** **Best ask + one tick**, where **tick** is parsed from `COPYTRADE_TICK_SIZE` (must match the market’s CLOB tick size).
- **Order type:** **GTC** limit via `createAndPostOrder`.
- **Retry:** Up to **2** attempts with a short delay on failure; second-side is placed **only if** this leg returns a valid `orderID`.

#### Leg B — Second side (hedge / paired limit)

- **Side:** The **opposite** outcome to leg A.
- **Size:** Same `COPYTRADE_SHARES`.
- **Price:**  
  **`limitPrice = 0.98 - firstSidePrice`**  
  where `firstSidePrice` is the **best ask** used for leg A (not the filled price). Invalid if not in `(0, 1)`.
- **Order type:** **GTC** limit.
- **Tracking:** Order may be polled asynchronously so fills can update internal counts/costs; caps can pause the market if fills would exceed limits.

**Economic interpretation (structural, not a guarantee)**

- The pair is designed so the **sum of limit prices** for the two legs is tied to **~0.98 + one_tick** in the idealized case (exact fill prices and fees differ in practice). This is a **paired exposure** template, not risk-free arbitrage: execution, partial fills, fees, and resolution risk still apply.

### 2.5 Risk, rotation, and state

- **Slug rotation:** When the clock moves to a new Up/Down window, the slug changes; the bot **re-fetches** token IDs, **rewires** WebSocket subscriptions, and **resets** the predictor for that market.
- **Per-window scoring:** In-memory structures track costs, counts, and optional “prediction vs outcome” logging for dashboards; summaries can be emitted at interval boundaries or on shutdown.
- **Persistence:** `src/data/predictive-arb-state.json` stores lightweight row data (e.g. `conditionId`, slug) for continuity and tooling.
- **Metrics:** Counters such as poles hit, first-side orders, second-side orders (`src/utils/metrics.ts`) for observability.

---

## 3. Configuration reference (strategy-relevant)

| Variable | Role |
|----------|------|
| `COPYTRADE_MARKETS` | Which coins to run (comma-separated). |
| `COPYTRADE_MARKET_INTERVAL_MINUTES` | `5` or `15` — must match live Polymarket listings. |
| `COPYTRADE_SHARES` | Shares per leg (position size). |
| `COPYTRADE_TICK_SIZE` | CLOB tick size; used for first-side limit offset and order options. |
| `COPYTRADE_NEG_RISK` | Passed to CLOB `createAndPostOrder` options; must match market type. |
| `COPYTRADE_MIN_BALANCE_USDC` | Skip new trades if estimated available USDC is below this. |
| `COPYTRADE_MAX_BUY_COUNTS_PER_SIDE` | `0` = unlimited; else max **buys per outcome** per window before that side (or both) stops / pauses. |

See `src/config/index.ts` for the full list including `BOT_MIN_USDCBalance` (startup gate) and RPC settings for on-chain actions.

---

## 4. Legacy strategies (not used by default `npm start`)

Located under `src/trade/` and driven by TOML-shaped config (`src/config/toml.ts` / `globalThis.__CONFIG__`):

- **`trade_1`:** Exit when **remaining time ratio** or **Up price distance from 0.5** crosses configured thresholds; sells current holding.
- **`trade_2`:** Uses **entry/exit bands** on a price ratio vs 0.5, **time** gates, optional **emergency swap** (sell then buy opposite in a band), and a default entry rule comparing Up vs Down when flat.

These attach to a **`Trade`** class with **market orders (FAK)** and different lifecycle than `PredictiveArbBot`. **The current `src/index.ts` does not import this path.**

---

## 5. Supporting code (not a standalone strategy)

- **`src/order-builder/helpers.ts`:** Converts a `TradePayload`-style object into a CLOB **market order** — useful for integrations, not the core `PredictiveArbBot` loop.
- **Redeem scripts (`src/redeem*.ts`):** **Post-resolution** on-chain redemption of winning tokens — **not** a trading strategy.

---

## 6. Disclaimer

This file describes **what the code does**. It is **not** financial advice. Prediction markets involve **risk of loss**. Past or backtested performance in README material does not guarantee future results. Review Polymarket terms, fees, and your jurisdiction before trading.
