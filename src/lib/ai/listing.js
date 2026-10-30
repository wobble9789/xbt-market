// Draft a listing from its photos with the seller's own AI service. The
// connection (API key, address, model) is stored encrypted (secrets.js) and
// used only from this browser, sent only to the service's own address.
//
// Two kinds of service:
// - an Anthropic API key (sk-ant-…): the official SDK, with structured output;
// - any other: an OpenAI-compatible chat completions API at the address the
//   seller gives (hosted services, or a model on their own computer).
// The SDK is loaded on first use, so the app stays small for everyone else.

import { CATEGORIES, CONDITIONS } from '../nostr/listings.js';
import { getSecret, setSecret, hasSecret } from '../secrets.js';
import { AI_MODEL } from '../../config.js';
import { api, apiEnabled } from '../api.js';

const NAME = 'ai';
const OLD_NAME = 'anthropic'; // a bare Anthropic key, from before other services
const ANTHROPIC_HOST = 'api.anthropic.com';

export const isAnthropicKey = (key) => /^sk-ant-/.test((key || '').trim());

// The address without a trailing slash or a pasted /chat/completions.
export function normalizeBase(base) {
  return (base || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

export function validBase(base) {
  try {
    const u = new URL(normalizeBase(base));
    return u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname));
  } catch { return false; }
}

export const aiConfigured = () => hasSecret(NAME) || hasSecret(OLD_NAME);

// { key, base, model, anthropic } or null.
export function loadAi() {
  const raw = getSecret(NAME);
  if (raw) {
    try {
      const c = JSON.parse(raw);
      return { key: c.key || '', base: normalizeBase(c.base), model: c.model || '', anthropic: isAnthropicKey(c.key) && !c.base };
    } catch { return null; }
  }
  const old = getSecret(OLD_NAME);
  return old ? { key: old, base: '', model: '', anthropic: true } : null;
}

// Where the photos and the key go, for the settings page.
export const aiHost = (c) => (c?.anthropic ? ANTHROPIC_HOST : (() => { try { return new URL(c.base).host; } catch { return ''; } })());

export function saveAi(c) {
  setSecret(OLD_NAME, null);
  if (!c) { setSecret(NAME, null); return; }
  const key = (c.key || '').trim();
  const anthropic = isAnthropicKey(key) && !c.base;
  if (!anthropic && !validBase(c.base)) throw new Error('Enter the API address of your AI service, starting with https://');
  if (!anthropic && !(c.model || '').trim()) throw new Error('Enter the model to use');
  setSecret(NAME, JSON.stringify({ key, base: anthropic ? '' : normalizeBase(c.base), model: (c.model || '').trim() }));
}

// ---- talking to an OpenAI-compatible service -------------------------------------

const isLocal = (base) => { try { return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(base).hostname); } catch { return false; } };

// One request, straight from this browser. Many services refuse requests from
// websites (no CORS): the request then fails before any answer, and it goes
// through the XBT Market service instead (server/ai.js), when that is set up.
// relay is for tests. Returns { status, text, via }.
export async function aiRequest(c, path, request, { fetchImpl = fetch, relay } = {}) {
  const headers = { 'content-type': 'application/json', ...(c.key ? { authorization: `Bearer ${c.key}` } : {}) };
  try {
    const r = await fetchImpl(`${normalizeBase(c.base)}/${path}`, path === 'models' ? { headers } : { method: 'POST', headers, body: JSON.stringify(request) });
    return { status: r.status, text: await r.text(), via: 'direct' };
  } catch {
    const through = relay || (apiEnabled() && !isLocal(c.base) ? (body) => api('/api/ai', { method: 'POST', auth: true, body }) : null);
    if (!through) {
      throw new Error(isLocal(c.base)
        ? 'No answer from the model on this computer. Is it running, and does it allow requests from this site?'
        : 'Your AI service does not answer requests from websites. It works once the XBT Market service is set up; until then, use a service that allows it.');
    }
    const res = await through({ base: normalizeBase(c.base), key: c.key, path, request });
    if (!res.status) throw new Error(res.error || 'The XBT Market service could not reach your AI service. Check the API address.');
    return { status: res.status, text: res.body, via: 'service' };
  }
}

