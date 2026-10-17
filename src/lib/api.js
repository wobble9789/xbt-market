// Client for the XBT Market service (server/worker.js). Requests that act for
// a user carry a NIP-98 HTTP auth event signed with their Nostr key.
import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';
import { bytesToHex } from './btc/bytes.js';
import { sign } from './nostr/account.js';
import { API_URL } from '../config.js';

export const apiEnabled = () => !!API_URL;
export const apiDomain = () => (API_URL ? new URL(API_URL).host : '');

export async function api(path, { method = 'GET', body, auth = false } = {}) {
  if (!API_URL) throw new Error('The XBT Market service is not configured for this app');
  const url = API_URL + path;
  const text = body == null ? undefined : JSON.stringify(body);
  const headers = { accept: 'application/json' };
  if (text) headers['content-type'] = 'application/json';
  if (auth) {
    const tags = [['u', url], ['method', method]];
    if (text) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(text)))]);
    const ev = sign({ kind: 27235, content: '', tags });
    headers.authorization = 'Nostr ' + base64.encode(new TextEncoder().encode(JSON.stringify(ev)));
  }
  let r;
  try { r = await fetch(url, { method, headers, body: text }); } catch (e) { throw new Error(`XBT Market service unreachable: ${e.message}`); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `XBT Market service: ${r.status}`);
  return data;
}
