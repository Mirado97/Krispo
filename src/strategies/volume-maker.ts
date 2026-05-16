/**
 * VolumeMaker strategy — cashback / maker-rebate focused.
 *
 * Targets high-volume binary markets with stable prices near 50%.
 * Does NOT use BTC price for fair value — quotes symmetrically around
 * the CLOB midpoint (fair value = 0.5 adjusted by inventory skew only).
 *
 * Ideal for: earning Polymarket maker rebates with minimal directional risk.
 */

import { childLogger } from '../utils/logger.js';
import type { MarketInfo, MarketStrategy } from './types.js';

const log = childLogger('VolumeMakerStrategy');
const GAMMA_API = 'https://gamma-api.polymarket.com';

interface GammaMarket {
  conditionId: string;
  question: string;
  clobTokenIds: string;
  outcomePrices: string;
  outcomes: string;
  volume24hr: number;
  active: boolean;
  closed: boolean;
  neg_risk: boolean;
  acceptingOrders: boolean;
  orderPriceMinTickSize: number;
  endDate: string;
}

export class VolumeMakerStrategy implements MarketStrategy {
  readonly name = 'volume-maker';
  readonly quotingCutoffMs = 300_000;   // stop quoting 5 min before expiry
  readonly discoveryIntervalMs = 60_000; // re-check market every 60s

  // Only quote markets with price in this range (avoid extreme probabilities)
  private readonly minPrice = 0.35;
  private readonly maxPrice = 0.65;
  // Minimum 24h volume to ensure liquidity
  private readonly minVolume24h = 50_000;
  // Minimum time to expiry (avoid markets about to close)
  private readonly minTteMs = 3 * 24 * 60 * 60 * 1000; // 3 days

  async discoverActiveMarket(): Promise<MarketInfo | null> {
    try {
      const resp = await fetch(
        `${GAMMA_API}/markets?closed=false&active=true&limit=100&order=volume24hr&ascending=false`,
      );
      if (!resp.ok) return null;
      const markets: GammaMarket[] = await resp.json();

      const now = Date.now();
      const candidates: { market: MarketInfo; score: number }[] = [];

      for (const m of markets) {
        if (!m.active || m.closed || !m.acceptingOrders) continue;
        if (m.neg_risk) continue; // skip neg-risk (more complex settlement)

        const expiresAt = new Date(m.endDate).getTime();
        if (expiresAt - now < this.minTteMs) continue;

        const vol = m.volume24hr ?? 0;
        if (vol < this.minVolume24h) continue;

        let tokenIds: string[];
        let prices: string[];
        let outcomes: string[];
        try {
          tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
          prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
        } catch {
          continue;
        }

        if (tokenIds.length < 2 || prices.length < 2) continue;

        const yesIdx = outcomes.findIndex((o) => o === 'Yes');
        const noIdx = outcomes.findIndex((o) => o === 'No');
        if (yesIdx === -1 || noIdx === -1) continue;

        const yesPrice = parseFloat(prices[yesIdx]);
        if (yesPrice < this.minPrice || yesPrice > this.maxPrice) continue;

        // Score: prefer markets closest to 50% and with highest volume
        const distFrom50 = Math.abs(yesPrice - 0.5);
        const score = vol / (1 + distFrom50 * 10);

        candidates.push({
          market: {
            conditionId: m.conditionId,
            yesTokenId: tokenIds[yesIdx],
            noTokenId: tokenIds[noIdx],
            negRisk: false,
            tickSize: m.orderPriceMinTickSize ?? 0.01,
            expiresAt,
            startedAt: now,
            description: m.question,
          },
          score,
        });
      }

      if (!candidates.length) {
        log.info('No suitable volume-maker markets found');
        return null;
      }

      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0].market;

      log.info(
        {
          description: best.description,
          conditionId: best.conditionId,
          expiresAt: new Date(best.expiresAt).toISOString(),
          candidates: candidates.length,
        },
        'Volume-maker market selected',
      );

      return best;
    } catch (err) {
      log.error({ err }, 'Market discovery error');
      return null;
    }
  }

  /**
   * For stable markets, fair value is simply 0.5.
   * Inventory skew in the quoting agent handles position drift.
   * BTC price and volatility are intentionally ignored.
   */
  computeFairValue(
    _btcPrice: number,
    _strikePrice: number,
    _volatility: number,
    _timeToExpiryMs: number,
  ): number {
    return 0.5;
  }
}
