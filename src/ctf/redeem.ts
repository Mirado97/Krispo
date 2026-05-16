import { Interface, ZeroHash, Wallet } from 'ethers';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import { CTF_ABI } from './abi.js';
import { execSafeCall } from './client.js';

const log = childLogger('CTFRedeem');

const CTF_IFACE = new Interface(CTF_ABI);

// Redeem winning tokens after market resolution.
// indexSets: [1] for YES win, [2] for NO win, [1, 2] for both (invalid result / draw)
export async function redeemPositions(
  wallet: Wallet,
  conditionId: string,
  indexSets: number[],
): Promise<string> {
  log.info({ conditionId, indexSets }, 'redeemPositions');

  const data = CTF_IFACE.encodeFunctionData('redeemPositions', [
    CONFIG.PUSD_ADDRESS,
    ZeroHash,
    conditionId,
    indexSets.map(BigInt),
  ]);

  return execSafeCall(
    wallet,
    CONFIG.CTF_TOKEN_ADDRESS,
    data,
    `redeem indexSets=[${indexSets}]`,
  );
}
