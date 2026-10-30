// The service's relay for AI services that refuse requests from websites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayAi } from '../server/ai.js';

const memStore = () => { const m = new Map(); return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } }; };

test('AI relay: only https to public addresses and the two paths, per account at most 60 an hour, answer passed back', async () => {
  const store = memStore();
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response('{"ok":1}', { status: 201 }); };
  const ok = await relayAi('pk', { base: 'https://ai.example/v1/', key: 'k1', path: 'chat/completions', request: { model: 'm' } }, store, fetchImpl);
  assert.deepEqual(ok, { status: 201, body: '{"ok":1}' });
  assert.equal(seen[0].url, 'https://ai.example/v1/chat/completions');
  assert.equal(seen[0].init.headers.authorization, 'Bearer k1');
  assert.deepEqual(JSON.parse(seen[0].init.body), { model: 'm' });
  for (const base of ['http://ai.example/v1', 'https://localhost/v1', 'https://192.168.1.5/v1', 'https://node.local/v1', 'not a url']) {
    await assert.rejects(relayAi('pk', { base, path: 'models' }, store, fetchImpl), /https/);
  }
  await assert.rejects(relayAi('pk', { base: 'https://ai.example/v1', path: 'files' }, store, fetchImpl), /Unknown path/);
  for (let i = 1; i < 60; i++) await relayAi('pk', { base: 'https://ai.example/v1', path: 'models' }, store, fetchImpl);
  await assert.rejects(relayAi('pk', { base: 'https://ai.example/v1', path: 'models' }, store, fetchImpl), /60 AI requests per hour/);
  // Another account has its own count; an unreachable service is said so.
  const down = await relayAi('pk2', { base: 'https://ai.example/v1', path: 'models' }, store, async () => { throw new Error('dns'); });
  assert.equal(down.status, 0);
  assert.match(down.error, /Could not reach ai\.example/);
});
