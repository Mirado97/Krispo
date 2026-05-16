import { Contract, Interface, ZeroHash, Wallet } from 'ethers';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import { CTF_ABI, ERC20_ABI } from './abi.js';
import { execSafeCall, getCtfProvider } from './client.js';

const log = childLogger('CTFSplit');

const CTF_IFACE = new Interface(CTF_ABI);
const ERC20_IFACE = new Interface(ERC20_ABI);

const PARTITION = [1n, 2n];
const UNIT = 10n ** BigInt(CONFIG.AMOUNT_DECIMALS);

async function ensureUsdcApproval(wallet: Wallet, amount: bigint): Promise<void> {
  if (CONFIG.DRY_RUN) return;

  const usdc = new Contract(CONFIG.PUSD_ADDRESS, ERC20_ABI, getCtfProvider());
  const allowance: bigint = await usdc.allowance(CONFIG.PROXY_ADDRESS, CONFIG.CTF_TOKEN_ADDRESS);

  if (allowance >= amount) return;

  log.info({ current: allowance.toString(), needed: amount.toString() }, 'Approving pUSD for CTF');

  const data = ERC20_IFACE.encodeFunctionData('approve', [
    CONFIG.CTF_TOKEN_ADDRESS,
    // Max approval — avoid repeated approve txs
    2n ** 256n - 1n,
  ]);

  await execSafeCall(wallet, CONFIG.PUSD_ADDRESS, data, 'approve pUSD for CTF');
}

export async function splitPosition(
  wallet: Wallet,
  conditionId: string,
  usdcAmount: number,
): Promise<string> {
  const amount = BigInt(Math.floor(usdcAmount * Number(UNIT)));

  log.info(
    { conditionId, usdcAmount, amountRaw: amount.toString() },
    'splitPosition — pUSD → YES+NO',
  );

  await ensureUsdcApproval(wallet, amount);

  const data = CTF_IFACE.encodeFunctionData('splitPosition', [
    CONFIG.PUSD_ADDRESS,
    ZeroHash,
    conditionId,
    PARTITION,
    amount,
  ]);

  return execSafeCall(wallet, CONFIG.CTF_TOKEN_ADDRESS, data, `split ${usdcAmount} pUSD`);
}
