// The user's connected Lightning wallet (NWC), with the connection string kept
// encrypted in secrets.js.

import { pool } from '../nostr/pool.js';
import { getSecret, setSecret, hasSecret } from '../secrets.js';
import { parseNwcUri, nwc } from './nwc.js';

const NAME = 'nwc';

export const walletConnected = () => hasSecret(NAME);

function conn() {
  const uri = getSecret(NAME);
  if (!uri) throw new Error('No wallet connected. Connect one under Account → Lightning wallet.');
  return parseNwcUri(uri);
}

// Checks the wallet answers before storing the connection.
export async function connectWallet(uri) {
  const c = parseNwcUri(uri);
  const info = await nwc.info(pool, c);
  setSecret(NAME, uri.trim());
  return info;
}

export const disconnectWallet = () => setSecret(NAME, null);
export const walletInfo = () => nwc.info(pool, conn());
export const walletBalance = () => nwc.balance(pool, conn());
export const walletLud16 = () => { try { return conn().lud16; } catch { return ''; } };
export const makeInvoice = (sats, description) => nwc.makeInvoice(pool, conn(), sats, description);
export const payInvoice = (invoice) => nwc.payInvoice(pool, conn(), invoice);
export const lookupInvoice = (paymentHash) => nwc.lookupInvoice(pool, conn(), paymentHash);
