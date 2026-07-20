import express from 'express';
import path from 'path';
import http from 'http';
import { Config, BotState, PerformanceMetrics, OrderbookSnapshot, Position, WalletState, WalletId, WALLET_COLORS } from './types';
import { getLogger, now } from './utils';

const DASHBOARD_PORT = 3456;

export class DashboardServer {
  private app: express.Application;
  private server: http.Server;
  private logger: ReturnType<typeof getLogger>;
  private port: number;

  private state: BotState = {
    totalCapital: 10,
    safeEngine: {} as any,
    mixedEngine: {} as any,
    compoundPool: 0,
    completedTrades: 0,
    totalProfit: 0,
    totalLoss: 0,
    winRate: 0,
    startTime: now(),
    isRunning: true,
    mode: 'simulation',
    marketCount: 0,
    withdrawalMode: 'compound',
    dailyWithdrawCap: 5000,
  };

  private metrics: PerformanceMetrics = {
    totalTrades: 0, wins: 0, losses: 0, winRate: 0,
    totalProfit: 0, totalLoss: 0, netProfit: 0,
    averageReturn: 0, bestTrade: 0, worstTrade: 0,
    sharpeRatio: 0, maxDrawdown: 0, currentDrawdown: 0,
  };

  private walletStates: Record<WalletId, WalletState> = {} as Record<WalletId, WalletState>;
  private recentTrades: Position[] = [];
  private currentMarkets: OrderbookSnapshot[] = [];
  private compoundStats = { profitPool: 0, totalReinvested: 0 };

  constructor(config: Config, port: number = DASHBOARD_PORT) {
    this.port = port;
    this.logger = getLogger(config);
    this.app = express();

    this.app.use(express.static(path.join(__dirname, '..', 'dashboard')));

    this.app.get('/api/state', (_req, res) => {
      res.json({
        state: this.state,
        metrics: this.metrics,
        wallets: this.walletStates,
        compoundStats: this.compoundStats,
        recentTrades: this.recentTrades.slice(0, 50),
        currentMarkets: this.currentMarkets,
        timestamp: now(),
      });
    });

    this.server = http.createServer(this.app);
  }

  start(): void {
    let retries = 3;
    const tryListen = () => {
      this.server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && retries > 0) {
          retries--;
          this.port++;
          this.logger.warn(`Port ${this.port - 1} in use, trying ${this.port}...`);
          this.server = http.createServer(this.app);
          tryListen();
        } else {
          this.logger.error(`Failed to start dashboard: ${err.message}`);
        }
      });

      this.server.listen(this.port, () => {
        this.logger.info(`Dashboard running at http://localhost:${this.port}`);
      });
    };
    tryListen();
  }

  stop(): void {
    try { this.server.close(); } catch { }
  }

  updateState(partial: Partial<BotState>): void {
    Object.assign(this.state, partial);
  }

  updateMetrics(m: Partial<PerformanceMetrics>): void {
    Object.assign(this.metrics, m);
  }

  updateWalletStates(ws: Record<WalletId, WalletState>): void {
    this.walletStates = ws;
  }

  updateCompoundStats(stats: { profitPool: number; totalReinvested: number }): void {
    this.compoundStats = stats;
  }

  setRecentTrades(trades: Position[]): void {
    this.recentTrades = trades;
  }

  setCurrentMarkets(markets: OrderbookSnapshot[]): void {
    this.currentMarkets = markets;
  }
}
