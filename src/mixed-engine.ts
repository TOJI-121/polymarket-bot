import { Config, EngineState, EngineId, OrderbookSnapshot, Position, StrategyDecision, Trade } from './types';
import { DumpHedgeStrategy } from './strategy';
import { ScalpStrategy } from './strategy-scalp';
import { ExecutionEngine } from './executor';
import { AutoCompound } from './compound';
import { TradeJournal } from './journal';
import { Notifier } from './notifier';
import { KellyCalculator } from './kelly';
import { SlippageModel } from './slippage';
import { getLogger, formatUSD, now } from './utils';

export class MixedEngine {
  readonly id: EngineId = 'mixed';
  private config: Config;
  private logger: ReturnType<typeof getLogger>;
  private safeArb: DumpHedgeStrategy;
  private scalp: ScalpStrategy;
  private executor: ExecutionEngine;
  private compound: AutoCompound;
  private journal: TradeJournal;
  private notifier: Notifier;
  private kelly: KellyCalculator;
  private slippage: SlippageModel;
  private state: EngineState;
  private scalpKelly: KellyCalculator;

  private safeAllocation = 0.70;
  private directionalAllocation = 0.30;

  constructor(
    config: Config,
    executor: ExecutionEngine,
    compound: AutoCompound,
    journal: TradeJournal,
    notifier: Notifier
  ) {
    this.config = config;
    this.logger = getLogger(config);
    this.safeArb = new DumpHedgeStrategy(config);
    this.scalp = new ScalpStrategy(config, 'mixed');
    this.executor = executor;
    this.compound = compound;
    this.journal = journal;
    this.notifier = notifier;
    this.kelly = new KellyCalculator(0.80, 3.0);
    this.scalpKelly = new KellyCalculator(0.75, 2.5);
    this.slippage = new SlippageModel();
    this.state = this.createInitialState();
  }

  private createInitialState(): EngineState {
    return {
      id: 'mixed',
      name: 'Mixed Engine',
      capital: this.config.mixedCapital,
      availableBalance: this.config.mixedCapital,
      initialCapital: this.config.mixedCapital,
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

  getSafeArb(): DumpHedgeStrategy {
    return this.safeArb;
  }

  getScalp(): ScalpStrategy {
    return this.scalp;
  }

  async processSnapshot(snapshot: OrderbookSnapshot): Promise<void> {
    if (this.state.availableBalance < 0.01) return;

    const safeBalance = this.state.availableBalance * this.safeAllocation;
    const directionalBalance = this.state.availableBalance * this.directionalAllocation;

    await this.processSafeArb(snapshot, safeBalance);
    await this.processDirectional(snapshot, directionalBalance);
  }

  private async processSafeArb(snapshot: OrderbookSnapshot, balance: number): Promise<void> {
    if (balance < 0.01) return;

    const decisions = this.safeArb.analyze(snapshot, balance);

    for (const decision of decisions) {
      await this.handleSafeDecision(snapshot, decision);
    }
  }

  private async processDirectional(snapshot: OrderbookSnapshot, balance: number): Promise<void> {
    if (balance < 0.01) return;

    const decisions = this.scalp.analyze(snapshot, balance);

    for (const decision of decisions) {
      await this.handleScalpDecision(snapshot, decision);
    }
  }

  private async handleSafeDecision(snapshot: OrderbookSnapshot, decision: StrategyDecision): Promise<void> {
    const { action, reason, side, price, shares } = decision;
    this.logger.info(`[MIXED-SAFE] ${action} ${reason}`);

    switch (action) {
      case 'BUY_LEG1': {
        const trade = await this.executor.buyLeg1(snapshot, side!, price!, shares!, 'mixed');
        if (trade.status !== 'filled') return;

        const pos = this.safeArb.createPosition(snapshot, trade);
        this.state.availableBalance -= trade.totalCost;
        await this.notifier.onTradeOpened(pos);
        break;
      }

      case 'HEDGE':
      case 'STOP_LOSS_HEDGE': {
        const trade = await this.executor.buyHedge(snapshot, side!, price!, shares!, 'mixed');
        if (trade.status !== 'filled') return;

        this.state.availableBalance -= trade.totalCost;
        const completedPos = this.safeArb.addHedge(snapshot.market, trade);
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
          `[MIXED-SAFE] ${completedPos.asset} → ${profit >= 0 ? '+' : ''}${formatUSD(profit)} `
        );
        break;
      }
    }
  }

  private async handleScalpDecision(snapshot: OrderbookSnapshot, decision: StrategyDecision): Promise<void> {
    const { action, reason, side, price, shares, targetPrice } = decision;
    this.logger.info(`[MIXED-SCALP] ${action} ${reason}`);

    switch (action) {
      case 'BUY_LEG1': {
        const kellyResult = this.kelly.recommendedBetSize(
          this.state.availableBalance * this.directionalAllocation,
          price!,
          this.state.consecutiveLosses
        );

        const finalShares = Math.min(kellyResult.shares, shares || kellyResult.shares);
        if (finalShares < 1) return;

        const trade = await this.executor.buyLeg1(snapshot, side!, price!, finalShares, 'mixed');
        if (trade.status !== 'filled') return;

        const pos = this.scalp.createPosition(snapshot, trade, targetPrice);
        this.state.availableBalance -= trade.totalCost;
        await this.notifier.onTradeOpened(pos);
        break;
      }

      case 'SELL': {
        const pos = this.scalp.getPositionForMarket(snapshot.market);
        if (!pos) return;

        const completed = this.scalp.scalpComplete(snapshot.market, price!);
        if (!completed) return;

        const profit = completed.profit;
        this.compound.addProfit(Math.max(0, profit));
        this.state.availableBalance += profit + (pos.leg1?.totalCost || 0);

        this.state.completedTrades++;
        this.state.totalProfit += Math.max(0, profit);
        this.state.totalLoss += Math.max(0, -profit);

        this.journal.logTrade(completed);
        await this.notifier.onTradeCompleted(completed);
        break;
      }

      case 'STOP_LOSS_HEDGE': {
        const trade = await this.executor.buyHedge(snapshot, side!, price!, shares!, 'mixed');
        if (trade.status !== 'filled') return;

        this.state.availableBalance -= trade.totalCost;

        const completedPos = this.scalp.addHedge(snapshot.market, trade);
        if (!completedPos) return;

        const profit = completedPos.profit;
        this.compound.addProfit(Math.max(0, profit));
        this.state.availableBalance += profit + (completedPos.leg1?.totalCost || 0) + (completedPos.leg2?.totalCost || 0);

        this.state.completedTrades++;
        this.state.totalProfit += Math.max(0, profit);
        this.state.totalLoss += Math.max(0, -profit);

        this.journal.logTrade(completedPos);
        await this.notifier.onTradeCompleted(completedPos);
        break;
      }
    }
  }

  syncState(): void {
    const allSafe = this.safeArb.getAllPositions();
    const allScalp = this.scalp.getAllPositions();
    const allPositions = [...allSafe, ...allScalp];

    const completed = allPositions.filter(p => p.status === 'complete' || p.status === 'stop_loss');
    const wins = completed.filter(p => p.profit >= 0);
    const losses = completed.filter(p => p.profit < 0);

    const safeOpen = this.safeArb.getOpenPositions();
    const scalpOpen = this.scalp.getOpenPositions();

    this.state.openPositions = [...safeOpen, ...scalpOpen];
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
    this.safeArb.removeFinishedPositions();
    this.scalp.removeFinishedPositions();
  }
}
