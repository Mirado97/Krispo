import { Wallet } from 'ethers';
import { CONFIG } from './config.js';
import { logger } from './utils/logger.js';
import { MarketManager } from './market-manager.js';
import { Btc5MinStrategy } from './strategies/btc-5min.js';
import { Btc15MinStrategy } from './strategies/btc-15min.js';
import { MarketDataAgent } from './agents/market-data.js';
import { OrderbookAgent } from './agents/orderbook.js';
import { QuotingAgent } from './agents/quoting.js';
import { ExecutionAgent } from './agents/execution.js';
import { RiskAgent, RiskAction } from './agents/risk.js';
import { LatencyMonitor } from './agents/latency.js';
import { GhostFillDetector } from './ctf/ghost-fill.js';
import { TakerSweepMode } from './modes/taker-sweep.js';
import { CtfSplitMode } from './modes/ctf-split.js';
import { LadderMode } from './modes/ladder.js';
import { onMarketStart, onMarketEnd } from './utils/vol-collector.js';
import { PaperTrader } from './simulation/paper-trader.js';
import type { MarketStrategy } from './strategies/types.js';
import type { ActiveMarketContext } from './strategies/types.js';
import type { GhostFillEvent, UnmatchedResidualEvent } from './types.js';
import type { TakerSignal } from './modes/taker-sweep.js';

const log = logger.child({ agent: 'Orchestrator' });

function createStrategy(): MarketStrategy {
  switch (CONFIG.MARKET_STRATEGY) {
    case 'btc-5min':
      return new Btc5MinStrategy(CONFIG.EVENT_SLUG || '');
    case 'btc-15min':
      return new Btc15MinStrategy(CONFIG.EVENT_SLUG || '');
    default:
      throw new Error(`Unknown strategy: ${CONFIG.MARKET_STRATEGY}`);
  }
}

