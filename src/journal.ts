import * as fs from 'fs';
import * as path from 'path';
import { Position } from './types';
import { getLogger } from './utils';

export class TradeJournal {
  private filePath: string;
  private logger: ReturnType<typeof getLogger>;
  private headersWritten: boolean;

  constructor() {
    this.filePath = path.join(process.cwd(), 'trades.csv');
    this.logger = getLogger();
    this.headersWritten = false;
  }

  private ensureHeaders(): void {
    if (this.headersWritten) return;
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, 'id,asset,side,shares,entryPrice,entryCost,hedgePrice,hedgeCost,totalCost,profit,roi,timestamp\n');
    }
    this.headersWritten = true;
  }

  logTrade(pos: Position): void {
    try {
      this.ensureHeaders();
      const leg1 = pos.leg1;
      const leg2 = pos.leg2;
      const roi = pos.totalCost > 0 ? ((pos.profit / pos.totalCost) * 100).toFixed(2) : '0';
      const line = [
        pos.id,
        pos.asset,
        leg1?.side || '',
        leg1?.shares || 0,
        leg1?.price?.toFixed(3) || '',
        leg1?.totalCost?.toFixed(2) || '',
        leg2?.price?.toFixed(3) || '',
        leg2?.totalCost?.toFixed(2) || '',
        pos.totalCost.toFixed(2),
        pos.profit.toFixed(2),
        roi,
        new Date(pos.createdAt).toISOString(),
      ].join(',') + '\n';
      fs.appendFileSync(this.filePath, line);
      this.logger.info(`[JOURNAL] Wrote trade ${pos.id.slice(0, 8)}... to trades.csv`);
    } catch (err) {
      this.logger.warn(`[JOURNAL] Write failed: ${err}`);
    }
  }
}
