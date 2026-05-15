import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import type { ActiveMarketContext } from '../strategies/types.js';
import type {
  L2Book,
  PriceLevel,
  PolymarketMarketMsg,
  PolymarketUserMsg,
} from '../types.js';

const log = childLogger('OrderbookAgent');

export class OrderbookAgent extends EventEmitter {
  private marketWs: WebSocket | null = null;
  private userWs: WebSocket | null = null;
  private alive = false;
  private reconnectTimers: ReturnType<typeof setTimeout>[] = [];
  private market: ActiveMarketContext | null = null;

  private yesBook: L2Book = { bids: [], asks: [], timestamp: 0 };
  private noBook: L2Book = { bids: [], asks: [], timestamp: 0 };

  get yesOrderbook(): L2Book {
    return this.yesBook;
  }

  get noOrderbook(): L2Book {
    return this.noBook;
  }

  start(): void {
    this.alive = true;
    log.info('OrderbookAgent запущен (ожидает назначения рынка)');
  }

  switchMarket(market: ActiveMarketContext): void {
    this.market = market;
    this.yesBook = { bids: [], asks: [], timestamp: 0 };
    this.noBook = { bids: [], asks: [], timestamp: 0 };

    this.disconnectAll();
    this.connectMarket();
    this.connectUser();

    log.info(
      { conditionId: market.conditionId },
      'OrderbookAgent переключён на рынок',
    );
  }

  stop(): void {
    this.alive = false;
    this.reconnectTimers.forEach(clearTimeout);
    this.disconnectAll();
  }

