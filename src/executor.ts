import { ethers } from 'ethers';
import axios, { AxiosInstance } from 'axios';
import { Config, Trade, OrderbookSnapshot, EngineId } from './types';
import { getLogger, generateId, roundToCents, now } from './utils';

interface PlaceOrderResult {
  txHash?: string;
  orderId?: string;
  success?: boolean;
}

export class ExecutionEngine {
  private config: Config;
  private logger: ReturnType<typeof getLogger>;
  private clobClient: AxiosInstance;
  private provider: ethers.Provider | null = null;
  private wallet: ethers.Wallet | null = null;

  constructor(config: Config) {
    this.config = config;
    this.logger = getLogger(config);

    this.clobClient = axios.create({
      baseURL: config.clobApiUrl,
      timeout: 15000,
      headers: { 'Accept': 'application/json' },
    });

    if (!config.simulation) {
      this.logger.warn('No wallet key configured — running in simulation-only mode for live data');
    }
  }

  async executeTrade(
    label: string,
    snapshot: OrderbookSnapshot,
    side: 'YES' | 'NO',
    price: number,
    shares: number,
    engineId?: EngineId
  ): Promise<Trade> {
    const totalCost = roundToCents(price * shares);
    const asset = this.extractAsset(snapshot.market);

    const trade: Trade = {
      id: generateId(),
      market: snapshot.market,
      asset,
      engine: engineId || 'safe',
      side,
      price,
      shares,
      totalCost,
      timestamp: now(),
      status: 'pending',
    };

    if (this.config.simulation) {
      this.logger.info(`[SIM] ${label} ${side} ${shares}sh @ $${price.toFixed(3)} = $${totalCost.toFixed(2)} on ${snapshot.market}`);
      trade.status = 'filled';
      trade.txHash = `sim_${trade.id}`;
      return trade;
    }

    try {
      const result = await this.placeOrder({
        market: snapshot.market,
        side,
        price,
        size: shares,
        orderType: 'MARKET',
      });

      trade.status = 'filled';
      trade.txHash = result.txHash || result.orderId || trade.id;
      this.logger.info(`LIVE ${label} ${side} ${shares}sh @ $${price.toFixed(3)} = $${totalCost.toFixed(2)} | tx: ${trade.txHash}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to execute ${label}: ${msg}`);
      trade.status = 'cancelled';
    }

    return trade;
  }

  async buyLeg1(snapshot: OrderbookSnapshot, side: 'YES' | 'NO', price: number, shares: number, engineId?: EngineId): Promise<Trade> {
    return this.executeTrade('Leg1 BUY', snapshot, side, price, shares, engineId);
  }

  async buyHedge(snapshot: OrderbookSnapshot, side: 'YES' | 'NO', price: number, shares: number, engineId?: EngineId): Promise<Trade> {
    return this.executeTrade('Hedge BUY', snapshot, side, price, shares, engineId);
  }

  private async placeOrder(orderData: {
    market: string;
    side: string;
    price: number;
    size: number;
    orderType: string;
  }): Promise<PlaceOrderResult> {
    const resp = await this.clobClient.post('/order', orderData);
    return resp.data as PlaceOrderResult;
  }

  private extractAsset(market: string): string {
    const lower = market.toLowerCase();
    for (const asset of this.config.markets) {
      if (lower.includes(asset)) return asset;
    }
    if (/\bbtc\b|\bbitcoin\b/.test(lower)) return 'btc';
    if (/\beth\b|\bethereum\b/.test(lower)) return 'eth';
    if (/\bsol\b|\bsolana\b/.test(lower)) return 'sol';
    if (/\bxrp\b/.test(lower)) return 'xrp';
    return 'unknown';
  }

  async getBalance(): Promise<number> {
    if (this.config.simulation) return 2.40;

    if (!this.wallet) {
      this.logger.warn('No wallet configured for balance check');
      return 0;
    }

    try {
      const address = this.wallet.address;
      const resp = await this.clobClient.get(`/balance?address=${address}`);
      return parseFloat(resp.data?.balance || '0');
    } catch (err) {
      this.logger.warn(`Balance check failed: ${err}`);
      return 0;
    }
  }

  async redeemWinningTokens(conditionId: string): Promise<boolean> {
    if (this.config.simulation) {
      this.logger.info(`[SIM] Redeemed winning tokens for ${conditionId}`);
      return true;
    }

    try {
      const resp = await this.clobClient.post('/redeem', { conditionId });
      this.logger.info(`Redeemed tokens for ${conditionId}: ${resp.status}`);
      return true;
    } catch (err) {
      this.logger.error(`Failed to redeem tokens for ${conditionId}: ${err}`);
      return false;
    }
  }
}
