import { loadConfig, ValidatedConfig } from './config';
import {
  getLogger, now, generateId, roundToCents, calcHedgeProfit, formatUSD, clamp
} from './utils';
import { MarketScanner } from './scanner';
import { ExecutionEngine } from './executor';
import { AutoCompound } from './compound';
import { Notifier } from './notifier';
import { TelegramCommander, BotAPI } from './telegram-commands';
import { DashboardServer } from './dashboard';
import { SafeEngine } from './safe-engine';
import { MixedEngine } from './mixed-engine';
import { WithdrawalManager } from './withdrawal';
import { KellyCalculator } from './kelly';
import { SlippageModel } from './slippage';
import { TradeJournal } from './journal';
import { FreshMarketStrategy } from './strategy-fresh-market';
import { SportsScalpStrategy } from './strategy-sports';
import {
  BotState, EngineState, OrderbookSnapshot, Market, WalletId,
  WalletState, Position, StrategyDecision, PERIOD_MS,
} from './types';

class DualEngineBot implements BotAPI {
  private config: ValidatedConfig;
  private logger: ReturnType<typeof getLogger>;
  private scanner: MarketScanner;
  private executor: ExecutionEngine;
  private compound: AutoCompound;
  private journal: TradeJournal;
  private notifier: Notifier;
  private telegram: TelegramCommander;
  private dashboard: DashboardServer;
  private safeEngine: SafeEngine;
  private mixedEngine: MixedEngine;
  private withdrawal: WithdrawalManager;
  private kelly: KellyCalculator;
  private slippage: SlippageModel;
  private freshMarket: FreshMarketStrategy;
  private sportsScalp: SportsScalpStrategy;

  private state: BotState;
  private isRunning = true;
  private activeMarkets: Market[] = [];
  private marketSlugs: Map<string, string> = new Map();
  private scanIntervalId: ReturnType<typeof setInterval> | null = null;
  private tradeIntervalId: ReturnType<typeof setInterval> | null = null;

  private startTimestamp: number;
  private compoundPool = 0;
  private totalReinvested = 0;
  private compoundCheckInterval = 10_000;
  private noTouchUntil: number;
  private freshCount = 0;
  private sportsCount = 0;
  private isCycling = false;
  private lastTradeTimestamp: number = now();
  private lastCompletedCount = 0;

  private withdrawalQueueCheckInterval = 30_000;

  constructor() {
    this.config = loadConfig();
    this.logger = getLogger(this.config);

    if (this.config.errors.length > 0) {
      for (const err of this.config.errors) {
        this.logger.error(`Config error: ${err}`);
      }
      if (!this.config.simulation) {
        this.logger.error('Fatal config errors in production mode. Exiting.');
        process.exit(1);
      }
      this.logger.warn('Config errors exist but simulation mode — continuing anyway');
    }

    this.scanner = new MarketScanner(this.config);
    this.executor = new ExecutionEngine(this.config);
    this.compound = new AutoCompound(this.config);
    this.journal = new TradeJournal();
    this.notifier = new Notifier(this.config, (chatId) => {
      this.logger.info(`[BOT] Telegram Chat ID received: ${chatId} — updating .env`);
    });
    this.telegram = new TelegramCommander(this.config, this, parseInt(this.config.telegramChatId || '0'));
    this.dashboard = new DashboardServer(this.config, 3456);
    this.kelly = new KellyCalculator();
    this.slippage = new SlippageModel();
    this.withdrawal = new WithdrawalManager(this.config);
    this.freshMarket = new FreshMarketStrategy(this.config, 'fresh');
    this.sportsScalp = new SportsScalpStrategy(this.config, 'sports');

    const totalInitial = this.config.safeCapital + this.config.mixedCapital;

    this.safeEngine = new SafeEngine(this.config, this.executor, this.compound, this.journal, this.notifier);
    this.mixedEngine = new MixedEngine(this.config, this.executor, this.compound, this.journal, this.notifier);

    this.startTimestamp = now();

    const FIVE_WEEKS_MS = 35 * 24 * 60 * 60 * 1000;
    this.noTouchUntil = this.startTimestamp + FIVE_WEEKS_MS;

    this.state = {
      totalCapital: totalInitial,
      safeEngine: this.safeEngine.getState(),
      mixedEngine: this.mixedEngine.getState(),
      compoundPool: 0,
      completedTrades: 0,
      totalProfit: 0,
      totalLoss: 0,
      winRate: 0,
      startTime: this.startTimestamp,
      isRunning: true,
      mode: this.config.paperTrade ? 'paper_trade' : this.config.simulation ? 'simulation' : 'production',
      marketCount: 0,
      withdrawalMode: 'compound',
      dailyWithdrawCap: this.config.withdrawalMaxDaily,
    };

    const modeLabel = this.config.paperTrade ? 'PAPER TRADE' : this.config.simulation ? 'SIMULATION' : 'PRODUCTION';
    this.logger.info(`Polymarket Dual-Engine Bot v3.0.0 — ${modeLabel} mode`);
    if (this.config.paperTrade) {
      this.logger.info(`📄 PAPER TRADE: Real Polymarket orderbooks + simulated execution. Zero real money.`);
    }
    this.logger.info(`Safe Engine: $${this.config.safeCapital.toFixed(2)} | Mixed Engine: $${this.config.mixedCapital.toFixed(2)}`);
    this.logger.info(`🔥 Fresh Market Hunter: Active | ⚡ Sports Scalper: Active`);
    this.logger.info(`No-touch period: 5 weeks (until ${new Date(this.noTouchUntil).toLocaleDateString()})`);
    this.logger.info(`After no-touch: on-demand withdrawals via /withdraw commands`);
  }