// What went wrong, in words the user can act on, with the service's own message.
function aiError(res) {
  let detail = '';
  try { const j = JSON.parse(res.text); detail = String(j.error?.message || j.error || j.message || '').slice(0, 200); } catch { detail = String(res.text || '').slice(0, 200); }
  const tail = detail ? ` (${detail})` : '';
  if (res.status === 401 || res.status === 403) return new Error(`Your AI service did not accept the API key${tail}.`);
  if (res.status === 404) return new Error(`Not found at your AI service: check the API address (it usually ends in /v1) and the model${tail}.`);
  if (res.status === 429) return new Error(`Your AI service says: too many requests or no credit left${tail}.`);
  return new Error(`Your AI service answered with error ${res.status}${tail}.`);
}

// The models an OpenAI-compatible service offers (to pick one). Free to call.
export async function listModels({ base, key, fetchImpl, relay }) {
  if (!validBase(base)) throw new Error('Enter the API address first');
  const res = await aiRequest({ base, key: (key || '').trim() }, 'models', null, { fetchImpl, relay });
  if (res.status < 200 || res.status >= 300) throw aiError(res);
  let body = {};
  try { body = JSON.parse(res.text); } catch { /* no list */ }
  const ids = (body.data || body.models || []).map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  return [...new Set(ids)].sort();
}

// A tiny real request, to show whether the key, address and model work.
export async function testAi(c, { fetchImpl, relay } = {}) {
  if (c.anthropic) {
    const client = await anthropicClient(c.key, fetchImpl);
    await client.models.list({ limit: 1 });
    return { ok: true, via: 'direct' };
  }
  const res = await aiRequest(c, 'chat/completions', { model: c.model, max_tokens: 5, messages: [{ role: 'user', content: 'Reply with: OK' }] }, { fetchImpl, relay });
  if (res.status < 200 || res.status >= 300) throw aiError(res);
  return { ok: true, via: res.via };
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'category', 'condition', 'price', 'notes'],
  properties: {
    title: { type: 'string', description: 'Short, searchable title: brand, model, size or key spec. Max 70 characters.' },
    description: { type: 'string', description: 'Honest description for a second-hand marketplace: what it is, visible condition and flaws, size/dimensions if visible, what is included.' },
    category: { type: 'string', enum: CATEGORIES },
    condition: { type: 'string', enum: CONDITIONS },
    price: { type: 'number', description: 'Suggested asking price for a quick second-hand sale, in the requested currency. 0 if you cannot tell.' },
    notes: { type: 'string', description: 'One or two sentences for the seller (not the buyer): what to check or add, e.g. measurements or a missing detail. Empty if nothing.' },
  },
};

const SYSTEM = 'You write listings for a second-hand marketplace. Describe only what the photos show or the seller states; never invent brands, sizes or specs. Mention visible wear. Plain text, no emoji, no hype.';

const subcategorySchema = (subs) => ({ type: 'object', additionalProperties: false, required: ['subcategory'], properties: { subcategory: { type: 'string', enum: subs.map((c) => c[0]) } } });
const subcategoryPrompt = (out, subs) => `Pick the best subcategory for this listing.\nTitle: ${out.title}\nDescription: ${out.description}\nSubcategories (id: name): ${subs.map((c) => `${c[0]}: ${c[2]}`).join('; ')}`;

// ---- Anthropic (official SDK) ----------------------------------------------

async function anthropicClient(apiKey, fetchImpl) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // The key belongs to the user and is only used from their own browser.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

