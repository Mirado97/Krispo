/**
 * Vol calibration backtest.
 *
 * For each closed BTC 15-min Polymarket market:
 *   1. Fetch Binance 1m klines for the market window
 *   2. Compute EWMA annualised vol at window start
 *   3. Compute BTC log-move over the window: |ln(btcEnd / btcStart)|
 *   4. Compute fair-value move: |P(Up)_end - 0.5| from log-normal model
 *   5. Collect (vol, btcMove, fvMove) for all markets
 *   6. Report Pearson correlation and recommended exit_k
 *
 * Usage: tsx src/scripts/calibrate-vol.ts [--limit 50] [--alpha 0.06]
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { ewmaVol, pearson, median, percentile, normalCDF } from '../utils/vol-stats.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const BINANCE_API = 'https://api.binance.com/api/v3/klines';
const CACHE_FILE = 'vol-calibration-cache.json';

// CLI args
const args = process.argv.slice(2);
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '40');
const ALPHA = parseFloat(args.find(a => a.startsWith('--alpha='))?.split('=')[1] ?? '0.06');
const WARMUP_BARS = 30; // 1m bars before market start for EWMA warm-up

interface MarketRecord {
  conditionId: string;
  question: string;
  startMs: number;
  endMs: number;
  strikePrice: number; // BTC price at market start
  btcAtEnd: number;
  volAtStart: number;       // EWMA vol (annualised)
  btcLogMove: number;       // |ln(btcEnd/btcStart)|
  fvMoveAtStart: number;    // |P(Up)_at_end_using_start_vol - 0.5|
  resolvedUp: boolean;
}

// ─── Gamma API helpers ───────────────────────────────────────────────────────

interface GammaMarket {
  conditionId: string;
  question: string;
  endDate: string;
  startDate?: string;
  active: boolean;
  closed: boolean;
  clobTokenIds: string;
  outcomes: string;
}

interface GammaEvent {
  slug: string;
  markets: GammaMarket[];
  startDate?: string;
  endDate?: string;
}

async function fetchClosedEvents(limit: number): Promise<GammaEvent[]> {
  console.log(`Fetching up to ${limit} closed btc-15min events from Gamma...`);

  // Try timestamp-based slugs going backwards from now
  const results: GammaEvent[] = [];
  const WINDOW = 900; // 15 min in seconds
  let ts = Math.floor(Date.now() / 1000 / WINDOW) * WINDOW;

  while (results.length < limit) {
    // Go back in time
    ts -= WINDOW;

    const slug = `btc-updown-15m-${ts}`;
    try {
      const resp = await fetch(`${GAMMA_API}/events?slug=${encodeURIComponent(slug)}&limit=1`);
      if (!resp.ok) continue;
      const data = await resp.json() as GammaEvent[];
      const events = Array.isArray(data) ? data : [data];
      for (const ev of events) {
        if (ev?.markets?.length && ev.markets.some(m => m.closed)) {
          results.push(ev);
        }
      }
    } catch {
      // skip
    }

    // Don't go back more than 7 days
    if (ts < Math.floor(Date.now() / 1000) - 7 * 24 * 3600) break;
  }

  console.log(`Found ${results.length} closed events`);
  return results;
}

// ─── Binance klines ──────────────────────────────────────────────────────────

async function fetchKlines(startMs: number, endMs: number, extraBars = 0): Promise<number[]> {
  const adjustedStart = startMs - extraBars * 60_000;
  const url = `${BINANCE_API}?symbol=BTCUSDT&interval=1m&startTime=${adjustedStart}&endTime=${endMs}&limit=${extraBars + 20}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json() as number[][];
    // Each kline: [openTime, open, high, low, close, ...]
    return data.map(k => parseFloat(String(k[4]))); // close prices
  } catch {
    return [];
  }
}

// ─── Analysis ────────────────────────────────────────────────────────────────

function computeRecord(ev: GammaEvent): MarketRecord | null {
  const market = ev.markets?.find(m => m.closed);
  if (!market) return null;

  const startMs = market.startDate
    ? new Date(market.startDate).getTime()
    : new Date(market.endDate).getTime() - 15 * 60_000;
  const endMs = new Date(market.endDate).getTime();

  return {
    conditionId: market.conditionId,
    question: market.question,
    startMs,
    endMs,
    strikePrice: 0,
    btcAtEnd: 0,
    volAtStart: 0,
    btcLogMove: 0,
    fvMoveAtStart: 0,
    resolvedUp: false,
  };
}

async function enrichRecord(rec: MarketRecord): Promise<MarketRecord | null> {
  const closes = await fetchKlines(rec.startMs, rec.endMs, WARMUP_BARS);
  if (closes.length < WARMUP_BARS + 2) return null;

  const warmupCloses = closes.slice(0, WARMUP_BARS + 1);
  const windowCloses = closes.slice(WARMUP_BARS);

  if (windowCloses.length < 2) return null;

  const btcAtStart = warmupCloses[warmupCloses.length - 1];
  const btcAtEnd = windowCloses[windowCloses.length - 1];
  const vol = ewmaVol(warmupCloses, ALPHA);

  if (vol <= 0 || btcAtStart <= 0 || btcAtEnd <= 0) return null;

  const T15m = 15 / (365.25 * 24 * 60); // 15 min in years
  const sqrtT = Math.sqrt(T15m);

  // Fair value at end using start-of-market vol
  const d = Math.log(btcAtEnd / btcAtStart) / (vol * sqrtT);
  const fvAtEnd = normalCDF(d);
  const fvMove = Math.abs(fvAtEnd - 0.5);
  const btcLogMove = Math.abs(Math.log(btcAtEnd / btcAtStart));

  return {
    ...rec,
    strikePrice: btcAtStart,
    btcAtEnd,
    volAtStart: vol,
    btcLogMove,
    fvMoveAtStart: fvMove,
    resolvedUp: btcAtEnd > btcAtStart,
  };
}

// ─── Reporting ───────────────────────────────────────────────────────────────

function report(records: MarketRecord[]): void {
  const vols = records.map(r => r.volAtStart);
  const moves = records.map(r => r.btcLogMove);
  const fvMoves = records.map(r => r.fvMoveAtStart);

  const corr = pearson(vols, moves);
  const corrFv = pearson(vols, fvMoves);

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Vol Calibration Report — ${records.length} markets`);
  console.log('═══════════════════════════════════════════════');
  console.log(`  EWMA alpha:          ${ALPHA}`);
  console.log(`  Avg vol (annualised): ${(vols.reduce((a,b)=>a+b,0)/vols.length*100).toFixed(1)}%`);
  console.log(`  Vol p25/p50/p75:     ${(percentile(vols,25)*100).toFixed(1)}% / ${(median(vols)*100).toFixed(1)}% / ${(percentile(vols,75)*100).toFixed(1)}%`);
  console.log();
  console.log(`  Pearson(vol, btcLogMove):  ${corr.toFixed(4)}  ${corrLabel(corr)}`);
  console.log(`  Pearson(vol, fvMove):      ${corrFv.toFixed(4)}  ${corrLabel(corrFv)}`);
  console.log();

  // Recommended k: empirical ratio actual_move / (vol * sqrt(T15m))
  const sqrtT15m = Math.sqrt(15 / (365.25 * 24 * 60));
  const kValues = records
    .filter(r => r.volAtStart > 0)
    .map(r => r.btcLogMove / (r.volAtStart * sqrtT15m));

  const kP25 = percentile(kValues, 25);
  const kP50 = median(kValues);
  const kP75 = percentile(kValues, 75);

  console.log('  Empirical k = |btcMove| / (vol × √T):');
  console.log(`    p25 = ${kP25.toFixed(2)}  p50 = ${kP50.toFixed(2)}  p75 = ${kP75.toFixed(2)}`);
  console.log();
  console.log('  CTF_EXIT_K recommendation:');
  console.log(`    Conservative (exit on ~75% of moves): k = ${kP25.toFixed(2)}`);
  console.log(`    Balanced     (exit on ~50% of moves): k = ${kP50.toFixed(2)}`);
  console.log(`    Aggressive   (exit on ~25% of moves): k = ${kP75.toFixed(2)}`);
  console.log();

  // Directional accuracy as sanity check
  const upCount = records.filter(r => r.resolvedUp).length;
  console.log(`  Resolved Up: ${upCount}/${records.length} (${(upCount/records.length*100).toFixed(0)}%) — sanity: expect ~50%`);

  if (corr < 0.2) {
    console.log('\n  ⚠  Weak correlation. Consider using bid-ask spread as vol proxy instead.');
    console.log('     Add TAKER_EDGE_MIN for anomaly detection rather than vol-threshold for CTF Split.');
  } else {
    console.log(`\n  ✓  Correlation sufficient. CTF_EXIT_K = ${kP50.toFixed(2)} (balanced) recommended.`);
    console.log(`     Update .env: CTF_EXIT_K=${kP50.toFixed(2)}`);
    console.log(`     Update .env: CTF_VOL_MIN=${(percentile(vols, 30)*100).toFixed(0)}  # 30th percentile vol`);
  }

  console.log('═══════════════════════════════════════════════\n');
}

function corrLabel(r: number): string {
  if (Math.abs(r) >= 0.6) return '(strong)';
  if (Math.abs(r) >= 0.35) return '(moderate)';
  if (Math.abs(r) >= 0.2) return '(weak)';
  return '(negligible)';
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Load or build cache
  let records: MarketRecord[] = [];

  if (existsSync(CACHE_FILE)) {
    const cached = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as MarketRecord[];
    console.log(`Loaded ${cached.length} records from cache (${CACHE_FILE})`);
    records = cached;
  }

  if (records.length < LIMIT) {
    const events = await fetchClosedEvents(LIMIT - records.length + 5);
    const existingIds = new Set(records.map(r => r.conditionId));

    let added = 0;
    for (const ev of events) {
      const base = computeRecord(ev);
      if (!base || existingIds.has(base.conditionId)) continue;

      process.stdout.write(`  Enriching ${base.conditionId.slice(0, 12)}...`);
      const enriched = await enrichRecord(base);
      if (enriched) {
        records.push(enriched);
        existingIds.add(enriched.conditionId);
        added++;
        process.stdout.write(` vol=${(enriched.volAtStart*100).toFixed(1)}% move=${(enriched.btcLogMove*100).toFixed(2)}%\n`);
      } else {
        process.stdout.write(' skip (missing data)\n');
      }

      // Polite rate limiting
      await new Promise(r => setTimeout(r, 250));
    }

    console.log(`Added ${added} new records`);
    writeFileSync(CACHE_FILE, JSON.stringify(records, null, 2));
    console.log(`Cache saved to ${CACHE_FILE}`);
  }

  if (records.length < 5) {
    console.log('Not enough data to calibrate. Run again later after more markets close.');
    return;
  }

  report(records);
}

main().catch(console.error);
