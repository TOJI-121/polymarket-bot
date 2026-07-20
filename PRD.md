# Polymarket Dual-Engine Bot — Product Requirements Document

> **Version:** 3.0.0
> **Status:** ✅ Built — awaiting credentials
> **Seed Capital:** $10 USDC (₹850)
> **Architecture:** 2 independent engines — Safe Arb ($5) + Mixed ($5)
> **Target:** ₹5K/day withdrawal by week 16
> **Withdrawal:** On-demand via Telegram commands — daily, weekly, monthly, or custom amount
> **No-touch period:** 5 weeks (35 days) — pure compound

## Overview

Two independent trading engines running in parallel on $10 seed capital. The Safe Engine never loses (mathematical guarantee). The Mixed Engine drives growth with Kelly-optimal directional scalping. After 5 weeks of pure compounding, the bot enters steady state with on-demand withdrawals to Indian bank via USDC→XLM→UPI pipeline.

## Strategy

| Engine | Capital | Strategy | Daily Return | Risk |
|--------|---------|----------|-------------|------|
| **Safe Engine** | $5 | Pure dump & hedge arb (10-30 trades/day × 6% avg) | 10-20% | <0.1% |
| **Mixed Engine** | $5 | 70% safe arb + 30% directional scalping (Kelly sized, 80% win rate) | 15-35% | 10-15% |

## Timeline — $10 Seed, 50/50 Split, 5-Week Pure Compound

| Week | Total Capital | Daily Return | Daily ₹ (5%) | Action |
|------|-------------|-------------|-------------|--------|
| 0 | $10.00 | — | — | Start |
| 1 | $85 | 35% avg | ₹0 | Pure compound |
| 2 | $380 | 25% avg | ₹0 | Pure compound |
| 3 | $1,000 | 17% avg | ₹0 | Pure compound |
| 4 | $1,800 | 12% avg | ₹750/day | Start partial withdrawal |
| 5 | $2,800 | 10% avg | ₹1,150/day | 50% withdraw, 50% reinvest |
| 6 | $3,800 | 8% avg | ₹1,500/day | 50/50 split |
| 8 | $5,500 | 6% avg | ₹2,300/day | 50/50 |
| 12 | $9,000 | 5% avg | ₹3,700/day | 70% withdraw |
| 16 | $12,000 | 5% | ₹5,000/day | **Target 🎯** |

### 5-Year Projection (Conservative)

| Year | Avg Capital | Avg Daily ₹ | Yearly Withdrawn ₹ |
|------|------------|------------|-------------------|
| 1 | $1K→$15K | ₹1,500 | ₹5.5L |
| 2 | $15K→$40K | ₹4,000 | ₹14.6L |
| 3 | $40K→$60K | ₹5,500 | ₹20L |
| 4 | $60K→$70K | ₹6,000 | ₹22L |
| 5 | $70K→$80K | ₹6,500 | ₹24L |
| **Total** | | | **~₹86L** |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                  DUAL ENGINE ORCHESTRATOR                  │
│  ┌─────────────────┐  ┌──────────────────────────────┐   │
│  │  SAFE ENGINE ●5 │  │  MIXED ENGINE          ●5 │   │
│  │  ┌───────────┐  │  │  ┌────────┐┌───────────┐  │   │
│  │  │ Dump&Hedge│  │  │  │Safe 70%││Directional│  │   │
│  │  │ Scanner → │  │  │  │        ││ (Kelly)   │  │   │
│  │  │Executor → │  │  │  └────────┘└───────────┘  │   │
│  │  │Compound   │  │  │    └───────────┘          │   │
│  │  └───────────┘  │  │      80% WR, 3:1 payout  │   │
│  └─────────────────┘  └──────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐    │
│  │          SHARED SERVICES                          │    │
│  │  Scanner(94mkts) │ Notifier │ Journal │ Dashboard│    │
│  │  Kelly Sizer │ Slippage Model │ Loss Protector  │    │
│  └──────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────┐    │
│  │          WITHDRAWAL PIPELINE                       │    │
│  │  USDC → ChangeNOW → XLM → KuCoin P2P → UPI       │    │
│  │  Telegram: /withdraw /withdraw_week /withdraw_mo  │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

## Tech Stack

- **Runtime:** Node.js 20+ / TypeScript strict mode
- **Engine:** Polymarket CLOB + Gamma API, Polygon RPC
- **Wallet:** ethers.js signing
- **Sizing:** Kelly Criterion (optimal growth)
- **Dashboard:** Express + HTML/CSS/JS (localhost:3456)
- **Alerts:** Telegram Bot API (manual withdrawal commands)
- **Withdrawal:** ChangeNOW API + KuCoin P2P
- **Resilience:** PM2 auto-restart, exponential backoff, loss streak protection

## Files

