/**
 * Quick smoke-test: verify btc-15min strategy can discover an active market.
 * Run: tsx src/scripts/test-discovery-15min.ts
 */
import { Btc15MinStrategy } from '../strategies/btc-15min.js';

const strategy = new Btc15MinStrategy('');
console.log('Testing btc-15min market discovery...');

const market = await strategy.discoverActiveMarket();
if (market) {
  console.log('✅ Found 15m market:');
  console.log('  conditionId:', market.conditionId);
  console.log('  description:', market.description);
  console.log('  expiresAt:  ', new Date(market.expiresAt).toISOString());
  console.log('  yesTokenId: ', market.yesTokenId);
  console.log('  noTokenId:  ', market.noTokenId);
  console.log('  tickSize:   ', market.tickSize);
} else {
  console.log('❌ No active 15m market found — market may not exist yet or API is down');
  console.log('   Try: btc-5min runs every 5min, btc-15min runs every 15min');
  console.log('   Wait for the next 15-min window and re-run');
}
