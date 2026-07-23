import dotenv from 'dotenv';
import { Config } from './types';

dotenv.config();

function envStr(key: string, defaultVal?: string): string | undefined {
  return process.env[key] || defaultVal;
}

function envNum(key: string, defaultVal: number): number {
  const val = process.env[key];
  if (val === undefined || val === '') return defaultVal;
  const parsed = parseFloat(val);
  return isNaN(parsed) ? defaultVal : parsed;
}

function envBool(key: string, defaultVal: boolean): boolean {
  const val = process.env[key];
  if (val === undefined || val === '') return defaultVal;
  return val.toLowerCase() === 'true' || val === '1';
}

export interface ValidatedConfig extends Config {
  errors: string[];
}

export function loadConfig(): ValidatedConfig {
  const errors: string[] = [];

  const upiRaw = envStr('UPI_IDS', '') || '';
  const upiIds = upiRaw.split(',').map(s => s.trim()).filter(Boolean);

  const cfg: Config = {
    engineMode: (envStr('ENGINE_MODE', 'dual') as 'dual' | 'safe_only' | 'mixed_only'),
    safeCapital: envNum('SAFE_CAPITAL', 5),
    mixedCapital: envNum('MIXED_CAPITAL', 5),
    signatureType: envNum('SIGNATURE_TYPE', 2),
    gammaApiUrl: envStr('GAMMA_API_URL', 'https://gamma-api.polymarket.com')!,
    clobApiUrl: envStr('CLOB_API_URL', 'https://clob.polymarket.com')!,
    polygonRpc: envStr('POLYGON_RPC', 'https://polygon-rpc.com')!,
    telegramBotToken: envStr('TELEGRAM_BOT_TOKEN'),
    telegramChatId: envStr('TELEGRAM_CHAT_ID'),
    markets: (envStr('MARKETS', 'btc,eth,sol,xrp') || '').split(',').map(m => m.trim().toLowerCase()).filter(Boolean),
    allMarkets: envBool('ALL_MARKETS', true),
    dumpHedgeShares: envNum('DUMP_HEDGE_SHARES', 3),
    dumpHedgeSharesMax: envNum('DUMP_HEDGE_SHARES_MAX', 20),
    dumpHedgeCapitalFraction: envNum('DUMP_HEDGE_CAPITAL_FRACTION', 0.8),
    dumpHedgeSumTarget: envNum('DUMP_HEDGE_SUM_TARGET', 0.94),
    dumpHedgeMoveThreshold: envNum('DUMP_HEDGE_MOVE_THRESHOLD', 0.05),
    dumpHedgeMinDumpPrice: envNum('DUMP_HEDGE_MIN_DUMP_PRICE', 0.35),
    dumpHedgeStopLossMaxWaitMinutes: envNum('DUMP_HEDGE_STOP_LOSS_MAX_WAIT_MINUTES', 2),
    dumpHedgeStopLossPercentage: envNum('DUMP_HEDGE_STOP_LOSS_PERCENTAGE', 0.2),
    scalpProfitTarget: envNum('SCALP_PROFIT_TARGET', 2.0),
    scalpHedgeTimeoutMs: envNum('SCALP_HEDGE_TIMEOUT_MS', 60000),
    kellyFraction: envNum('KELLY_FRACTION', 0.50),
    maxConsecutiveLosses: envNum('MAX_CONSECUTIVE_LOSSES', 3),
    lossReducerMultiplier: envNum('LOSS_REDUCER_MULTIPLIER', 0.5),
    withdrawalEnabled: envBool('WITHDRAWAL_ENABLED', false),
    withdrawalMinBalance: envNum('WITHDRAWAL_MIN_BALANCE', 50),
    withdrawalMaxDaily: envNum('WITHDRAWAL_MAX_DAILY', 5000),
    changenowApiKey: envStr('CHANGENOW_API_KEY'),
    kucoinApiKey: envStr('KUCOIN_API_KEY'),
    kucoinApiSecret: envStr('KUCOIN_API_SECRET'),
    upiIds,
    simulation: envBool('SIMULATION', true),
    paperTrade: envBool('PAPER_TRADE', false),
    logLevel: envStr('LOG_LEVEL', 'info')!,
  };

  if (!cfg.simulation) {
    if (!cfg.telegramBotToken) errors.push('TELEGRAM_BOT_TOKEN required in production mode');
    if (!cfg.telegramChatId) errors.push('TELEGRAM_CHAT_ID required in production mode');
    if (cfg.withdrawalEnabled && !cfg.changenowApiKey) errors.push('CHANGENOW_API_KEY required for withdrawals');
  }

  if (cfg.markets.length === 0) errors.push('MARKETS must include at least one asset');
  if (cfg.safeCapital < 1) errors.push('SAFE_CAPITAL must be ≥ $1');
  if (cfg.mixedCapital < 1) errors.push('MIXED_CAPITAL must be ≥ $1');
  if (cfg.dumpHedgeShares < 1) errors.push('DUMP_HEDGE_SHARES must be ≥ 1');
  if (cfg.dumpHedgeSharesMax < cfg.dumpHedgeShares) errors.push('DUMP_HEDGE_SHARES_MAX must be ≥ DUMP_HEDGE_SHARES');
  if (cfg.dumpHedgeCapitalFraction <= 0 || cfg.dumpHedgeCapitalFraction > 1) errors.push('DUMP_HEDGE_CAPITAL_FRACTION must be 0 < fraction ≤ 1');
  if (cfg.dumpHedgeSumTarget <= 0 || cfg.dumpHedgeSumTarget > 1) errors.push('DUMP_HEDGE_SUM_TARGET must be 0 < target ≤ 1');
  if (cfg.dumpHedgeMoveThreshold <= 0 || cfg.dumpHedgeMoveThreshold >= 1) errors.push('DUMP_HEDGE_MOVE_THRESHOLD must be 0 < threshold < 1');
  if (cfg.kellyFraction <= 0 || cfg.kellyFraction > 1) errors.push('KELLY_FRACTION must be 0 < f ≤ 1');
  if (cfg.maxConsecutiveLosses < 1) errors.push('MAX_CONSECUTIVE_LOSSES must be ≥ 1');
  if (cfg.lossReducerMultiplier <= 0 || cfg.lossReducerMultiplier > 1) errors.push('LOSS_REDUCER_MULTIPLIER must be 0 < m ≤ 1');

  return { ...cfg, errors };
}
