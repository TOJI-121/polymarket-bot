import { Config } from './types';

export class ProfitSplitter {
  constructor(config: Config) {}

  onDirectionalWin(_netProfit: number, _totalReturn: number): Record<string, number> {
    return {};
  }

  onAnyTradeComplete(_walletId: string, _profit: number): void {}

  setBalance(_walletId: string, _balance: number): void {}
}
