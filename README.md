# Polymarket Arbitrage Bot · Polymarket Trading Bot

**Polymarket predictive-arb bot** for automated prediction-market trading. This **Polymarket trading bot** trades Polymarket **5-minute** (default) or **15-minute** Up/Down markets (e.g. BTC, ETH) using the CLOB API, WebSocket orderbook, and an adaptive price predictor with paired limit orders.

---


## What this bot does

Automated **Polymarket** trading on **5m or 15m Up/Down markets** (configure with `COPYTRADE_MARKET_INTERVAL_MINUTES`). It uses a price predictor to choose direction, places a first-side limit at best ask, then hedges with a second-side limit at `0.98 − firstSidePrice`. Built with TypeScript and Polymarket’s CLOB API.


## Proof of work

Bot logs from live runs: [logs](https://github.com/CrewSX/polymarket-trading-bot/tree/main/logs).


---

## Overview

- **Strategy**: Predict Up/Down from live orderbook via an adaptive price predictor; buy the predicted side at best ask (GTC), then place the opposite side at `0.98 − firstSidePrice` (GTC).
- **Markets**: Configurable list (e.g. `btc`, `eth`); slugs are `{market}-updown-{5|15}m-{windowStartUnix}` via Polymarket Gamma API (must match live Polymarket listings).
- **Stack**: TypeScript, Node (or Bun), `@polymarket/clob-client`, WebSocket orderbook, Ethers.js for allowances/redemption.

## Requirements

- Node.js 18+ (or Bun)
- Polygon wallet with USDC
- RPC URL for Polygon (e.g. Alchemy) for allowances and redemption

## Install

```bash
git clone https://github.com/agruai/polymarket-trading-bot.git
cd polymarket-trading-bot
npm install
```

## Configuration

Copy the example env and set at least `PRIVATE_KEY` and `COPYTRADE_MARKETS`:

```bash
cp .env.temp .env
```

| Variable | Description | Default |
|----------|-------------|---------|
| `PRIVATE_KEY` | Wallet private key | **required** |
| `COPYTRADE_MARKETS` | Comma-separated markets (e.g. `btc`) | `btc` |
| `COPYTRADE_SHARES` | Shares per side per trade | `5` |
| `COPYTRADE_TICK_SIZE` | Price precision | `0.01` |
| `COPYTRADE_PRICE_BUFFER` | Price buffer for execution | `0` |
| `COPYTRADE_MARKET_INTERVAL_MINUTES` | Up/Down window: `5` or `15` | `5` |
| `COPYTRADE_WAIT_FOR_NEXT_MARKET_START` | Wait for next interval boundary before starting | `false` |
| `COPYTRADE_MAX_BUY_COUNTS_PER_SIDE` | Max buys per side per market (0 = no cap) | `0` |
| `CHAIN_ID` | Chain ID (Polygon) | `137` |
| `CLOB_API_URL` | Polymarket CLOB API base URL | `https://clob.polymarket.com` |
| `RPC_URL` / `RPC_TOKEN` | RPC for allowances/redemption | — |
| `BOT_MIN_USDC_BALANCE` | Min USDC to start | `1` |
| `LOG_DIR` / `LOG_FILE_PREFIX` | Log directory and file prefix | `logs` / `bot` |

API credentials are created on first run and stored in `src/data/credential.json`.

## Usage

**Run the Polymarket trading bot**

```bash
npm start
# or: bun src/index.ts
```

**Redemption**

```bash
# Auto-redeem resolved markets (holdings file)
npm run redeem:holdings
# or: bun src/auto-redeem.ts [--dry-run] [--clear-holdings] [--api] [--max N]

# Redeem by condition ID
npm run redeem
# or: bun src/redeem.ts [conditionId] [indexSets...]
bun src/redeem.ts --check <conditionId>
```

**Development**

```bash
npx tsc --noEmit
bun --watch src/index.ts
```

**Tests**

```bash
npm test
```

**Observability**: set `DEBUG=true` to log periodic strategy counters (prediction poles, first/second-side orders) from `src/utils/metrics.ts`.

## Project structure

| Path | Role |
|------|------|
| `src/index.ts` | Entry: credentials, CLOB, allowances, min balance, start `PredictiveArbBot`. |
| `src/config/index.ts` | Loads `.env` and exposes config (chain, CLOB, predictive-arb, logging). |
| `src/order-builder/predictiveArb.ts` | **PredictiveArbBot**: 5m/15m slug resolution, WebSocket orderbook, predictor → first-side buy + second-side hedge; state in `src/data/predictive-arb-state.json`. |
| `src/utils/marketInterval.ts` | Slot timestamps, slug helper, interval boundaries (shared with redeem scripts). |
| `src/trading/limits.ts` | Pure helpers for per-side buy caps (used by PredictiveArbBot; covered by `npm test`). |
| `src/utils/metrics.ts` | Lightweight counters; summary logs when `DEBUG=true`. |
| `src/providers/clobclient.ts` | Polymarket CLOB client singleton (credentials + `PRIVATE_KEY`). |
| `src/providers/websocketOrderbook.ts` | WebSocket to Polymarket CLOB market channel; best bid/ask by token ID. |
| `src/utils/pricePredictor.ts` | **AdaptivePricePredictor**: direction, confidence, signal (BUY_UP / BUY_DOWN / HOLD). |
| `src/utils/redeem.ts` | CTF redemption, resolution checks, auto-redeem from holdings or API. |
| `src/security/allowance.ts` | USDC and CTF approvals. |
| `src/data/token-holding.json` | Token holdings for redemption (generated). |
| `src/data/predictive-arb-state.json` | Per-slug state (prices, timestamps, buy counts). |

## Risk and disclaimer

Trading prediction markets involves significant risk. This software is provided as-is. Use at your own discretion and only with funds you can afford to lose.

## License

ISC
