// Lightning addresses (name@domain, LUD-16) and LNURL-pay (LUD-06): turn an
// address into an invoice for an exact amount. Used by sellers without a
// connected wallet, and to check a seller's address before showing it.

import { decodeInvoice } from './bolt11.js';

export const isLightningAddress = (s) => /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(s || '').trim());

export function lnurlpUrl(address) {
  const [name, domain] = address.trim().toLowerCase().split('@');
  const scheme = /\.onion$/.test(domain) || /^(localhost|127\.)/.test(domain) ? 'http' : 'https';
  return `${scheme}://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`;
}

async function getJSON(url, fetchImpl) {
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`${new URL(url).host}: ${r.status}`);
  const j = await r.json();
  if (j.status === 'ERROR') throw new Error(j.reason || 'LNURL error');
  return j;
}

// Returns { invoice, decoded } for exactly `sats`.
export async function invoiceFromAddress(address, sats, comment = '', fetchImpl = globalThis.fetch) {
  if (!isLightningAddress(address)) throw new Error('Not a Lightning address (name@domain)');
  const meta = await getJSON(lnurlpUrl(address), fetchImpl);
  if (meta.tag !== 'payRequest' || !meta.callback) throw new Error('This address does not accept payments');
  const msat = sats * 1000;
  if (msat < meta.minSendable || msat > meta.maxSendable) throw new Error(`Amount outside what this address accepts (${Math.ceil(meta.minSendable / 1000)}–${Math.floor(meta.maxSendable / 1000)} sats)`);
  const url = new URL(meta.callback);
  url.searchParams.set('amount', String(msat));
  if (comment && meta.commentAllowed) url.searchParams.set('comment', comment.slice(0, meta.commentAllowed));
  const res = await getJSON(url.toString(), fetchImpl);
  const decoded = decodeInvoice(res.pr);
  if (decoded.amountMsat == null || Number(decoded.amountMsat) !== msat) throw new Error('The wallet returned an invoice for a different amount');
  return { invoice: decoded.invoice, decoded };
}
