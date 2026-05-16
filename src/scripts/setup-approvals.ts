/**
 * One-time on-chain approval setup for SIGNATURE_TYPE=0 (EOA direct trading).
 *
 * For EOA signing, the CTF Exchange must be approved to pull pUSD from your wallet.
 * This script checks and sets the required approvals.
 *
 * Usage:
 *   SIGNATURE_TYPE=0 npx tsx src/scripts/setup-approvals.ts
 *
 * After success, set in .env:
 *   SIGNATURE_TYPE=0
 *   PROXY_ADDRESS=<same as WALLET_ADDRESS>
 */

import { Wallet, JsonRpcProvider, Contract, formatUnits, MaxUint256 } from 'ethers';
import 'dotenv/config';
import { CONFIG } from '../config.js';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const CTF_ABI = [
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
];

async function main() {
  const wallet = new Wallet(CONFIG.PRIVATE_KEY);
  if (wallet.address.toLowerCase() !== CONFIG.WALLET_ADDRESS.toLowerCase()) {
    throw new Error(`Key mismatch: got ${wallet.address}, expected ${CONFIG.WALLET_ADDRESS}`);
  }

  const provider = new JsonRpcProvider(CONFIG.POLYGON_RPC_URL);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CONFIG.CHAIN_ID) {
    throw new Error(`Chain mismatch: got ${network.chainId}`);
  }

  const connectedWallet = wallet.connect(provider);
  const usdc = new Contract(CONFIG.PUSD_ADDRESS, ERC20_ABI, connectedWallet);
  const ctf = new Contract(CONFIG.CTF_TOKEN_ADDRESS, CTF_ABI, connectedWallet);

  const exchangeAddr = CONFIG.CTF_EXCHANGE;
  const negRiskAddr = CONFIG.NEG_RISK_CTF_EXCHANGE;

  console.log('=== On-chain approval setup for SIGNATURE_TYPE=0 ===');
  console.log(`Wallet:       ${wallet.address}`);
  console.log(`CTF Exchange: ${exchangeAddr}`);
  console.log(`NegRisk Exch: ${negRiskAddr}`);

  // --- 1. Check pUSD balance ---
  const usdcRaw = await usdc.balanceOf(wallet.address);
  const usdcBalance = parseFloat(formatUnits(usdcRaw, 6));
  console.log(`\npUSD balance: $${usdcBalance.toFixed(4)}`);

  if (usdcBalance < 1) {
    console.log('WARNING: Low pUSD balance — you need pUSD in this wallet to trade.');
  }

  // --- 2. pUSD allowance for CTF Exchange ---
  const allowanceRaw = await usdc.allowance(wallet.address, exchangeAddr);
  const allowance = parseFloat(formatUnits(allowanceRaw, 6));
  console.log(`\npUSD allowance for CTF Exchange: $${allowance.toFixed(2)}`);

  if (allowance < 1000) {
    console.log('Approving pUSD for CTF Exchange (MaxUint256)...');
    const tx = await usdc.approve(exchangeAddr, MaxUint256);
    console.log(`  TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  Confirmed in block ${receipt!.blockNumber}`);
  } else {
    console.log('  Already approved.');
  }

  // --- 3. pUSD allowance for NegRisk CTF Exchange ---
  const negRiskAllowanceRaw = await usdc.allowance(wallet.address, negRiskAddr);
  const negRiskAllowance = parseFloat(formatUnits(negRiskAllowanceRaw, 6));
  console.log(`\npUSD allowance for NegRisk Exchange: $${negRiskAllowance.toFixed(2)}`);

  if (negRiskAllowance < 1000) {
    console.log('Approving pUSD for NegRisk CTF Exchange...');
    const tx = await usdc.approve(negRiskAddr, MaxUint256);
    console.log(`  TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  Confirmed in block ${receipt!.blockNumber}`);
  } else {
    console.log('  Already approved.');
  }

  // --- 4. CTF token approval for exchange (needed for SELL orders) ---
  const ctfApproved = await ctf.isApprovedForAll(wallet.address, exchangeAddr);
  console.log(`\nCTF token approval for CTF Exchange: ${ctfApproved}`);

  if (!ctfApproved) {
    console.log('Setting CTF setApprovalForAll...');
    const tx = await ctf.setApprovalForAll(exchangeAddr, true);
    console.log(`  TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  Confirmed in block ${receipt!.blockNumber}`);
  } else {
    console.log('  Already approved.');
  }

  // --- 5. CTF token approval for NegRisk exchange ---
  const ctfNegRiskApproved = await ctf.isApprovedForAll(wallet.address, negRiskAddr);
  console.log(`\nCTF token approval for NegRisk Exchange: ${ctfNegRiskApproved}`);

  if (!ctfNegRiskApproved) {
    console.log('Setting CTF setApprovalForAll for NegRisk...');
    const tx = await ctf.setApprovalForAll(negRiskAddr, true);
    console.log(`  TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  Confirmed in block ${receipt!.blockNumber}`);
  } else {
    console.log('  Already approved.');
  }

  console.log('\n=== Setup complete ===');
  console.log('Now update your .env:');
  console.log('  SIGNATURE_TYPE=0');
  console.log(`  PROXY_ADDRESS=${wallet.address}   # same as WALLET_ADDRESS`);
  console.log('\nThen run: npm run preflight');
}

main().catch((err) => {
  console.error('Error:', err.message ?? err);
  process.exit(1);
});
