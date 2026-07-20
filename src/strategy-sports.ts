import { OrderbookSnapshot, Position, Config, Trade, StrategyDecision, EngineId } from './types';
import { getLogger, generateId, roundToCents, now } from './utils';

interface PriceSnapshot {
  time: number;
  yesAsk: number;
  noAsk: number;
}

export class SportsScalpStrategy {
  private config: Config;
  private logger: ReturnType<typeof getLogger>;
  private positions: Map<string, Position> = new Map();
  private priceHistory: Map<string, PriceSnapshot[]> = new Map();
  private engineId: EngineId;
  private maxHistory = 10;

  private sportsKeywords = [
    'cricket', 'football', 'soccer', 'tennis', 'basketball', 'nba', 'nfl',
    'ufc', 'boxing', 'baseball', 'mlb', 'hockey', 'nhl', 'f1', 'formula',
    'golf', 'rugby', 'world cup', 'champions', 'premier league', 'ipl',
    'super bowl', 'olympics', 'tour de france', 'wwe', 'wrestling',
  ];

  constructor(config: Config, engineId: EngineId = 'sports') {
    this.config = config;
    this.logger = getLogger(config);
    this.engineId = engineId;
  }

  isSportsMarket(slug: string): boolean {
    const lower = slug.toLowerCase();
    return this.sportsKeywords.some(k => lower.includes(k));
  }

  analyze(snapshot: OrderbookSnapshot, question: string, availableBalance?: number): StrategyDecision[] {
    const marketId = snapshot.market;
    const existingPos = this.positions.get(marketId);

    this.recordPrice(marketId, snapshot);

    if (existingPos) {
      if (existingPos.status === 'leg1_filled') {
        return this.checkScalpExit(snapshot, existingPos);
      }
      return [];
    }

    if (!this.isSportsMarket(question)) return [];

    const history = this.priceHistory.get(marketId);
    if (!history || history.length < 3) return [];

    const momentum = this.calcMomentum(history);
    if (!momentum) return [];

    const yesAsk = snapshot.yes.ask;
    const noAsk = snapshot.no.ask;
    const combined = yesAsk + noAsk;

    const { direction, strength } = momentum;

    if (strength < 10) return [];

    const side: 'YES' | 'NO' = direction === 'up' ? 'YES' : 'NO';
    const price = side === 'YES' ? yesAsk : noAsk;

    if (price >= 0.85 || price <= 0.15) return [];

    const shares = this.calcShares(price, availableBalance);
    if (shares < 1) return [];

    return [{
      action: 'BUY_LEG1',
      reason: `⚡ Sports scalp: ${side} momentum ${strength.toFixed(0)}% at $${price.toFixed(3)} on ${question.slice(0, 30)}`,
      side, price, shares,
      targetPrice: roundToCents(price * (1 + (strength > 20 ? 0.15 : 0.20))),
    }];
  }

  private recordPrice(marketId: string, snapshot: OrderbookSnapshot): void {
    if (!this.priceHistory.has(marketId)) {
      this.priceHistory.set(marketId, []);
    }
    const hist = this.priceHistory.get(marketId)!;
    hist.push({ time: now(), yesAsk: snapshot.yes.ask, noAsk: snapshot.no.ask });
    if (hist.length > this.maxHistory) hist.shift();
  }

  private calcMomentum(history: PriceSnapshot[]): { direction: 'up' | 'down'; strength: number } | null {
    if (history.length < 3) return null;

    const oldest = history[0];
    const newest = history[history.length - 1];
    const midIdx = Math.floor(history.length / 2);
    const mid = history[midIdx];

    const yesChange1 = ((mid.yesAsk - oldest.yesAsk) / oldest.yesAsk) * 100;
    const yesChange2 = ((newest.yesAsk - mid.yesAsk) / mid.yesAsk) * 100;
    const noChange1 = ((mid.noAsk - oldest.noAsk) / oldest.noAsk) * 100;
    const noChange2 = ((newest.noAsk - mid.noAsk) / mid.noAsk) * 100;

    if (yesChange1 > 5 && yesChange2 > 5) {
      return { direction: 'up', strength: (yesChange1 + yesChange2) / 2 };
    }
    if (yesChange1 < -5 && yesChange2 < -5) {
      return { direction: 'down', strength: Math.abs((yesChange1 + yesChange2) / 2) };
    }
    if (noChange1 > 5 && noChange2 > 5) {
      return { direction: 'up', strength: (noChange1 + noChange2) / 2 };
    }
    if (noChange1 < -5 && noChange2 < -5) {
      return { direction: 'down', strength: Math.abs((noChange1 + noChange2) / 2) };
    }

    if (yesChange1 > 8 || yesChange2 > 8) {
      return { direction: 'up', strength: Math.max(yesChange1, yesChange2) };
    }
    if (yesChange1 < -8 || yesChange2 < -8) {
      return { direction: 'down', strength: Math.max(Math.abs(yesChange1), Math.abs(yesChange2)) };
    }
    if (noChange1 > 8 || noChange2 > 8) {
      return { direction: 'up', strength: Math.max(noChange1, noChange2) };
    }
    if (noChange1 < -8 || noChange2 < -8) {
      return { direction: 'down', strength: Math.max(Math.abs(noChange1), Math.abs(noChange2)) };
    }

    return null;
  }

  private checkScalpExit(snapshot: OrderbookSnapshot, pos: Position): StrategyDecision[] {
    if (!pos.leg1) return [];

    const leg1 = pos.leg1;
    const targetPrice = pos.expectedPayout || (leg1.price * 1.2);
    const currentBid = leg1.side === 'YES' ? snapshot.yes.bid : snapshot.no.bid;
    const entryPrice = leg1.price;
    const profitPct = (currentBid - entryPrice) / entryPrice;
    const ageSec = (now() - pos.createdAt) / 1000;

    if (currentBid >= targetPrice || profitPct >= 0.20) {
      return [{
        action: 'SELL', reason: `Sports scalp target hit: ${(profitPct * 100).toFixed(0)}%`,
        side: leg1.side, price: currentBid, shares: leg1.shares,
      }];
    }

    if (profitPct <= -0.15) {
      return [{
        action: 'SELL', reason: `Sports scalp stop loss: ${(profitPct * 100).toFixed(0)}%`,
        side: leg1.side, price: currentBid, shares: leg1.shares,
      }];
    }

    if (ageSec > 600) {
      const hedgeSide: 'YES' | 'NO' = leg1.side === 'YES' ? 'NO' : 'YES';
      const hedgePrice = hedgeSide === 'YES' ? snapshot.yes.ask : snapshot.no.ask;
      const hedgeCost = hedgePrice * leg1.shares;
      return [{
        action: 'STOP_LOSS_HEDGE', reason: `Sports timeout hedge after ${Math.round(ageSec / 60)}min`,
        side: hedgeSide, price: hedgePrice, shares: leg1.shares,
      }];
    }

    return [];
  }

  createPosition(snapshot: OrderbookSnapshot, trade: Trade, targetPrice?: number): Position {
    const pos: Position = {
      id: generateId(), asset: trade.asset || 'sports', period: 15,
      strategy: 'sports_scalp', engine: trade.engine,
      leg1: trade, leg2: null,
      totalCost: trade.totalCost, expectedPayout: targetPrice || 0, profit: 0,
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
    const maxCost = availableBalance * 0.3;
    const shares = Math.floor(maxCost / price);
    return Math.max(1, Math.min(shares, 10));
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
