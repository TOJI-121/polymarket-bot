import TelegramBot from 'node-telegram-bot-api';
import { Config } from './types';
import { getLogger, now } from './utils';

export interface BotAPI {
  getStatus(): Promise<string>;
  getProfit(): Promise<string>;
  getPositions(): Promise<string>;
  getConfig(): Promise<string>;
  handleWithdraw(amount?: number): Promise<string>;
  handleWithdrawWeek(): Promise<string>;
  handleWithdrawMonth(): Promise<string>;
  getOpenPositionCount(): number;
  getLastTradeTime(): number;
  getStartTime(): number;
}

export class TelegramCommander {
  private bot: TelegramBot | null = null;
  private config: Config;
  private api: BotAPI;
  private logger: ReturnType<typeof getLogger>;
  private chatId: number;
  private withdrawState: Map<number, boolean> = new Map();
  private lastDailyReport = 0;
  private lastWeeklyDigest = 0;
  private lastPerformanceAlert = 0;

  constructor(config: Config, api: BotAPI, chatId: number) {
    this.config = config;
    this.api = api;
    this.chatId = chatId;
    this.logger = getLogger(config);

    if (!config.telegramBotToken) {
      this.logger.warn('[TELEGRAM] No bot token — commands disabled');
      return;
    }

    try {
      this.bot = new TelegramBot(config.telegramBotToken, { polling: true });

      this.bot.onText(/\/start/, (msg) => this.handleStart(msg));
      this.bot.on('callback_query', (query) => this.handleCallback(query));
      this.bot.on('message', (msg) => this.handleMessage(msg));

      this.startAutoReports();

      setTimeout(() => {
        this.bot!.sendMessage(this.chatId,
          '🌾 <b>Farmer Bot v3.0</b>\nYour Polymarket auto-compound machine. Select an option below:',
          this.menuKeyboard()
        ).catch(() => {});
      }, 2000);

      this.logger.info('[TELEGRAM] Farmer Bot online with inline menu');
    } catch (err) {
      this.logger.error(`[TELEGRAM] Failed to start: ${err}`);
    }
  }

  private async handleStart(msg: TelegramBot.Message): Promise<void> {
    await this.bot!.sendMessage(msg.chat.id,
      '🌾 <b>Farmer Bot v3.0</b>\nWelcome back! Select an option below:',
      this.menuKeyboard()
    );
  }

