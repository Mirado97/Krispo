import { Contract, Interface, ZeroHash, Wallet } from 'ethers';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import { CTF_ABI } from './abi.js';
import { execSafeCall, getCtfProvider } from './client.js';

const log = childLogger('CTFMerge');

const CTF_IFACE = new Interface(CTF_ABI);

// YES=1, NO=2 partition used by all Polymarket binary markets
const PARTITION = [1n, 2n];
const UNIT = 10n ** BigInt(CONFIG.AMOUNT_DECIMALS); // 1e6 for USDC

export async function mergePositions(
  wallet: Wallet,
  conditionId: string,
  sharesAmount: number,
): Promise<string> {
  const amount = BigInt(Math.floor(sharesAmount * Number(UNIT)));

  log.info(
    { conditionId, sharesAmount, amountRaw: amount.toString() },
    'mergePositions — YES+NO → USDC',
  );

  const data = CTF_IFACE.encodeFunctionData('mergePositions', [
    CONFIG.USDC_E_ADDRESS,
    ZeroHash,
    conditionId,
    PARTITION,
    amount,
  ]);

  return execSafeCall(wallet, CONFIG.CTF_TOKEN_ADDRESS, data, `merge ${sharesAmount} shares`);
}

export async function getCtfBalance(
  account: string,
  tokenId: string,
): Promise<number> {
  const ctf = new Contract(CONFIG.CTF_TOKEN_ADDRESS, CTF_ABI, getCtfProvider());
  const raw: bigint = await ctf.balanceOf(account, BigInt(tokenId));
  return Number(raw) / Number(UNIT);
}
