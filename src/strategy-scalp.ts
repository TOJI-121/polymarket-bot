import { OrderbookSnapshot, Position, Config, Trade, StrategyDecision, EngineId } from './types';
import { getLogger, generateId, roundToCents, now } from './utils';

export class ScalpStrategy {
  private config: Config;
  private logger: ReturnType<typeof getLogger>;
  private engineId: EngineId;
  private positions: Map<string, Position> = new Map();

  constructor(config: Config, engineId: EngineId) {
    this.config = config;
    this.logger = getLogger(config);
    this.engineId = engineId;
  }

  analyze(snapshot: OrderbookSnapshot, availableBalance?: number): StrategyDecision[] {
    const yesAsk = snapshot.yes.ask;
    const noAsk = snapshot.no.ask;
    const combined = yesAsk + noAsk;
    const maxAsk = Math.max(yesAsk, noAsk);
    const asymmetry = maxAsk > 0 ? Math.abs(yesAsk - noAsk) / maxAsk : 0;

    const existingPos = this.getPositionForMarket(snapshot.market);
    if (existingPos) {
      if (existingPos.status === 'leg1_filled') {
        return this.checkScalp(snapshot, existingPos);
      }
      return [];
    }

    if (combined >= 1.0) return [];

    const threshold = this.config.dumpHedgeMoveThreshold;
    const isYesDumped = asymmetry >= threshold && yesAsk <= noAsk;
    const isNoDumped = asymmetry >= threshold && noAsk <= yesAsk;

    if (!isYesDumped && !isNoDumped) return [];

    const side: 'YES' | 'NO' = isYesDumped ? 'YES' : 'NO';
    const price = roundToCents(isYesDumped ? yesAsk : noAsk);
    const shares = this.calcShares(price, availableBalance);
    if (shares < 1) return [];

    const targetPrice = roundToCents(price * this.config.scalpProfitTarget);

    return [{
      action: 'BUY_LEG1',
      reason: `[SCALP] ${side} dumped at $${price.toFixed(3)} ` +
        `(target $${targetPrice.toFixed(3)}, shares=${shares}) on ${this.engineId}`,
      side,
      price,
      shares,
      targetPrice,
    }];
  }

  private checkScalp(snapshot: OrderbookSnapshot, pos: Position): StrategyDecision[] {
    const leg1 = pos.leg1!;
    const currentBid = leg1.side === 'YES' ? snapshot.yes.bid : snapshot.no.bid;
    const targetPrice = roundToCents(leg1.price * this.config.scalpProfitTarget);
    const age = now() - pos.createdAt;

    if (currentBid >= targetPrice) {
      return [{
        action: 'SELL',
        reason: `[SCALP] Hit target $${currentBid.toFixed(3)} ≥ $${targetPrice.toFixed(3)} ` +
          `on ${this.engineId} — profit $${((currentBid - leg1.price) * leg1.shares).toFixed(2)}`,
        side: leg1.side,
        price: currentBid,
        shares: leg1.shares,
      }];
    }

    if (age >= this.config.scalpHedgeTimeoutMs) {
      const hedgeSide: 'YES' | 'NO' = leg1.side === 'YES' ? 'NO' : 'YES';
      const hedgePrice = roundToCents(hedgeSide === 'YES' ? snapshot.yes.ask : snapshot.no.ask);
      const hedgeCost = hedgePrice * leg1.shares;

      if (hedgeCost <= leg1.totalCost * 0.8) {
        return [{
          action: 'STOP_LOSS_HEDGE',
          reason: `[SCALP] Timeout after ${Math.round(age / 1000)}s, hedging at ` +
            `$${hedgePrice.toFixed(3)} on ${this.engineId}`,
          side: hedgeSide,
          price: hedgePrice,
          shares: leg1.shares,
        }];
      }
    }

    return [];
  }

  private calcShares(price: number, availableBalance?: number): number {
    if (!availableBalance || availableBalance <= 0) return this.config.dumpHedgeShares;
    const maxCost = availableBalance * 0.5;
    const shares = Math.floor(maxCost / price);
    return Math.max(1, Math.min(shares, Math.floor(this.config.dumpHedgeSharesMax / 2)));
  }

  createPosition(snapshot: OrderbookSnapshot, trade: Trade, targetPrice?: number): Position {
    const pos: Position = {
      id: generateId(),
      asset: trade.asset || 'unknown',
      period: 15,
      strategy: 'scalp',
      engine: this.engineId,
      leg1: trade,
      leg2: null,
      totalCost: trade.totalCost,
      expectedPayout: targetPrice || 0,
      profit: 0,
      status: 'leg1_filled',
      createdAt: now(),
    };
    this.positions.set(snapshot.market, pos);
    return pos;
  }

  scalpComplete(market: string, sellPrice: number): Position | null {
    const pos = this.positions.get(market);
    if (!pos || !pos.leg1) return null;

    const payout = sellPrice * pos.leg1.shares;
    pos.totalCost = pos.leg1.totalCost;
    pos.profit = payout - pos.totalCost;
    pos.status = 'complete';
    pos.resolvedAt = now();
    return pos;
  }

  addHedge(market: string, trade: Trade): Position | null {
    const pos = this.positions.get(market);
    if (!pos || !pos.leg1) return null;

    pos.leg2 = trade;
    pos.totalCost = pos.leg1.totalCost + trade.totalCost;
    pos.profit = pos.leg1.shares - pos.totalCost;
    pos.status = pos.profit >= 0 ? 'complete' : 'stop_loss';
    pos.resolvedAt = now();
    return pos;
  }

  getPositionForMarket(market: string): Position | undefined {
    return this.positions.get(market);
  }

  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'leg1_filled');
  }

  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  removeFinishedPositions(): void {
    const threshold = now() - 24 * 60 * 60 * 1000;
    for (const [key, pos] of this.positions) {
      if ((pos.status === 'complete' || pos.status === 'stop_loss') && pos.resolvedAt && pos.resolvedAt < threshold) {
        this.positions.delete(key);
      }
    }
  }
}
