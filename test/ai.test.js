// The AI listing draft: request shape and response handling, against a fake API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftListing, normalizeBase, validBase, listModels } from '../src/lib/ai/listing.js';

const ANT = { key: 'sk-ant-test', base: '', model: '', anthropic: true };

function fakeApi(reply) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: reply.stop_reason || 'end_turn', stop_sequence: null,
      content: reply.text != null ? [{ type: 'text', text: reply.text }] : [], usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { seen, fetchImpl };
}

test('AI draft: sends the photos and a JSON schema, returns the parsed listing', async () => {
  const draft = { title: 'IKEA Ranarp desk lamp, black', description: 'Works. Small scratch on the base.', category: 'huis-en-inrichting', condition: 'good', price: 15, notes: 'Add the cable length.' };
  const { seen, fetchImpl } = fakeApi({ text: JSON.stringify(draft) });
  const res = await draftListing({ images: ['https://blossom.example/a.jpg', 'https://blossom.example/b.jpg'], lang: 'es', config: ANT, fetchImpl });
  assert.deepEqual(res, { ...draft, subcategory: '' });
  const { url, headers, body } = seen[0];
  assert.match(url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.equal(headers['x-api-key'], 'sk-ant-test');
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.ok(body.output_config.format.schema.properties.category.enum.includes('huis-en-inrichting'));
  assert.deepEqual(body.messages[0].content.slice(0, 2).map((c) => c.source.url), ['https://blossom.example/a.jpg', 'https://blossom.example/b.jpg']);
  assert.match(body.messages[0].content[2].text, /Spanish/);
});

test('AI draft: refusals and missing photos or key give clear errors', async () => {
  await assert.rejects(draftListing({ images: ['https://x/a.jpg'], config: ANT, fetchImpl: fakeApi({ stop_reason: 'refusal' }).fetchImpl }), /declined/);
  await assert.rejects(draftListing({ images: [], config: ANT }), /photo/);
  await assert.rejects(draftListing({ images: ['https://x/a.jpg'], config: { ...ANT, key: '' } }), /Connect your AI service/);
});

test('AI draft: picks the subcategory from that category\'s own list', async () => {
  const draft = { title: 'Oak coffee table', description: 'Solid oak.', category: 'huis-en-inrichting', condition: 'good', price: 40, notes: '' };
  let n = 0;
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    const text = n++ === 0 ? JSON.stringify(draft) : JSON.stringify({ subcategory: 'tafels-salontafels' });
    return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const tree = new Map([['huis-en-inrichting', [['tafels-salontafels', 'Tafels | Salontafels', 'Tables | Coffee tables', 'Mesas | Mesas de centro'], ['banken-bankstellen', 'Banken | Bankstellen', 'Sofas', 'Sofás']]]]);
  const res = await draftListing({ images: ['https://x/a.jpg'], config: ANT, fetchImpl, tree });
  assert.equal(res.subcategory, 'tafels-salontafels');
  assert.deepEqual(seen[1].output_config.format.schema.properties.subcategory.enum, ['tafels-salontafels', 'banken-bankstellen']);
});

// Any OpenAI-compatible service: chat completions at the seller's own address.
function fakeChat(replies) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith('https://blossom.example/')) return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }));
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ url, headers: Object.fromEntries(new Headers(init.headers)), body });
    const r = replies.shift();
    if (r.status) return new Response('{}', { status: r.status });
    return new Response(JSON.stringify({ choices: [{ finish_reason: r.finish || 'stop', message: { content: r.text } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { seen, fetchImpl };
}
const OAI = { key: 'sk-other', base: 'https://ai.example/v1', model: 'vision-1', anthropic: false };

test('AI draft, OpenAI-compatible: photos inline, schema requested, answer cleaned', async () => {
  const draft = { title: 'Brass desk lamp', description: 'Works.', category: 'huis-en-inrichting', condition: 'like-new', price: 25, notes: '' };
  const { seen, fetchImpl } = fakeChat([{ text: '```json\n' + JSON.stringify(draft) + '\n```' }]);
  const res = await draftListing({ images: ['https://blossom.example/a.jpg'], config: OAI, fetchImpl });
  assert.deepEqual(res, { ...draft, subcategory: '' });
  const call = seen[0];
  assert.equal(call.url, 'https://ai.example/v1/chat/completions');
  assert.equal(call.headers.authorization, 'Bearer sk-other');
  assert.equal(call.body.model, 'vision-1');
  assert.equal(call.body.response_format.type, 'json_schema');
  assert.match(call.body.messages[1].content[0].image_url.url, /^data:image\/jpeg;base64,/);
});

test('AI draft, OpenAI-compatible: retries without a schema, keeps only valid values, clear errors', async () => {
  const { seen, fetchImpl } = fakeChat([{ status: 400 }, { text: JSON.stringify({ title: 'Lamp', description: 'x', category: 'made-up', condition: 'mint', price: 'abc', notes: '' }) }]);
  const res = await draftListing({ images: ['https://blossom.example/a.jpg'], config: OAI, fetchImpl });
  assert.equal(seen[1].body.response_format, undefined);
  assert.deepEqual([res.category, res.condition, res.price], ['', 'good', 0]);
  await assert.rejects(draftListing({ images: ['https://blossom.example/a.jpg'], config: OAI, fetchImpl: fakeChat([{ status: 401 }]).fetchImpl }), /did not accept the API key/);
  await assert.rejects(draftListing({ images: ['https://blossom.example/a.jpg'], config: OAI, fetchImpl: fakeChat([{ finish: 'content_filter', text: '' }]).fetchImpl }), /declined/);
});

test('AI service address: normalized, https only (or this computer), models listed', async () => {
  assert.equal(normalizeBase(' https://ai.example/v1/chat/completions/ '), 'https://ai.example/v1');
  assert.ok(validBase('https://ai.example/v1'));
  assert.ok(validBase('http://localhost:11434/v1'));
  assert.ok(!validBase('http://ai.example/v1'));
  assert.ok(!validBase('not a url'));
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }), { status: 200 });
  assert.deepEqual(await listModels({ base: 'https://ai.example/v1', key: 'k', fetchImpl }), ['a', 'b']);
});
