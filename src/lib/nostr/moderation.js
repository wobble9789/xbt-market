// Blocking, reporting and suspended accounts.
//
// - Blocking: my own list of blocked people, a kind 30000 list with
//   d = xbt-market/blocked. Their listings are hidden for me. The list is
//   public, so anyone can count how many people blocked someone.
// - Blocked by BLOCK_LIMIT different people: the account is inactive (its
//   listings are hidden and it cannot be ordered from), unless the admin
//   cleared it. The admin can also suspend an account directly. Both live in
//   the admin's config (directory.js).
// - Reports and bug reports go privately to the admin (gift-wrapped).

import { createStore } from '../store.js';
import { query, signAndPublish, latestBy, tags } from './pool.js';
import { account } from './account.js';
import { directory } from './directory.js';
import { sendPrivate } from './inbox.js';
import { api, apiEnabled } from '../api.js';

export const BLOCK_D = 'xbt-market/blocked';
export const BLOCK_LIMIT = 10;
export const REPORT_REASONS = ['scam', 'no-delivery', 'fake', 'prohibited', 'abuse', 'spam', 'other'];

export const blocks = createStore({ set: new Set(), loaded: false });
// pubkey -> number of different people who blocked it (loaded on demand).
export const blockCounts = createStore({ counts: new Map() });

export async function loadBlocks(me = account.get().pubkey) {
  if (!me) { blocks.set({ set: new Set(), loaded: false }); return; }
  const ev = latestBy(await query({ kinds: [30000], authors: [me], '#d': [BLOCK_D] }), (e) => e.pubkey)[0];
  blocks.set({ set: new Set(ev ? tags(ev, 'p') : []), loaded: true });
}

async function saveBlocks(set) {
  blocks.set({ set: new Set(set), loaded: true });
  await signAndPublish({ kind: 30000, tags: [['d', BLOCK_D], ['title', 'XBT Market: blocked'], ['t', 'xbt-market'], ...[...set].map((p) => ['p', p])], content: '' });
}

export async function block(pk) {
  await loadBlocks();
  await saveBlocks([...blocks.get().set, pk]);
  bumpCount(pk, 1);
}

export async function unblock(pk) {
  await loadBlocks();
  await saveBlocks([...blocks.get().set].filter((p) => p !== pk));
  bumpCount(pk, -1);
}

function bumpCount(pk, d) {
  const counts = new Map(blockCounts.get().counts);
  if (counts.has(pk)) counts.set(pk, Math.max(0, counts.get(pk) + d));
  blockCounts.set({ counts });
}

// Whether `owner` blocked `pk` (their list is public).
export async function isBlockedBy(owner, pk) {
  const ev = latestBy(await query({ kinds: [30000], authors: [owner], '#d': [BLOCK_D] }).catch(() => []), (e) => e.pubkey)[0];
  return !!ev && tags(ev, 'p').includes(pk);
}

const pending = new Set();
let timer = null;

// Counts, per pubkey, the people whose block list names it. Batched.
export function loadBlockCounts(pks) {
  const known = blockCounts.get().counts;
  for (const pk of pks) if (pk && !known.has(pk)) pending.add(pk);
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const list = [...pending];
    pending.clear();
    if (!list.length) return;
    const lists = latestBy(await query({ kinds: [30000], '#d': [BLOCK_D], '#p': list }).catch(() => []), (e) => e.pubkey);
    const counts = new Map(blockCounts.get().counts);
    for (const pk of list) counts.set(pk, 0);
    for (const e of lists) for (const pk of new Set(tags(e, 'p'))) if (counts.has(pk) && list.includes(pk)) counts.set(pk, counts.get(pk) + 1);
    blockCounts.set({ counts });
  }, 200);
}

// Why an account is inactive: 'admin', 'blocks', or null when it is fine.
export function suspension(pk, dir = directory.get(), counts = blockCounts.get().counts) {
  const cfg = dir.config || {};
  if ((cfg.suspended || []).includes(pk)) return 'admin';
  if ((cfg.cleared || []).includes(pk)) return null;
  return (counts.get(pk) || 0) >= BLOCK_LIMIT ? 'blocks' : null;
}

export async function reportUser(admin, pk, { reason, text, listing }) {
  const body = { pk, reason, text: String(text || '').slice(0, 2000), listing: listing || '' };
  await sendPrivate(admin, JSON.stringify(body), [['xbt-report', pk], ['l', reason]]);
}

const MAX_FILES_BYTES = 15 * 1024 * 1024;

// A bug report: privately to the admin over Nostr, and by e-mail with the
// screenshots or video when the XBT Market service is set up for it.
export async function reportBug(admin, { text, files = [], page }) {
  const size = files.reduce((n, f) => n + f.size, 0);
  if (size > MAX_FILES_BYTES) throw new Error('Attachments are too large (15 MB at most)');
  const info = { text: String(text || '').slice(0, 5000), page, ua: navigator.userAgent, files: files.map((f) => `${f.name} (${Math.round(f.size / 1024)} kB)`) };
  let emailed = false;
  if (apiEnabled()) {
    const attachments = await Promise.all(files.map(async (f) => ({ filename: f.name, type: f.type, content: await toBase64(f) })));
    await api('/api/bug', { method: 'POST', body: { ...info, attachments }, auth: true }).then(() => { emailed = true; }).catch(() => {});
  }
  if (admin) await sendPrivate(admin, JSON.stringify({ ...info, emailed }), [['xbt-bug', '1']]);
  else if (!emailed) throw new Error('Bug reports are not set up for this app yet');
  return { emailed };
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
