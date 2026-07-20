import { OrderbookSnapshot, Position, Config, Trade, StrategyDecision, EngineId } from './types';
import { getLogger, generateId, roundToCents, now } from './utils';

export class DirectionalStrategy {
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
        return this.checkResolution(snapshot, existingPos);
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

    return [{
      action: 'BUY_LEG1',
      reason: `[DIRECTIONAL] ${side} dumped at $${price.toFixed(3)} ` +
        `(combined=$${combined.toFixed(3)}, asym=${(asymmetry * 100).toFixed(0)}%, ` +
        `shares=${shares}) on ${this.engineId}`,
      side,
      price,
      shares,
    }];
  }

  private checkResolution(snapshot: OrderbookSnapshot, pos: Position): StrategyDecision[] {
    const age = now() - pos.createdAt;
    const marketEnded = snapshot.endTimestamp > 0 && now() > snapshot.endTimestamp;
    const leg1 = pos.leg1;

    if (!leg1) return [];

    if (marketEnded || age > 24 * 60 * 60 * 1000) {
      const yesBid = snapshot.yes.bid;
      const noBid = snapshot.no.bid;
      const ourBid = leg1.side === 'YES' ? yesBid : noBid;
      const otherBid = leg1.side === 'YES' ? noBid : yesBid;

      return [{
        action: 'RESOLVE',
        reason: `[DIRECTIONAL] Market resolved on ${this.engineId} — ` +
          `${leg1.side} settled at $${ourBid.toFixed(3)} (opposite $${otherBid.toFixed(3)})`,
        side: leg1.side,
        price: 0,
        shares: leg1.shares,
        settlePrice: ourBid,
      }];
    }

    if (age > 60000 && pos.status === 'leg1_filled') {
      const combined = snapshot.yes.ask + snapshot.no.ask;
      if (combined <= this.config.dumpHedgeSumTarget) {
        const hedgeSide: 'YES' | 'NO' = leg1.side === 'YES' ? 'NO' : 'YES';
        const hedgePrice = roundToCents(hedgeSide === 'YES' ? snapshot.yes.ask : snapshot.no.ask);
        const hedgeCost = hedgePrice * leg1.shares;
        const maxLoss = leg1.totalCost * 0.5;

        if (hedgeCost <= maxLoss) {
          return [{
            action: 'STOP_LOSS_HEDGE',
            reason: `[DIRECTIONAL] Emergency hedge on ${this.engineId} — ` +
              `combined $${combined.toFixed(3)}, cost $${hedgeCost.toFixed(2)}`,
            side: hedgeSide,
            price: hedgePrice,
            shares: leg1.shares,
          }];
        }
      }
    }

    return [];
  }

  private calcShares(price: number, availableBalance?: number): number {
    if (!availableBalance || availableBalance <= 0) return this.config.dumpHedgeShares;
    const estimatedTotalPerShare = 1.0;
    const maxTotalCost = availableBalance * this.config.dumpHedgeCapitalFraction;
    const shares = Math.floor(maxTotalCost / estimatedTotalPerShare);
    return Math.max(1, Math.min(shares, this.config.dumpHedgeSharesMax));
  }

  createPosition(snapshot: OrderbookSnapshot, trade: Trade): Position {
    const pos: Position = {
      id: generateId(),
      asset: trade.asset || 'unknown',
      period: 15,
      strategy: 'directional',
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

  resolvePositionAtPrice(market: string, settlePrice: number): Position | null {
    const pos = this.positions.get(market);
    if (!pos || !pos.leg1) return null;

    const payout = settlePrice * pos.leg1.shares;
    pos.totalCost = pos.leg1.totalCost;
    pos.profit = payout - pos.totalCost;
    pos.status = pos.profit >= 0 ? 'complete' : 'stop_loss';
    pos.resolvedAt = now();
    return pos;
  }

  resolvePosition(market: string, trade: Trade): Position | null {
    const pos = this.positions.get(market);
    if (!pos || !pos.leg1) return null;

    pos.leg2 = trade;
    pos.totalCost = pos.leg1.totalCost + (trade.totalCost || 0);
    pos.expectedPayout = pos.leg1.shares;

    if (trade.status === 'filled' && trade.side === pos.leg1.side) {
      pos.profit = pos.leg1.shares - pos.leg1.totalCost;
      pos.status = 'complete';
    } else {
      pos.profit = calcDirectionalProfit(pos);
      pos.status = pos.profit >= 0 ? 'complete' : 'stop_loss';
    }

    pos.resolvedAt = now();
    return pos;
  }

  getPositionForMarket(market: string): Position | undefined {
    return this.positions.get(market);
  }

  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'leg1_filled' || p.status === 'watching');
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

function calcDirectionalProfit(pos: Position): number {
  if (!pos.leg1) return 0;
  const payout = pos.leg1.shares;
  const cost = pos.leg1.totalCost + (pos.leg2?.totalCost || 0);
  return payout - cost;
}