  private menuKeyboard(): TelegramBot.SendMessageOptions {
    return {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📊 Status', callback_data: 'status' },
            { text: '💰 P&L', callback_data: 'profit' },
          ],
          [
            { text: '📋 Positions', callback_data: 'positions' },
            { text: '💳 Withdraw', callback_data: 'withdraw' },
          ],
          [
            { text: '📅 Weekly', callback_data: 'weekly' },
            { text: '📅 Monthly', callback_data: 'monthly' },
          ],
          [
            { text: '⚙️ Config', callback_data: 'config' },
            { text: '❓ Help', callback_data: 'help' },
          ],
        ],
      },
    };
  }

  private backKeyboard(): TelegramBot.SendMessageOptions {
    return {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'menu' }]],
      },
    };
  }

  private async handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    const chatId = query.message?.chat?.id;
    const msgId = query.message?.message_id;
    const data = query.data;
    if (!chatId || !msgId || !data) return;

    await this.bot!.answerCallbackQuery(query.id);

    switch (data) {
      case 'status': {
        const status = await this.api.getStatus();
        await this.bot!.editMessageText(status, {
          chat_id: chatId, message_id: msgId, ...this.backKeyboard(),
        });
        break;
      }
      case 'profit': {
        const profit = await this.api.getProfit();
        await this.bot!.editMessageText(profit, {
          chat_id: chatId, message_id: msgId, ...this.backKeyboard(),
        });
        break;
      }
      case 'positions': {
        const positions = await this.api.getPositions();
        await this.bot!.editMessageText(positions, {
          chat_id: chatId, message_id: msgId, ...this.backKeyboard(),
        });
        break;
      }
      case 'withdraw': {
        this.withdrawState.set(chatId, true);
        await this.bot!.editMessageText(
          '💳 <b>Enter amount in USD:</b>\n\nExample: <code>10</code> for $10\nReply with just the number.',
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'menu' }]] } }
        );
        break;
      }
      case 'weekly': {
        const weekly = await this.api.handleWithdrawWeek();
        await this.bot!.editMessageText(`📅 <b>Weekly Withdrawals</b>\n\n${weekly}`, {
          chat_id: chatId, message_id: msgId, ...this.backKeyboard(),
        });
        break;
      }
      case 'monthly': {
        const monthly = await this.api.handleWithdrawMonth();
        await this.bot!.editMessageText(`📅 <b>Monthly Withdrawals</b>\n\n${monthly}`, {
          chat_id: chatId, message_id: msgId, ...this.backKeyboard(),
        });
        break;
      }
      case 'config': {
        const configInfo = await this.api.getConfig();
        await this.bot!.editMessageText(configInfo, {
          chat_id: chatId, message_id: msgId, ...this.backKeyboard(),
        });
        break;
      }
      case 'help': {
        const help = `<b>🌾 Farmer Bot - Help</b>\n\n` +
          `<b>📊 Status</b> — Balance, engines, no-touch countdown\n` +
          `<b>💰 P&L</b> — Profit per engine + total\n` +
          `<b>📋 Positions</b> — All open positions\n` +
          `<b>💳 Withdraw</b> — Queue a withdrawal (after no-touch)\n` +
          `<b>📅 Weekly</b> — Weekly withdrawal summary\n` +
          `<b>📅 Monthly</b> — Monthly withdrawal summary\n` +
          `<b>⚙️ Config</b> — Current bot parameters\n\n` +
          `Bot auto-compounds for 5 weeks (no-touch), then withdrawals unlock.`;
        await this.bot!.editMessageText(help, {
          chat_id: chatId, message_id: msgId, ...this.backKeyboard(),
        });
        break;
      }
      case 'menu': {
        await this.bot!.deleteMessage(chatId, msgId).catch(() => {});
        await this.bot!.sendMessage(chatId,
          '🌾 <b>Farmer Bot v3.0</b>\nYour Polymarket auto-compound machine.',
          this.menuKeyboard()
        );
        break;
      }
    }
  }

  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    if (this.withdrawState.get(chatId)) {
      this.withdrawState.delete(chatId);
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) {
        await this.bot!.sendMessage(chatId,
          '❌ Invalid amount. Enter a positive number.',
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'menu' }]] } }
        );
        return;
      }
      const result = await this.api.handleWithdraw(amount);
      await this.bot!.sendMessage(chatId, result, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'menu' }]] },
      });
    }
  }

  private startAutoReports(): void {
    setInterval(() => this.checkDailyReport(), 60 * 60 * 1000);
    setInterval(() => this.checkWeeklyDigest(), 60 * 60 * 1000);
    setInterval(() => this.checkPerformanceAlert(), 15 * 60 * 1000);
  }

  private async checkDailyReport(): Promise<void> {
    const nowMs = now();
    if (nowMs - this.lastDailyReport < 24 * 60 * 60 * 1000) return;
    this.lastDailyReport = nowMs;
    const status = await this.api.getStatus();
    await this.bot!.sendMessage(this.chatId,
      `📆 <b>Daily Auto-Report</b>\n\n${status}`, this.backKeyboard()
    );
    this.logger.info('[TELEGRAM] Daily report sent');
  }

  private async checkWeeklyDigest(): Promise<void> {
    const nowMs = now();
    if (nowMs - this.lastWeeklyDigest < 7 * 24 * 60 * 60 * 1000) return;
    this.lastWeeklyDigest = nowMs;
    const status = await this.api.getStatus();
    const weekly = await this.api.handleWithdrawWeek();
    await this.bot!.sendMessage(this.chatId,
      `📆 <b>Weekly Digest</b>\n\n${status}\n\n<b>Withdrawals This Week:</b>\n${weekly}`,
      this.backKeyboard()
    );
    this.logger.info('[TELEGRAM] Weekly digest sent');
  }

  private async checkPerformanceAlert(): Promise<void> {
    const nowMs = now();
    const lastTrade = this.api.getLastTradeTime();
    const startTime = this.api.getStartTime();
    const uptime = nowMs - startTime;
    if (uptime < 60 * 60 * 1000) return;

    const idleMs = nowMs - lastTrade;
    const idleMin = Math.round(idleMs / 60000);

    if (idleMs > 2 * 60 * 60 * 1000 && nowMs - this.lastPerformanceAlert > 2 * 60 * 60 * 1000) {
      this.lastPerformanceAlert = nowMs;
      await this.bot!.sendMessage(this.chatId,
        `⚠️ <b>Alert: No Trades for ${idleMin} min</b>\n\n` +
        `Open positions: ${this.api.getOpenPositionCount()}\n` +
        `Last trade: ${new Date(lastTrade).toLocaleString()}`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📊 Check Status', callback_data: 'status' }]] } }
      );
      this.logger.info('[TELEGRAM] Performance alert sent');
    }
  }

  async sendTradeOpened(details: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.sendMessage(this.chatId,
      `🟢 <b>Trade Opened</b>\n\n${details}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📊 Status', callback_data: 'status' }]] } }
    );
  }

  async sendTradeCompleted(details: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.sendMessage(this.chatId,
      `✅ <b>Trade Completed</b>\n\n${details}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📊 Status', callback_data: 'status' }]] } }
    );
  }

  async sendErrorAlert(error: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.sendMessage(this.chatId,
      `🔴 <b>Bot Error</b>\n\n${error}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📊 Status', callback_data: 'status' }]] } }
    );
  }
}