async function anthropicJson(c, { images = [], text, schema, maxTokens, fetchImpl }) {
  const { jsonSchemaOutputFormat } = await import('@anthropic-ai/sdk/helpers/json-schema');
  const client = await anthropicClient(c.key, fetchImpl);
  const response = await client.beta.messages.parse({
    model: c.model || AI_MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // transform: false keeps the enums as real constraints (the API supports them).
    output_config: { effort: 'low', format: jsonSchemaOutputFormat(schema, { transform: false }) },
    system: SYSTEM,
    messages: [{ role: 'user', content: [...images.map((url) => ({ type: 'image', source: { type: 'url', url } })), { type: 'text', text }] }],
  });
  if (response.stop_reason === 'refusal') throw new Error('The AI declined to describe these photos.');
  return response.parsed_output || null;
}

// ---- OpenAI-compatible chat completions -----------------------------------

// Photos go along inline, so services that cannot fetch URLs (such as a
// model on the seller's own computer) see them too.
async function asDataUrl(url, fetchImpl) {
  try {
    const blob = await (await fetchImpl(url)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${blob.type || 'image/jpeg'};base64,${btoa(bin)}`;
  } catch {
    return url;
  }
}

function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = t.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

async function chatJson(c, { images = [], text, schema, maxTokens, fetchImpl = fetch, relay }) {
  const content = [...await Promise.all(images.map(async (url) => ({ type: 'image_url', image_url: { url: await asDataUrl(url, fetchImpl) } }))), { type: 'text', text }];
  const messages = [
    { role: 'system', content: `${SYSTEM}\nAnswer with only a JSON object that matches this JSON schema:\n${JSON.stringify(schema)}` },
    { role: 'user', content },
  ];
  const ask = (format) => aiRequest(c, 'chat/completions', { model: c.model, max_tokens: maxTokens, messages, ...(format ? { response_format: format } : {}) }, { fetchImpl, relay });
  let res = await ask({ type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } });
  // Not every service supports a schema; the prompt carries it too.
  if (res.status === 400 || res.status === 422) res = await ask(null);
  if (res.status < 200 || res.status >= 300) throw aiError(res);
  let body = {};
  try { body = JSON.parse(res.text); } catch { /* checked below */ }
  const choice = body.choices?.[0];
  if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw new Error('The AI declined to describe these photos.');
  return parseJson(choice?.message?.content);
}

// ---- the listing ------------------------------------------------------------

// Only what the form can take: known category and condition, a sane price.
function clean(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const s = (v, n) => String(v ?? '').trim().slice(0, n);
  const price = Number(raw.price);
  return {
    title: s(raw.title, 120),
    description: s(raw.description, 5000),
    category: CATEGORIES.includes(raw.category) ? raw.category : '',
    condition: CONDITIONS.includes(raw.condition) ? raw.condition : 'good',
    price: Number.isFinite(price) && price > 0 ? price : 0,
    notes: s(raw.notes, 500),
  };
}

// images: https URLs (already uploaded to the photo server).
// config and fetchImpl are for tests; the app uses the stored connection.
export async function draftListing({ images, lang = 'en', currency = 'EUR', hint = '', config, fetchImpl, relay, tree }) {
  if (!images?.length) throw new Error('Add at least one photo first');
  const c = config ?? loadAi();
  if (!c || (c.anthropic && !c.key)) throw new Error('Connect your AI service under Account → AI listing assistant first');
  const ask = c.anthropic ? anthropicJson : chatJson;
  const language = lang === 'es' ? 'Spanish' : 'English';
  const out = clean(await ask(c, {
    images: images.slice(0, 8), schema: SCHEMA, maxTokens: 4000, fetchImpl, relay,
    text: `Write the listing in ${language}. Price in ${currency}.${hint ? `\nThe seller adds: ${hint}` : ''}`,
  }));
  if (!out?.title) throw new Error('The AI returned no usable listing. Try again.');
  out.subcategory = '';
  // Second, small text-only step: the subcategory, from that category's own list.
  const subs = tree?.get(out.category) || [];
  if (subs.length) {
    try {
      const pick = await ask(c, { schema: subcategorySchema(subs), maxTokens: 200, fetchImpl, relay, text: subcategoryPrompt(out, subs) });
      if (subs.some((x) => x[0] === pick?.subcategory)) out.subcategory = pick.subcategory;
    } catch { /* the seller picks it */ }
  }
  return out;
}
