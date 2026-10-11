// Minimal in-memory Nostr relay for local development and end-to-end tests.
//   node dev/relay.mjs [port]      (default 7777)
import { WebSocketServer } from 'ws';
import { verifyEvent } from 'nostr-tools/pure';
import { matchFilters } from 'nostr-tools/filter';

const port = Number(process.argv[2] || process.env.PORT || 7777);
const events = [];
const subs = new Map(); // ws -> Map(subId -> filters)
const isReplaceable = (k) => k === 0 || k === 3 || (k >= 10000 && k < 20000);
const isAddressable = (k) => k >= 30000 && k < 40000;
const dTag = (e) => e.tags.find((t) => t[0] === 'd')?.[1] ?? '';

function store(e) {
  if (events.some((x) => x.id === e.id)) return false;
  if (isReplaceable(e.kind) || isAddressable(e.kind)) {
    const same = (x) => x.kind === e.kind && x.pubkey === e.pubkey && (!isAddressable(e.kind) || dTag(x) === dTag(e));
    const old = events.find(same);
    if (old && old.created_at > e.created_at) return false;
    for (let i = events.length - 1; i >= 0; i--) if (same(events[i])) events.splice(i, 1);
  }
  events.push(e);
  return true;
}

const wss = new WebSocketServer({ port });
wss.on('connection', (ws) => {
  subs.set(ws, new Map());
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const [type, ...rest] = msg;
    if (type === 'EVENT') {
      const e = rest[0];
      if (!verifyEvent(e)) return ws.send(JSON.stringify(['OK', e?.id, false, 'invalid: bad signature']));
      const fresh = store(e);
      ws.send(JSON.stringify(['OK', e.id, true, fresh ? '' : 'duplicate:']));
      if (fresh) for (const [client, m] of subs) for (const [id, filters] of m) if (matchFilters(filters, e)) client.send(JSON.stringify(['EVENT', id, e]));
    } else if (type === 'REQ') {
      const [id, ...filters] = rest;
      subs.get(ws).set(id, filters);
      const limit = Math.min(...filters.map((f) => f.limit ?? Infinity));
      const hits = events.filter((e) => matchFilters(filters, e)).sort((a, b) => b.created_at - a.created_at).slice(0, Number.isFinite(limit) ? limit : undefined);
      for (const e of hits) ws.send(JSON.stringify(['EVENT', id, e]));
      ws.send(JSON.stringify(['EOSE', id]));
    } else if (type === 'CLOSE') {
      subs.get(ws).delete(rest[0]);
    }
  });
  ws.on('close', () => subs.delete(ws));
});
console.log(`relay listening on ws://127.0.0.1:${port}`);
