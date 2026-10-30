// Relay for AI services that do not accept requests from websites (no CORS):
// the app sends the request here and the service passes it on, unchanged, to
// the address the user configured, and the answer back. Nothing is stored;
// the API key only passes through. Only signed-in accounts (NIP-98), at most
// RATE per hour each, only https addresses, only the two paths the app uses.

const RATE = 60;
const PATHS = ['chat/completions', 'models'];
const MAX_BYTES = 20 * 1024 * 1024;

function allowedBase(base) {
  let u;
  try { u = new URL(String(base || '')); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  // Never addresses inside a network (the service itself, or a private one).
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[|0\.)/i.test(u.hostname) || u.hostname.endsWith('.internal') || u.hostname.endsWith('.local')) return null;
  return u.href.replace(/\/+$/, '');
}

export async function relayAi(pk, body, store, fetchImpl, size = 0) {
  if (size > MAX_BYTES) throw Object.assign(new Error('Too large'), { status: 413 });
  const base = allowedBase(body.base);
  if (!base) throw Object.assign(new Error('The AI service address must start with https://'), { status: 400 });
  if (!PATHS.includes(body.path)) throw Object.assign(new Error('Unknown path'), { status: 400 });
  const hour = Math.floor(Date.now() / 3_600_000);
  const k = `ai-rate:${pk}:${hour}`;
  const used = (await store.get(k)) || 0;
  if (used >= RATE) throw Object.assign(new Error(`At most ${RATE} AI requests per hour through this service`), { status: 429 });
  await store.put(k, used + 1);
  if (!used) await store.delete(`ai-rate:${pk}:${hour - 1}`);
  const headers = { 'content-type': 'application/json', ...(body.key ? { authorization: `Bearer ${String(body.key)}` } : {}) };
  let r;
  try {
    r = await fetchImpl(`${base}/${body.path}`, body.path === 'models' ? { headers } : { method: 'POST', headers, body: JSON.stringify(body.request || {}) });
  } catch (e) {
    return { status: 0, error: `Could not reach ${new URL(base).host}: ${e.message}` };
  }
  return { status: r.status, body: await r.text() };
}