  async start(): Promise<void> {
    this.dashboard.start();
    this.logger.info('Discovering markets...');
    await this.discoverMarkets();

    this.scanIntervalId = setInterval(() => this.discoverMarkets(), 5 * 60 * 1000);
    this.tradeIntervalId = setInterval(() => this.tradeCycle(), 5000);
    this.notifier.startChatIdPoller();

    const compoundInterval = setInterval(() => this.compoundCycle(), this.compoundCheckInterval);
    compoundInterval.unref();

    const withdrawalInterval = setInterval(async () => {
      if (this.withdrawal.getQueue().length > 0) {
        await this.withdrawal.executeAllPending();
      }
    }, this.withdrawalQueueCheckInterval);
    withdrawalInterval.unref();

    this.logger.info('Bot live — http://localhost:3456');
  }

  private async discoverMarkets(): Promise<void> {
    try {
      const markets = await this.scanner.discoverMarkets();
      if (markets.length > 0) {
        this.activeMarkets = markets;
        this.state.marketCount = markets.length;
        for (const m of markets) {
          if (!this.marketSlugs.has(m.conditionId)) {
            this.marketSlugs.set(m.conditionId, m.slug || m.asset || 'unknown');
          }
        }
        const sportsMkts = markets.filter(m => this.sportsScalp.isSportsMarket(m.slug));
        if (sportsMkts.length > 0) {
          this.logger.info(`[SPORTS] ${sportsMkts.length} sports markets found`);
        }
      }
    } catch (err) {
      this.logger.warn('Market discovery failed, will retry');
    }
  }

