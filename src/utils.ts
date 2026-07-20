import winston from 'winston';
import { Config } from './types';

let loggerInstance: winston.Logger | null = null;

export function getLogger(config?: Config): winston.Logger {
  if (loggerInstance) return loggerInstance;

  const level = config?.logLevel || 'info';

  loggerInstance = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
      })
    ),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: 'bot.log', maxsize: 10 * 1024 * 1024, maxFiles: 3 }),
    ],
  });

  return loggerInstance;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

export function calcHedgeProfit(totalCost: number, winningShares: number): number {
  return winningShares - totalCost;
}

export function roundToCents(val: number): number {
  return Math.round(val * 100) / 100;
}

export function roundToDec(val: number, decimals: number): number {
  const mult = Math.pow(10, decimals);
  return Math.round(val * mult) / mult;
}

export function formatUSD(val: number): string {
  return `$${Math.abs(val).toFixed(2)}`;
}

export function now(): number {
  return Date.now();
}

export function getPeriodTimestamp(): number {
  return Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000);
}

export function timeRemaining(endTimestamp: number): number {
  return Math.max(0, endTimestamp - Date.now());
}

export function minutesRemaining(endTimestamp: number): number {
  return timeRemaining(endTimestamp) / 60000;
}

export function safeJsonParse<T>(val: string, fallback: T): T {
  try {
    const parsed = JSON.parse(val);
    return (Array.isArray(parsed) ? parsed : fallback) as unknown as T;
  } catch {
    return fallback;
  }
}

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function assertDefined<T>(val: T | undefined | null, name: string): T {
  if (val === undefined || val === null) {
    throw new Error(`Assertion failed: ${name} is undefined/null`);
  }
  return val;
}
