import { EventEmitter } from 'node:events';
import { Wallet } from 'ethers';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import { getCtfBalance, mergePositions } from './merge.js';

const log = childLogger('GhostFillDetector');

// How long to wait before declaring a fill "ghost" (network delay tolerance)
const GHOST_WAIT_MS = 30_000;
// Max CLOB sell attempts for unmatched side
const SELL_RETRIES = 3;

interface PendingFill {
  orderId: string;
  side: 'YES' | 'NO';
  tokenId: string;
  expectedShares: number;
  baseline: number; // onchain balance before fill
  detectedAt: number;
}

export class GhostFillDetector extends EventEmitter {
  private wallet: Wallet;
  private conditionId = '';
  private yesTokenId = '';
  private noTokenId = '';
  private pending = new Map<string, PendingFill>();
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(wallet: Wallet) {
    super();
    this.wallet = wallet;
  }

  setMarket(conditionId: string, yesTokenId: string, noTokenId: string): void {
    this.conditionId = conditionId;
    this.yesTokenId = yesTokenId;
    this.noTokenId = noTokenId;
    this.pending.clear();
  }

  start(): void {
    this.checkTimer = setInterval(() => this.check(), 5_000);
  }

  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
  }

  // Record a CLOB fill event — we'll verify it onchain after GHOST_WAIT_MS
  async recordFill(
    orderId: string,
    side: 'YES' | 'NO',
    expectedShares: number,
  ): Promise<void> {
    if (CONFIG.DRY_RUN) return;

    const tokenId = side === 'YES' ? this.yesTokenId : this.noTokenId;
    const baseline = await getCtfBalance(CONFIG.PROXY_ADDRESS, tokenId);

    this.pending.set(orderId, {
      orderId,
      side,
      tokenId,
      expectedShares,
      baseline,
      detectedAt: Date.now(),
    });

    log.debug({ orderId, side, baseline, expectedShares }, 'Fill recorded for ghost check');
  }

  private async check(): Promise<void> {
    if (this.pending.size === 0) return;

    const now = Date.now();

    for (const [orderId, fill] of this.pending) {
      if (now - fill.detectedAt < GHOST_WAIT_MS) continue;

      this.pending.delete(orderId);

      const actualBalance = await getCtfBalance(CONFIG.PROXY_ADDRESS, fill.tokenId);
      const received = actualBalance - fill.baseline;

      if (received >= fill.expectedShares * 0.99) {
        // Fill confirmed onchain — normal
        log.debug({ orderId, received }, 'Fill confirmed onchain');
        continue;
      }

      log.warn(
        { orderId, side: fill.side, expected: fill.expectedShares, received },
        'Ghost fill detected — CLOB fill not confirmed onchain',
      );

      this.emit('ghost_fill', { orderId, side: fill.side, expected: fill.expectedShares, received });
      await this.recover(fill, received);
    }
  }

  private async recover(fill: PendingFill, actualReceived: number): Promise<void> {
    log.info({ side: fill.side, actualReceived }, 'Starting ghost fill recovery');

    // Merge whatever paired shares we have to recover USDC
    const yesBal = await getCtfBalance(CONFIG.PROXY_ADDRESS, this.yesTokenId);
    const noBal = await getCtfBalance(CONFIG.PROXY_ADDRESS, this.noTokenId);
    const mergeable = Math.min(yesBal, noBal);

    if (mergeable > 0.01) {
      try {
        await mergePositions(this.wallet, this.conditionId, mergeable);
        log.info({ merged: mergeable }, 'Ghost fill recovery: merged paired shares');
      } catch (err) {
        log.error({ err }, 'Ghost fill recovery: merge failed');
      }
    }

    // Emit so orchestrator can decide what to do with the remaining unpaired side
    const remainingYes = await getCtfBalance(CONFIG.PROXY_ADDRESS, this.yesTokenId);
    const remainingNo = await getCtfBalance(CONFIG.PROXY_ADDRESS, this.noTokenId);

    if (remainingYes > 0.01 || remainingNo > 0.01) {
      this.emit('unmatched_residual', {
        yesBalance: remainingYes,
        noBalance: remainingNo,
        conditionId: this.conditionId,
      });
    }
  }
}
