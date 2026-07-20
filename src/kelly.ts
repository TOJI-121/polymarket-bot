import { KellyResult } from './types';

export class KellyCalculator {
  private winRate: number;
  private winLossRatio: number;
  private maxFraction: number;

  constructor(winRate = 0.8, winLossRatio = 3.0, maxFraction = 0.95) {
    this.winRate = winRate;
    this.winLossRatio = winLossRatio;
    this.maxFraction = maxFraction;
  }

  setWinRate(rate: number): void {
    this.winRate = Math.max(0.01, Math.min(0.99, rate));
  }

  setWinLossRatio(ratio: number): void {
    this.winLossRatio = Math.max(1.01, ratio);
  }

  calculateFullKelly(): number {
    const q = 1 - this.winRate;
    const b = this.winLossRatio;
    const f = (b * this.winRate - q) / b;
    return Math.max(0, Math.min(f, this.maxFraction));
  }

  calculateHalfKelly(): number {
    return this.calculateFullKelly() * 0.5;
  }

  calculateFractional(fraction: number): number {
    return this.calculateFullKelly() * Math.max(0, Math.min(1, fraction));
  }

  sizePosition(capital: number, price: number, kellyMultiplier = 1.0): KellyResult {
    const fullKelly = this.calculateFullKelly();
    const fraction = fullKelly * kellyMultiplier;
    const maxCost = capital * fraction;
    const shares = Math.max(1, Math.floor(maxCost / price));
    const cost = Math.min(shares * price, capital * 0.95);

    return { fraction, shares, cost };
  }

  expectedGrowth(fraction: number): number {
    const q = 1 - this.winRate;
    const b = this.winLossRatio;
    const winReturn = Math.log(1 + b * fraction);
    const lossReturn = Math.log(1 - fraction);
    return this.winRate * winReturn + q * lossReturn;
  }

  simulateTrades(initialCapital: number, trades: number, kellyMultiplier = 1.0): number[] {
    const results: number[] = [initialCapital];
    let capital = initialCapital;
    const fraction = this.calculateFullKelly() * kellyMultiplier;

    for (let i = 0; i < trades; i++) {
      const isWin = Math.random() < this.winRate;
      if (isWin) {
        capital = capital * (1 + this.winLossRatio * fraction);
      } else {
        capital = capital * (1 - fraction);
      }
      results.push(capital);
    }

    return results;
  }

  recommendedBetSize(capital: number, price: number, consecutiveLosses = 0): KellyResult {
    let multiplier = 1.0;
    if (consecutiveLosses >= 3) multiplier = 0.5;
    if (consecutiveLosses >= 5) multiplier = 0.25;
    if (consecutiveLosses >= 7) multiplier = 0.0;

    return this.sizePosition(capital, price, multiplier);
  }
}
