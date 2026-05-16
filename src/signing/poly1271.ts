/**
 * POLY_1271 (signatureType=3) signing for Polymarket V2 deposit wallets.
 *
 * The deposit wallet uses a simplified ERC-7739 scheme:
 *   1. EOA signs a TypedDataSign struct against the CTF Exchange EIP-712 domain
 *   2. TypedDataSign wraps the Order contents + deposit wallet identity info
 *   3. Final signature = innerSig || ctfDomainSep || contentsHash || typeStringHex || typeStringLen
 *
 * Source: Polymarket clob-client-v2 ExchangeOrderBuilderV2.buildOrderSignature()
 */

import { Wallet, TypedDataEncoder } from 'ethers';
import { CONFIG } from '../config.js';
import type { RawOrder } from '../types.js';

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

const ORDER_TYPE_STRING =
  'Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)';

const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'metadata', type: 'bytes32' },
    { name: 'builder', type: 'bytes32' },
  ],
};

// TypedDataSign wraps Order contents with deposit wallet identity
const TYPED_DATA_SIGN_TYPES = {
  TypedDataSign: [
    { name: 'contents', type: 'Order' },
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ],
  Order: ORDER_TYPES.Order,
};

export async function signOrderPoly1271(
  wallet: Wallet,
  order: RawOrder,
  negRisk: boolean,
): Promise<string> {
  const ctfExchangeAddress = negRisk ? CONFIG.NEG_RISK_CTF_EXCHANGE : CONFIG.CTF_EXCHANGE;
  const depositWalletAddress = CONFIG.PROXY_ADDRESS;

  // CTF Exchange domain (the "app" domain)
  const ctfDomain = {
    name: 'Polymarket CTF Exchange',
    version: '2',
    chainId: CONFIG.CHAIN_ID,
    verifyingContract: ctfExchangeAddress,
  };

  // 1. EOA signs TypedDataSign against CTF Exchange domain
  //    TypedDataSign wraps the Order + deposit wallet identity
  const innerSig = await wallet.signTypedData(
    ctfDomain,
    TYPED_DATA_SIGN_TYPES,
    {
      contents: order,
      name: 'DepositWallet',
      version: '1',
      chainId: CONFIG.CHAIN_ID,
      verifyingContract: depositWalletAddress,
      salt: ZERO_BYTES32,
    },
  );

  // 2. CTF Exchange domain separator
  const ctfDomainSep = TypedDataEncoder.hashDomain(ctfDomain);

  // 3. Order struct hash (hashStruct, no domain)
  const orderEncoder = TypedDataEncoder.from(ORDER_TYPES);
  const contentsHash = orderEncoder.hashStruct('Order', order);

  // 4. Order type string as hex + its length (2 bytes, big-endian)
  const typeStrHex = Buffer.from(ORDER_TYPE_STRING, 'utf8').toString('hex');
  const lenHex = ORDER_TYPE_STRING.length.toString(16).padStart(4, '0');

  // 5. Concatenate: innerSig || ctfDomainSep || contentsHash || typeString || len
  return innerSig + ctfDomainSep.slice(2) + contentsHash.slice(2) + typeStrHex + lenHex;
}
