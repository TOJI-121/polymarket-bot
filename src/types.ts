export interface Market {
  conditionId: string;
  tokenId: string;
  noTokenId: string;
  outcome: string;
  price: number;
  timestamp: number;
  slug: string;
  asset: string;
  period: number;
  endTimestamp: number;
}

export interface OrderbookSnapshot {
  market: string;
  yes: { bid: number; ask: number };
  no: { bid: number; ask: number };
  timestamp: number;
  endTimestamp: number;
}

export interface Trade {
  id: string;
  market: string;
  asset: string;
  engine: EngineId;
  side: 'YES' | 'NO';
  price: number;
  shares: number;
  totalCost: number;
  timestamp: number;
  status: 'pending' | 'filled' | 'partial' | 'cancelled' | 'redeemed';
  txHash?: string;
}

export interface Position {
  id: string;
  asset: string;
  period: number;
  strategy: StrategyMode;
  engine: EngineId;
  leg1: Trade | null;
  leg2: Trade | null;
  totalCost: number;
  expectedPayout: number;
  profit: number;
  status: 'watching' | 'leg1_filled' | 'hedging' | 'complete' | 'stop_loss' | 'error';
  createdAt: number;
  resolvedAt?: number;
}

export interface EngineState {
  id: EngineId;
  name: string;
  capital: number;
  availableBalance: number;
  initialCapital: number;
  openPositions: Position[];
  completedTrades: number;
  totalProfit: number;
  totalLoss: number;
  winRate: number;
  consecutiveLosses: number;
}

export interface BotState {
  totalCapital: number;
  safeEngine: EngineState;
  mixedEngine: EngineState;
  compoundPool: number;
  completedTrades: number;
  totalProfit: number;
  totalLoss: number;
  winRate: number;
  startTime: number;
  isRunning: boolean;
  mode: 'simulation' | 'production' | 'paper_trade';
  marketCount: number;
  withdrawalMode: 'compound' | 'partial' | 'full';
  dailyWithdrawCap: number;
}

export type EngineId = 'safe' | 'mixed' | 'fresh' | 'sports';
export type StrategyMode = 'safe_arb' | 'scalp' | 'directional' | 'fresh_market' | 'sports_scalp' | 'fresh_arb';

export interface WalletConfigEntry {
  key: string;
  proxy: string;
}

export interface Config {
  engineMode: 'dual' | 'safe_only' | 'mixed_only';
  safeCapital: number;
  mixedCapital: number;
  signatureType: number;
  gammaApiUrl: string;
  clobApiUrl: string;
  polygonRpc: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  markets: string[];
  allMarkets: boolean;
  dumpHedgeShares: number;
  dumpHedgeSharesMax: number;
  dumpHedgeCapitalFraction: number;
  dumpHedgeSumTarget: number;
  dumpHedgeMoveThreshold: number;
  dumpHedgeMinDumpPrice: number;
  dumpHedgeStopLossMaxWaitMinutes: number;
  dumpHedgeStopLossPercentage: number;
  scalpProfitTarget: number;
  scalpHedgeTimeoutMs: number;
  kellyFraction: number;
  maxConsecutiveLosses: number;
  lossReducerMultiplier: number;
  withdrawalEnabled: boolean;
  withdrawalMinBalance: number;
  withdrawalMaxDaily: number;
  changenowApiKey?: string;
  kucoinApiKey?: string;
  kucoinApiSecret?: string;
  upiIds: string[];
  simulation: boolean;
  paperTrade: boolean;
  logLevel: string;
}

export interface PerformanceMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalProfit: number;
  totalLoss: number;
  netProfit: number;
  averageReturn: number;
  bestTrade: number;
  worstTrade: number;
  sharpeRatio: number;
  maxDrawdown: number;
  currentDrawdown: number;
}

export interface DashboardData {
  state: BotState;
  metrics: PerformanceMetrics;
  compoundStats: { profitPool: number; totalReinvested: number };
  recentTrades: Position[];
  currentMarkets: OrderbookSnapshot[];
  withdrawalQueue: WithdrawalRequest[];
  timestamp: number;
}

export interface KellyResult {
  fraction: number;
  shares: number;
  cost: number;
}

export interface SlippageEstimate {
  expectedPrice: number;
  actualPrice: number;
  slippagePercent: number;
  level: 'none' | 'low' | 'medium' | 'high';
}

export interface WithdrawalRequest {
  id: string;
  amountUSD: number;
  amountINR: number;
  upiId: string;
  status: 'pending' | 'swapping' | 'sending' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
  txHash?: string;
  error?: string;
}

export interface StrategyDecision {
  action: 'BUY_LEG1' | 'HEDGE' | 'STOP_LOSS_HEDGE' | 'SELL' | 'RESOLVE' | 'WAIT';
  reason: string;
  side?: 'YES' | 'NO';
  price?: number;
  shares?: number;
  targetPrice?: number;
  settlePrice?: number;
}

export const PERIOD_MS = 15 * 60 * 1000;

export const ENGINE_NAMES: Record<EngineId, string> = { safe: 'Safe Engine', mixed: 'Mixed Engine', fresh: 'Fresh Market', sports: 'Sports Scalper' };
export const ENGINE_INITIAL: Record<EngineId, number> = { safe: 5, mixed: 5, fresh: 0, sports: 0 };
export const ENGINE_COLORS: Record<EngineId, string> = { safe: '#3fb950', mixed: '#d29922', fresh: '#58a6ff', sports: '#f78166' };

// Dashboard compatibility types
export type WalletId = 'safe' | 'mixed';
export interface WalletState {
  id: WalletId;
  strategy: string;
  name: string;
  totalCapital: number;
  availableBalance: number;
  openPositions: Position[];
  completedTrades: number;
  totalProfit: number;
  totalLoss: number;
  winRate: number;
  initialCapital: number;
}
export const WALLET_NAMES: Record<WalletId, string> = { safe: 'Safe Engine', mixed: 'Mixed Engine' };
export const WALLET_STRATEGIES: Record<WalletId, string> = { safe: 'safe_arb', mixed: 'mixed' };
export const WALLET_COLORS: Record<WalletId, string> = { safe: '#3fb950', mixed: '#d29922' };
export const WALLET_INITIAL: Record<WalletId, number> = { safe: 5, mixed: 5 };
