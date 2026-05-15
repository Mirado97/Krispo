import { EventEmitter } from 'node:events';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import type { ExecutionAgent } from '../agents/execution.js';
import type { RiskAgent } from '../agents/risk.js';
import type { L2Book } from '../types.js';
import type { ActiveMarketContext } from '../strategies/types.js';

const log = childLogger('LadderMode');

interface LadderLevel {
  price: number;
  size: number;
  orderId: string | null;
}

export class LadderMode extends EventEmitter {
  private execution: ExecutionAgent;
  private risk: RiskAgent;
  private market: ActiveMarketContext | null = null;

  private fairValue = 0.5;
  private activeLevels: LadderLevel[] = [];
  private inFlight = false;

  // Cooldown: don't resubmit ladder for 10s after placing
  private lastPlacedAt = 0;
  private readonly RESUBMIT_COOLDOWN_MS = 10_000;

  constructor(execution: ExecutionAgent, risk: RiskAgent) {
    super();
    this.execution = execution;
    this.risk = risk;
  }

  setMarket(market: ActiveMarketContext): void {
    this.market = market;
    this.activeLevels = [];
    this.inFlight = false;
    this.lastPlacedAt = 0;
  }

  updateFairValue(fv: number): void {
    this.fairValue = fv;
  }

  // Called on every book_update — evaluates whether to place/replace ladder
  async tick(yesBook: L2Book, noBook: L2Book): Promise<void> {
    if (!CONFIG.MODE_LADDER || !this.market) return;

    // Cancel stale orders that exceeded inventory hold limit
    const stale = this.risk.tickInventoryCycles();
    for (const orderId of stale) {
      this.activeLevels = this.activeLevels.filter((l) => l.orderId !== orderId);
      await this.execution.cancelOrder(orderId);
      this.emit('stale_cancel', { orderId });
    }

    if (this.inFlight) return;
    if (Date.now() - this.lastPlacedAt < this.RESUBMIT_COOLDOWN_MS) return;

    const yesAsk = yesBook.asks[0]?.price;
    const noAsk = noBook.asks[0]?.price;
    if (!yesAsk || !noAsk) return;

    // Entry condition: YES is significantly cheaper than fair value
    const discount = this.fairValue - yesAsk;
    if (discount < CONFIG.LADDER_ENTRY_DISCOUNT) return;

    // Combined cap check: even the top level must not make the pair too expensive
    const combined = yesAsk + noAsk;
    if (combined > CONFIG.LADDER_MAX_COMBINED) {
      return;
    }

    await this.placeLadder(yesAsk, noAsk);
  }

  private async placeLadder(topAsk: number, noAsk: number): Promise<void> {
    this.inFlight = true;

    const levels = this.buildLevels(topAsk, noAsk);
    if (levels.length === 0) {
      this.inFlight = false;
      return;
    }

    log.info(
      {
        levels: levels.map((l) => ({ price: l.price.toFixed(4), size: l.size.toFixed(2) })),
        fv: this.fairValue.toFixed(4),
        discount: (this.fairValue - topAsk).toFixed(4),
      },
      'Placing ladder orders',
    );

    try {
      const orderIds = await this.execution.submitLadderOrders(
        this.market!.yesTokenId,
        levels,
      );

      this.activeLevels = levels.map((lvl, i) => ({
        ...lvl,
        orderId: orderIds[i] ?? null,
      }));

      // Register each real order for inventory hold tracking
      for (const lvl of this.activeLevels) {
        if (lvl.orderId) this.risk.trackOrder(lvl.orderId);
      }

      this.lastPlacedAt = Date.now();
      this.emit('placed', { levels: this.activeLevels });
    } catch (err) {
      log.error({ err }, 'Ladder placement failed');
    } finally {
      this.inFlight = false;
    }
  }

  // Build price levels, filtering out any that would breach the combined cap
  private buildLevels(topAsk: number, noAsk: number): Array<{ price: number; size: number }> {
    const levels: Array<{ price: number; size: number }> = [];
    const totalSize = CONFIG.ORDER_SIZE;
    const pcts = CONFIG.LADDER_SIZES_PCT;

    for (let i = 0; i < CONFIG.LADDER_LEVELS; i++) {
      const price = topAsk - i * CONFIG.LADDER_STEP;
      if (price <= 0.01) break;

      // Combined cap check per level: use this level's price as the YES cost
      if (price + noAsk > CONFIG.LADDER_MAX_COMBINED) {
        log.debug({ level: i, price: price.toFixed(4), combined: (price + noAsk).toFixed(4) }, 'Ladder level pruned by combined cap');
        break;
      }

      const pct = (pcts[i] ?? pcts[pcts.length - 1]) / 100;
      const size = Math.max(0.01, totalSize * pct);
      levels.push({ price, size });
    }

    return levels;
  }

  get activeOrders(): LadderLevel[] {
    return [...this.activeLevels];
  }

  // Called when a fill comes in — reduce the matched level's size
  handleFill(orderId: string, filledAmount: number): void {
    const level = this.activeLevels.find((l) => l.orderId === orderId);
    if (!level) return;

    level.size -= filledAmount;
    if (level.size <= 0.001) {
      this.activeLevels = this.activeLevels.filter((l) => l.orderId !== orderId);
      this.risk.clearTrackedOrder(orderId);
      // Reset cooldown so new ladder can be placed if still in discount
      this.lastPlacedAt = 0;
    }

    this.emit('fill', { orderId, filledAmount, remaining: level.size });
    log.info({ orderId, filledAmount, remaining: level.size.toFixed(3) }, 'Ladder fill');
  }
}
