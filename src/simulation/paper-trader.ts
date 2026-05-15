import { childLogger } from '../utils/logger.js';
import type { L2Book } from '../types.js';

const log = childLogger('PaperTrader');

const REPORT_INTERVAL_MS = 60_000;
// Re-arm pending only if price changed by more than this (avoid re-arming every Binance tick)
const MIN_PRICE_CHANGE = 0.005;

export class PaperTrader {
  private bidPrice = 0;
  private askPrice = 0;
  private bidSize = 0;
  private askSize = 0;
  private bidPending = false;
  private askPending = false;

  private yesShares = 0;
  private avgEntry = 0;
  private realizedPnl = 0;
  private trades = 0;
  private lastReportAt = 0;

  // Called every time the quoting engine computes a new quote.
  // Only re-arms the fill flag when the price moves by more than MIN_PRICE_CHANGE
  // — prevents re-arming on every Binance tick.
  updateQuote(bid: number, ask: number, bidSize: number, askSize: number): void {
    if (Math.abs(bid - this.bidPrice) >= MIN_PRICE_CHANGE || bidSize !== this.bidSize) {
      this.bidPrice = bid;
      this.bidSize = bidSize;
      this.bidPending = bidSize > 0;
    }
    if (Math.abs(ask - this.askPrice) >= MIN_PRICE_CHANGE || askSize !== this.askSize) {
      this.askPrice = ask;
      this.askSize = askSize;
      // Can only have an active ask if we hold shares to sell
      this.askPending = askSize > 0 && this.yesShares > 0;
    }
  }

  // Called on every book_update — checks if virtual orders would have been filled.
  checkFills(yesBook: L2Book, fairValue: number): void {
    // BUY fill: someone offers to sell at or below our bid
    if (this.bidPending && this.bidSize > 0 && yesBook.asks.length > 0) {
      const bestAsk = yesBook.asks[0].price;
      if (bestAsk <= this.bidPrice) {
        this.buyFill(this.bidPrice, this.bidSize);
        this.bidPending = false;
        // After buying, arm the ask side
        this.askPending = this.askSize > 0 && this.yesShares > 0;
      }
    }

    // SELL fill: someone wants to buy at or above our ask — only if we hold shares
    if (this.askPending && this.yesShares > 0 && yesBook.bids.length > 0) {
      const bestBid = yesBook.bids[0].price;
      if (bestBid >= this.askPrice) {
        this.sellFill(this.askPrice, Math.min(this.askSize, this.yesShares));
        this.askPending = false;
      }
    }

    const now = Date.now();
    if (now - this.lastReportAt >= REPORT_INTERVAL_MS) {
      this.report(fairValue);
      this.lastReportAt = now;
    }
  }

  private buyFill(price: number, size: number): void {
    const newShares = this.yesShares + size;
    this.avgEntry = (this.avgEntry * this.yesShares + price * size) / newShares;
    this.yesShares = newShares;
    this.trades++;
    log.info(
      { side: 'BUY', price: price.toFixed(4), size: size.toFixed(2), позиция: this.yesShares.toFixed(2), средняя_цена: this.avgEntry.toFixed(4) },
      'Виртуальная сделка',
    );
  }

  private sellFill(price: number, size: number): void {
    if (size <= 0 || this.avgEntry === 0) return;
    const pnl = (price - this.avgEntry) * size;
    this.realizedPnl += pnl;
    this.yesShares = Math.max(0, this.yesShares - size);
    if (this.yesShares < 0.001) {
      this.yesShares = 0;
      this.avgEntry = 0;
    }
    this.trades++;
    log.info(
      {
        side: 'SELL',
        price: price.toFixed(4),
        size: size.toFixed(2),
        сделка_pnl: pnl.toFixed(4),
        итого_pnl: this.realizedPnl.toFixed(4),
        позиция: this.yesShares.toFixed(2),
      },
      'Виртуальная сделка',
    );
  }

  private report(fairValue: number): void {
    if (this.trades === 0) return;
    const unrealizedPnl = this.yesShares > 0 && this.avgEntry > 0
      ? (fairValue - this.avgEntry) * this.yesShares
      : 0;
    log.info(
      {
        сделок: this.trades,
        позиция: this.yesShares.toFixed(2),
        средняя_цена: this.avgEntry.toFixed(4),
        реализованный_pnl: this.realizedPnl.toFixed(4),
        нереализованный_pnl: unrealizedPnl.toFixed(4),
        итого_pnl: (this.realizedPnl + unrealizedPnl).toFixed(4),
      },
      'Виртуальный P&L',
    );
  }
}
