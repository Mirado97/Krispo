/**
 * Diagnostic: show balances of all known tokens on wallet + proxy addresses.
 * Usage: npx tsx src/scripts/check-balances.ts
 */
import { JsonRpcProvider, Contract, formatUnits } from 'ethers';
import 'dotenv/config';
import { CONFIG } from '../config.js';

const TOKENS = [
  { symbol: 'pUSD (config)',      address: CONFIG.PUSD_ADDRESS,                              decimals: 6 },
  { symbol: 'USDC (native)',      address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',  decimals: 6 },
  { symbol: 'USDC.e (bridged)',   address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',  decimals: 6 },
];

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

async function main() {
  const provider = new JsonRpcProvider(CONFIG.POLYGON_RPC_URL);
  const addrs = [
    { label: 'Wallet (EOA)',    addr: CONFIG.WALLET_ADDRESS },
    { label: 'Proxy',          addr: CONFIG.PROXY_ADDRESS },
  ];

  for (const { label, addr } of addrs) {
    console.log(`\n=== ${label}: ${addr} ===`);
    for (const tok of TOKENS) {
      const c = new Contract(tok.address, ERC20_ABI, provider);
      try {
        const raw = await c.balanceOf(addr);
        const bal = parseFloat(formatUnits(raw, tok.decimals));
        if (bal > 0) {
          console.log(`  ${tok.symbol.padEnd(20)} $${bal.toFixed(4)}   [${tok.address}]`);
        } else {
          console.log(`  ${tok.symbol.padEnd(20)} $0.00`);
        }
      } catch {
        console.log(`  ${tok.symbol.padEnd(20)} (read error)`);
      }
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
