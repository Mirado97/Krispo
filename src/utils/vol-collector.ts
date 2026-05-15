/**
 * Live vol data collector.
 * Records (vol, btcMove, fvMove) for every completed market window.
 * Appends one JSON line per market to vol-data.jsonl.
 * Used to accumulate calibration data while the bot runs in DRY_RUN.
 */
import { appendFileSync } from 'node:fs';
import { childLogger } from './logger.js';

const log = childLogger('VolCollector');
const DATA_FILE = 'vol-data.jsonl';

export interface VolDataPoint {
  ts: number;
  conditionId: string;
  question: string;
  durationMs: number;
  volAtStart: number;       // EWMA vol when market started
  btcAtStart: number;
  btcAtEnd: number;
  btcLogMove: number;
  resolvedUp: boolean;
}

let _pendingMarket: {
  conditionId: string;
  question: string;
  startMs: number;
  startedAt: number;        // performance.now() at market start
  volAtStart: number;
  btcAtStart: number;
} | null = null;

export function onMarketStart(
  conditionId: string,
  question: string,
  vol: number,
  btcPrice: number,
): void {
  _pendingMarket = {
    conditionId,
    question,
    startMs: Date.now(),
    startedAt: performance.now(),
    volAtStart: vol,
    btcAtStart: btcPrice,
  };
  log.debug({ conditionId: conditionId.slice(0, 12) }, 'VolCollector: market start recorded');
}

export function onMarketEnd(btcFinalPrice: number): void {
  if (!_pendingMarket) return;

  const m = _pendingMarket;
  _pendingMarket = null;

  if (m.btcAtStart <= 0 || btcFinalPrice <= 0 || m.volAtStart <= 0) return;

  const durationMs = Date.now() - m.startMs;
  const btcLogMove = Math.abs(Math.log(btcFinalPrice / m.btcAtStart));
  const resolvedUp = btcFinalPrice > m.btcAtStart;

  const point: VolDataPoint = {
    ts: Date.now(),
    conditionId: m.conditionId,
    question: m.question,
    durationMs,
    volAtStart: m.volAtStart,
    btcAtStart: m.btcAtStart,
    btcAtEnd: btcFinalPrice,
    btcLogMove,
    resolvedUp,
  };

  try {
    appendFileSync(DATA_FILE, JSON.stringify(point) + '\n');
    log.info(
      { vol: (m.volAtStart * 100).toFixed(1) + '%', move: (btcLogMove * 100).toFixed(2) + '%', resolvedUp },
      'VolCollector: market data saved',
    );
  } catch (err) {
    log.error({ err }, 'VolCollector: failed to write data');
  }
}
