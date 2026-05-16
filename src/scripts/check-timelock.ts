/**
 * Read timelock info from Polymarket proxy contract.
 * Read-only — no transactions, no gas.
 * Usage: npx tsx src/scripts/check-timelock.ts
 */
import { JsonRpcProvider, Contract } from 'ethers';
import 'dotenv/config';
import { CONFIG } from '../config.js';

const PROXY_ABI = [
  'function timelockDelay() view returns (uint256)',
  'function delay() view returns (uint256)',
  'function pauseTime() view returns (uint256)',
  'function pausedAt() view returns (uint256)',
  'function paused() view returns (bool)',
  'function isPaused() view returns (bool)',
  'function withdrawEnabled() view returns (bool)',
];

async function tryRead(contract: Contract, fn: string): Promise<bigint | boolean | null> {
  try {
    const val = await (contract as any)[fn]();
    return val;
  } catch {
    return null;
  }
}

async function main() {
  const provider = new JsonRpcProvider(CONFIG.POLYGON_RPC_URL);
  const proxy = new Contract(CONFIG.PROXY_ADDRESS, PROXY_ABI, provider);

  console.log(`Proxy: ${CONFIG.PROXY_ADDRESS}\n`);

  const now = BigInt(Math.floor(Date.now() / 1000));
  console.log(`Current time: ${now} (${new Date().toISOString()})\n`);

  // Try all known timelock/pause fields
  const checks = [
    'timelockDelay', 'delay', 'pauseTime', 'pausedAt', 'paused', 'isPaused', 'withdrawEnabled',
  ];

  for (const fn of checks) {
    const val = await tryRead(proxy, fn);
    if (val === null) continue;

    if (typeof val === 'bigint' && val > 0n) {
      const secs = Number(val);
      if (secs > 1_000_000_000) {
        // Looks like a timestamp
        const unlockDate = new Date(secs * 1000);
        const remaining = secs - Number(now);
        console.log(`${fn}(): ${val} → timestamp ${unlockDate.toISOString()}`);
        if (remaining > 0) {
          const h = Math.floor(remaining / 3600);
          const m = Math.floor((remaining % 3600) / 60);
          console.log(`  → Unlock in: ${h}h ${m}m`);
        } else {
          console.log(`  → Already elapsed — can withdraw now!`);
        }
      } else {
        // Duration in seconds
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        console.log(`${fn}(): ${val} seconds = ${h}h ${m}m`);
      }
    } else {
      console.log(`${fn}(): ${val}`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
