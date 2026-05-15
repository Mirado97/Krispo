import 'dotenv/config';

const DRY_RUN = process.env.DRY_RUN === 'true';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    if (DRY_RUN) return `sim-${key.toLowerCase()}`;
    throw new Error(`Missing required env var: ${key}`);
  }
  return val;
}

function envFloat(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseFloat(val) : fallback;
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

export const CONFIG = {
  // Wallet
  PRIVATE_KEY: requireEnv('PRIVATE_KEY'),
  WALLET_ADDRESS: requireEnv('WALLET_ADDRESS'),
  PROXY_ADDRESS: requireEnv('PROXY_ADDRESS'),
  SIGNATURE_TYPE: envInt('SIGNATURE_TYPE', 2), // 0=EOA, 2=GNOSIS_SAFE

  // API credentials
  API_KEY: requireEnv('POLY_API_KEY'),
  API_SECRET: requireEnv('POLY_API_SECRET'),
  API_PASSPHRASE: requireEnv('POLY_API_PASSPHRASE'),

  // Strategy selection
  MARKET_STRATEGY: process.env.MARKET_STRATEGY || 'btc-5min',
  EVENT_SLUG: process.env.EVENT_SLUG || '',

  // Exchange contracts
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  NEG_RISK_CTF_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  CHAIN_ID: 137,

  // Network endpoints
  CLOB_URL: 'https://clob.polymarket.com',
  WS_MARKET_URL: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  WS_USER_URL: 'wss://ws-subscriptions-clob.polymarket.com/ws/user',
  BINANCE_WS_URL: 'wss://stream.binance.com:9443/ws/btcusdt@trade',

  // Trading parameters
  ORDER_SIZE: envFloat('ORDER_SIZE', 50),
  MIN_SPREAD_BPS: envInt('MIN_SPREAD_BPS', 200),
  MAX_SPREAD_BPS: envInt('MAX_SPREAD_BPS', 1000),
  INVENTORY_SKEW_FACTOR: envFloat('INVENTORY_SKEW_FACTOR', 0.001),
  REQUOTE_THRESHOLD_BPS: envInt('REQUOTE_THRESHOLD_BPS', 50),

  // Risk limits
  MAX_POSITION: envFloat('MAX_POSITION', 1000),
  MAX_NOTIONAL: envFloat('MAX_NOTIONAL', 5000),
  MAX_LOSS: envFloat('MAX_LOSS', 500),
  // Hard daily USDC spend cap — resets at UTC midnight
  DAILY_SPEND_CAP: envFloat('DAILY_SPEND_CAP', 200),
  // Cancel ladder order if unfilled after this many orderbook ticks
  INVENTORY_HOLD_MAX_CYCLES: envInt('INVENTORY_HOLD_MAX_CYCLES', 60),

  // Volatility
  VOL_WINDOW_MS: envInt('VOL_WINDOW_MS', 300000),
  VOL_EWMA_ALPHA: envFloat('VOL_EWMA_ALPHA', 0.06),

  // Ladder orders (TitanFlow DCA grid on cheap side)
  MODE_LADDER: process.env.MODE_LADDER !== 'false',
  // Number of ladder levels
  LADDER_LEVELS: envInt('LADDER_LEVELS', 3),
  // Price step between levels (e.g. 0.02 → $0.38, $0.36, $0.34)
  LADDER_STEP: envFloat('LADDER_STEP', 0.02),
  // % of ORDER_SIZE per level (must sum to 100)
  LADDER_SIZES_PCT: (process.env.LADDER_SIZES || '50,30,20').split(',').map(Number),
  // Minimum discount vs fair_value to trigger ladder entry
  LADDER_ENTRY_DISCOUNT: envFloat('LADDER_ENTRY_DISCOUNT', 0.05),
  // Never enter if YES_avg + NO_ask > this (combined cap)
  LADDER_MAX_COMBINED: envFloat('LADDER_MAX_COMBINED', 0.97),

  // CTF Split mode (Hawk-Split)
  MODE_CTF_SPLIT: process.env.MODE_CTF_SPLIT !== 'false',
  // Enter when fair_value is in this band (market uncertain)
  CTF_SPLIT_TRIGGER_MIN: envFloat('CTF_SPLIT_TRIGGER_MIN', 0.45),
  CTF_SPLIT_TRIGGER_MAX: envFloat('CTF_SPLIT_TRIGGER_MAX', 0.55),
  // USDC to spend per split
  CTF_SPLIT_SIZE: envFloat('CTF_SPLIT_SIZE', 10),
  // exit_threshold = fair_value + CTF_EXIT_K * vol * sqrt(T)
  CTF_EXIT_K: envFloat('CTF_EXIT_K', 1.5),
  // Vol must exceed this to enter (annualised)
  CTF_VOL_MIN: envFloat('CTF_VOL_MIN', 0.30),
  // Stop quoting and force-exit this many seconds before market expiry
  CIRCUIT_BREAKER_SEC: envInt('CIRCUIT_BREAKER_SEC', 30),

  // Taker Sweep mode
  MODE_TAKER_SWEEP: process.env.MODE_TAKER_SWEEP !== 'false',
  // Combined YES_ask + NO_ask must be below this to trigger a sweep
  TAKER_THRESHOLD: envFloat('TAKER_THRESHOLD', 0.90),
  // USDC size per taker sweep (split equally between YES and NO)
  TAKER_SIZE: envFloat('TAKER_SIZE', 20),
  // Minimum confirmed anomaly: fair value must show both sides cheap by at least this margin
  TAKER_EDGE_MIN: envFloat('TAKER_EDGE_MIN', 0.02),

  // Performance
  HEARTBEAT_INTERVAL_MS: 5000,
  CANCEL_REPLACE_TIMEOUT_MS: envInt('CANCEL_REPLACE_TIMEOUT_MS', 100),

  exchangeAddress(negRisk: boolean): string {
    return negRisk ? this.NEG_RISK_CTF_EXCHANGE : this.CTF_EXCHANGE;
  },

  // Polygon
  POLYGON_RPC_URL: process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',
  USDC_E_ADDRESS: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // native USDC on Polygon (Polymarket migrated from USDC.e)
  CTF_TOKEN_ADDRESS: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',

  AMOUNT_DECIMALS: 6,
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',

  // Simulation
  DRY_RUN,
};
