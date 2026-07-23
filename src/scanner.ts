import axios, { AxiosInstance } from 'axios';
import { Market, OrderbookSnapshot, Config } from './types';
import { getLogger, safeJsonParse, sleep, roundToCents } from './utils';

interface GammaMarket {
  conditionId?: string;
  closed?: boolean;
  active?: boolean;
  acceptingOrders?: boolean;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  endDateIso?: string;
  endDate?: string;
  question?: string;
  slug?: string;
  tokenId?: string;
}

export class MarketScanner {
  private config: Config;
  private logger: ReturnType<typeof getLogger>;
  private gammaClient: AxiosInstance;
  private clobClient: AxiosInstance;

  private allMarkets: string[];

  constructor(config: Config) {
    this.config = config;
    this.logger = getLogger(config);
    this.gammaClient = axios.create({
      baseURL: config.gammaApiUrl,
      timeout: 10000,
      headers: { 'Accept': 'application/json' },
    });
    this.clobClient = axios.create({
      baseURL: config.clobApiUrl,
      timeout: 10000,
      headers: { 'Accept': 'application/json' },
    });
    this.allMarkets = [];
  }

  async discoverMarkets(): Promise<Market[]> {
    const markets: Market[] = [];
    const nowMs = Date.now();
    const maxRetries = 3;

    let resp;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        resp = await this.gammaClient.get('/markets', {
          params: { limit: 100, closed: false, active: true },
          timeout: 15000,
        });
        break;
      } catch (err) {
        if (attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 1000;
          this.logger.warn(`Gamma API attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
          await sleep(delay);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Market discovery failed after ${maxRetries} attempts: ${msg}`);
          return markets;
        }
      }
    }

    const rawMarkets: GammaMarket[] = Array.isArray(resp!.data) ? resp!.data : (resp!.data?.data || []);

    for (const m of rawMarkets) {
      if (!m.conditionId) continue;
      if (m.closed) continue;

      const outcomes = typeof m.outcomes === 'string'
        ? safeJsonParse<string[]>(m.outcomes, [])
        : [];

      if (outcomes.length !== 2) continue;

      const endDate = m.endDateIso || m.endDate;
      const endTimestamp = endDate ? new Date(endDate).getTime() : 0;

      if (endTimestamp > 0 && endTimestamp < nowMs) continue;

      const tokenIds = typeof m.clobTokenIds === 'string'
        ? safeJsonParse<string[]>(m.clobTokenIds, [])
        : [];

      const prices = typeof m.outcomePrices === 'string'
        ? safeJsonParse<string[]>(m.outcomePrices, [])
        : [];

      markets.push({
        conditionId: m.conditionId,
        tokenId: tokenIds[0] || '',
        noTokenId: tokenIds[1] || '',
        outcome: outcomes[0] || 'YES',
        price: parseFloat(prices[0] || '0.5'),
        timestamp: nowMs,
        slug: m.slug || m.question || '',
        asset: this.identifyAsset(m.question || m.slug || ''),
        period: endTimestamp > 0 ? Math.round((endTimestamp - nowMs) / 60000) : 0,
        endTimestamp,
      });
    }

    this.allMarkets = markets.map(m => m.conditionId);

    let filtered = markets;
    if (!this.config.allMarkets && this.config.markets.length > 0) {
      filtered = markets.filter(m => this.config.markets.includes(m.asset));
    }

    if (filtered.length > 0) {
      const byAsset = new Map<string, number>();
      for (const m of filtered) {
        byAsset.set(m.asset, (byAsset.get(m.asset) || 0) + 1);
      }
      const breakdown = Array.from(byAsset.entries()).map(([a, c]) => `${a}:${c}`).join(', ');
      const total = markets.length;
      const label = filtered.length < total ? `${filtered.length}/${total}` : `${total}`;
      this.logger.info(`Discovered ${label} active binary markets [${breakdown}]`);
    }

    return filtered;
  }

  async fetchOrderbook(conditionId: string, tokenId: string, noTokenId?: string): Promise<OrderbookSnapshot | null> {
    let yesBid = 0, yesAsk = 0, noBid = 0, noAsk = 0;

    if (tokenId) {
      try {
        const resp = await this.clobClient.get(`/orderbook/${tokenId}`);
        const data = resp.data || {};
        yesBid = this.parseOrderPrice(data.bids);
        yesAsk = this.parseOrderPrice(data.asks);
      } catch {
        this.logger.debug(`CLOB orderbook fetch failed for YES token ${tokenId.slice(0, 10)}...`);
      }
    }

    if (noTokenId) {
      try {
        const resp = await this.clobClient.get(`/orderbook/${noTokenId}`);
        const data = resp.data || {};
        noBid = this.parseOrderPrice(data.bids);
        noAsk = this.parseOrderPrice(data.asks);
      } catch {
        this.logger.debug(`CLOB orderbook fetch failed for NO token ${noTokenId.slice(0, 10)}...`);
      }
    }

    if (yesBid === 0 && yesAsk === 0 && noBid === 0 && noAsk === 0) {
      return this.fallbackOrderbook(conditionId);
    }

    return {
      market: conditionId,
      yes: { bid: yesBid || 0.01, ask: yesAsk || 0.99 },
      no: { bid: noBid || 0.01, ask: noAsk || 0.99 },
      timestamp: Date.now(),
      endTimestamp: 0,
    };
  }

  private parseOrderPrice(orders: unknown): number {
    if (!Array.isArray(orders) || orders.length === 0) return 0;
    const first = orders[0];
    if (first && typeof first === 'object' && 'price' in (first as Record<string, unknown>)) {
      return parseFloat(String((first as Record<string, unknown>).price)) || 0;
    }
    if (Array.isArray(first) && first.length > 0) {
      return parseFloat(String(first[0])) || 0;
    }
    return 0;
  }

  private async fallbackOrderbook(conditionId: string): Promise<OrderbookSnapshot | null> {
    try {
      const resp = await this.gammaClient.get('/markets', {
        params: { condition_id: conditionId },
        timeout: 10000,
      });

      const raw = Array.isArray(resp.data) ? resp.data : (resp.data?.data || []);
      const m: GammaMarket | undefined = raw[0] || resp.data;
      if (!m) return null;

      const prices = typeof m.outcomePrices === 'string'
        ? safeJsonParse<string[]>(m.outcomePrices, [])
        : [];

      if (prices.length < 2) return null;

      const p0 = parseFloat(prices[0]);
      const p1 = parseFloat(prices[1]);

      if (isNaN(p0) || isNaN(p1)) return null;

      const endDate = m.endDateIso || m.endDate;
      const endTimestamp = endDate ? new Date(endDate).getTime() : 0;

      const spreadFactor = 0.99;
      return {
        market: conditionId,
        yes: { bid: roundToCents(p0 * spreadFactor), ask: roundToCents(Math.min(p0 / spreadFactor, 0.99)) },
        no: { bid: roundToCents(p1 * spreadFactor), ask: roundToCents(Math.min(p1 / spreadFactor, 0.99)) },
        timestamp: Date.now(),
        endTimestamp,
      };
    } catch {
      return null;
    }
  }

  async pollAllMarkets(markets: Market[]): Promise<OrderbookSnapshot[]> {
    if (markets.length === 0) return [];

    const BATCH_SIZE = 10;
    const snapshots: OrderbookSnapshot[] = [];

    for (let i = 0; i < markets.length; i += BATCH_SIZE) {
      const batch = markets.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(m => this.fetchOrderbook(m.conditionId, m.tokenId, m.noTokenId))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          snapshots.push(r.value);
        }
      }
    }

    return snapshots;
  }

  private identifyAsset(question: string): string {
    const q = question.toLowerCase();
    if (/\bbtc\b|\bbitcoin\b/.test(q)) return 'btc';
    if (/\beth\b|\bethereum\b/.test(q)) return 'eth';
    if (/\bsol\b|\bsolana\b/.test(q)) return 'sol';
    if (/\bxrp\b/.test(q)) return 'xrp';
    if (/\bmatic\b|\bpolygon\b/.test(q)) return 'matic';
    if (/\bdoge\b/.test(q)) return 'doge';
    if (/\bada\b|\bcardano\b/.test(q)) return 'ada';
    return 'other';
  }
}
