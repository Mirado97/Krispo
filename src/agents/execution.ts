import { EventEmitter } from 'node:events';
import { Wallet } from 'ethers';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import { buildOrder, signOrder, type BuildOrderParams } from '../signing/eip712.js';
import { buildL2Headers } from '../signing/hmac.js';
import type { ActiveMarketContext } from '../strategies/types.js';
import {
  Side,
  type Quote,
  type SignedOrder,
  type ActiveOrders,
  type OrderResponse,
  type CancelResponse,
  type HeartbeatResponse,
} from '../types.js';

const log = childLogger('ExecutionAgent');

const SIDE_STR: Record<number, string> = { 0: 'BUY', 1: 'SELL' };

function buildOrderPayload(signed: SignedOrder, orderType: string) {
  return {
    order: {
      salt: parseInt(signed.salt, 10),
      maker: signed.maker,
      signer: signed.signer,
      taker: signed.taker,
      tokenId: signed.tokenId,
      makerAmount: signed.makerAmount,
      takerAmount: signed.takerAmount,
      side: SIDE_STR[signed.side],
      expiration: signed.expiration,
      nonce: signed.nonce,
      feeRateBps: signed.feeRateBps,
      signatureType: signed.signatureType,
      signature: signed.signature,
    },
    owner: CONFIG.API_KEY,
    orderType,
    deferExec: false,
  };
}

export class ExecutionAgent extends EventEmitter {
  private wallet: Wallet;
  private market: ActiveMarketContext | null = null;
  private feeRateBps = '0';
  private active: ActiveOrders = {
    bidOrderId: null,
    askOrderId: null,
    bidPrice: 0,
    askPrice: 0,
    bidSize: 0,
    askSize: 0,
  };
  private heartbeatId = '';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cancelInFlight = false;

  constructor(wallet: Wallet) {
    super();
    this.wallet = wallet;
  }

  get activeOrders(): ActiveOrders {
    return { ...this.active };
  }

  async init(): Promise<void> {
    if (CONFIG.DRY_RUN) {
      log.info('[СИМУЛЯЦИЯ] ExecutionAgent инициализирован — ордера не выставляются');
      return;
    }
    this.startHeartbeat();
    log.info('ExecutionAgent initialized (waiting for market assignment)');
  }

