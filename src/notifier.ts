import { Config, Position, BotState } from './types';
import { getLogger, formatUSD } from './utils';

export class Notifier {
  private config: Config;
  private logger: ReturnType<typeof getLogger>;
  private telegramAvailable: boolean;
  private onChatIdDetected?: (chatId: string) => void;

  constructor(config: Config, onChatId?: (chatId: string) => void) {
    this.config = config;
    this.logger = getLogger(config);
    this.telegramAvailable = !!(config.telegramBotToken && config.telegramChatId);
    this.onChatIdDetected = onChatId;
  }

  startChatIdPoller(): void {
    if (!this.config.telegramBotToken) return;
    let lastOffset = 0;
    const poll = async () => {
      try {
        const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/getUpdates?offset=${lastOffset + 1}&timeout=5`;
        const resp = await fetch(url);
        const data = await resp.json() as any;
        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            if (update.update_id > lastOffset) lastOffset = update.update_id;
            const chatId = update?.message?.chat?.id || update?.my_chat_member?.chat?.id;
            if (chatId && String(chatId) !== String(this.config.telegramChatId)) {
              this.logger.info(`[TELEGRAM] Chat ID detected: ${chatId}`);
              if (this.onChatIdDetected) this.onChatIdDetected(String(chatId));
              const ackUrl = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
              const params = new URLSearchParams({
                chat_id: String(chatId), text: '✅ Bot connected! You\'ll receive trade notifications here.',
                parse_mode: 'HTML',
              });
              await fetch(ackUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
            }
          }
        }
      } catch { }
    };
    poll();
    setInterval(poll, 15000);
  }

  async send(msg: string): Promise<void> {
    this.logger.info(`[NOTIFY] ${msg}`);
    if (this.telegramAvailable) {
      await this.sendTelegram(msg);
    }
  }

  private async sendTelegram(msg: string): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
      const params = new URLSearchParams({
        chat_id: this.config.telegramChatId!,
        text: msg,
        parse_mode: 'HTML',
      });

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => 'unknown');
        this.logger.warn(`Telegram send failed: ${resp.status} ${text}`);
      }
    } catch (err) {
      this.logger.warn(`Telegram error: ${err}`);
    }
  }

  async onTradeOpened(pos: Position): Promise<void> {
    const side = pos.leg1?.side || '?';
    const shares = pos.leg1?.shares || 0;
    const cost = pos.leg1?.totalCost || 0;
    const price = pos.leg1?.price || 0;

    await this.send(
      `🟢 <b>Trade Opened</b>\n` +
      `Asset: ${pos.asset.toUpperCase()} | Period: ${pos.period}m\n` +
      `Side: ${side} | Shares: ${shares}\n` +
      `Cost: ${formatUSD(cost)}\n` +
      `Price: $${price.toFixed(3)}\n` +
      `ID: ${pos.id.slice(0, 8)}...`
    );
  }

  async onTradeCompleted(pos: Position): Promise<void> {
    const emoji = pos.profit >= 0 ? '✅' : '❌';
    const roi = pos.totalCost > 0 ? ((pos.profit / pos.totalCost) * 100).toFixed(1) : '0.0';
    const sign = pos.profit >= 0 ? '+' : '-';

    await this.send(
      `${emoji} <b>Trade Resolved</b>\n` +
      `Asset: ${pos.asset.toUpperCase()}\n` +
      `P&L: ${sign}${formatUSD(pos.profit)}\n` +
      `ROI: ${roi}%\n` +
      `ID: ${pos.id.slice(0, 8)}...`
    );
  }

  async onStateUpdate(state: BotState): Promise<void> {
    if (state.completedTrades === 0) return;
    if (state.completedTrades % 10 !== 0) return;

    const netPnl = state.totalProfit - state.totalLoss;
    const sign = netPnl >= 0 ? '+' : '-';

    const openCount = (state.safeEngine?.openPositions?.length || 0) + (state.mixedEngine?.openPositions?.length || 0);

    await this.send(
      `📊 <b>Bot Status Update</b>\n` +
      `Trades: ${state.completedTrades} | Win Rate: ${(state.winRate * 100).toFixed(1)}%\n` +
      `Total P&L: ${sign}${formatUSD(netPnl)}\n` +
      `Capital: ${formatUSD(state.totalCapital)}\n` +
      `Open Positions: ${openCount}\n` +
      `Mode: ${state.mode.toUpperCase()}`
    );
  }

  async onError(err: string): Promise<void> {
    await this.send(`🔴 <b>Bot Error</b>\n${err}`);
  }
}
