// Draft a listing from its photos with Claude, using the seller's own API key.
// The key is stored encrypted (secrets.js) and sent only to api.anthropic.com,
// straight from this browser. The SDK is loaded on first use, so the app stays
// small for everyone who does not use this.

import { CATEGORIES, CONDITIONS } from '../nostr/listings.js';
import { getSecret, setSecret, hasSecret } from '../secrets.js';
import { AI_MODEL } from '../../config.js';

const NAME = 'anthropic';

export const aiConfigured = () => hasSecret(NAME);
export const saveAiKey = (key) => setSecret(NAME, key ? key.trim() : null);

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

async function client(apiKey, fetchImpl) {
  if (!apiKey) throw new Error('Add your Anthropic API key under Account → AI first');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // The key belongs to the user and is only used from their own browser.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

// images: https URLs (already uploaded to the photo server).
// apiKey and fetchImpl are for tests; the app uses the stored key.
export async function draftListing({ images, lang = 'en', currency = 'EUR', hint = '', apiKey, fetchImpl }) {
  if (!images?.length) throw new Error('Add at least one photo first');
  const { jsonSchemaOutputFormat } = await import('@anthropic-ai/sdk/helpers/json-schema');
  const anthropic = await client(apiKey ?? getSecret(NAME), fetchImpl);
  const language = lang === 'nl' ? 'Dutch' : 'English';
  const response = await anthropic.beta.messages.parse({
    model: AI_MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // transform: false keeps the enums as real constraints (the API supports them).
    output_config: { effort: 'low', format: jsonSchemaOutputFormat(SCHEMA, { transform: false }) },
    system: 'You write listings for a second-hand marketplace like Marktplaats or Vinted. Describe only what the photos show or the seller states; never invent brands, sizes or specs. Mention visible wear. Plain text, no emoji, no hype.',
    messages: [{
      role: 'user',
      content: [
        ...images.slice(0, 8).map((url) => ({ type: 'image', source: { type: 'url', url } })),
        { type: 'text', text: `Write the listing in ${language}. Price in ${currency}.${hint ? `\nThe seller adds: ${hint}` : ''}` },
      ],
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error('The AI declined to describe these photos.');
  if (!response.parsed_output) throw new Error('The AI returned no usable listing. Try again.');
  return response.parsed_output;
}
