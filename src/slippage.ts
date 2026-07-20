import { SlippageEstimate } from './types';

export class SlippageModel {
  private baseSlippage: number;

  constructor(baseSlippage = 0.001) {
    this.baseSlippage = baseSlippage;
  }

  estimate(positionSizeUSD: number, marketLiquidity: number): SlippageEstimate {
    const fillRatio = marketLiquidity > 0 ? positionSizeUSD / marketLiquidity : 0;

    let slippagePercent: number;
    let level: SlippageEstimate['level'];

    if (fillRatio <= 0.01) {
      slippagePercent = this.baseSlippage;
      level = 'none';
    } else if (fillRatio <= 0.05) {
      slippagePercent = this.baseSlippage + fillRatio * 0.5;
      level = 'low';
    } else if (fillRatio <= 0.15) {
      slippagePercent = this.baseSlippage + fillRatio * 0.8;
      level = 'medium';
    } else if (fillRatio <= 0.30) {
      slippagePercent = this.baseSlippage + fillRatio * 1.2;
      level = 'high';
    } else {
      slippagePercent = 0.5;
      level = 'high';
    }

    slippagePercent = Math.min(slippagePercent, 0.5);

    return {
      expectedPrice: 1,
      actualPrice: 1 - slippagePercent,
      slippagePercent,
      level,
    };
  }

  adjustReturn(baseReturn: number, positionSizeUSD: number): number {
    const liq = this.estimateMarketLiquidity(positionSizeUSD);
    const slip = this.estimate(positionSizeUSD, liq);
    return baseReturn * (1 - slip.slippagePercent * 3);
  }

  private estimateMarketLiquidity(positionSizeUSD: number): number {
    if (positionSizeUSD < 5) return 500;
    if (positionSizeUSD < 20) return 2000;
    if (positionSizeUSD < 50) return 5000;
    if (positionSizeUSD < 200) return 15000;
    if (positionSizeUSD < 500) return 30000;
    return 100000;
  }

  dailyReturnMultiplier(capital: number): number {
    if (capital < 10) return 1.0;
    if (capital < 50) return 0.85;
    if (capital < 200) return 0.70;
    if (capital < 500) return 0.55;
    if (capital < 2000) return 0.40;
    if (capital < 10000) return 0.25;
    return 0.15;
  }
}