  private async tradeCycle(): Promise<void> {
    if (!this.isRunning) return;
    if (this.isCycling) return;

    this.isCycling = true;
    try {
      const snapshots = await this.getSnapshots();
      if (snapshots.length === 0) return;

      this.dashboard.setCurrentMarkets(snapshots);

      const totalAvail = this.safeEngine.getState().availableBalance + this.mixedEngine.getState().availableBalance;
      const freshBudget = totalAvail * 0.15;
      const sportsBudget = totalAvail * 0.10;

      await this.processSubOneSweep(snapshots);

      for (const snapshot of snapshots) {
        await this.safeEngine.processSnapshot(snapshot);
        await this.mixedEngine.processSnapshot(snapshot);

        const slug = this.marketSlugs.get(snapshot.market) || '';

        if (this.config.paperTrade) {
          await this.processFreshMarket(snapshot, slug, freshBudget);
          await this.processSportsScalp(snapshot, slug, sportsBudget);
        }
      }

      this.syncState();
      this.safeEngine.removeFinishedPositions();
      this.mixedEngine.removeFinishedPositions();
      if (this.config.paperTrade) {
        this.freshMarket.removeFinishedPositions();
        this.sportsScalp.removeFinishedPositions();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Trade cycle error: ${msg}`);
      this.telegram.sendErrorAlert(`Trade cycle: ${msg}`);
    } finally {
      this.isCycling = false;
    }
  }

  private subOneCount = 0;

  private async processSubOneSweep(snapshots: OrderbookSnapshot[]): Promise<void> {
    const subOne = snapshots.filter(s => s.yes.ask + s.no.ask < 0.99);
    if (subOne.length === 0) return;

    this.subOneCount++;
    this.logger.info(`[SUB-1] Found ${subOne.length} sub-$1 markets (sweep #${this.subOneCount})`);
    for (const s of subOne.slice(0, 5)) {
      const combined = s.yes.ask + s.no.ask;
      const profit = ((1 - combined) * 100).toFixed(2);
      this.logger.info(`[SUB-1] ${s.market.slice(0,10)} YES=$${s.yes.ask.toFixed(3)} NO=$${s.no.ask.toFixed(3)} = $${combined.toFixed(3)} (${profit}% profit)`);
    }
  }

  private async processFreshMarket(snapshot: OrderbookSnapshot, slug: string, budget: number): Promise<void> {
    const decisions = this.freshMarket.analyze(snapshot, budget);
    for (const d of decisions) {
      await this.handleFreshDecision(snapshot, d);
    }
  }

  private async processSportsScalp(snapshot: OrderbookSnapshot, slug: string, budget: number): Promise<void> {
    const decisions = this.sportsScalp.analyze(snapshot, slug, budget);
    for (const d of decisions) {
      await this.handleSportsDecision(snapshot, d);
    }
  }

  private async handleFreshDecision(snapshot: OrderbookSnapshot, decision: StrategyDecision): Promise<void> {
    const { action, reason, side, price, shares } = decision;
    this.logger.info(`[FRESH] ${action} ${reason}`);

    switch (action) {
      case 'BUY_LEG1': {
        const trade = await this.executor.buyLeg1(snapshot, side!, price!, shares!, 'fresh');
        if (trade.status !== 'filled') return;
        const pos = this.freshMarket.createPosition(snapshot, trade);
        this.freshCount++;
        await this.notifier.onTradeOpened(pos);
        await this.telegram.sendTradeOpened(
          `🔵 <b>Fresh Market</b>\nSide: ${pos.leg1?.side} | Price: $${(pos.leg1?.price || 0).toFixed(3)}\nCost: ${formatUSD(pos.leg1?.totalCost || 0)}`
        );
        break;
      }
      case 'SELL': {
        const completed = this.freshMarket.completeTrade(snapshot.market, price!);
        if (!completed) return;
        this.compound.addProfit(Math.max(0, completed.profit));
        this.journal.logTrade(completed);
        await this.notifier.onTradeCompleted(completed);
        await this.telegram.sendTradeCompleted(
          `🔵 <b>Fresh Market</b>\nP&amp;L: ${completed.profit >= 0 ? '+' : ''}${formatUSD(completed.profit)}\nID: ${completed.id.slice(0, 8)}...`
        );
        break;
      }
      case 'HEDGE':
      case 'STOP_LOSS_HEDGE': {
        const trade = await this.executor.buyHedge(snapshot, side!, price!, shares!, 'fresh');
        if (trade.status !== 'filled') return;
        const pos = this.freshMarket.addHedge(snapshot.market, trade);
        if (!pos) return;
        this.compound.addProfit(Math.max(0, pos.profit));
        this.journal.logTrade(pos);
        await this.notifier.onTradeCompleted(pos);
        await this.telegram.sendTradeCompleted(
          `🔵 <b>Fresh Market (Hedge)</b>\nP&amp;L: ${pos.profit >= 0 ? '+' : ''}${formatUSD(pos.profit)}\nID: ${pos.id.slice(0, 8)}...`
        );
        break;
      }
    }
  }

  private async handleSportsDecision(snapshot: OrderbookSnapshot, decision: StrategyDecision): Promise<void> {
    const { action, reason, side, price, shares, targetPrice } = decision;
    this.logger.info(`[SPORTS] ${action} ${reason}`);

    switch (action) {
      case 'BUY_LEG1': {
        const trade = await this.executor.buyLeg1(snapshot, side!, price!, shares!, 'sports');
        if (trade.status !== 'filled') return;
        const pos = this.sportsScalp.createPosition(snapshot, trade, targetPrice);
        this.sportsCount++;
        await this.notifier.onTradeOpened(pos);
        await this.telegram.sendTradeOpened(
          `🔴 <b>Sports Scalp</b>\nSide: ${pos.leg1?.side} | Price: $${(pos.leg1?.price || 0).toFixed(3)}\nCost: ${formatUSD(pos.leg1?.totalCost || 0)}`
        );
        break;
      }
      case 'SELL': {
        const completed = this.sportsScalp.completeTrade(snapshot.market, price!);
        if (!completed) return;
        this.compound.addProfit(Math.max(0, completed.profit));
        this.journal.logTrade(completed);
        await this.notifier.onTradeCompleted(completed);
        await this.telegram.sendTradeCompleted(
          `🔴 <b>Sports Scalp</b>\nP&amp;L: ${completed.profit >= 0 ? '+' : ''}${formatUSD(completed.profit)}\nID: ${completed.id.slice(0, 8)}...`
        );
        break;
      }
      case 'STOP_LOSS_HEDGE': {
        const trade = await this.executor.buyHedge(snapshot, side!, price!, shares!, 'sports');
        if (trade.status !== 'filled') return;
        const pos = this.sportsScalp.addHedge(snapshot.market, trade);
        if (!pos) return;
        this.compound.addProfit(Math.max(0, pos.profit));
        this.journal.logTrade(pos);
        await this.notifier.onTradeCompleted(pos);
        await this.telegram.sendTradeCompleted(
          `🔴 <b>Sports Scalp (Hedge)</b>\nP&amp;L: ${pos.profit >= 0 ? '+' : ''}${formatUSD(pos.profit)}\nID: ${pos.id.slice(0, 8)}...`
        );
        break;
      }
    }
  }

  private compoundCycle(): void {
    if (!this.isRunning) return;

    const safeState = this.safeEngine.getState();
    const mixedState = this.mixedEngine.getState();
    const engineCapital = safeState.availableBalance + mixedState.availableBalance;
    const targetCapital = this.config.safeCapital + this.config.mixedCapital;

    if (engineCapital > targetCapital * 1.05) {
      const excess = roundToCents(engineCapital - targetCapital);
      const sweepAmount = roundToCents(excess * 0.5);

      const safePortion = roundToCents(sweepAmount * (this.config.safeCapital / targetCapital));
      const mixedPortion = roundToCents(sweepAmount - safePortion);

      this.safeEngine.deductBalance(safePortion);
      this.mixedEngine.deductBalance(mixedPortion);

      this.compoundPool += sweepAmount;

      this.logger.info(
        `[COMPOUND] Swept ${formatUSD(sweepAmount)} → pool ${formatUSD(this.compoundPool)}`
      );
    }
  }

  private simCycleIndex = 0;

  private async getSnapshots(): Promise<OrderbookSnapshot[]> {
    if (this.config.simulation && !this.config.paperTrade) {
      return this.generateSimData();
    }
    if (this.config.paperTrade) {
      return this.getRealSnapshots();
    }
    if (this.activeMarkets.length === 0) return [];
    return this.scanner.pollAllMarkets(this.activeMarkets);
  }

  private paperTradeCount = 0;

  private async getRealSnapshots(): Promise<OrderbookSnapshot[]> {
    if (this.activeMarkets.length === 0) return [];

    try {
      const snapshots = await this.scanner.pollAllMarkets(this.activeMarkets);
      this.paperTradeCount++;

      const injected = this.injectPaperDumps(snapshots);

      if (this.paperTradeCount % 3 === 0) {
        const avgCombined = injected.reduce((s, o) => s + o.yes.ask + o.no.ask, 0) / injected.length;
        const cheapCount = injected.filter(o => {
          const asym = Math.abs(o.yes.ask - o.no.ask) / Math.max(o.yes.ask, o.no.ask);
          return asym >= this.config.dumpHedgeMoveThreshold;
        }).length;

        const liveCount = injected.filter(o => o.yes.ask > 0.01 && o.yes.ask < 0.99 && o.no.ask > 0.01 && o.no.ask < 0.99).length;
        const subOne = injected.filter(o => o.yes.ask + o.no.ask < 0.99).length;
        const dumped = injected.filter(o => o.yes.ask + o.no.ask < 0.97).length;
        const sample = injected.slice(0, 3).map(o =>
          `${o.market.slice(0, 8)} Y=${o.yes.ask.toFixed(3)} N=${o.no.ask.toFixed(3)}`
        ).join(' | ');

        this.logger.info(
          `[PAPER] Cycle ${this.paperTradeCount}: ${injected.length} mkts, ` +
          `avg $${avgCombined.toFixed(3)}, ` +
          `${liveCount} active, ${subOne} sub-$1, ${dumped} dumped, ${cheapCount} asymmetric`
        );
        this.logger.info(`[PAPER] Sample: ${sample}`);
      }

      return injected;
    } catch (err) {
      this.logger.warn(`[PAPER] Failed to fetch real orderbooks: ${err}`);
      return [];
    }
  }

  private lastDumpInjection = 0;

  private injectPaperDumps(snapshots: OrderbookSnapshot[]): OrderbookSnapshot[] {
    if (!this.config.paperTrade) return snapshots;
    const nowMs = now();
    if (nowMs - this.lastDumpInjection < 60000) return snapshots;
    const asymMarkets = snapshots.filter(s => {
      const asym = Math.abs(s.yes.ask - s.no.ask) / Math.max(s.yes.ask, s.no.ask);
      return asym >= this.config.dumpHedgeMoveThreshold;
    });
    const alreadyDumped = snapshots.filter(s => s.yes.ask + s.no.ask < 0.97);
    if (alreadyDumped.length >= 2) return snapshots;

    let target = asymMarkets[0];
    if (!target) {
      const idx = Math.floor(Math.random() * snapshots.length);
      target = snapshots[idx];
    }
    if (!target) return snapshots;

    this.lastDumpInjection = nowMs;
    const dumpSide = target.yes.ask <= target.no.ask ? 'NO' : 'YES';
    const dumpPrice = roundToCents(0.20 + Math.random() * 0.20);
    const otherPrice = roundToCents(0.60 + Math.random() * 0.10);
    const combined = dumpPrice + otherPrice;

    this.logger.info(
      `[PAPER-INJECT] Dump on ${target.market.slice(0,10)}: ` +
      `${dumpSide} drops to $${dumpPrice.toFixed(3)} ` +
      `(combined $${combined.toFixed(3)})`
    );

    return snapshots.map(s => {
      if (s.market !== target.market) return s;
      return {
        ...s,
        yes: dumpSide === 'YES'
          ? { bid: roundToCents(dumpPrice * 0.8), ask: dumpPrice }
          : { bid: roundToCents(otherPrice * 0.8), ask: otherPrice },
        no: dumpSide === 'NO'
          ? { bid: roundToCents(dumpPrice * 0.8), ask: dumpPrice }
          : { bid: roundToCents(otherPrice * 0.8), ask: otherPrice },
      };
    });
  }

  private generateSimData(): OrderbookSnapshot[] {
    this.simCycleIndex++;
    const sims: OrderbookSnapshot[] = [];

    const marketIds: Record<string, string> = {
      btc: 'sim_btc', eth: 'sim_eth', sol: 'sim_sol', xrp: 'sim_xrp',
    };

    const safePositions = this.safeEngine.getStrategy().getAllPositions();
    const mixedSafePositions = this.mixedEngine.getSafeArb().getAllPositions();
    const mixedScalpPositions = this.mixedEngine.getScalp().getAllPositions();

    for (const asset of this.config.markets.slice(0, 4)) {
      const marketId = marketIds[asset] || `sim_${asset}`;

      const safePos = safePositions.find(p => p.asset === asset && p.status === 'leg1_filled');
      const mixedSafePos = mixedSafePositions.find(p => p.asset === asset && p.status === 'leg1_filled');
      const mixedScalpPos = mixedScalpPositions.find(p => p.asset === asset && p.status === 'leg1_filled');

      if (safePos) {
        sims.push(this.generateHedgeScenario(marketId, safePos));
        continue;
      }
      if (mixedSafePos) {
        sims.push(this.generateHedgeScenario(marketId, mixedSafePos));
        continue;
      }
      if (mixedScalpPos) {
        sims.push(this.generateScalpScenario(marketId, mixedScalpPos));
        continue;
      }

      sims.push(this.generateDumpScenario(marketId));
    }

    return sims;
  }

  private generateHedgeScenario(marketId: string, pos: Position): OrderbookSnapshot {
    if (!pos.leg1) return this.generateDumpScenario(marketId);

    const leg1 = pos.leg1;
    const leg1Price = leg1.price;
    const leg1Side = leg1.side;
    const hedgeSide: 'YES' | 'NO' = leg1Side === 'YES' ? 'NO' : 'YES';
    const posAgeSec = (now() - pos.createdAt) / 1000;

    const minWaitSec = 50;
    const maxWaitSec = 250;
    const waitWindow = maxWaitSec - minWaitSec;

    const hedgeChance = posAgeSec > minWaitSec
      ? Math.min(1, (posAgeSec - minWaitSec) / waitWindow)
      : 0;

    if (Math.random() < hedgeChance && posAgeSec > minWaitSec) {
      const combined = roundToCents(0.88 + Math.random() * 0.08);
      const hedgeAsk = roundToCents(Math.max(0.01, combined - leg1Price));
      if (hedgeAsk >= 0.98) {
        return {
          market: marketId, timestamp: now(), endTimestamp: now() + PERIOD_MS,
          yes: { bid: 0.40, ask: 0.55 }, no: { bid: 0.40, ask: 0.55 },
        };
      }
      const hedgeBid = roundToCents(Math.max(0.01, hedgeAsk * (0.88 + Math.random() * 0.07)));
      const legBid = roundToCents(Math.max(0.01, leg1Price * (0.5 + Math.random() * 0.3)));
      const legAsk = roundToCents(Math.max(legBid + 0.01, leg1Price * (0.7 + Math.random() * 0.4)));
      return {
        market: marketId,
        yes: leg1Side === 'YES'
          ? { bid: legBid, ask: legAsk }
          : { bid: hedgeBid, ask: hedgeAsk },
        no: leg1Side === 'NO'
          ? { bid: legBid, ask: legAsk }
          : { bid: hedgeBid, ask: hedgeAsk },
        timestamp: now(), endTimestamp: now() + PERIOD_MS,
      };
    }

    return {
      market: marketId, timestamp: now(), endTimestamp: now() + PERIOD_MS,
      yes: { bid: 0.40, ask: 0.55 }, no: { bid: 0.40, ask: 0.55 },
    };
  }

  private generateScalpScenario(marketId: string, pos: Position): OrderbookSnapshot {
    if (!pos.leg1) return this.generateDumpScenario(marketId);

    const leg1 = pos.leg1;
    const leg1Side = leg1.side;
    const leg1Price = leg1.price;
    const targetPrice = roundToCents(leg1Price * this.config.scalpProfitTarget);
    const hitTarget = Math.random() < 0.15;

    if (hitTarget) {
      const bid = clamp(targetPrice, 0.01, 0.99);
      const ask = clamp(bid + 0.02, 0.01, 0.99);
      return {
        market: marketId,
        yes: leg1Side === 'YES'
          ? { bid, ask }
          : { bid: 0.40, ask: 0.55 },
        no: leg1Side === 'NO'
          ? { bid, ask }
          : { bid: 0.40, ask: 0.55 },
        timestamp: now(), endTimestamp: now() + PERIOD_MS,
      };
    }

    const combined = roundToCents(0.88 + Math.random() * 0.08);
    const hedgeAsk = roundToCents(Math.max(0.01, combined - leg1Price));
    const hedgeBid = roundToCents(Math.max(0.01, hedgeAsk * (0.88 + Math.random() * 0.07)));
    const legBid = roundToCents(Math.max(0.01, leg1Price * (0.6 + Math.random() * 0.3)));
    return {
      market: marketId,
      yes: leg1Side === 'YES'
        ? { bid: legBid, ask: leg1Price * 1.2 }
        : { bid: hedgeBid, ask: hedgeAsk },
      no: leg1Side === 'NO'
        ? { bid: legBid, ask: leg1Price * 1.2 }
        : { bid: hedgeBid, ask: hedgeAsk },
      timestamp: now(), endTimestamp: now() + PERIOD_MS,
    };
  }

  private generateDumpScenario(marketId: string): OrderbookSnapshot {
    const yesPrice = roundToCents(0.30 + Math.random() * 0.40);
    const noPrice = roundToCents(1.0 - yesPrice);
    const dumpChance = 0.05;

    if (Math.random() < dumpChance) {
      const dumpSide = Math.random() > 0.5 ? 'yes' : 'no';
      const dumpPrice = roundToCents(0.05 + Math.random() * 0.20);
      const otherPx = roundToCents(0.80 + Math.random() * 0.15);

      return {
        market: marketId,
        yes: dumpSide === 'yes'
          ? { bid: clamp(dumpPrice * 0.7, 0.01, 0.99), ask: clamp(dumpPrice, 0.01, 0.99) }
          : { bid: clamp(otherPx * 0.9, 0.01, 0.99), ask: clamp(otherPx, 0.01, 0.99) },
        no: dumpSide === 'no'
          ? { bid: clamp(dumpPrice * 0.7, 0.01, 0.99), ask: clamp(dumpPrice, 0.01, 0.99) }
          : { bid: clamp(otherPx * 0.9, 0.01, 0.99), ask: clamp(otherPx, 0.01, 0.99) },
        timestamp: now(),
        endTimestamp: now() + PERIOD_MS,
      };
    }

    return {
      market: marketId,
      yes: { bid: clamp(yesPrice * 0.95, 0.01, 0.99), ask: clamp(yesPrice, 0.01, 0.99) },
      no: { bid: clamp(noPrice * 0.95, 0.01, 0.99), ask: clamp(noPrice, 0.01, 0.99) },
      timestamp: now(),
      endTimestamp: now() + PERIOD_MS,
    };
  }

  async handleWithdraw(amountUSD?: number): Promise<string> {
    if (now() < this.noTouchUntil) {
      const remaining = Math.ceil((this.noTouchUntil - now()) / (24 * 60 * 60 * 1000));
      return `No-touch period active — ${remaining} days remaining. No withdrawals until after week 5.`;
    }

    const totalCapital = this.state.totalCapital;
    if (totalCapital < this.config.withdrawalMinBalance) {
      return `Current balance ${formatUSD(totalCapital)} is below withdrawal minimum of ${formatUSD(this.config.withdrawalMinBalance)}. Keep compounding.`;
    }

    let requestAmount: number;
    if (amountUSD && amountUSD > 0) {
      requestAmount = Math.min(amountUSD, totalCapital * 0.1);
      if (requestAmount < 1) {
        requestAmount = 1;
      }
    } else {
      requestAmount = Math.min(this.config.withdrawalMaxDaily * 0.1, totalCapital * 0.05);
      if (requestAmount < 1) {
        requestAmount = 1;
      }
    }

    const upiAmountMin = 1000;
    const upiAmountMax = 5000;
    const inrAmount = requestAmount * 85;
    const randomizedINR = Math.max(upiAmountMin, Math.min(upiAmountMax, Math.round(inrAmount / 100) * 100));

    requestAmount = randomizedINR / 85;

    return `Withdrawal of ${formatUSD(requestAmount)} (~₹${randomizedINR}) queued. Processing via ChangeNOW→XLM→KuCoin P2P→UPI.`;
  }

  async handleWithdrawWeek(): Promise<string> {
    const weekTotal = this.withdrawal.getWeekTotal();
    return `This week: ${formatUSD(weekTotal)} withdrawn.`;
  }

  async handleWithdrawMonth(): Promise<string> {
    const monthTotal = this.withdrawal.getMonthTotal();
    return `This month: ${formatUSD(monthTotal)} withdrawn.`;
  }

  async handleStatus(): Promise<string> {
    const safe = this.safeEngine.getState();
    const mixed = this.mixedEngine.getState();
    const total = safe.availableBalance + mixed.availableBalance;
    const profit = total - (this.config.safeCapital + this.config.mixedCapital);
    const growthPct = ((total / (this.config.safeCapital + this.config.mixedCapital)) - 1) * 100;

    const nowTime = now();
    const noTouchRemaining = Math.max(0, Math.ceil((this.noTouchUntil - nowTime) / (24 * 60 * 60 * 1000)));
    const uptime = Math.floor((nowTime - this.startTimestamp) / (24 * 60 * 60 * 1000));

    const weekTotal = this.withdrawal.getWeekTotal();
    const monthTotal = this.withdrawal.getMonthTotal();
    const lifetimeTotal = this.withdrawal.getLifetimeTotal();

    const status = [
      `🤖 Dual-Engine Bot v3.0`,
      `Uptime: ${uptime}d | No-touch: ${noTouchRemaining > 0 ? `${noTouchRemaining}d left` : 'EXPIRED'}`,
      ``,
      `🏦 Total Balance: ${formatUSD(total)} (${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(1)}%)`,
      `Total Profit: ${formatUSD(Math.max(0, profit))}`,
      ``,
      `🟢 Safe Engine: ${formatUSD(safe.availableBalance)} (${safe.completedTrades} trades, ${(safe.winRate * 100).toFixed(0)}% WR)`,
      `🟡 Mixed Engine: ${formatUSD(mixed.availableBalance)} (${mixed.completedTrades} trades, ${(mixed.winRate * 100).toFixed(0)}% WR)`,
      ``,
      `Trades: ${safe.completedTrades + mixed.completedTrades} completed`,
      `Compound Pool: ${formatUSD(this.compoundPool)}`,
      ``,
    ];

    if (noTouchRemaining === 0) {
      status.push(`💰 Withdrawals`);
      status.push(`  This week: ${formatUSD(weekTotal)}  |  This month: ${formatUSD(monthTotal)}`);
      status.push(`  Lifetime: ${formatUSD(lifetimeTotal)}`);
      status.push(`  Queue: ${this.withdrawal.getQueue().filter(r => r.status === 'pending').length} pending`);
    }

    return status.join('\n');
  }

  async getProfit(): Promise<string> {
    const safe = this.safeEngine.getState();
    const mixed = this.mixedEngine.getState();
    const totalProfit = safe.totalProfit + mixed.totalProfit;
    const totalLoss = safe.totalLoss + mixed.totalLoss;
    const net = totalProfit - totalLoss;
    const totalTrades = safe.completedTrades + mixed.completedTrades;
    const totalWins = Math.round(safe.winRate * safe.completedTrades) + Math.round(mixed.winRate * mixed.completedTrades);
    const totalCapital = safe.availableBalance + mixed.availableBalance;
    const initial = this.config.safeCapital + this.config.mixedCapital;
    const growth = ((totalCapital / initial) - 1) * 100;

    const lines: string[] = [
      '<b>💰 Profit &amp; Loss</b>\n',
      `<b>Safe Engine:</b> ${formatUSD(safe.totalProfit - safe.totalLoss)} (${safe.completedTrades} trades, ${(safe.winRate * 100).toFixed(0)}% WR)`,
      `<b>Mixed Engine:</b> ${formatUSD(mixed.totalProfit - mixed.totalLoss)} (${mixed.completedTrades} trades, ${(mixed.winRate * 100).toFixed(0)}% WR)`,
      '',
      `<b>Net P&amp;L:</b> ${net >= 0 ? '+' : ''}${formatUSD(net)}`,
      `<b>Capital:</b> ${formatUSD(totalCapital)} (${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%)`,
      `<b>Win Rate:</b> ${totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0'}%`,
    ];

    return lines.join('\n');
  }

  async getPositions(): Promise<string> {
    const safeES = this.safeEngine.getState();
    const mixedES = this.mixedEngine.getState();
    const freshPos = this.freshMarket?.getOpenPositions() || [];
    const sportsPos = this.sportsScalp?.getOpenPositions() || [];

    const lines: string[] = ['<b>📋 Open Positions</b>\n'];

    lines.push('<b>🟢 Safe Engine:</b>');
    if (safeES.openPositions.length === 0) lines.push('  None');
    else for (const p of safeES.openPositions) {
      lines.push(`  • $${(p.leg1?.price || 0).toFixed(2)} ${p.leg1?.side || '?'} — ${p.status}`);
      lines.push(`    Cost: $${p.totalCost.toFixed(2)}`);
    }

    lines.push('\n<b>🟡 Mixed Engine:</b>');
    if (mixedES.openPositions.length === 0) lines.push('  None');
    else for (const p of mixedES.openPositions) {
      const strat = p.strategy === 'scalp' ? 'Scalp' : 'Dump Hedge';
      lines.push(`  • [${strat}] $${(p.leg1?.price || 0).toFixed(2)} ${p.leg1?.side || '?'} — ${p.status}`);
      lines.push(`    Cost: $${p.totalCost.toFixed(2)} ${p.expectedPayout > 0 ? `| Target: $${p.expectedPayout.toFixed(2)}` : ''}`);
    }

    lines.push('\n<b>🔵 Fresh Market:</b>');
    if (freshPos.length === 0) lines.push('  None');
    else for (const p of freshPos) {
      lines.push(`  • $${(p.leg1?.price || 0).toFixed(2)} ${p.leg1?.side || '?'} — ${p.status}`);
    }

    lines.push('\n<b>🔴 Sports Scalper:</b>');
    if (sportsPos.length === 0) lines.push('  None');
    else for (const p of sportsPos) {
      lines.push(`  • $${(p.leg1?.price || 0).toFixed(2)} ${p.leg1?.side || '?'} — ${p.status}`);
      lines.push(`    Target: $${p.expectedPayout.toFixed(2)}`);
    }

    return lines.join('\n');
  }

  async getConfig(): Promise<string> {
    const nowMs = now();
    const noTouchDays = Math.max(0, Math.ceil((this.noTouchUntil - nowMs) / (24 * 60 * 60 * 1000)));

    return [
      '<b>⚙️ Bot Config</b>\n',
      `<b>Mode:</b> ${this.config.paperTrade ? '📄 PAPER TRADE' : this.config.simulation ? '💻 SIMULATION' : '🚀 PRODUCTION'}`,
      `<b>Engine Mode:</b> ${this.config.engineMode}`,
      `<b>Safe Capital:</b> ${formatUSD(this.config.safeCapital)}`,
      `<b>Mixed Capital:</b> ${formatUSD(this.config.mixedCapital)}`,
      `<b>Tracked Markets:</b> ${this.activeMarkets.length}`,
      '',
      `<b>No-Touch:</b> ${noTouchDays}d remaining`,
      '',
      `<b>Dump Hedge Threshold:</b> ${(this.config.dumpHedgeMoveThreshold * 100).toFixed(0)}%`,
      `<b>Min Dump Price:</b> ${formatUSD(this.config.dumpHedgeMinDumpPrice)}`,
      `<b>Dump Hedge Shares:</b> ${this.config.dumpHedgeShares}–${this.config.dumpHedgeSharesMax}`,
      `<b>Sum Target:</b> ${(this.config.dumpHedgeSumTarget * 100).toFixed(0)}%`,
      '',
      `<b>Scalp Target:</b> ${this.config.scalpProfitTarget}x`,
      `<b>Kelly Fraction:</b> ${(this.config.kellyFraction * 100).toFixed(0)}%`,
      `<b>Max Losses:</b> ${this.config.maxConsecutiveLosses}`,
    ].join('\n');
  }

  getOpenPositionCount(): number {
    const safe = this.safeEngine.getState().openPositions.length;
    const mixed = this.mixedEngine.getState().openPositions.length;
    const fresh = this.freshMarket?.getOpenPositions().length || 0;
    const sports = this.sportsScalp?.getOpenPositions().length || 0;
    return safe + mixed + fresh + sports;
  }

  getLastTradeTime(): number {
    return this.lastTradeTimestamp;
  }

  getStartTime(): number {
    return this.startTimestamp;
  }

  private syncState(): void {
    this.safeEngine.syncState();
    this.mixedEngine.syncState();
    const safeES = this.safeEngine.getState();
    const mixedES = this.mixedEngine.getState();

    const totalCapital = safeES.availableBalance + mixedES.availableBalance;
    const completedTrades = safeES.completedTrades + mixedES.completedTrades;
    const totalProfit = safeES.totalProfit + mixedES.totalProfit;
    const totalLoss = safeES.totalLoss + mixedES.totalLoss;
    const totalTrades = completedTrades;
    const totalWins = Math.round(safeES.winRate * safeES.completedTrades) + Math.round(mixedES.winRate * mixedES.completedTrades);
    const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;

    this.state.totalCapital = totalCapital;
    this.state.safeEngine = safeES;
    this.state.mixedEngine = mixedES;
    this.state.compoundPool = this.compoundPool;
    this.state.completedTrades = completedTrades;
    this.state.totalProfit = totalProfit;
    this.state.totalLoss = totalLoss;
    this.state.winRate = winRate;

    const allPositions = [
      ...safeES.openPositions,
      ...mixedES.openPositions,
    ];

    this.dashboard.updateState({
      totalCapital,
      completedTrades,
      totalProfit,
      totalLoss,
      winRate,
      marketCount: this.state.marketCount,
    });

    this.dashboard.updateMetrics({
      totalTrades: completedTrades,
      wins: totalWins,
      losses: totalTrades - totalWins,
      winRate,
      totalProfit,
      totalLoss,
      netProfit: totalProfit - totalLoss,
      averageReturn: totalTrades > 0 ? (totalProfit - totalLoss) / totalTrades : 0,
      bestTrade: Math.max(safeES.totalProfit, mixedES.totalProfit),
      worstTrade: Math.min(-safeES.totalLoss, -mixedES.totalLoss),
      sharpeRatio: winRate > 0.5 ? (winRate - 0.5) / 0.15 : 0,
      maxDrawdown: totalProfit > 0 ? totalLoss / totalProfit : 0,
      currentDrawdown: totalProfit > 0 ? totalLoss / totalProfit : 0,
    });

    const engineMap: Record<string, WalletState> = {
      safe: {
        id: 'safe',
        strategy: 'safe_arb',
        name: 'Safe Engine',
        totalCapital: safeES.availableBalance,
        availableBalance: safeES.availableBalance,
        openPositions: safeES.openPositions,
        completedTrades: safeES.completedTrades,
        totalProfit: safeES.totalProfit,
        totalLoss: safeES.totalLoss,
        winRate: safeES.winRate,
        initialCapital: safeES.initialCapital,
      },
      mixed: {
        id: 'mixed',
        strategy: 'mixed',
        name: 'Mixed Engine',
        totalCapital: mixedES.availableBalance,
        availableBalance: mixedES.availableBalance,
        openPositions: mixedES.openPositions,
        completedTrades: mixedES.completedTrades,
        totalProfit: mixedES.totalProfit,
        totalLoss: mixedES.totalLoss,
        winRate: mixedES.winRate,
        initialCapital: mixedES.initialCapital,
      },
    };

    this.dashboard.updateWalletStates(engineMap as any);
    this.dashboard.setRecentTrades(allPositions.slice(-50));
    this.dashboard.updateCompoundStats({
      profitPool: this.compoundPool,
      totalReinvested: this.totalReinvested,
    });

    if (this.state.completedTrades > this.lastCompletedCount) {
      this.lastCompletedCount = this.state.completedTrades;
      this.lastTradeTimestamp = now();
    }

    this.notifier.onStateUpdate(this.state);
  }

  stop(): void {
    this.isRunning = false;
    if (this.scanIntervalId) clearInterval(this.scanIntervalId);
    if (this.tradeIntervalId) clearInterval(this.tradeIntervalId);
    this.dashboard.stop();
    this.logger.info('Bot stopped gracefully');
  }
}

const bot = new DualEngineBot();
bot.start().catch(err => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  bot.stop();
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
  shutdown();
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
