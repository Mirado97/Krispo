/**
 * Wrap native USDC → pUSD for EOA trading (SIGNATURE_TYPE=0).
 *
 * pUSD (0xC011...) is an ERC20Wrapper around native USDC (0x3c49...) on Polygon.
 * This script approves pUSD contract to pull USDC and calls depositFor().
 *
 * Usage:
 *   npx tsx src/scripts/wrap-usdc.ts [amount]
 *   npx tsx src/scripts/wrap-usdc.ts 50      # wrap $50 USDC → pUSD
 *
 * After wrapping, run:
 *   npm run setup-approvals   (approves CTF Exchange to spend pUSD)
 *   npm run preflight
 */

import { Wallet, JsonRpcProvider, Contract, formatUnits, parseUnits } from 'ethers';
import 'dotenv/config';
import { CONFIG } from '../config.js';

// Native USDC on Polygon (not USDC.e)
const NATIVE_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
// USDC.e (bridged) on Polygon — fallback
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// pUSD is an OpenZeppelin ERC20Wrapper
const PUSD_WRAPPER_ABI = [
  ...ERC20_ABI,
  'function depositFor(address account, uint256 amount) returns (bool)',
  'function withdrawTo(address account, uint256 amount) returns (bool)',
  'function underlying() view returns (address)',
];

async function getUsdcBalance(usdc: Contract, addr: string, symbol: string) {
  try {
    const raw = await usdc.balanceOf(addr);
    const decimals = await usdc.decimals();
    const bal = parseFloat(formatUnits(raw, decimals));
    console.log(`  ${symbol}: $${bal.toFixed(4)}`);
    return { raw, bal, decimals };
  } catch {
    console.log(`  ${symbol}: failed to read`);
    return { raw: 0n, bal: 0, decimals: 6 };
  }
}

async function main() {
  const amountArg = process.argv[2];
  const provider = new JsonRpcProvider(CONFIG.POLYGON_RPC_URL);
  const wallet = new Wallet(CONFIG.PRIVATE_KEY, provider);

  if (wallet.address.toLowerCase() !== CONFIG.WALLET_ADDRESS.toLowerCase()) {
    throw new Error(`Key mismatch: got ${wallet.address}, expected ${CONFIG.WALLET_ADDRESS}`);
  }

  console.log('=== USDC → pUSD Wrapper ===\n');
  console.log(`Wallet: ${wallet.address}`);

  const pUsd = new Contract(CONFIG.PUSD_ADDRESS, PUSD_WRAPPER_ABI, wallet);

  // Detect underlying token
  let usdcAddr = NATIVE_USDC;
  try {
    const underlying = await pUsd.underlying();
    usdcAddr = underlying;
    console.log(`pUSD underlying: ${underlying}`);
  } catch {
    console.log(`underlying() not available — assuming native USDC (${NATIVE_USDC})`);
  }

  const usdc = new Contract(usdcAddr, ERC20_ABI, wallet);
  const usdcE = new Contract(USDC_E, ERC20_ABI, provider);

  console.log('\n--- Balances ---');
  const { raw: usdcRaw, bal: usdcBal, decimals: usdcDec } = await getUsdcBalance(usdc, wallet.address, 'USDC (native)');
  await getUsdcBalance(usdcE, wallet.address, 'USDC.e (bridged)');
  const { bal: pUsdBal } = await getUsdcBalance(pUsd as unknown as Contract, wallet.address, 'pUSD');

  if (usdcBal < 0.01) {
    console.log('\n  You have no native USDC to wrap.');
    console.log('  Options to get pUSD:');
    console.log('    1. Bridge USDC to Polygon: https://portal.polygon.technology');
    console.log('    2. Buy pUSD on Uniswap (Polygon):');
    console.log(`       USDC → pUSD at https://app.uniswap.org/swap?chain=polygon`);
    console.log(`       pUSD contract: ${CONFIG.PUSD_ADDRESS}`);
    console.log('    3. Deposit via Polymarket app (auto-wraps to deposit wallet)');
    return;
  }

  // Determine amount to wrap
  let wrapAmount: number;
  if (amountArg) {
    wrapAmount = parseFloat(amountArg);
    if (isNaN(wrapAmount) || wrapAmount <= 0) {
      throw new Error(`Invalid amount: ${amountArg}`);
    }
    if (wrapAmount > usdcBal) {
      throw new Error(`Requested $${wrapAmount} but only have $${usdcBal.toFixed(4)} USDC`);
    }
  } else {
    // Wrap entire USDC balance
    wrapAmount = usdcBal;
    console.log(`\nNo amount specified — wrapping entire balance: $${wrapAmount.toFixed(4)}`);
  }

  const wrapRaw = parseUnits(wrapAmount.toFixed(usdcDec), usdcDec);

  // Step 1: Approve
  console.log(`\n--- Step 1: Approve pUSD to pull $${wrapAmount.toFixed(4)} USDC ---`);
  const allowance = await usdc.allowance(wallet.address, CONFIG.PUSD_ADDRESS);
  if (allowance < wrapRaw) {
    const tx = await usdc.approve(CONFIG.PUSD_ADDRESS, wrapRaw);
    console.log(`  TX: ${tx.hash}`);
    await tx.wait();
    console.log('  Approved.');
  } else {
    console.log('  Already approved.');
  }

  // Step 2: Wrap
  console.log(`\n--- Step 2: depositFor (wrap USDC → pUSD) ---`);
  const tx = await pUsd.depositFor(wallet.address, wrapRaw);
  console.log(`  TX: ${tx.hash}`);
  console.log('  Waiting for confirmation...');
  const receipt = await tx.wait();
  console.log(`  Confirmed in block ${receipt!.blockNumber}`);

  // Final balances
  console.log('\n--- Result ---');
  const newUsdcRaw = await usdc.balanceOf(wallet.address);
  const newPUsdRaw = await pUsd.balanceOf(wallet.address);
  console.log(`  USDC:  $${parseFloat(formatUnits(newUsdcRaw, usdcDec)).toFixed(4)}`);
  console.log(`  pUSD:  $${parseFloat(formatUnits(newPUsdRaw, 6)).toFixed(4)}  (was $${pUsdBal.toFixed(4)})`);

  console.log('\n==============================================');
  console.log('  Next steps:');
  console.log('  1. npm run setup-approvals   (approve CTF Exchange)');
  console.log('  2. npm run preflight          (test order)');
  console.log('==============================================');
}

main().catch((err) => {
  console.error('Error:', err.message ?? err);
  process.exit(1);
});
