import { OrderbookSnapshot, Position, Config, Trade, StrategyDecision, EngineId } from './types';
import { getLogger, generateId, roundToCents, now } from './utils';

export class FreshMarketStrategy {
  private config: Config;
  private logger: ReturnType<typeof getLogger>;
  private positions: Map<string, Position> = new Map();
  private knownMarkets: Set<string> = new Set();
  private engineId: EngineId;

  constructor(config: Config, engineId: EngineId = 'fresh') {
    this.config = config;
    this.logger = getLogger(config);
    this.engineId = engineId;
  }

  isNewMarket(marketId: string): boolean {
    if (this.knownMarkets.has(marketId)) return false;
    this.knownMarkets.add(marketId);
    return true;
  }

  analyze(snapshot: OrderbookSnapshot, availableBalance?: number): StrategyDecision[] {
    const marketId = snapshot.market;
    const existingPos = this.positions.get(marketId);

    if (existingPos) {
      if (existingPos.status === 'leg1_filled') {
        return this.checkExit(snapshot, existingPos);
      }
      return [];
    }

    if (!this.isNewMarket(marketId)) return [];

    const yesBid = snapshot.yes.bid;
    const yesAsk = snapshot.yes.ask;
    const noBid = snapshot.no.bid;
    const noAsk = snapshot.no.ask;
    const combined = yesAsk + noAsk;
    const spread = Math.abs(yesAsk - noAsk);
    const maxPx = Math.max(yesAsk, noAsk);
    const asymmetry = maxPx > 0 ? spread / maxPx : 0;

    if (combined >= 0.99 && asymmetry < this.config.dumpHedgeMoveThreshold) return [];

    const cheapSide: 'YES' | 'NO' = yesAsk <= noAsk ? 'YES' : 'NO';
    const price = cheapSide === 'YES' ? yesAsk : noAsk;
    const arbPct = (1.0 - combined) * 100;

    if (arbPct < 1.0) return [];

    const shares = this.calcShares(price, availableBalance);
    if (shares < 1) return [];

    const msg = arbPct >= 5
      ? `🔥 Fresh market ARB: ${cheapSide} at $${price.toFixed(3)} (${arbPct.toFixed(1)}% arb, combined $${combined.toFixed(3)})`
      : `Fresh market: ${cheapSide} at $${price.toFixed(3)} (${arbPct.toFixed(1)}% arb)`;

    return [{ action: 'BUY_LEG1', reason: msg, side: cheapSide, price, shares }];
  }

  private checkExit(snapshot: OrderbookSnapshot, pos: Position): StrategyDecision[] {
    if (!pos.leg1) return [];

    const leg1 = pos.leg1;
    const currentBid = leg1.side === 'YES' ? snapshot.yes.bid : snapshot.no.bid;
    const currentAsk = leg1.side === 'YES' ? snapshot.yes.ask : snapshot.no.ask;
    const entryPrice = leg1.price;
    const profitPct = (currentBid - entryPrice) / entryPrice;
    const ageSec = (now() - pos.createdAt) / 1000;

    const oppositeSide: 'YES' | 'NO' = leg1.side === 'YES' ? 'NO' : 'YES';
    const oppositeAsk = oppositeSide === 'YES' ? snapshot.yes.ask : snapshot.no.ask;
    const combined = currentAsk + oppositeAsk;

    if (profitPct >= 0.20 && currentBid > entryPrice) {
      return [{
        action: 'SELL', reason: `Fresh market profit: ${(profitPct * 100).toFixed(0)}% gain`,
        side: leg1.side, price: currentBid, shares: leg1.shares,
      }];
    }

    if (ageSec > 180 && combined <= 0.97) {
      const hedgePrice = oppositeAsk;
      const hedgeCost = hedgePrice * leg1.shares;
      if (hedgeCost <= leg1.totalCost * 2) {
        return [{
          action: 'HEDGE', reason: `Fresh arb hedge after ${Math.round(ageSec)}s`,
          side: oppositeSide, price: hedgePrice, shares: leg1.shares,
        }];
      }
    }

    if (ageSec > 600) {
      const hedgePrice = oppositeAsk;
      const hedgeCost = hedgePrice * leg1.shares;
      if (hedgeCost <= leg1.totalCost * 3) {
        return [{
          action: 'STOP_LOSS_HEDGE', reason: `Fresh market timeout hedge after ${Math.round(ageSec)}s`,
          side: oppositeSide, price: hedgePrice, shares: leg1.shares,
        }];
      }
    }

    return [];
  }

  createPosition(snapshot: OrderbookSnapshot, trade: Trade): Position {
    const yesBid = snapshot.yes.bid;
    const noBid = snapshot.no.bid;
    const expectedPayout = Math.max(yesBid, noBid) * trade.shares;
    const pos: Position = {
      id: generateId(), asset: trade.asset || 'fresh', period: 15,
      strategy: 'fresh_market', engine: trade.engine,
      leg1: trade, leg2: null,
      totalCost: trade.totalCost, expectedPayout, profit: 0,
      status: 'leg1_filled', createdAt: now(),
    };
    this.positions.set(snapshot.market, pos);
    return pos;
  }

  completeTrade(market: string, sellPrice: number): Position | null {
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
    const payout = pos.leg1.shares;
    pos.profit = payout - pos.totalCost;
    pos.status = pos.profit >= 0 ? 'complete' : 'stop_loss';
    pos.resolvedAt = now();
    return pos;
  }

  private calcShares(price: number, availableBalance?: number): number {
    if (!availableBalance || availableBalance <= 0) return 1;
    const estimatedTotalPerShare = 1.0;
    const maxCost = availableBalance * this.config.dumpHedgeCapitalFraction;
    const shares = Math.floor(maxCost / estimatedTotalPerShare);
    return Math.max(1, Math.min(shares, this.config.dumpHedgeSharesMax));
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
