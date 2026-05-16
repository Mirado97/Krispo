/**
 * One-time setup: deploy a Polymarket V2 deposit wallet for your EOA.
 *
 * The deposit wallet is a deterministic ERC-1967 proxy (CREATE2) that:
 *   - holds your pUSD and CTF tokens on-chain
 *   - is required for SIGNATURE_TYPE=3 (POLY_1271) trading
 *
 * Usage:
 *   npx tsx src/scripts/setup-deposit-wallet.ts
 *
 * After success, add to .env:
 *   SIGNATURE_TYPE=3
 *   PROXY_ADDRESS=<deposit_wallet_address>   # printed below
 *
 * Note: for SIGNATURE_TYPE=0 (EOA) trading you do NOT need a deposit wallet.
 * This script is only needed if you want to use SIGNATURE_TYPE=3 (POLY_1271).
 */

import { Wallet } from 'ethers';
import 'dotenv/config';
import { CONFIG } from '../config.js';

const RELAYER_URL = 'https://relayer.polymarket.com';

// Minimal builder-relayer-client interaction via raw API calls
// (avoids dealing with the package's viem dependency for this simple setup script)

async function deriveDepositWalletAddress(ownerAddress: string): Promise<string> {
  const resp = await fetch(`${RELAYER_URL}/deposit-wallet/${ownerAddress}`);
  if (!resp.ok) throw new Error(`GET deposit-wallet: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as { address?: string; wallet?: string };
  return (data.address ?? data.wallet)!;
}

async function isDeployed(walletAddress: string): Promise<boolean> {
  const resp = await fetch(`${RELAYER_URL}/deposit-wallet/${walletAddress}/deployed`);
  if (!resp.ok) return false;
  const data = await resp.json() as { deployed?: boolean };
  return data.deployed ?? false;
}

async function deployDepositWallet(ownerAddress: string): Promise<string> {
  const resp = await fetch(`${RELAYER_URL}/deposit-wallet/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: ownerAddress, factory: CONFIG.DEPOSIT_WALLET_FACTORY }),
  });
  if (!resp.ok) throw new Error(`Deploy: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as { txHash?: string; address?: string };
  console.log(`  TX hash: ${data.txHash ?? '(relayer handled)'}`);
  return (data.address ?? '')!;
}

async function main() {
  console.log('=== Polymarket V2 Deposit Wallet Setup ===\n');

  const wallet = new Wallet(CONFIG.PRIVATE_KEY);
  if (wallet.address.toLowerCase() !== CONFIG.WALLET_ADDRESS.toLowerCase()) {
    throw new Error(`Wallet mismatch: derived ${wallet.address}, expected ${CONFIG.WALLET_ADDRESS}`);
  }
  console.log(`Owner EOA: ${wallet.address}`);
  console.log(`Factory:   ${CONFIG.DEPOSIT_WALLET_FACTORY}\n`);

  // 1. Derive deterministic deposit wallet address
  console.log('--- Step 1: Derive deposit wallet address ---');
  const depositWallet = await deriveDepositWalletAddress(wallet.address);
  console.log(`  Deposit wallet: ${depositWallet}`);

  // 2. Check if already deployed
  console.log('\n--- Step 2: Check deployment ---');
  const deployed = await isDeployed(depositWallet);
  if (deployed) {
    console.log('  Already deployed.');
  } else {
    console.log('  Not deployed. Deploying via relayer...');
    await deployDepositWallet(wallet.address);
    console.log('  Deployed successfully.');
  }

  // 3. Fund reminder
  console.log('\n--- Step 3: Funding ---');
  console.log('  Fund the deposit wallet with pUSD:');
  console.log(`    pUSD contract:     ${CONFIG.PUSD_ADDRESS}`);
  console.log(`    Deposit wallet:    ${depositWallet}`);
  console.log('  Option A: Transfer pUSD directly from your wallet.');
  console.log('  Option B: Wrap USDC via the Polymarket UI (wrapping to pUSD is automatic on app).');

  // 4. Print .env instructions
  console.log('\n==============================================');
  console.log('  Add to your .env:');
  console.log('==============================================');
  console.log(`  SIGNATURE_TYPE=3`);
  console.log(`  PROXY_ADDRESS=${depositWallet}`);
  console.log('\n  Then run approvals:');
  console.log('    npm run setup-approvals');
  console.log('\n  Then run preflight:');
  console.log('    npm run preflight');
  console.log('==============================================');
}

main().catch((err) => {
  console.error('Error:', err.message ?? err);
  process.exit(1);
});
