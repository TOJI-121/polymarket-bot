import { Config, WithdrawalRequest } from './types';
import { getLogger, now, formatUSD } from './utils';

const INR_RATE = 85;

export class WithdrawalManager {
  private config: Config;
  private logger: ReturnType<typeof getLogger>;
  private queue: WithdrawalRequest[] = [];
  private dailyTotalUSD = 0;
  private lastResetDate = '';
  private lastUpiIndex = 0;

  constructor(config: Config) {
    this.config = config;
    this.logger = getLogger(config);
  }

  getQueue(): WithdrawalRequest[] {
    return [...this.queue];
  }

  getDailyTotal(): number {
    this.checkDailyReset();
    return this.dailyTotalUSD;
  }

  private checkDailyReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.dailyTotalUSD = 0;
      this.lastResetDate = today;
    }
  }

  canWithdraw(amountUSD: number): { allowed: boolean; reason?: string } {
    this.checkDailyReset();

    if (!this.config.withdrawalEnabled) {
      return { allowed: false, reason: 'Withdrawals disabled' };
    }

    if (amountUSD < 1) {
      return { allowed: false, reason: 'Minimum withdrawal is $1' };
    }

    if (amountUSD > this.config.withdrawalMaxDaily) {
      return { allowed: false, reason: `Daily limit is $${this.config.withdrawalMaxDaily}` };
    }

    if (this.dailyTotalUSD + amountUSD > this.config.withdrawalMaxDaily) {
      return { allowed: false, reason: `Daily remaining: $${(this.config.withdrawalMaxDaily - this.dailyTotalUSD).toFixed(2)}` };
    }

    return { allowed: true };
  }

  async requestWithdrawal(amountUSD: number): Promise<WithdrawalRequest> {
    this.checkDailyReset();

    const canWithdraw = this.canWithdraw(amountUSD);
    if (!canWithdraw.allowed) {
      throw new Error(canWithdraw.reason);
    }

    const upiId = this.getNextUpiId();
    const request: WithdrawalRequest = {
      id: `w${now()}_${Math.random().toString(36).slice(2, 6)}`,
      amountUSD,
      amountINR: Math.round(amountUSD * INR_RATE),
      upiId,
      status: 'pending',
      createdAt: now(),
    };

    this.queue.push(request);
    this.dailyTotalUSD += amountUSD;

    this.logger.info(
      `[WITHDRAW] Requested ${formatUSD(amountUSD)} → ₹${request.amountINR} via ${upiId}`
    );

    return request;
  }

  async executeWithdrawal(requestId: string): Promise<boolean> {
    const req = this.queue.find(r => r.id === requestId);
    if (!req) {
      this.logger.error(`[WITHDRAW] Request ${requestId} not found`);
      return false;
    }

    if (req.status !== 'pending') {
      this.logger.error(`[WITHDRAW] Request ${requestId} already ${req.status}`);
      return false;
    }

    req.status = 'swapping';
    this.logger.info(`[WITHDRAW] ${requestId}: USDC→XLM swap...`);

    req.status = 'sending';
    const delay = 5000 + Math.random() * 10000;
    await new Promise(r => setTimeout(r, delay));

    const success = Math.random() > 0.05;
    if (success) {
      req.status = 'completed';
      req.completedAt = now();
      req.txHash = `0x${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      this.logger.info(
        `[WITHDRAW] ${requestId}: Sent ₹${req.amountINR} to ${req.upiId} (tx: ${req.txHash!.slice(0, 10)}...)`
      );
      return true;
    } else {
      req.status = 'failed';
      req.error = `Simulated failure at step ${Math.random() > 0.5 ? 'swap' : 'send'}`;
      this.dailyTotalUSD -= req.amountUSD;
      this.logger.error(`[WITHDRAW] ${requestId}: ${req.error}`);
      return false;
    }
  }

  async executeAllPending(): Promise<void> {
    const pending = this.queue.filter(r => r.status === 'pending');
    for (const req of pending) {
      await this.executeWithdrawal(req.id);
    }
  }

  getFailedRequests(): WithdrawalRequest[] {
    return this.queue.filter(r => r.status === 'failed');
  }

  getWeekTotal(): number {
    const weekAgo = now() - 7 * 86400000;
    return this.queue
      .filter(r => r.createdAt >= weekAgo && r.status === 'completed')
      .reduce((s, r) => s + r.amountUSD, 0);
  }

  getMonthTotal(): number {
    const monthAgo = now() - 30 * 86400000;
    return this.queue
      .filter(r => r.createdAt >= monthAgo && r.status === 'completed')
      .reduce((s, r) => s + r.amountUSD, 0);
  }

  getLifetimeTotal(): number {
    return this.queue
      .filter(r => r.status === 'completed')
      .reduce((s, r) => s + r.amountUSD, 0);
  }

  private getNextUpiId(): string {
    if (this.config.upiIds.length === 0) return 'default@upi';

    const upi = this.config.upiIds[this.lastUpiIndex % this.config.upiIds.length];
    this.lastUpiIndex++;
    return upi;
  }
}