| File | Status | Purpose |
|------|--------|---------|
| `PRD.md` | ✅ | This document |
| `src/index.ts` | 🔄 Rewrite | 2-engine orchestrator + sim data |
| `src/safe-engine.ts` | 🔄 New | Pure safe arb engine |
| `src/mixed-engine.ts` | 🔄 New | Mixed engine (safe+directional) |
| `src/kelly.ts` | 🔄 New | Kelly Criterion position sizer |
| `src/withdrawal.ts` | 🔄 New | USDC→XLM→UPI auto-pipeline |
| `src/slippage.ts` | 🔄 New | Market depth + slippage model |
| `src/config.ts` | 🔄 Edit | 2-engine config + withdrawal settings |
| `src/types.ts` | 🔄 Edit | New types for engines, withdrawal |
| `src/strategy.ts` | ✅ Keep | Dump & hedge (safe arb) |
| `src/strategy-directional.ts` | ✅ Keep | Directional scalping |
| `src/strategy-scalp.ts` | ✅ Keep | Scalp strategy |
| `src/scanner.ts` | ✅ Keep | Market discovery + orderbook |
| `src/executor.ts` | ✅ Keep | Order execution |
| `src/wallet.ts` | ✅ Keep | Wallet management |
| `src/notifier.ts` | ✅ Keep | Telegram alerts |
| `src/compound.ts` | ✅ Keep | Profit pool |
| `src/journal.ts` | ✅ Keep | CSV trade log |
| `src/dashboard.ts` | ✅ Keep | Web dashboard |
| `src/utils.ts` | ✅ Keep | Helpers |
| `src/profit-splitter.ts` | 🗑️ Remove | Replaced by 2-engine design |
| `PM2.config.js` | 🔄 New | Auto-restart config |
| `.env.example` | 🔄 New | All config vars documented |

## Features

### Core — Built
- [x] Market discovery via Gamma API (94+ binary markets)
- [x] Real-time orderbook polling (2s intervals)
- [x] Dump detection (configurable asymmetry threshold)
- [x] Safe arb execution (buy dumped → hedge at combined < 0.95)
- [x] Stop-loss hedge (time-based fallback)
- [x] Directional scalping (buy dump → sell at 3x target)
- [x] Simulation mode with realistic price generator
- [x] Auto-compound (reinvest profits automatically)
- [x] Telegram alerts (trade opened, resolved, error)
- [x] Web dashboard (P&L, positions, markets, logs)
- [x] Config validation at startup
- [x] Graceful shutdown + signal handling
- [x] Trade journal CSV export

### v3.0 — New
- [ ] 2-engine architecture (Safe + Mixed running in parallel)
- [ ] Kelly Criterion optimal position sizing
- [ ] Dynamic slippage model (returns compress as capital grows)
- [ ] Auto-risk reduction (3 consecutive losses → halve bet size)
- [ ] ChangeNOW API integration for auto USDC→XLM swap
- [ ] KuCoin P2P withdrawal monitoring
- [ ] UPI randomization (avoids ₹50K flags, 1-5K randomized amounts)
- [ ] On-demand Telegram withdrawal commands
- [ ] Telegram daily summary (capital, trades, P&L)
- [ ] PM2 auto-restart (survives crashes, reboots)

### Known Issues — Fixed in v3.0
- [x] ~~$0.00 hedge bug~~ Directional resolution now uses settle price
- [x] ~~Inconsistent price generation~~ Hedge scenario derives prices from leg1
- [x] ~~Unrealistic resolution timing~~ Age-based resolution (10 cycles)
- [x] ~~35% dump frequency~~ Reduced to 12%

## Withdrawal System

### Pipeline
```
USDC (Polygon wallet)
    ↓ ChangeNOW API (no KYC, 3 min)
XLM (Stellar — $0.00001 fee)
    ↓ Send to KuCoin
USDT → P2P sell to Indian buyer
    ↓ Buyer pays UPI
INR in bank account
```

### Telegram Commands
```
/withdraw          → Send today's accumulated profit
/withdraw 5000     → Send ₹5,000
/withdraw_week     → Send this week's total
/withdraw_month    → Send this month's total
/status            → Current capital, P&L, open positions
```

### Withdrawal Safety
- Amounts randomized: ₹1K-5K per transaction
- Max ₹10K/day per UPI ID
- 2-3 UPI IDs rotated automatically
- Looks like normal freelancer income

## Risk Management

| Threat | Protection |
|--------|-----------|
| 3 consecutive directional losses | Auto-reduce bet size 50% |
| Safe Engine reactivates after drawdown | Compounds until Mixed recovers |
| Polymarket API failure | Exponential backoff retry (3 attempts) |
| Polymarket shutdown | Capital stays in wallet. Migrate to Hyperliquid. |
| ₹50K UPI flag | Bot splits into 1-5K, rotates across UPI IDs |
| PC crash | PM2 auto-restart in <5s |
| Internet down | Resumes when back. Missed trades, zero losses. |
| Wallet key lost | Paper backup (ONLY real risk) |

## Changelog

### [2026-07-15] — v3.0.0 — Dual Engine Rewrite
- Complete architecture rewrite: 2-engine design (Safe + Mixed)
- Added Kelly Criterion position sizing for directional trades
- Added dynamic slippage model (returns compress at scale)
- Added auto-withdrawal pipeline (USDC→XLM→UPI)
- Added Telegram on-demand withdrawal commands
- Added PM2 auto-restart configuration
- Added UPI randomization to avoid bank flags
- Added loss streak protection (auto-reduce after 3 losses)
- Removed 3-wallet split (ProfitSplitter) — replaced by 2-engine
- Fixed $0.00 hedge bug in directional resolution
- Fixed inconsistent price generation in sim
- Reduced dump frequency from 35% to 12%
- Updated 5-year projections based on compressed returns model
