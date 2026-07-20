import { Config, EngineState, EngineId, OrderbookSnapshot, Position, StrategyDecision, Trade } from './types';
import { DumpHedgeStrategy } from './strategy';
import { ExecutionEngine } from './executor';
import { AutoCompound } from './compound';
import { TradeJournal } from './journal';
import { Notifier } from './notifier';
import { SlippageModel } from './slippage';
import { getLogger, formatUSD, now } from './utils';

export class SafeEngine {
  readonly id: EngineId = 'safe';
  private config: Config;
  private logger: ReturnType<typeof getLogger>;
  private strategy: DumpHedgeStrategy;
  private executor: ExecutionEngine;
  private compound: AutoCompound;
  private journal: TradeJournal;
  private notifier: Notifier;
  private slippage: SlippageModel;
  private state: EngineState;
  private marketOrderbooks: Map<string, OrderbookSnapshot> = new Map();

  constructor(
    config: Config,
    executor: ExecutionEngine,
    compound: AutoCompound,
    journal: TradeJournal,
    notifier: Notifier
  ) {
    this.config = config;
    this.logger = getLogger(config);
    this.strategy = new DumpHedgeStrategy(config);
    this.executor = executor;
    this.compound = compound;
    this.journal = journal;
    this.notifier = notifier;
    this.slippage = new SlippageModel();
    this.state = this.createInitialState();
  }

  private createInitialState(): EngineState {
    return {
      id: 'safe',
      name: 'Safe Engine',
      capital: this.config.safeCapital,
      availableBalance: this.config.safeCapital,
      initialCapital: this.config.safeCapital,
      openPositions: [],
      completedTrades: 0,
      totalProfit: 0,
      totalLoss: 0,
      winRate: 0,
      consecutiveLosses: 0,
    };
  }

  getState(): EngineState {
    return { ...this.state };
  }

  getStrategy(): DumpHedgeStrategy {
    return this.strategy;
  }

  async processSnapshot(snapshot: OrderbookSnapshot): Promise<void> {
    if (this.state.availableBalance < 0.01) return;

    const decisions = this.strategy.analyze(snapshot, this.state.availableBalance);

    for (const decision of decisions) {
      await this.handleDecision(snapshot, decision);
    }
  }

  private async handleDecision(snapshot: OrderbookSnapshot, decision: StrategyDecision): Promise<void> {
    const { action, reason, side, price, shares } = decision;
    this.logger.info(`[SAFE] ${action} ${reason}`);

    switch (action) {
      case 'BUY_LEG1': {
        const trade = await this.executor.buyLeg1(snapshot, side!, price!, shares!, 'safe');
        if (trade.status !== 'filled') return;

        const pos = this.strategy.createPosition(snapshot, trade);
        this.state.availableBalance -= trade.totalCost;
        await this.notifier.onTradeOpened(pos);
        break;
      }

      case 'HEDGE':
      case 'STOP_LOSS_HEDGE': {
        const trade = await this.executor.buyHedge(snapshot, side!, price!, shares!, 'safe');
        if (trade.status !== 'filled') return;

        this.state.availableBalance -= trade.totalCost;

        const completedPos = this.strategy.addHedge(snapshot.market, trade);
        if (!completedPos) return;

        const profit = completedPos.profit;
        const toReturn = (completedPos.leg1?.totalCost || 0) + (completedPos.leg2?.totalCost || 0);

        this.compound.addProfit(Math.max(0, profit));
        this.state.availableBalance += toReturn;

        this.state.completedTrades++;
        this.state.totalProfit += Math.max(0, profit);
        this.state.totalLoss += Math.max(0, -profit);

        this.journal.logTrade(completedPos);
        await this.notifier.onTradeCompleted(completedPos);

        this.logger.info(
          `[SAFE] Completed ${completedPos.asset} → ` +
          `${profit >= 0 ? '+' : ''}${formatUSD(profit)} ` +
          `(${((profit / (completedPos.totalCost || 1)) * 100).toFixed(1)}%)`
        );
        break;
      }
    }
  }

  syncState(): void {
    const allPositions = this.strategy.getAllPositions();
    const completed = allPositions.filter(p => p.status === 'complete' || p.status === 'stop_loss');
    const wins = completed.filter(p => p.profit >= 0);
    const losses = completed.filter(p => p.profit < 0);

    this.state.openPositions = this.strategy.getOpenPositions();
    this.state.completedTrades = completed.length;
    this.state.totalProfit = wins.reduce((s, p) => s + p.profit, 0);
    this.state.totalLoss = losses.reduce((s, p) => s + Math.abs(p.profit), 0);
    this.state.winRate = completed.length > 0 ? wins.length / completed.length : 0;
    this.state.consecutiveLosses = this.calcConsecutiveLosses(completed);
    this.state.capital = this.state.availableBalance;
  }

  private calcConsecutiveLosses(positions: Position[]): number {
    const sorted = [...positions].sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0));
    let count = 0;
    for (const p of sorted) {
      if (p.profit < 0) count++;
      else break;
    }
    return count;
  }

  removeFinishedPositions(): void {
    this.strategy.removeFinishedPositions();
  }
}
