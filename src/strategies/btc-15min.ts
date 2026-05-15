import { childLogger } from '../utils/logger.js';
import type { MarketInfo, MarketStrategy } from './types.js';

const log = childLogger('Btc15MinStrategy');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const BTC_15M_SERIES_SLUG = 'btc-up-or-down-15m';
const FIFTEEN_MIN_SEC = 900;

function getCurrent15mWindowTimestamp(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.floor(nowSec / FIFTEEN_MIN_SEC) * FIFTEEN_MIN_SEC;
}

interface GammaMarket {
  conditionId: string;
  question: string;
  clobTokenIds: string;
  outcomes: string;
  negRisk: boolean;
  orderPriceMinTickSize: number;
  endDate: string;
  startDate?: string;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
}

interface GammaEvent {
  slug: string;
  markets: GammaMarket[];
  seriesSlug?: string;
}

function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
  return 0.5 * (1.0 + sign * y);
}

export class Btc15MinStrategy implements MarketStrategy {
  readonly name = 'btc-15min';
  // Stop quoting 60s before expiry (longer window = more time to fill, later cutoff)
  readonly quotingCutoffMs = 60_000;
  readonly discoveryIntervalMs = 30_000;

  private readonly eventOrSeriesSlug: string;

  constructor(eventOrSeriesSlug: string) {
    this.eventOrSeriesSlug = eventOrSeriesSlug || BTC_15M_SERIES_SLUG;
  }

  async discoverActiveMarket(): Promise<MarketInfo | null> {
    try {
      const events = await this.fetchEvents();
      const market = this.pickNextActiveMarket(events);
      if (!market) {
        log.info('Активный BTC 15m рынок не найден');
        return null;
      }
      log.info(
        { conditionId: market.conditionId, expiresAt: new Date(market.expiresAt).toISOString(), question: market.description },
        'Активный рынок найден',
      );
      return market;
    } catch (err) {
      log.error({ err }, 'Ошибка поиска рынка');
      return null;
    }
  }

  private pickNextActiveMarket(events: GammaEvent[]): MarketInfo | null {
    const now = Date.now();
    const candidates: { market: MarketInfo; expiresAt: number }[] = [];

    for (const event of events) {
      for (const m of event.markets || []) {
        if (!m.active || m.closed || !m.acceptingOrders) continue;
        const outcomes = this.parseJson<string[]>(m.outcomes);
        const tokenIds = this.parseJson<string[]>(m.clobTokenIds);
        if (!outcomes || !tokenIds || outcomes.length < 2 || tokenIds.length < 2) continue;

        const upIdx = outcomes.findIndex((o) => o === 'Up' || o === 'Yes');
        const downIdx = outcomes.findIndex((o) => o === 'Down' || o === 'No');
        if (upIdx === -1 || downIdx === -1) continue;

        const expiresAt = new Date(m.endDate).getTime();
        if (expiresAt <= now) continue;

        const startedAt = m.startDate
          ? new Date(m.startDate).getTime()
          : expiresAt - 15 * 60 * 1000;

        candidates.push({
          market: {
            conditionId: m.conditionId,
            yesTokenId: tokenIds[upIdx],
            noTokenId: tokenIds[downIdx],
            negRisk: m.negRisk ?? false,
            tickSize: m.orderPriceMinTickSize ?? 0.01,
            expiresAt,
            startedAt,
            description: m.question,
          },
          expiresAt,
        });
      }
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => a.expiresAt - b.expiresAt);
    return candidates[0].market;
  }

  private parseJson<T>(s: string | undefined): T | null {
    if (!s) return null;
    try {
      return typeof s === 'string' ? (JSON.parse(s) as T) : (s as T);
    } catch {
      return null;
    }
  }

  private async fetchEvents(): Promise<GammaEvent[]> {
    const slug = this.eventOrSeriesSlug;
    const isSeries = !slug || slug === BTC_15M_SERIES_SLUG || slug.startsWith('btc-up-or-down');

    if (isSeries) return this.fetchEventsByTimestampGuessing();

    const url = `${GAMMA_API}/events?slug=${encodeURIComponent(slug)}&limit=5`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    const raw = Array.isArray(data) ? data : [data];
    return raw.filter((e: GammaEvent) => e && (e.markets?.length ?? 0) > 0);
  }

  private async fetchEventsByTimestampGuessing(): Promise<GammaEvent[]> {
    const baseTs = getCurrent15mWindowTimestamp();
    const slugs = [
      `btc-updown-15m-${baseTs}`,
      `btc-updown-15m-${baseTs + FIFTEEN_MIN_SEC}`,
      `btc-updown-15m-${baseTs - FIFTEEN_MIN_SEC}`,
      // Fallback: series-level search
      `btc-up-or-down-15m`,
    ];

    for (const s of slugs) {
      const events = await this.fetchEventBySlug(s);
      if (events.length > 0) {
        const hasActive = events.some((e) =>
          e.markets?.some((m) => m.active && !m.closed && m.acceptingOrders),
        );
        if (hasActive) {
          log.debug({ slug: s }, 'Found active 15m market');
          return events;
        }
      }
    }

    // Last resort: search by series slug with limit
    return this.fetchBySeriesSearch();
  }

  private async fetchBySeriesSearch(): Promise<GammaEvent[]> {
    const url = `${GAMMA_API}/events?seriesSlug=${encodeURIComponent(BTC_15M_SERIES_SLUG)}&limit=10&active=true`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return [];
      const data = await resp.json();
      const raw = Array.isArray(data) ? data : [data];
      return raw.filter((e: GammaEvent) => e && (e.markets?.length ?? 0) > 0);
    } catch {
      return [];
    }
  }

  private async fetchEventBySlug(slug: string): Promise<GammaEvent[]> {
    const url = `${GAMMA_API}/events?slug=${encodeURIComponent(slug)}&limit=1`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return [];
      const data = await resp.json();
      const raw = Array.isArray(data) ? data : [data];
      return raw.filter((e: GammaEvent) => e && (e.markets?.length ?? 0) > 0);
    } catch {
      return [];
    }
  }

  computeFairValue(
    btcPrice: number,
    strikePrice: number,
    volatility: number,
    timeToExpiryMs: number,
  ): number {
    if (btcPrice <= 0 || strikePrice <= 0 || volatility <= 0) return 0.5;
    const T = Math.max(timeToExpiryMs / 1000 / (365.25 * 24 * 3600), 1e-10);
    const sqrtT = Math.sqrt(T);
    const d = Math.log(btcPrice / strikePrice) / (volatility * sqrtT);
    return Math.max(0.01, Math.min(0.99, normalCDF(d)));
  }
}
