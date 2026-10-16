// Nostr Wallet Connect (NIP-47): talk to the user's own Lightning wallet
// (Alby Hub, Zeus, Primal, Coinos, Mutiny-style wallets…) through a relay.
// The connection string holds a secret that lets this app ask the wallet to
// pay; users should create it with a spending budget. It is stored encrypted
// (see secrets.js) and never leaves this browser except to the wallet's relay.

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import * as nip44 from 'nostr-tools/nip44';
import { hexToBytes } from '../btc/bytes.js';

export const NWC_REQUEST = 23194;
export const NWC_RESPONSE = 23195;
export const NWC_INFO = 13194;

export function parseNwcUri(uri) {
  const s = String(uri || '').trim();
  const m = /^nostr\+walletconnect:\/\/?([0-9a-f]{64})\?(.+)$/i.exec(s);
  if (!m) throw new Error('Not a Nostr Wallet Connect string (nostr+walletconnect://…)');
  const q = new URLSearchParams(m[2]);
  const relays = q.getAll('relay').filter((r) => /^wss?:\/\//.test(r));
  const secret = q.get('secret') || '';
  if (!relays.length) throw new Error('The connection string has no relay');
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error('The connection string has no valid secret');
  return { walletPubkey: m[1].toLowerCase(), relays, secret: secret.toLowerCase(), lud16: q.get('lud16') || '' };
}

const sk = (conn) => hexToBytes(conn.secret);
export const clientPubkey = (conn) => getPublicKey(sk(conn));

// Wallets list their supported encryption in the info event; NIP-04 is the
// legacy default when the tag is missing.
export function pickEncryption(infoEvent) {
  const tag = infoEvent?.tags?.find((t) => t[0] === 'encryption')?.[1] || '';
  return tag.split(/\s+/).includes('nip44_v2') ? 'nip44_v2' : 'nip04';
}

function encrypt(conn, enc, text) {
  return enc === 'nip44_v2'
    ? nip44.encrypt(text, nip44.getConversationKey(sk(conn), conn.walletPubkey))
    : nip04.encrypt(sk(conn), conn.walletPubkey, text);
}

function decrypt(conn, enc, text) {
  // A wallet answers in the scheme of the request; NIP-04 payloads contain "?iv=".
  return enc === 'nip04' || text.includes('?iv=')
    ? nip04.decrypt(sk(conn), conn.walletPubkey, text)
    : nip44.decrypt(text, nip44.getConversationKey(sk(conn), conn.walletPubkey));
}

export function buildRequest(conn, enc, method, params, now = Math.floor(Date.now() / 1000)) {
  const tags = [['p', conn.walletPubkey]];
  if (enc === 'nip44_v2') tags.push(['encryption', 'nip44_v2']);
  return finalizeEvent({ kind: NWC_REQUEST, created_at: now, tags, content: encrypt(conn, enc, JSON.stringify({ method, params })) }, sk(conn));
}

export function readResponse(conn, enc, event) {
  if (event.pubkey !== conn.walletPubkey) throw new Error('response from another key');
  const body = JSON.parse(decrypt(conn, enc, event.content));
  if (body.error) throw Object.assign(new Error(body.error.message || body.error.code || 'wallet error'), { code: body.error.code });
  return body.result || {};
}

// One request/response round trip. `pool` is a nostr-tools SimplePool.
export async function nwcCall(pool, conn, method, params = {}, { timeout = 60_000 } = {}) {
  const info = await pool.get(conn.relays, { kinds: [NWC_INFO], authors: [conn.walletPubkey] }, { maxWait: 4000 }).catch(() => null);
  const enc = pickEncryption(info);
  const req = buildRequest(conn, enc, method, params);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); sub.close(); fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('The wallet did not answer in time. Is it online?')), timeout);
    const sub = pool.subscribe(conn.relays, { kinds: [NWC_RESPONSE], authors: [conn.walletPubkey], '#e': [req.id] }, {
      onevent(ev) {
        try { finish(resolve, readResponse(conn, enc, ev)); } catch (e) { finish(reject, e); }
      },
    });
    Promise.allSettled(pool.publish(conn.relays, req)).then((res) => {
      if (!res.some((r) => r.status === 'fulfilled')) finish(reject, new Error('Could not reach the wallet relay'));
    });
  });
}

export const nwc = {
  info: (pool, conn) => nwcCall(pool, conn, 'get_info'),
  balance: (pool, conn) => nwcCall(pool, conn, 'get_balance'),
  makeInvoice: (pool, conn, sats, description) => nwcCall(pool, conn, 'make_invoice', { amount: sats * 1000, description }),
  payInvoice: (pool, conn, invoice) => nwcCall(pool, conn, 'pay_invoice', { invoice }, { timeout: 120_000 }),
  lookupInvoice: (pool, conn, paymentHash) => nwcCall(pool, conn, 'lookup_invoice', { payment_hash: paymentHash }),
};