  async setMarket(market: ActiveMarketContext): Promise<void> {
    this.market = market;
    if (CONFIG.DRY_RUN) {
      log.info({ conditionId: market.conditionId }, '[СИМУЛЯЦИЯ] Рынок установлен');
      return;
    }
    await this.cancelAll();
    await this.fetchFeeRate();
    log.info(
      { conditionId: market.conditionId, feeRateBps: this.feeRateBps },
      'ExecutionAgent switched market',
    );
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  async cancelAndReplace(quote: Quote): Promise<{ cycleMs: number; signMs: number; cancelMs: number; submitMs: number }> {
    if (!this.market) return { cycleMs: 0, signMs: 0, cancelMs: 0, submitMs: 0 };

    if (CONFIG.DRY_RUN) {
      log.debug(
        { bid: quote.bidPrice.toFixed(4), ask: quote.askPrice.toFixed(4), fv: quote.fairValue.toFixed(4), spread: (quote.spread * 10000).toFixed(0) + 'bps' },
        '[СИМУЛЯЦИЯ] выставить котировки',
      );
      return { cycleMs: 0, signMs: 0, cancelMs: 0, submitMs: 0 };
    }

    if (this.cancelInFlight) return { cycleMs: 0, signMs: 0, cancelMs: 0, submitMs: 0 };

    this.cancelInFlight = true;
    const cycleStart = performance.now();

    try {
      const signStart = performance.now();
      const [signedBid, signedAsk, _cancelResult] = await Promise.all([
        this.signNewOrder(this.market.yesTokenId, Side.BUY, quote.bidPrice, quote.bidSize),
        this.signNewOrder(this.market.yesTokenId, Side.SELL, quote.askPrice, quote.askSize),
        this.cancelExisting(),
      ]);
      const signMs = performance.now() - signStart;

      const submitStart = performance.now();
      const [bidResult, askResult] = await this.submitOrdersBatch(signedBid, signedAsk);
      const submitMs = performance.now() - submitStart;

      this.active = {
        bidOrderId: bidResult?.orderID ?? null,
        askOrderId: askResult?.orderID ?? null,
        bidPrice: quote.bidPrice,
        askPrice: quote.askPrice,
        bidSize: quote.bidSize,
        askSize: quote.askSize,
      };

      const cycleMs = performance.now() - cycleStart;
      const cancelMs = signMs;

      log.info(
        { cycleMs: cycleMs.toFixed(1), signMs: signMs.toFixed(1), submitMs: submitMs.toFixed(1), bid: quote.bidPrice, ask: quote.askPrice },
        'Цикл cancel/replace выполнен',
      );

      this.emit('cycle_complete', { cycleMs, signMs, cancelMs, submitMs });
      return { cycleMs, signMs, cancelMs, submitMs };
    } catch (err) {
      log.error({ err }, 'Cancel/replace cycle failed');
      this.emit('cycle_error', err);
      return { cycleMs: performance.now() - cycleStart, signMs: 0, cancelMs: 0, submitMs: 0 };
    } finally {
      this.cancelInFlight = false;
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (CONFIG.DRY_RUN) {
      log.info({ orderId }, '[СИМУЛЯЦИЯ] отмена ордера');
      return;
    }
    try {
      await this.httpRequest('DELETE', '/cancel', JSON.stringify({ orderId }));
      log.info({ orderId }, 'Order cancelled');
    } catch (err) {
      log.error({ err, orderId }, 'Failed to cancel order');
    }
  }

  async cancelAll(): Promise<void> {
    if (CONFIG.DRY_RUN) {
      this.active = { bidOrderId: null, askOrderId: null, bidPrice: 0, askPrice: 0, bidSize: 0, askSize: 0 };
      return;
    }
    try {
      await this.httpRequest('DELETE', '/cancel-all');
      this.active = { bidOrderId: null, askOrderId: null, bidPrice: 0, askPrice: 0, bidSize: 0, askSize: 0 };
      log.info('All orders cancelled');
    } catch (err) {
      log.error({ err }, 'Failed to cancel all');
    }
  }

  // Submit a batch of GTC BUY limit orders at different price levels (ladder).
  // Returns array of order IDs for each level (null if level was skipped or failed).
  async submitLadderOrders(
    tokenId: string,
    levels: Array<{ price: number; size: number }>,
  ): Promise<Array<string | null>> {
    if (!this.market) return levels.map(() => null);

    if (CONFIG.DRY_RUN) {
      for (const lvl of levels) {
        log.info(
          { price: lvl.price.toFixed(4), size: lvl.size.toFixed(2) },
          '[СИМУЛЯЦИЯ] выставить Ladder BUY',
        );
      }
      return levels.map(() => null);
    }

    const signed = await Promise.all(
      levels.map((lvl) => this.signNewOrder(tokenId, Side.BUY, lvl.price, lvl.size)),
    );

    const payloads = signed.map((s) => buildOrderPayload(s, 'GTC'));
    const body = JSON.stringify(payloads);

    try {
      const results = await this.httpRequest<OrderResponse[]>('POST', '/orders', body);
      return (results ?? []).map((r) => r?.orderID ?? null);
    } catch (err) {
      log.error({ err }, 'Ladder batch submission failed, falling back to sequential');
      const ids: Array<string | null> = [];
      for (const payload of payloads) {
        const r = await this.submitSingle(payload);
        ids.push(r?.orderID ?? null);
      }
      return ids;
    }
  }

  // Submit a FAK (Fill-And-Kill) pair: BUY YES + BUY NO simultaneously.
  // Returns filled amounts for each side, or [0, 0] on dry run.
  async submitFakPair(
    yesTokenId: string,
    noTokenId: string,
    yesAskPrice: number,
    noAskPrice: number,
    sizeEach: number,
  ): Promise<{ yesFilled: number; noFilled: number; yesOrderId: string | null; noOrderId: string | null }> {
    if (!this.market) return { yesFilled: 0, noFilled: 0, yesOrderId: null, noOrderId: null };

    if (CONFIG.DRY_RUN) {
      log.info(
        { yesAsk: yesAskPrice.toFixed(4), noAsk: noAskPrice.toFixed(4), combined: (yesAskPrice + noAskPrice).toFixed(4), size: sizeEach },
        '[СИМУЛЯЦИЯ] Taker Sweep FAK пара',
      );
      return { yesFilled: sizeEach, noFilled: sizeEach, yesOrderId: null, noOrderId: null };
    }

    const [signedYes, signedNo] = await Promise.all([
      this.signNewOrder(yesTokenId, Side.BUY, yesAskPrice, sizeEach),
      this.signNewOrder(noTokenId, Side.BUY, noAskPrice, sizeEach),
    ]);

    const yesPayload = buildOrderPayload(signedYes, 'FAK');
    const noPayload = buildOrderPayload(signedNo, 'FAK');
    const body = JSON.stringify([yesPayload, noPayload]);

    try {
      const results = await this.httpRequest<OrderResponse[]>('POST', '/orders', body);
      const yesRes = results?.[0] ?? null;
      const noRes = results?.[1] ?? null;

      log.info(
        { yesOrderId: yesRes?.orderID, noOrderId: noRes?.orderID, combined: (yesAskPrice + noAskPrice).toFixed(4) },
        'FAK pair submitted',
      );

      return {
        yesFilled: yesRes?.success ? sizeEach : 0,
        noFilled: noRes?.success ? sizeEach : 0,
        yesOrderId: yesRes?.orderID ?? null,
        noOrderId: noRes?.orderID ?? null,
      };
    } catch (err) {
      log.error({ err }, 'FAK pair submission failed');
      return { yesFilled: 0, noFilled: 0, yesOrderId: null, noOrderId: null };
    }
  }

  // Submit a single FAK SELL — used by CTF Split mode to exit YES position
  async submitFakSell(
    tokenId: string,
    bidPrice: number,
    size: number,
    label = 'FAK sell',
  ): Promise<{ filled: number; orderId: string | null }> {
    if (!this.market) return { filled: 0, orderId: null };

    if (CONFIG.DRY_RUN) {
      log.info({ tokenId: tokenId.slice(0, 8) + '...', bid: bidPrice.toFixed(4), size }, `[DRY_RUN] would ${label}`);
      return { filled: size, orderId: null };
    }

    try {
      const signed = await this.signNewOrder(tokenId, Side.SELL, bidPrice, size);
      const payload = buildOrderPayload(signed, 'FAK');
      const result = await this.httpRequest<OrderResponse>('POST', '/order', JSON.stringify(payload));
      return { filled: result?.success ? size : 0, orderId: result?.orderID ?? null };
    } catch (err) {
      log.error({ err }, `${label} failed`);
      return { filled: 0, orderId: null };
    }
  }

  handleFill(orderId: string, filledAmount: number, side: string): void {
    if (orderId === this.active.bidOrderId) {
      this.active.bidSize = Math.max(0, this.active.bidSize - filledAmount);
      if (this.active.bidSize <= 0) this.active.bidOrderId = null;
    } else if (orderId === this.active.askOrderId) {
      this.active.askSize = Math.max(0, this.active.askSize - filledAmount);
      if (this.active.askSize <= 0) this.active.askOrderId = null;
    }
    this.emit('fill_processed', { orderId, filledAmount, side });
  }

  private async signNewOrder(
    tokenId: string,
    side: Side,
    price: number,
    size: number,
  ): Promise<SignedOrder> {
    const negRisk = this.market?.negRisk ?? false;
    const params: BuildOrderParams = {
      tokenId,
      side,
      price,
      size,
      feeRateBps: this.feeRateBps,
      negRisk,
    };
    const order = buildOrder(params);
    return signOrder(this.wallet, order, negRisk);
  }

  private async cancelExisting(): Promise<CancelResponse | null> {
    const hasOrders = this.active.bidOrderId || this.active.askOrderId;
    if (!hasOrders || !this.market) return null;

    try {
      const body = JSON.stringify({
        market: this.market.conditionId,
        asset_id: this.market.yesTokenId,
      });
      return await this.httpRequest<CancelResponse>('DELETE', '/cancel-market-orders', body);
    } catch (err) {
      log.error({ err }, 'Cancel failed');
      return null;
    }
  }

  private async submitOrdersBatch(
    bid: SignedOrder,
    ask: SignedOrder,
  ): Promise<[OrderResponse | null, OrderResponse | null]> {
    const bidPayload = buildOrderPayload(bid, 'GTC');
    const askPayload = buildOrderPayload(ask, 'GTC');
    const body = JSON.stringify([bidPayload, askPayload]);

    try {
      const results = await this.httpRequest<OrderResponse[]>('POST', '/orders', body);
      return [results?.[0] ?? null, results?.[1] ?? null];
    } catch (err) {
      log.error({ err }, 'Batch order submission failed, falling back to individual');
      const [bidRes, askRes] = await Promise.all([
        this.submitSingle(bidPayload),
        this.submitSingle(askPayload),
      ]);
      return [bidRes, askRes];
    }
  }

  private async submitSingle(payload: ReturnType<typeof buildOrderPayload>): Promise<OrderResponse | null> {
    try {
      return await this.httpRequest<OrderResponse>('POST', '/order', JSON.stringify(payload));
    } catch (err) {
      log.error({ err }, 'Single order submission failed');
      return null;
    }
  }

  private async fetchFeeRate(): Promise<void> {
    if (!this.market) return;
    try {
      const resp = await fetch(
        `${CONFIG.CLOB_URL}/fee-rate?token_id=${this.market.yesTokenId}`,
      );
      const data = (await resp.json()) as { fee_rate_bps?: string; base_fee?: number };
      this.feeRateBps = data.fee_rate_bps ?? '0';
      log.info({ feeRateBps: this.feeRateBps }, 'Fetched fee rate');
    } catch (err) {
      log.warn({ err }, 'Failed to fetch fee rate, defaulting to 0');
      this.feeRateBps = '0';
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      try {
        const body = JSON.stringify({ heartbeat_id: this.heartbeatId || null });
        const resp = await this.httpRequest<HeartbeatResponse>('POST', '/v1/heartbeats', body);
        if (resp?.heartbeat_id) this.heartbeatId = resp.heartbeat_id;
      } catch (err) {
        log.error({ err }, 'Heartbeat failed');
      }
    }, CONFIG.HEARTBEAT_INTERVAL_MS);
  }

  private async httpRequest<T>(method: string, path: string, body?: string): Promise<T | null> {
    const url = CONFIG.CLOB_URL + path;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...buildL2Headers(method, path, body),
    };

    const resp = await fetch(url, {
      method: method === 'DELETE' ? 'DELETE' : 'POST',
      headers,
      body: method !== 'DELETE' || body ? body : undefined,
      keepalive: true,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      log.error({ status: resp.status, path, errText }, 'HTTP request failed');
      throw new Error(`HTTP ${resp.status}: ${errText}`);
    }

    const text = await resp.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  }
}
