/**
 * Diagnostic + recovery for USDC stuck in a Polymarket proxy contract.
 *
 * Usage:
 *   PROXY_ADDRESS=0xF520... npx tsx src/scripts/recover-proxy-usdc.ts
 */

import { Wallet, JsonRpcProvider, Contract, formatUnits, Interface } from 'ethers';
import 'dotenv/config';
import { CONFIG } from '../config.js';

const PROXY_ADDR = CONFIG.PROXY_ADDRESS;
const WALLET_ADDR = CONFIG.WALLET_ADDRESS;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

// Polymarket ProxyWallet ABI — supports withdrawERC20 and execute
const PROXY_ABI = [
  'function owner() view returns (address)',
  'function getImplementation() view returns (address)',
  // ProxyWallet execute — calls arbitrary function as the proxy
  'function execute(address to, uint256 value, bytes calldata data) payable returns (bool, bytes memory)',
  // Some versions expose direct withdraw
  'function withdrawERC20(address token, address to, uint256 amount)',
  // SafeProxy / GnosisSafe style
  'function getOwners() view returns (address[])',
];

async function main() {
  const provider = new JsonRpcProvider(CONFIG.POLYGON_RPC_URL);
  const wallet = new Wallet(CONFIG.PRIVATE_KEY, provider);

  console.log('=== Proxy Recovery Diagnostic ===');
  console.log(`Proxy:  ${PROXY_ADDR}`);
  console.log(`Wallet: ${WALLET_ADDR}`);

  // 1. Check if proxy is a contract
  const code = await provider.getCode(PROXY_ADDR);
  if (code === '0x') {
    console.log('\nERROR: 0xF520... is a plain EOA, not a contract.');
    console.log('The $20 USDC are accessible directly — use wallet to transfer them.');
    console.log('But you would need the private key for that address.');
    return;
  }
  console.log(`\nContract: YES (bytecode length: ${(code.length - 2) / 2} bytes)`);

  // 2. USDC balance on proxy
  const usdc = new Contract(CONFIG.PUSD_ADDRESS, ERC20_ABI, provider);
  const balRaw = await usdc.balanceOf(PROXY_ADDR);
  const bal = parseFloat(formatUnits(balRaw, 6));
  console.log(`USDC balance: $${bal.toFixed(4)}`);

  if (bal < 0.01) {
    console.log('No USDC to recover.');
    return;
  }

  // 3. Try to read owner / owners
  const proxy = new Contract(PROXY_ADDR, PROXY_ABI, wallet);

  try {
    const owner = await proxy.owner();
    console.log(`\nowner(): ${owner}`);
    if (owner.toLowerCase() === WALLET_ADDR.toLowerCase()) {
      console.log('You ARE the owner — can call execute() or withdrawERC20()');
    } else {
      console.log(`Owner is ${owner} — not your EOA`);
    }
  } catch {
    console.log('\nowner() not available on this contract');
  }

  try {
    const owners = await proxy.getOwners();
    console.log(`\ngetOwners(): ${owners}`);
  } catch {
    console.log('getOwners() not available');
  }

  // 4. Try execute() to call USDC.transfer from proxy to wallet
  console.log('\n--- Attempting recovery via execute() ---');
  const erc20Iface = new Interface(ERC20_ABI);
  const transferData = erc20Iface.encodeFunctionData('transfer', [WALLET_ADDR, balRaw]);

  try {
    const tx = await proxy.execute(CONFIG.PUSD_ADDRESS, 0n, transferData);
    console.log(`TX submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`Confirmed in block ${receipt!.blockNumber}`);

    const newBal = parseFloat(formatUnits(await usdc.balanceOf(PROXY_ADDR), 6));
    console.log(`Proxy USDC after: $${newBal.toFixed(4)}`);
    console.log('SUCCESS — funds recovered!');
  } catch (err: any) {
    console.log(`execute() failed: ${err.message}`);
    console.log('\nProxy does not allow arbitrary execute from your EOA.');
    console.log('This is a Polymarket-controlled proxy (Privy). Options:');
    console.log('  1. Contact Polymarket support — they can recover funds from API proxy');
    console.log('  2. The USDC might be usable for SIGNATURE_TYPE=1 if your EOA is a registered signer');
  }

  // 5. Try withdrawERC20 directly
  try {
    console.log('\n--- Attempting withdrawERC20() ---');
    const tx2 = await proxy.withdrawERC20(CONFIG.PUSD_ADDRESS, WALLET_ADDR, balRaw);
    console.log(`TX: ${tx2.hash}`);
    await tx2.wait();
    console.log('SUCCESS via withdrawERC20!');
  } catch (err: any) {
    console.log(`withdrawERC20() failed: ${err.message?.slice(0, 120)}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message ?? err);
  process.exit(1);
});
