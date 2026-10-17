// The AI listing draft: request shape and response handling, against a fake API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftListing } from '../src/lib/ai/listing.js';

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
  const res = await draftListing({ images: ['https://blossom.example/a.jpg', 'https://blossom.example/b.jpg'], lang: 'nl', apiKey: 'sk-ant-test', fetchImpl });
  assert.deepEqual(res, draft);
  const { url, headers, body } = seen[0];
  assert.match(url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.equal(headers['x-api-key'], 'sk-ant-test');
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.ok(body.output_config.format.schema.properties.category.enum.includes('huis-en-inrichting'));
  assert.deepEqual(body.messages[0].content.slice(0, 2).map((c) => c.source.url), ['https://blossom.example/a.jpg', 'https://blossom.example/b.jpg']);
  assert.match(body.messages[0].content[2].text, /Dutch/);
});

test('AI draft: refusals and missing photos or key give clear errors', async () => {
  await assert.rejects(draftListing({ images: ['https://x/a.jpg'], apiKey: 'sk-ant-test', fetchImpl: fakeApi({ stop_reason: 'refusal' }).fetchImpl }), /declined/);
  await assert.rejects(draftListing({ images: [], apiKey: 'k' }), /photo/);
  await assert.rejects(draftListing({ images: ['https://x/a.jpg'], apiKey: '' }), /API key/);
});
