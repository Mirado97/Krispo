import { EventEmitter } from 'node:events';
import { Wallet } from 'ethers';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import { splitPosition } from '../ctf/split.js';
import { redeemPositions } from '../ctf/redeem.js';
import { getCtfBalance } from '../ctf/merge.js';
import type { ExecutionAgent } from '../agents/execution.js';
import type { L2Book } from '../types.js';
import type { ActiveMarketContext } from '../strategies/types.js';

const log = childLogger('CtfSplit');

type SplitState = 'idle' | 'entered' | 'exiting_yes';

export class CtfSplitMode extends EventEmitter {
  private execution: ExecutionAgent;
  private wallet: Wallet;
  private market: ActiveMarketContext | null = null;

  private state: SplitState = 'idle';
  private splitShares = 0;   // how many YES (and NO) tokens we got from the split
  private entryUsdcCost = 0;

  // State updated from outside on every tick
  private fairValue = 0.5;
  private volatility = 0;
  private timeToExpiryMs = 0;

  // Cooldown: don't re-enter for 60s after an exit
  private lastExitAt = 0;
  private readonly REENTRY_COOLDOWN_MS = 60_000;

  constructor(execution: ExecutionAgent, wallet: Wallet) {
    super();
    this.execution = execution;
    this.wallet = wallet;
  }

  setMarket(market: ActiveMarketContext): void {
    this.market = market;
    this.state = 'idle';
    this.splitShares = 0;
    this.entryUsdcCost = 0;
    this.lastExitAt = 0;
  }

  update(fairValue: number, volatility: number, timeToExpiryMs: number): void {
    this.fairValue = fairValue;
    this.volatility = volatility;
    this.timeToExpiryMs = timeToExpiryMs;
  }

  // Main tick — called on every BTC price update (same cadence as quote loop)
  async tick(yesBook: L2Book): Promise<void> {
    if (!CONFIG.MODE_CTF_SPLIT || !this.market) return;

    const circuitBreakerMs = CONFIG.CIRCUIT_BREAKER_SEC * 1000;

    // Circuit breaker: force-exit everything before expiry
    if (this.timeToExpiryMs < circuitBreakerMs && this.state !== 'idle') {
      await this.forceExit(yesBook, 'circuit_breaker');
      return;
    }

    if (this.state === 'idle') {
      await this.maybeEnter();
    } else if (this.state === 'entered') {
      await this.maybeExitYes(yesBook);
    }
  }

  // Called after market resolution — redeem winning tokens
  async redeem(winnerIndexSet: number): Promise<void> {
    if (!this.market || this.splitShares <= 0) return;
    log.info({ winnerIndexSet, shares: this.splitShares }, 'Redeeming winning tokens');
    await redeemPositions(this.wallet, this.market.conditionId, [winnerIndexSet]);
    this.splitShares = 0;
    this.state = 'idle';
    this.emit('redeemed', { winnerIndexSet });
  }

  private async maybeEnter(): Promise<void> {
    if (Date.now() - this.lastExitAt < this.REENTRY_COOLDOWN_MS) return;

    const fv = this.fairValue;
    const vol = this.volatility;

    // Entry conditions: uncertain market (fv near 0.5) AND enough volatility to make exit worthwhile
    const fvInBand = fv >= CONFIG.CTF_SPLIT_TRIGGER_MIN && fv <= CONFIG.CTF_SPLIT_TRIGGER_MAX;
    const volSufficient = vol >= CONFIG.CTF_VOL_MIN;

    if (!fvInBand || !volSufficient) return;

    const usdcAmount = CONFIG.CTF_SPLIT_SIZE;

    log.info(
      { fv: fv.toFixed(4), vol: vol.toFixed(4), usdcAmount, conditionId: this.market!.conditionId },
      'CTF split entry triggered',
    );

    this.state = 'exiting_yes'; // prevent re-entry during async op
    try {
      await splitPosition(this.wallet, this.market!.conditionId, usdcAmount);
      this.splitShares = usdcAmount; // 1 USDC = 1 YES + 1 NO share
      this.entryUsdcCost = usdcAmount;
      this.state = 'entered';
      this.emit('entered', { usdcAmount, fv, vol });
      log.info({ shares: this.splitShares, entryUsdcCost: this.entryUsdcCost }, 'CTF split entered');
    } catch (err) {
      log.error({ err }, 'CTF split entry failed');
      this.state = 'idle';
    }
  }

  private async maybeExitYes(yesBook: L2Book): Promise<void> {
    const yesBid = yesBook.bids[0]?.price;
    if (!yesBid) return;

    const exitThreshold = this.computeExitThreshold();

    log.debug(
      { yesBid: yesBid.toFixed(4), exitThreshold: exitThreshold.toFixed(4), fv: this.fairValue.toFixed(4) },
      'CTF split monitoring',
    );

    if (yesBid < exitThreshold) return;

    log.info(
      { yesBid: yesBid.toFixed(4), exitThreshold: exitThreshold.toFixed(4), shares: this.splitShares },
      'CTF split exit triggered — selling YES',
    );

    this.state = 'exiting_yes';
    try {
      const { filled } = await this.execution.submitFakSell(
        this.market!.yesTokenId,
        yesBid,
        this.splitShares,
        'CTF split YES exit',
      );

      if (filled > 0) {
        const yesRevenue = filled * yesBid;
        // NO tokens remain → worth $0.50 avg at entry, will resolve to 0 or 1
        const profit = yesRevenue - this.entryUsdcCost * (filled / this.splitShares);
        log.info(
          { filled, yesBid, yesRevenue: yesRevenue.toFixed(4), profit: profit.toFixed(4) },
          'YES sold — NO position held to resolution',
        );
        this.splitShares -= filled;
        if (this.splitShares <= 0.001) {
          this.splitShares = 0;
          this.state = 'idle';
        } else {
          // Partial fill — keep monitoring
          this.state = 'entered';
        }
        this.lastExitAt = Date.now();
        this.emit('yes_sold', { filled, yesBid, profit });
      } else {
        log.warn('YES FAK sell missed — will retry next tick');
        this.state = 'entered';
      }
    } catch (err) {
      log.error({ err }, 'CTF split YES exit failed');
      this.state = 'entered';
    }
  }

  private async forceExit(yesBook: L2Book, reason: string): Promise<void> {
    if (this.splitShares <= 0) {
      this.state = 'idle';
      return;
    }

    const yesBid = yesBook.bids[0]?.price ?? 0.01;
    log.warn({ reason, shares: this.splitShares, yesBid }, 'CTF split force-exit');

    this.state = 'exiting_yes';
    try {
      // Sell YES at whatever the market will give us
      await this.execution.submitFakSell(this.market!.yesTokenId, yesBid, this.splitShares, 'force-exit YES');
      // NO tokens will resolve naturally at expiry (redeem called externally)
    } catch (err) {
      log.error({ err }, 'CTF split force-exit failed');
    } finally {
      this.splitShares = 0;
      this.state = 'idle';
      this.lastExitAt = Date.now();
      this.emit('force_exit', { reason });
    }
  }

  // exit_threshold = fair_value + k × σ × √T
  // Represents: "we expect YES to be here at max vol swing — exit if it gets there"
  private computeExitThreshold(): number {
    const T = Math.max(this.timeToExpiryMs / 1000 / (365.25 * 24 * 3600), 1e-10);
    const sqrtT = Math.sqrt(T);
    return Math.min(0.99, this.fairValue + CONFIG.CTF_EXIT_K * this.volatility * sqrtT);
  }

  get currentState(): SplitState {
    return this.state;
  }

  get heldShares(): number {
    return this.splitShares;
  }
}
