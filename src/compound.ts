import { Config } from './types';
import { getLogger, formatUSD, roundToCents } from './utils';

export class AutoCompound {
  private config: Config;
  private logger: ReturnType<typeof getLogger>;
  private profitPool: number;
  private totalReinvested: number;

  constructor(config: Config) {
    this.config = config;
    this.logger = getLogger(config);
    this.profitPool = 0;
    this.totalReinvested = 0;
  }

  addProfit(amount: number): void {
    if (amount <= 0) return;
    this.profitPool += amount;
    this.logger.info(`[COMPOUND] +${formatUSD(amount)} → pool ${formatUSD(this.profitPool)}`);
  }

  addBandwidthEarnings(amount: number): void {
    if (amount <= 0) return;
    this.profitPool += amount;
    this.logger.info(`[COMPOUND] Bandwidth +${formatUSD(amount)} → pool ${formatUSD(this.profitPool)}`);
  }

  shouldReinvest(): boolean {
    const minReinvest = this.config.dumpHedgeShares * 0.10;
    return this.profitPool >= minReinvest;
  }

  calculateMaxReinvestment(): number {
    const tenths = Math.floor(this.profitPool / 0.10);
    return tenths * 0.10;
  }

  reinvest(capital: number): number {
    const amount = this.calculateMaxReinvestment();
    if (amount <= 0) return 0;

    this.profitPool -= amount;
    this.totalReinvested += amount;

    this.logger.info(
      `[COMPOUND] Reinvested ${formatUSD(amount)} ` +
      `(pool: ${formatUSD(this.profitPool)}, total reinvested: ${formatUSD(this.totalReinvested)})`
    );

    return amount;
  }

  getStats(): { profitPool: number; totalReinvested: number } {
    return {
      profitPool: this.profitPool,
      totalReinvested: this.totalReinvested,
    };
  }
}
