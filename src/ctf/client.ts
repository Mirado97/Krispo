import { ethers, ZeroAddress, Contract, JsonRpcProvider, Wallet, TypedDataEncoder } from 'ethers';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import { GNOSIS_SAFE_ABI, SAFE_TX_TYPES } from './abi.js';

const log = childLogger('CTFClient');

let _provider: JsonRpcProvider | null = null;
let _safe: Contract | null = null;

function getProvider(): JsonRpcProvider {
  if (!_provider) {
    _provider = new JsonRpcProvider(CONFIG.POLYGON_RPC_URL);
  }
  return _provider;
}

function getSafe(wallet: Wallet): Contract {
  if (!_safe) {
    const connected = wallet.connect(getProvider());
    _safe = new Contract(CONFIG.PROXY_ADDRESS, GNOSIS_SAFE_ABI, connected);
  }
  return _safe;
}

// Serialized nonce queue — all Safe txs run sequentially to avoid nonce collisions
let _txQueue = Promise.resolve<void>(undefined);

async function _doExecSafeCall(
  wallet: Wallet,
  to: string,
  data: string,
  description: string,
): Promise<string> {
  const safe = getSafe(wallet);
  const safeNonce: bigint = await safe.nonce();

  const safeTxData = {
    to,
    value: 0n,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZeroAddress,
    refundReceiver: ZeroAddress,
    nonce: safeNonce,
  };

  const domain = {
    chainId: CONFIG.CHAIN_ID,
    verifyingContract: CONFIG.PROXY_ADDRESS,
  };

  const txHash = TypedDataEncoder.hash(domain, SAFE_TX_TYPES, safeTxData);
  const sig = wallet.signingKey.sign(txHash);
  // Safe expects r + s + v (65 bytes) without Ethereum prefix
  const v = sig.v === 27 ? '1b' : '1c';
  const signature = sig.r + sig.s.slice(2) + v;

  log.info({ to, description, nonce: safeNonce.toString() }, 'Executing Safe tx');

  const tx = await (safe as any).execTransaction(
    safeTxData.to,
    safeTxData.value,
    safeTxData.data,
    safeTxData.operation,
    safeTxData.safeTxGas,
    safeTxData.baseGas,
    safeTxData.gasPrice,
    safeTxData.gasToken,
    safeTxData.refundReceiver,
    signature,
    { gasLimit: 500_000 },
  );

  const receipt = await tx.wait(1);
  log.info({ txHash: receipt.hash, description }, 'Safe tx confirmed');
  return receipt.hash as string;
}

export function execSafeCall(
  wallet: Wallet,
  to: string,
  data: string,
  description: string,
): Promise<string> {
  if (CONFIG.DRY_RUN) {
    log.info({ to, description }, '[DRY_RUN] would execSafeCall');
    return Promise.resolve('0xdry');
  }

  // Enqueue — never run two Safe txs in parallel (nonce collision)
  const job = () => _doExecSafeCall(wallet, to, data, description);
  const result: Promise<string> = _txQueue.then(job);
  _txQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}

export function getCtfProvider(): JsonRpcProvider {
  return getProvider();
}
