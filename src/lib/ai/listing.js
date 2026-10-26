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

// The models an OpenAI-compatible service offers (to pick one). Free to call.
export async function listModels({ base, key, fetchImpl = fetch }) {
  if (!validBase(base)) throw new Error('Enter the API address first');
  let res;
  try {
    res = await fetchImpl(`${normalizeBase(base)}/models`, { headers: key ? { authorization: `Bearer ${key.trim()}` } : {} });
  } catch {
    throw new Error('No answer from that address. Check it, and that the service accepts requests from websites.');
  }
  if (res.status === 401 || res.status === 403) throw new Error('The service did not accept the API key');
  if (!res.ok) throw new Error(`The service answered with error ${res.status}`);
  const body = await res.json().catch(() => ({}));
  const ids = (body.data || body.models || []).map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  return [...new Set(ids)].sort();
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

async function chatJson(c, { images = [], text, schema, maxTokens, fetchImpl = fetch }) {
  const content = [...await Promise.all(images.map(async (url) => ({ type: 'image_url', image_url: { url: await asDataUrl(url, fetchImpl) } }))), { type: 'text', text }];
  const messages = [
    { role: 'system', content: `${SYSTEM}\nAnswer with only a JSON object that matches this JSON schema:\n${JSON.stringify(schema)}` },
    { role: 'user', content },
  ];
  const call = (format) => fetchImpl(`${c.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(c.key ? { authorization: `Bearer ${c.key}` } : {}) },
    body: JSON.stringify({ model: c.model, max_tokens: maxTokens, messages, ...(format ? { response_format: format } : {}) }),
  });
  let res;
  try {
    res = await call({ type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } });
    // Not every service supports a schema; the prompt carries it too.
    if (res.status === 400 || res.status === 422) res = await call(null);
  } catch {
    throw new Error('No answer from your AI service. Check the address under Account → AI listing assistant.');
  }
  if (res.status === 401 || res.status === 403) throw new Error('Your AI service did not accept the API key.');
  if (!res.ok) throw new Error(`Your AI service answered with error ${res.status}. Check the model under Account → AI listing assistant.`);
  const body = await res.json();
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
export async function draftListing({ images, lang = 'en', currency = 'EUR', hint = '', config, fetchImpl, tree }) {
  if (!images?.length) throw new Error('Add at least one photo first');
  const c = config ?? loadAi();
  if (!c || (c.anthropic && !c.key)) throw new Error('Connect your AI service under Account → AI listing assistant first');
  const ask = c.anthropic ? anthropicJson : chatJson;
  const language = lang === 'es' ? 'Spanish' : 'English';
  const out = clean(await ask(c, {
    images: images.slice(0, 8), schema: SCHEMA, maxTokens: 4000, fetchImpl,
    text: `Write the listing in ${language}. Price in ${currency}.${hint ? `\nThe seller adds: ${hint}` : ''}`,
  }));
  if (!out?.title) throw new Error('The AI returned no usable listing. Try again.');
  out.subcategory = '';
  // Second, small text-only step: the subcategory, from that category's own list.
  const subs = tree?.get(out.category) || [];
  if (subs.length) {
    try {
      const pick = await ask(c, { schema: subcategorySchema(subs), maxTokens: 200, fetchImpl, text: subcategoryPrompt(out, subs) });
      if (subs.some((x) => x[0] === pick?.subcategory)) out.subcategory = pick.subcategory;
    } catch { /* the seller picks it */ }
  }
  return out;
}
