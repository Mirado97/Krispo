import { EventEmitter } from 'node:events';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import { mergePositions } from '../ctf/merge.js';
import type { ExecutionAgent } from '../agents/execution.js';
import type { L2Book } from '../types.js';
import type { ActiveMarketContext } from '../strategies/types.js';
import type { Wallet } from 'ethers';

const log = childLogger('TakerSweep');

export interface TakerSignal {
  yesAsk: number;
  noAsk: number;
  combined: number;
  fairValue: number;
  edge: number; // (1 - combined) — expected profit per $1 invested
}

export class TakerSweepMode extends EventEmitter {
  private execution: ExecutionAgent;
  private wallet: Wallet;
  private market: ActiveMarketContext | null = null;
  private fairValue = 0.5;
  private sweepInFlight = false;

  // Cooldown: don't fire two sweeps within 5s (FAK orders settle fast)
  private lastSweepAt = 0;
  private readonly COOLDOWN_MS = 5_000;

  constructor(execution: ExecutionAgent, wallet: Wallet) {
    super();
    this.execution = execution;
    this.wallet = wallet;
  }

  setMarket(market: ActiveMarketContext): void {
    this.market = market;
    this.sweepInFlight = false;
    this.lastSweepAt = 0;
  }

  updateFairValue(fv: number): void {
    this.fairValue = fv;
  }

  // Called on every orderbook update — cheap synchronous check
  checkAnomalies(yesBook: L2Book, noBook: L2Book): TakerSignal | null {
    if (!CONFIG.MODE_TAKER_SWEEP || !this.market) return null;
    if (this.sweepInFlight) return null;
    if (Date.now() - this.lastSweepAt < this.COOLDOWN_MS) return null;

    const yesAsk = yesBook.asks[0]?.price;
    const noAsk = noBook.asks[0]?.price;
    if (!yesAsk || !noAsk) return null;

    const combined = yesAsk + noAsk;
    if (combined >= CONFIG.TAKER_THRESHOLD) return null;

    // Fair value confirmation: both sides must be cheap relative to model
    // YES is cheap if yesAsk < fairValue - EDGE_MIN
    // NO is cheap if noAsk < (1-fairValue) - EDGE_MIN
    const yesEdge = this.fairValue - yesAsk;
    const noEdge = (1 - this.fairValue) - noAsk;
    const bothCheap = yesEdge >= CONFIG.TAKER_EDGE_MIN && noEdge >= CONFIG.TAKER_EDGE_MIN;

    if (!bothCheap) {
      // Combined is low but only one side is cheap — might be arbitrage on one side only,
      // but that's a different trade. Skip to avoid one-sided exposure.
      log.debug(
        { combined: combined.toFixed(4), yesEdge: yesEdge.toFixed(4), noEdge: noEdge.toFixed(4) },
        'Low combined but asymmetric — skip',
      );
      return null;
    }

    const edge = 1 - combined;
    const signal: TakerSignal = { yesAsk, noAsk, combined, fairValue: this.fairValue, edge };

    log.info(
      { combined: combined.toFixed(4), edge: (edge * 100).toFixed(2) + '%', fv: this.fairValue.toFixed(4), threshold: CONFIG.TAKER_THRESHOLD },
      'Taker anomaly detected',
    );
    this.emit('signal', signal);

    return signal;
  }

  // Execute the sweep for a given signal (async, must not block the quote loop)
  async executeSwap(signal: TakerSignal): Promise<void> {
    if (!this.market || this.sweepInFlight) return;

    this.sweepInFlight = true;
    this.lastSweepAt = Date.now();

    const sizeEach = CONFIG.TAKER_SIZE / 2;

    try {
      log.info(
        { yesAsk: signal.yesAsk, noAsk: signal.noAsk, sizeEach, edge: (signal.edge * 100).toFixed(2) + '%' },
        'Executing taker sweep',
      );

      const { yesFilled, noFilled, yesOrderId, noOrderId } =
        await this.execution.submitFakPair(
          this.market.yesTokenId,
          this.market.noTokenId,
          signal.yesAsk,
          signal.noAsk,
          sizeEach,
        );

      if (yesFilled > 0 && noFilled > 0) {
        // Both sides filled — merge immediately for instant profit
        const mergeAmount = Math.min(yesFilled, noFilled);
        log.info({ mergeAmount, profit: (signal.edge * mergeAmount).toFixed(4) }, 'Both FAK filled — merging');

        const txHash = await mergePositions(this.wallet, this.market.conditionId, mergeAmount);
        this.emit('sweep_complete', { signal, mergeAmount, txHash });
        log.info({ txHash, profit: (signal.edge * mergeAmount).toFixed(4) }, 'Taker sweep complete');

      } else if (yesFilled > 0 && noFilled === 0) {
        // YES filled but NO didn't — we have naked YES exposure, cancel is moot (FAK already gone)
        log.warn({ yesFilled, yesOrderId }, 'Partial FAK: YES filled, NO missed — holding YES until expiry or merge opportunity');
        this.emit('partial_fill', { side: 'YES', filled: yesFilled, orderId: yesOrderId });

      } else if (noFilled > 0 && yesFilled === 0) {
        log.warn({ noFilled, noOrderId }, 'Partial FAK: NO filled, YES missed — holding NO until expiry or merge opportunity');
        this.emit('partial_fill', { side: 'NO', filled: noFilled, orderId: noOrderId });

      } else {
        log.info('Both FAK orders missed — no position taken');
        this.emit('sweep_miss', signal);
      }

    } catch (err) {
      log.error({ err }, 'Taker sweep failed');
      this.emit('sweep_error', err);
    } finally {
      this.sweepInFlight = false;
    }
  }
}
