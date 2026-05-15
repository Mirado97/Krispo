/**
 * One-time script to generate Polymarket CLOB API credentials.
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx src/scripts/generate-api-key.ts
 *
 * This signs a ClobAuth EIP-712 message with your private key and
 * posts it to the CLOB to create API credentials.
 * Store the output in your .env file.
 */

import { Wallet } from 'ethers';
import 'dotenv/config';

const CLOB_URL = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error('Set PRIVATE_KEY env var');
    process.exit(1);
  }

  const sigType = parseInt(process.env.SIGNATURE_TYPE || '0', 10);
  const wallet = new Wallet(pk);
  const proxyAddress = process.env.PROXY_ADDRESS || wallet.address;
  const useProxy = sigType !== 0 && proxyAddress !== wallet.address;

  console.log(`Wallet (EOA):    ${wallet.address}`);
  console.log(`Proxy address:   ${proxyAddress}`);
  console.log(`Signature type:  ${sigType}`);

  // Get server time
  const timeResp = await fetch(`${CLOB_URL}/time`);
  const serverTime = await timeResp.text();
  const timestamp = serverTime.trim().replace(/"/g, '');
  console.log(`Server time: ${timestamp}`);

  const nonce = 0;
  const domain = { name: 'ClobAuthDomain', version: '1', chainId: CHAIN_ID };
  // Message address = proxy when using proxy, EOA otherwise
  const value = {
    address: useProxy ? proxyAddress : wallet.address,
    timestamp,
    nonce,
    message: 'This message attests that I control the given wallet',
  };

  const signature = await wallet.signTypedData(domain, CLOB_AUTH_TYPES, value);

  // For POLY_PROXY: POLY_ADDRESS=EOA, POLY_PROXY_ADDRESS=proxy
  // For EOA: POLY_ADDRESS=EOA only
  const buildHeaders = () => {
    const h: Record<string, string> = {
      'POLY_ADDRESS': wallet.address,
      'POLY_SIGNATURE': signature,
      'POLY_TIMESTAMP': timestamp,
      'POLY_NONCE': nonce.toString(),
    };
    if (useProxy) h['POLY_PROXY_ADDRESS'] = proxyAddress;
    return h;
  };

  // Try derive first
  const deriveResp = await fetch(`${CLOB_URL}/auth/derive-api-key`, {
    method: 'GET',
    headers: buildHeaders(),
  });

  if (deriveResp.ok) {
    const creds = await deriveResp.json();
    printCreds(creds);
    return;
  }

  // Derive failed, create new
  console.log('No existing credentials, creating new...');
  const createResp = await fetch(`${CLOB_URL}/auth/api-key`, {
    method: 'POST',
    headers: buildHeaders(),
  });

  if (!createResp.ok) {
    const errText = await createResp.text();
    console.error(`Failed to create API key: ${createResp.status} ${errText}`);
    process.exit(1);
  }

  const creds = await createResp.json();
  printCreds(creds);
}

function printCreds(creds: any) {
  console.log('\n=== Add these to your .env file ===\n');
  console.log(`POLY_API_KEY=${creds.apiKey}`);
  console.log(`POLY_API_SECRET=${creds.secret}`);
  console.log(`POLY_API_PASSPHRASE=${creds.passphrase}`);
  console.log('\n===================================\n');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