async function main() {
  log.info('=== PolyBot запускается ===');
  log.info(
    {
      wallet: CONFIG.WALLET_ADDRESS,
      proxy: CONFIG.PROXY_ADDRESS,
      signatureType: CONFIG.SIGNATURE_TYPE,
      strategy: CONFIG.MARKET_STRATEGY,
      eventSlug: CONFIG.EVENT_SLUG,
    },
    'Конфигурация загружена',
  );

  const wallet = CONFIG.DRY_RUN
    ? new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
    : new Wallet(CONFIG.PRIVATE_KEY);

  if (!CONFIG.DRY_RUN && wallet.address.toLowerCase() !== CONFIG.WALLET_ADDRESS.toLowerCase()) {
    throw new Error(
      `Wallet address mismatch: derived ${wallet.address}, expected ${CONFIG.WALLET_ADDRESS}`,
    );
  }
  log.info(CONFIG.DRY_RUN ? '[СИМУЛЯЦИЯ] Тестовый кошелёк создан — реальные средства не используются' : 'Кошелёк проверен');

  const strategy = createStrategy();
  const marketManager = new MarketManager(strategy);

  const marketData = new MarketDataAgent();
  const orderbook = new OrderbookAgent();
  const quoting = new QuotingAgent();
  const execution = new ExecutionAgent(wallet);
  const risk = new RiskAgent();
  const latency = new LatencyMonitor();
  const ghostFill = new GhostFillDetector(wallet);
  const takerSweep = new TakerSweepMode(execution, wallet);
  const ctfSplit = new CtfSplitMode(execution, wallet);
  const ladder = new LadderMode(execution, risk);
  const paperTrader = CONFIG.DRY_RUN ? new PaperTrader() : null;
  let currentFairValue = 0.5;

  // --- Market rotation wiring ---
  marketManager.on(
    'market_switch',
    async (ev: { prev: ActiveMarketContext | null; current: ActiveMarketContext }) => {
      const { current } = ev;
      log.info(
        { conditionId: current.conditionId, description: current.description },
        'Ротация рынка',
      );

      // Save data for previous market before switching
      if (ev.prev) onMarketEnd(marketData.btcPrice);
      onMarketStart(current.conditionId, current.description, marketData.annualizedVol, marketData.btcPrice);

      risk.resetForNewMarket();
      quoting.resetForNewMarket();
      quoting.setTickSize(current.tickSize);

      await execution.setMarket(current);
      orderbook.switchMarket(current);
      ghostFill.setMarket(current.conditionId, current.yesTokenId, current.noTokenId);
      takerSweep.setMarket(current);
      ctfSplit.setMarket(current);
      ladder.setMarket(current);
    },
  );

  // --- MarketDataAgent → QuotingAgent + MarketManager ---
  marketData.on('price', (data: { price: number; volatility: number; latencyMs: number }) => {
    quoting.updateMarketData(data.price, data.volatility);
    latency.recordBinanceLatency(data.latencyMs);

    marketManager.updateStrikePrice(data.price);

    const tte = marketManager.getTimeToExpiryMs();
    if (tte <= 0) return;

    if (tte < marketManager.quotingCutoffMs) return;

    const fairValue = marketManager.computeFairValue(data.price, data.volatility, tte);
    currentFairValue = fairValue;
    takerSweep.updateFairValue(fairValue);
    ctfSplit.update(fairValue, data.volatility, tte);
    ladder.updateFairValue(fairValue);

    const quote = quoting.computeQuote(fairValue);
    if (!quote) return;

    const riskAction = risk.checkQuote(quote);
    if (riskAction === RiskAction.HALT) {
      log.warn('Риск СТОП — отмена всех ордеров');
      execution.cancelAll();
      return;
    }

    const adjustedQuote = risk.applyRiskAdjustment(quote, riskAction);
    if (adjustedQuote.bidSize <= 0 && adjustedQuote.askSize <= 0) return;

    if (paperTrader) paperTrader.updateQuote(adjustedQuote.bidPrice, adjustedQuote.askPrice, adjustedQuote.bidSize, adjustedQuote.askSize);

    execution.cancelAndReplace(adjustedQuote).then((timings) => {
      if (timings.cycleMs > 0) latency.recordCycle(timings);
    });
  });

  // --- OrderbookAgent fills → RiskAgent + ExecutionAgent + GhostFillDetector ---
  orderbook.on('fill', (msg: any) => {
    const side = msg.side as string;
    const price = parseFloat(msg.price);
    const size = parseFloat(msg.size);
    risk.processFill(side, price, size);

    for (const maker of msg.maker_orders || []) {
      const filledAmount = parseFloat(maker.matched_amount);
      execution.handleFill(maker.order_id, filledAmount, side);
      ladder.handleFill(maker.order_id, filledAmount);
      const fillSide: 'YES' | 'NO' = side === 'BUY' ? 'YES' : 'NO';
      ghostFill.recordFill(maker.order_id, fillSide, filledAmount);
    }
  });

  // --- GhostFillDetector events ---
  ghostFill.on('ghost_fill', (ev: GhostFillEvent) => {
    log.warn(ev, 'Ghost fill: CLOB исполнение не подтверждено на блокчейне');
  });

  ghostFill.on('unmatched_residual', (ev: UnmatchedResidualEvent) => {
    log.warn(ev, 'Остаток после ghost fill recovery — требуется ручное вмешательство');
  });

  orderbook.on('order_update', (msg: any) => {
    if (msg.type === 'CANCELLATION') {
      log.debug({ orderId: msg.id }, 'Order cancelled');
    }
  });

  // --- RiskAgent position updates → QuotingAgent ---
  risk.on('position_update', (pos) => {
    quoting.updatePosition(pos);
    risk.updateUnrealizedPnl(quoting.currentQuote?.fairValue ?? 0.5);
  });

  risk.on('halt', (reason: string) => {
    log.error({ reason }, 'РИСК СТОП — отмена всех ордеров');
    execution.cancelAll();
  });

  risk.on('daily_reset', () => {
    log.info({ cap: CONFIG.DAILY_SPEND_CAP }, 'Дневной счётчик сброшен — торговля разблокирована');
    risk.unhalt();
  });

  // --- OrderbookAgent book updates → LatencyMonitor + TakerSweep anomaly check ---
  orderbook.on('book_update', (data: { networkLatencyMs: number }) => {
    if (data.networkLatencyMs > 0) latency.recordPolymarketWsLatency(data.networkLatencyMs);

    const tte = marketManager.getTimeToExpiryMs();
    const circuitBreaker = tte > 0 && tte < CONFIG.CIRCUIT_BREAKER_SEC * 1000;

    if (circuitBreaker) {
      // All speculative modes blocked — only CTF Split can force-exit
      ctfSplit.tick(orderbook.yesOrderbook).catch((err) => log.error({ err }, 'ctfSplit.tick failed'));
      return;
    }

    if (paperTrader) paperTrader.checkFills(orderbook.yesOrderbook, currentFairValue);

    const signal = takerSweep.checkAnomalies(orderbook.yesOrderbook, orderbook.noOrderbook);
    if (signal) {
      takerSweep.executeSwap(signal).catch((err) => log.error({ err }, 'executeSwap failed'));
    }

    ctfSplit.tick(orderbook.yesOrderbook).catch((err) => log.error({ err }, 'ctfSplit.tick failed'));
    ladder.tick(orderbook.yesOrderbook, orderbook.noOrderbook).catch((err) => log.error({ err }, 'ladder.tick failed'));
  });

  // --- TakerSweepMode events ---
  takerSweep.on('signal', (sig: TakerSignal) => {
    log.info(
      { combined: sig.combined.toFixed(4), edge: (sig.edge * 100).toFixed(2) + '%' },
      'Taker сигнал обнаружен',
    );
  });
  takerSweep.on('sweep_complete', (ev: any) => {
    log.info(ev, 'Taker sweep выполнен — позиция смёрджена в USDC');
  });
  takerSweep.on('partial_fill', (ev: any) => {
    log.warn(ev, 'Частичное FAK исполнение — одна сторона не заполнена');
  });
  takerSweep.on('sweep_miss', () => {
    log.debug('Taker sweep пропущен — оба FAK ордера истекли без исполнения');
  });

  // --- CtfSplitMode events ---
  ctfSplit.on('entered', (ev: any) => {
    log.info(ev, 'CTF Split позиция открыта');
  });
  ctfSplit.on('yes_sold', (ev: any) => {
    log.info(ev, 'CTF Split YES продан — NO удерживается до резолюции');
  });
  ctfSplit.on('force_exit', (ev: any) => {
    log.warn(ev, 'CTF Split принудительный выход');
  });
  ctfSplit.on('redeemed', (ev: any) => {
    log.info(ev, 'CTF Split токены погашены');
  });

  // --- LadderMode events ---
  ladder.on('placed', (ev: any) => {
    log.info({ count: ev.levels.length }, 'Ladder ордера выставлены');
  });
  ladder.on('fill', (ev: any) => {
    log.info(ev, 'Ladder уровень исполнен');
  });

  // --- Startup sequence ---
  await execution.init();
  risk.startDailyReset();
  marketData.start();
  orderbook.start();
  latency.start();
  ghostFill.start();
  await marketManager.start();

  log.info('=== Все агенты запущены ===');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Завершение работы...');
    marketManager.stop();
    marketData.stop();
    orderbook.stop();
    latency.stop();
    ghostFill.stop();
    risk.stop();
    // Force-exit CTF split YES position if held
    if (ctfSplit.heldShares > 0) {
      log.info({ shares: ctfSplit.heldShares }, 'Завершение: принудительный выход из CTF Split YES');
      await ctfSplit.tick(orderbook.yesOrderbook).catch(() => {});
    }
    await execution.cancelAll();
    execution.stop();
    log.info('Завершение выполнено');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'Uncaught exception');
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (err) => {
    log.error({ err }, 'Unhandled rejection');
  });
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