  private disconnectAll(): void {
    [this.marketWs, this.userWs].forEach((ws) => {
      if (ws) {
        ws.removeAllListeners();
        // Avoid "WebSocket was closed before connection established" error
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
          ws.close();
        } else if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
      }
    });
    this.marketWs = null;
    this.userWs = null;
  }

  private connectMarket(): void {
    if (!this.alive || !this.market) return;
    log.info('Подключение к WebSocket рынка');

    this.marketWs = new WebSocket(CONFIG.WS_MARKET_URL);

    this.marketWs.on('open', () => {
      log.info('WebSocket рынка подключён');
      const sub = JSON.stringify({
        assets_ids: [this.market!.yesTokenId, this.market!.noTokenId],
        type: 'market',
        custom_feature_enabled: true,
      });
      this.marketWs!.send(sub);
      log.info('Подписка на канал рынка');
    });

    this.marketWs.on('message', (raw: Buffer) => {
      const recvWallMs = Date.now();
      try {
        const msg = JSON.parse(raw.toString());
        if (Array.isArray(msg)) {
          msg.forEach((m) => this.handleMarketMsg(m, recvWallMs));
        } else {
          this.handleMarketMsg(msg as PolymarketMarketMsg, recvWallMs);
        }
      } catch (err) {
        log.error({ err }, 'Ошибка парсинга сообщения рынка');
      }
    });

    this.marketWs.on('close', (code: number) => {
      log.warn({ code }, 'WebSocket рынка закрыт');
      this.scheduleReconnect(() => this.connectMarket());
    });

    this.marketWs.on('error', (err: Error) => {
      log.error({ err: err.message }, 'Ошибка WebSocket рынка');
    });
  }

  private connectUser(): void {
    if (CONFIG.DRY_RUN) return;
    if (!this.alive || !this.market) return;
    log.info('Подключение к пользовательскому WebSocket');

    this.userWs = new WebSocket(CONFIG.WS_USER_URL);

    this.userWs.on('open', () => {
      log.info('Пользовательский WebSocket подключён');
      const sub = JSON.stringify({
        auth: {
          apiKey: CONFIG.API_KEY,
          secret: CONFIG.API_SECRET,
          passphrase: CONFIG.API_PASSPHRASE,
        },
        markets: [this.market!.conditionId],
        type: 'user',
      });
      this.userWs!.send(sub);
      log.info('Подписка на пользовательский канал');
    });

    this.userWs.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (Array.isArray(msg)) {
          msg.forEach((m) => this.handleUserMsg(m));
        } else {
          this.handleUserMsg(msg as PolymarketUserMsg);
        }
      } catch (err) {
        log.error({ err }, 'Failed to parse user WS message');
      }
    });

    this.userWs.on('close', (code: number) => {
      log.warn({ code }, 'Пользовательский WebSocket закрыт');
      this.scheduleReconnect(() => this.connectUser());
    });

    this.userWs.on('error', (err: Error) => {
      log.error({ err: err.message }, 'Ошибка пользовательского WebSocket');
    });
  }

  private handleMarketMsg(msg: PolymarketMarketMsg, recvWallMs: number): void {
    if (!this.market) return;

    if (msg.event_type === 'book') {
      const msgTsMs = parseInt(msg.timestamp); // Polymarket timestamp already in ms
      const networkLatencyMs = msgTsMs > 0 ? recvWallMs - msgTsMs : 0;
      const book = this.parseBook(msg.bids, msg.asks, recvWallMs);
      if (msg.asset_id === this.market.yesTokenId) {
        this.yesBook = book;
      } else if (msg.asset_id === this.market.noTokenId) {
        this.noBook = book;
      }
      this.emit('book_update', { assetId: msg.asset_id, book, networkLatencyMs });
    }

    if (msg.event_type === 'price_change') {
      for (const pc of msg.price_changes) {
        const target =
          pc.asset_id === this.market.yesTokenId ? this.yesBook : this.noBook;
        this.applyPriceChange(target, pc);
      }
      // price_change has no server timestamp — emit with 0 latency so index.ts still fires
      this.emit('book_update', { assetId: msg.market, book: this.yesBook, networkLatencyMs: 0 });
      this.emit('price_change', { msg, recvWallMs });
    }

    if (msg.event_type === 'last_trade_price') {
      this.emit('last_trade', { assetId: msg.asset_id, price: parseFloat(msg.price), side: msg.side });
    }
  }

  private handleUserMsg(msg: PolymarketUserMsg): void {
    if (msg.event_type === 'trade' && msg.type === 'TRADE') {
      log.info(
        {
          side: (msg as any).side,
          price: (msg as any).price,
          size: (msg as any).size,
          status: (msg as any).status,
        },
        'Ордер исполнен',
      );
      this.emit('fill', msg);
    }

    if (msg.event_type === 'order') {
      this.emit('order_update', msg);
    }
  }

  private parseBook(
    rawBids: Array<{ price: string; size: string }>,
    rawAsks: Array<{ price: string; size: string }>,
    timestamp: number,
  ): L2Book {
    const bids: PriceLevel[] = rawBids
      .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .sort((a, b) => b.price - a.price);
    const asks: PriceLevel[] = rawAsks
      .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .sort((a, b) => a.price - b.price);
    return { bids, asks, timestamp };
  }

  private applyPriceChange(
    book: L2Book,
    change: { price: string; size: string; side: string },
  ): void {
    const price = parseFloat(change.price);
    const size = parseFloat(change.size);
    const levels = change.side === 'BUY' ? book.bids : book.asks;

    const idx = levels.findIndex((l) => l.price === price);
    if (size === 0) {
      if (idx >= 0) levels.splice(idx, 1);
    } else if (idx >= 0) {
      levels[idx].size = size;
    } else {
      levels.push({ price, size });
      if (change.side === 'BUY') {
        levels.sort((a, b) => b.price - a.price);
      } else {
        levels.sort((a, b) => a.price - b.price);
      }
    }
    book.timestamp = Date.now();
  }

  private scheduleReconnect(fn: () => void): void {
    if (!this.alive) return;
    const timer = setTimeout(fn, 2000);
    this.reconnectTimers.push(timer);
  }
}
