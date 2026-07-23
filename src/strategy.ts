import { OrderbookSnapshot, Position, Config, Trade, StrategyDecision } from './types';
import { getLogger, generateId, roundToCents, calcHedgeProfit, now } from './utils';

export class DumpHedgeStrategy {
  private config: Config;
  private logger: ReturnType<typeof getLogger>;
  private positions: Map<string, Position> = new Map();

  constructor(config: Config) {
    this.config = config;
    this.logger = getLogger(config);
  }

  analyze(snapshot: OrderbookSnapshot, availableBalance?: number): StrategyDecision[] {
    const yesAsk = snapshot.yes.ask;
    const noAsk = snapshot.no.ask;
    const combined = yesAsk + noAsk;
    const maxAsk = Math.max(yesAsk, noAsk);
    const asymmetry = maxAsk > 0 ? Math.abs(yesAsk - noAsk) / maxAsk : 0;

    this.logger.debug(
      `Market ${snapshot.market.slice(0, 12)}... ` +
      `YES=$${yesAsk.toFixed(3)} NO=$${noAsk.toFixed(3)} ` +
      `Combined=$${combined.toFixed(3)} Asym=${(asymmetry * 100).toFixed(1)}%`
    );

    const existingPos = this.getPositionForMarket(snapshot.market);

    if (existingPos && existingPos.status === 'leg1_filled' && existingPos.leg1) {
      return this.evaluateHedge(snapshot, existingPos, combined);
    }

    if (existingPos) return [];

    if (combined > 1.02) return [];

    const threshold = this.config.dumpHedgeMoveThreshold;
    const isYesDumped = asymmetry >= threshold && yesAsk <= noAsk;
    const isNoDumped = asymmetry >= threshold && noAsk <= yesAsk;

    if (!isYesDumped && !isNoDumped) return [];

    const side: 'YES' | 'NO' = isYesDumped ? 'YES' : 'NO';
    const price = roundToCents(isYesDumped ? yesAsk : noAsk);
    const shares = this.calcDynamicShares(price, availableBalance);

    if (shares < 1) return [];

    return [{
      action: 'BUY_LEG1',
      reason: `${side} dumped at $${price.toFixed(3)} ` +
        `(combined=$${combined.toFixed(3)}, asym=${(asymmetry * 100).toFixed(0)}%, ` +
        `shares=${shares})`,
      side,
      price,
      shares,
    }];
  }

  private calcDynamicShares(price: number, availableBalance?: number): number {
    if (!availableBalance || availableBalance <= 0) return this.config.dumpHedgeShares;

    const estimatedTotalPerShare = 1.0;
    const maxTotalCost = availableBalance * this.config.dumpHedgeCapitalFraction;
    const dynamicShares = Math.floor(maxTotalCost / estimatedTotalPerShare);

    return Math.max(1, Math.min(dynamicShares, this.config.dumpHedgeSharesMax));
  }

  private evaluateHedge(
    snapshot: OrderbookSnapshot,
    pos: Position,
    combined: number
  ): StrategyDecision[] {
    const leg1Side = pos.leg1!.side;
    const hedgeSide: 'YES' | 'NO' = leg1Side === 'YES' ? 'NO' : 'YES';
    const hedgePrice = roundToCents(hedgeSide === 'YES' ? snapshot.yes.ask : snapshot.no.ask);

    if (combined <= this.config.dumpHedgeSumTarget) {
      return [{
        action: 'HEDGE',
        reason: `Combined $${combined.toFixed(3)} ≤ target $${this.config.dumpHedgeSumTarget.toFixed(2)}`,
        side: hedgeSide,
        price: hedgePrice,
        shares: pos.leg1!.shares,
      }];
    }

    const age = now() - pos.createdAt;
    const maxWaitMs = this.config.dumpHedgeStopLossMaxWaitMinutes * 60 * 1000;

    if (age >= maxWaitMs) {
      const hedgeCost = hedgePrice * pos.leg1!.shares;
      const stopLossThreshold = pos.leg1!.totalCost * (1 - this.config.dumpHedgeStopLossPercentage);

      if (hedgeCost <= stopLossThreshold) {
        return [{
          action: 'STOP_LOSS_HEDGE',
          reason: `Stop-loss after ${Math.round(age / 1000)}s — ` +
            `hedge $${hedgeCost.toFixed(2)} ≤ $${stopLossThreshold.toFixed(2)}`,
          side: hedgeSide,
          price: hedgePrice,
          shares: pos.leg1!.shares,
        }];
      }
    }

    return [];
  }

  createPosition(snapshot: OrderbookSnapshot, trade: Trade): Position {
    const pos: Position = {
      id: generateId(),
      asset: trade.asset || 'unknown',
      period: 15,
      strategy: 'safe_arb',
      engine: trade.engine,
      leg1: trade,
      leg2: null,
      totalCost: trade.totalCost,
      expectedPayout: 0,
      profit: 0,
      status: 'leg1_filled',
      createdAt: now(),
    };
    this.positions.set(snapshot.market, pos);
    return pos;
  }

  addHedge(market: string, trade: Trade): Position | null {
    const pos = this.positions.get(market);
    if (!pos || !pos.leg1) return null;

    pos.leg2 = trade;
    pos.totalCost = pos.leg1.totalCost + trade.totalCost;
    pos.expectedPayout = pos.leg1.shares;
    pos.profit = calcHedgeProfit(pos.totalCost, pos.leg1.shares);
    pos.status = pos.profit >= 0 ? 'complete' : 'stop_loss';
    pos.resolvedAt = now();
    return pos;
  }

  closePosition(market: string, profit: number): void {
    const pos = this.positions.get(market);
    if (pos) {
      pos.status = 'complete';
      pos.profit = profit;
      pos.resolvedAt = now();
    }
  }

  getPositionForMarket(market: string): Position | undefined {
    return this.positions.get(market);
  }

  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'leg1_filled' || p.status === 'watching');
  }

  getCompletedPositions(): Position[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'complete' || p.status === 'stop_loss' || p.status === 'error');
  }

  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  removeFinishedPositions(): void {
    const threshold = now() - 24 * 60 * 60 * 1000;
    for (const [key, pos] of this.positions) {
      if (pos.status === 'complete' && pos.resolvedAt && pos.resolvedAt < threshold) {
        this.positions.delete(key);
      }
    }
  }
}
