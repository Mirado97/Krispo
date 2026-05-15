import { childLogger } from '../utils/logger.js';
import type { LatencyMetrics } from '../types.js';

const log = childLogger('LatencyMonitor');

const EWMA_ALPHA = 0.1;

export class LatencyMonitor {
  private metrics: LatencyMetrics = {
    cancelLatencyMs: 0,
    submitLatencyMs: 0,
    cycleLatencyMs: 0,
    signLatencyMs: 0,
    binanceLatencyMs: 0,
    polymarketWsLatencyMs: 0,
    ewmaCycleMs: 0,
  };
  private cycleCount = 0;
  private logInterval: ReturnType<typeof setInterval> | null = null;

  get current(): LatencyMetrics {
    return { ...this.metrics };
  }

  start(): void {
    this.logInterval = setInterval(() => this.logMetrics(), 10_000);
  }

  stop(): void {
    if (this.logInterval) clearInterval(this.logInterval);
  }

  recordCycle(data: {
    cycleMs: number;
    signMs: number;
    cancelMs: number;
    submitMs: number;
  }): void {
    this.metrics.cycleLatencyMs = data.cycleMs;
    this.metrics.signLatencyMs = data.signMs;
    this.metrics.cancelLatencyMs = data.cancelMs;
    this.metrics.submitLatencyMs = data.submitMs;
    this.metrics.ewmaCycleMs =
      EWMA_ALPHA * data.cycleMs + (1 - EWMA_ALPHA) * this.metrics.ewmaCycleMs;
    this.cycleCount++;

    if (data.cycleMs > 100) {
      log.warn({ cycleMs: data.cycleMs.toFixed(1) }, 'Цикл cancel/replace превысил 100мс');
    }
  }

  recordBinanceLatency(latencyMs: number): void {
    this.metrics.binanceLatencyMs = latencyMs;
  }

  recordPolymarketWsLatency(latencyMs: number): void {
    this.metrics.polymarketWsLatencyMs = latencyMs;
  }

  private logMetrics(): void {
    if (this.metrics.binanceLatencyMs === 0 && this.metrics.polymarketWsLatencyMs === 0) return;

    if (this.cycleCount === 0) {
      // DRY_RUN — show only WS latencies (no real order cycles)
      log.info(
        {
          binance_ws_мс: this.metrics.binanceLatencyMs.toFixed(1),
          polymarket_ws_мс: this.metrics.polymarketWsLatencyMs.toFixed(1),
        },
        'Задержки WebSocket',
      );
      return;
    }

    log.info(
      {
        циклов: this.cycleCount,
        цикл_ewma_мс: this.metrics.ewmaCycleMs.toFixed(1),
        цикл_последний_мс: this.metrics.cycleLatencyMs.toFixed(1),
        подпись_мс: this.metrics.signLatencyMs.toFixed(1),
        отмена_мс: this.metrics.cancelLatencyMs.toFixed(1),
        отправка_мс: this.metrics.submitLatencyMs.toFixed(1),
        binance_ws_мс: this.metrics.binanceLatencyMs.toFixed(1),
        polymarket_ws_мс: this.metrics.polymarketWsLatencyMs.toFixed(1),
      },
      'Отчёт по задержкам',
    );
  }
}
