import { EventEmitter } from 'node:events';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import type { Position, Quote } from '../types.js';

const log = childLogger('RiskAgent');

export const enum RiskAction {
  ALLOW = 'ALLOW',
  REDUCE_ONLY = 'REDUCE_ONLY',
  HALT = 'HALT',
}

export class RiskAgent extends EventEmitter {
  private position: Position = {
    yesShares: 0,
    noShares: 0,
    netDelta: 0,
    avgEntryPrice: 0,
    unrealizedPnl: 0,
    realizedPnl: 0,
  };
  private halted = false;

  // Daily spend tracking
  private dailySpendUsdc = 0;
  private midnightResetTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-order inventory hold cycle counter (orderId → tick count)
  private inventoryCycles = new Map<string, number>();

  get currentPosition(): Position {
    return { ...this.position };
  }

  get isHalted(): boolean {
    return this.halted;
  }

  get dailySpend(): number {
    return this.dailySpendUsdc;
  }

  // Call once at startup to begin the midnight reset cycle
  startDailyReset(): void {
    this.scheduleMidnightReset();
    log.info({ cap: CONFIG.DAILY_SPEND_CAP }, 'Дневной лимит расходов активирован');
  }

  // Record USDC spent on any order (call before submitting)
  recordSpend(usdcAmount: number): boolean {
    if (this.dailySpendUsdc + usdcAmount > CONFIG.DAILY_SPEND_CAP) {
      log.warn(
        { spent: this.dailySpendUsdc.toFixed(2), attempted: usdcAmount.toFixed(2), cap: CONFIG.DAILY_SPEND_CAP },
        'Дневной лимит будет превышен — ордер заблокирован',
      );
      return false; // caller must not submit
    }
    this.dailySpendUsdc += usdcAmount;
    log.debug({ daily: this.dailySpendUsdc.toFixed(2), cap: CONFIG.DAILY_SPEND_CAP }, 'Spend recorded');
    return true;
  }

  // Register an active order for inventory hold tracking
  trackOrder(orderId: string): void {
    this.inventoryCycles.set(orderId, 0);
  }

  // Increment all tracked order cycle counters.
  // Returns IDs of orders that exceeded INVENTORY_HOLD_MAX_CYCLES and should be cancelled.
  tickInventoryCycles(): string[] {
    const stale: string[] = [];
    for (const [id, cycles] of this.inventoryCycles) {
      const next = cycles + 1;
      if (next >= CONFIG.INVENTORY_HOLD_MAX_CYCLES) {
        stale.push(id);
        this.inventoryCycles.delete(id);
        log.warn({ orderId: id, cycles: next }, 'Превышен лимит удержания позиции — отмена ордера');
      } else {
        this.inventoryCycles.set(id, next);
      }
    }
    return stale;
  }

  clearTrackedOrder(orderId: string): void {
    this.inventoryCycles.delete(orderId);
  }

  private scheduleMidnightReset(): void {
    const now = new Date();
    const nextMidnightUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
    );
    const msUntilMidnight = nextMidnightUtc.getTime() - Date.now();

    this.midnightResetTimer = setTimeout(() => {
      this.dailySpendUsdc = 0;
      log.info({ resetAt: new Date().toISOString() }, 'Дневной счётчик сброшен в полночь UTC');
      this.emit('daily_reset');
      this.scheduleMidnightReset(); // reschedule for next day
    }, msUntilMidnight);

    log.debug({ msUntilMidnight, nextReset: nextMidnightUtc.toISOString() }, 'Midnight reset scheduled');
  }

  /**
   * Process a fill event and update the position.
   *
   * BUY fill → increase YES shares (we bought YES tokens)
   * SELL fill → decrease YES shares (we sold YES tokens)
   * netDelta = yesShares (positive = long YES, negative = short)
   */
  processFill(side: string, price: number, size: number): void {
    if (side === 'BUY') {
      const newShares = this.position.yesShares + size;
      this.position.avgEntryPrice =
        (this.position.avgEntryPrice * this.position.yesShares + price * size) / newShares;
      this.position.yesShares = newShares;
    } else {
      const pnl = (price - this.position.avgEntryPrice) * size;
      this.position.realizedPnl += pnl;
      this.position.yesShares -= size;
    }

    this.position.netDelta = this.position.yesShares;

    log.info(
      {
        yesShares: this.position.yesShares.toFixed(2),
        netDelta: this.position.netDelta.toFixed(2),
        realizedPnl: this.position.realizedPnl.toFixed(4),
      },
      'Позиция обновлена',
    );

    this.emit('position_update', this.position);
    this.checkLimits();
  }

  updateUnrealizedPnl(currentFairValue: number): void {
    this.position.unrealizedPnl =
      (currentFairValue - this.position.avgEntryPrice) * this.position.yesShares;
  }

  /**
   * Pre-trade risk check. Returns what action is allowed.
   */
  checkQuote(quote: Quote): RiskAction {
    if (this.halted) return RiskAction.HALT;

    if (this.dailySpendUsdc >= CONFIG.DAILY_SPEND_CAP) {
      log.warn({ spent: this.dailySpendUsdc.toFixed(2), cap: CONFIG.DAILY_SPEND_CAP }, 'Дневной лимит достигнут — СТОП');
      this.halted = true;
      this.emit('halt', 'daily_spend_cap');
      return RiskAction.HALT;
    }

    const absPosition = Math.abs(this.position.netDelta);
    const totalPnl = this.position.realizedPnl + this.position.unrealizedPnl;

    if (totalPnl < -CONFIG.MAX_LOSS) {
      log.error({ totalPnl }, 'Превышен макс. убыток — СТОП');
      this.halted = true;
      this.emit('halt', 'max_loss_breached');
      return RiskAction.HALT;
    }

    const notional = absPosition * (quote.fairValue || 0.5);
    if (notional > CONFIG.MAX_NOTIONAL) {
      log.warn({ notional }, 'Превышен макс. нотионал — только снижение позиции');
      return RiskAction.REDUCE_ONLY;
    }

    if (absPosition > CONFIG.MAX_POSITION) {
      log.warn({ absPosition }, 'Превышена макс. позиция — только снижение позиции');
      return RiskAction.REDUCE_ONLY;
    }

    return RiskAction.ALLOW;
  }

  /**
   * Adjust quote sizes based on risk action.
   * REDUCE_ONLY: only quote on the side that reduces position.
   * HALT: zero all sizes.
   */
  applyRiskAdjustment(quote: Quote, action: RiskAction): Quote {
    if (action === RiskAction.HALT) {
      return { ...quote, bidSize: 0, askSize: 0 };
    }

    if (action === RiskAction.REDUCE_ONLY) {
      if (this.position.netDelta > 0) {
        return { ...quote, bidSize: 0 };
      }
      return { ...quote, askSize: 0 };
    }

    return quote;
  }

  unhalt(): void {
    this.halted = false;
    log.info('Риск-стоп снят');
  }

  stop(): void {
    if (this.midnightResetTimer) clearTimeout(this.midnightResetTimer);
  }

  resetForNewMarket(): void {
    this.position = {
      yesShares: 0,
      noShares: 0,
      netDelta: 0,
      avgEntryPrice: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
    };
    this.halted = false;
    log.info('Позиция сброшена для нового рынка');
    this.emit('position_update', this.position);
  }

  private checkLimits(): void {
    const totalPnl = this.position.realizedPnl + this.position.unrealizedPnl;
    if (totalPnl < -CONFIG.MAX_LOSS) {
      this.halted = true;
      this.emit('halt', 'max_loss_breached');
    }
  }
}
