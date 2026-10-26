// Browser checks for the parts the trade tests do not cover: the blockchain
// server picker, encrypted secrets, the escrow advice above €50 and the AI
// listing assistant (against an intercepted, fake api.anthropic.com).
// Needs: npm run relay, npm run shim (regtest node), npm run wallets,
// npm run build && npm run preview. Browser as in the other e2e tests.
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync } from 'node:fs';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { Relay } from 'nostr-tools/relay';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { proof, setupPage, settle, fakeAnthropic } from './proof.mjs';

const APP = process.env.APP_URL || 'http://127.0.0.1:4173/';
const RELAY = process.env.RELAY || 'ws://127.0.0.1:7777';
const hex = (b) => Buffer.from(b).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`\n== ${s}`);
const shot = (page, caption, opts) => proof(page, 'extras', caption, opts);
const walletKey = (n) => sha256(new TextEncoder().encode(`xbt-mock-wallet/${n}`));
const walletUri = (n) => `nostr+walletconnect://${getPublicKey(walletKey(n))}?relay=${encodeURIComponent(RELAY)}&secret=${hex(walletKey(`${n}/client`))}`;

const chrome = process.env.CHROME;
const browser = await puppeteer.launch({
  browser: chrome ? 'chrome' : 'firefox', executablePath: chrome || process.env.FIREFOX || '/usr/bin/firefox', headless: true, protocolTimeout: 45000,
  ...(chrome ? { args: ['--no-sandbox'] } : {
    userDataDir: (() => { const d = (process.env.PROFILE_DIR || process.env.HOME + '/snap/firefox/common') + '/xbt-extras'; rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; })(),
  }),
});

const sk = generateSecretKey();
const me = { sk: hex(sk), pk: getPublicKey(sk) };
const page = await (await browser.createBrowserContext()).newPage();
page.who = 'seller';
page.on('pageerror', (e) => { if (!/establish a connection/.test(e.message)) console.log('[pageerror]', e.message); });
page.on('dialog', (d) => d.accept());
await setupPage(page);

const DRAFT = { title: 'Messing bureaulamp, jaren 70', description: 'Werkende bureaulamp van messing met verstelbare arm. Lichte gebruikssporen op de voet, kap zonder deuken. Inclusief snoer met schakelaar.', category: 'huis-en-inrichting', condition: 'good', price: 35, notes: 'Meet de hoogte van de lamp en vermeld die in de beschrijving.' };

const text = () => page.evaluate(() => document.querySelector('main')?.innerText || '');
async function waitText(t, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if ((await text()).includes(t)) return; await sleep(300); }
  throw new Error(`timed out waiting for "${t}". Page:\n${(await text()).slice(0, 1500)}`);
}
async function click(label) {
  console.log(`  click ${label}`);
  const el = await page.waitForSelector(`::-p-xpath(//button[normalize-space(.)="${label}"] | //a[normalize-space(.)="${label}"])`, { timeout: 30000 });
  await settle(el);
  await el.click();
}
async function fill(labelText, value) {
  const el = await page.waitForSelector(`::-p-xpath(//label[span[@class="label" and normalize-space(.)="${labelText}"]]//*[self::input or self::textarea][1])`, { timeout: 15000 });
  await settle(el);
  await el.click({ count: 3 });
  await el.type(value);
}
async function fillPh(ph, value) {
  const el = await page.waitForSelector(`::-p-xpath(//*[(self::input or self::textarea) and @placeholder="${ph}"])`, { timeout: 15000 });
  await settle(el);
  await el.click({ count: 3 });
  await el.type(value);
}
async function choose(labelStart) {
  const el = await page.waitForSelector(`::-p-xpath(//label[contains(@class,"choice")][starts-with(normalize-space(.),"${labelStart}")])`, { timeout: 15000 });
  await settle(el);
  await el.click();
}
const scrollTo = (t) => page.evaluate((t) => [...document.querySelectorAll('h3,h2')].find((h) => h.textContent.includes(t))?.scrollIntoView({ block: 'start' }), t);

try {
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate((p, relay) => {
    localStorage.setItem('xbt:account', JSON.stringify({ pubkey: p.pk, sk: p.sk, backedUp: true }));
    localStorage.setItem('xbt:settings', JSON.stringify({ relays: [relay], network: 'regtest', lang: 'en', manualRate: { value: 50000, currency: 'EUR' }, currency: 'EUR', country: 'NL', blossom: 'http://127.0.0.1:3008' }));
  }, me, RELAY);
  await page.reload({ waitUntil: 'load' });

  step('blockchain server: known server and own node');
  await page.evaluate(() => { location.hash = '#/settings?open=network,lightning,ai'; });
  await waitText('Blockchain server');
  await choose('Local (npm run shim)');
  await click('Test connection');
  await waitText('✓ block');
  await scrollTo('Network');
  await shot(page, 'Instellingen: blockchain-server gekozen uit de lijst; "Verbinding testen" haalt de blokhoogte op bij de node', { fullPage: false });
  await fillPh('https://mempool-xxxx.local', 'http://127.0.0.1:9');
  await click('Use');
  await waitText('✗ Could not reach it. Open http://127.0.0.1:9/api/blocks/tip/height in this browser');
  await scrollTo('Network');
  await shot(page, 'Instellingen: een eigen node die niet bereikbaar is geeft een duidelijke fout', { fullPage: false });
  await choose('Local (npm run shim)');

  step('wallet and AI key are stored encrypted');
  await fillPh('nostr+walletconnect://…', walletUri('seller'));
  await click('Connect');
  await waitText('✓ Connected', 30000);
  await fill('API key', 'sk-ant-test-key-123');
  await waitText('Recognised: everything else is filled in for you');
  await click('Connect AI service');
  await waitText('default model · api.anthropic.com');
  const stored = await page.evaluate((pk) => localStorage.getItem(`xbt:secrets:${pk}`), me.pk);
  if (!stored || stored.includes('walletconnect') || stored.includes('sk-ant-test')) throw new Error('secrets are not encrypted: ' + stored);
  console.log('  stored secrets (encrypted):', stored.slice(0, 90) + '…');
  await scrollTo('Lightning wallet');
  await shot(page, 'Instellingen: Lightning-wallet gekoppeld en AI-sleutel opgeslagen. Gecontroleerd: in de browseropslag staan alleen versleutelde gegevens, niet de koppelcode of de sleutel', { fullPage: false });

  step('AI assistant fills in a listing from photos');
  await page.evaluate(() => { location.hash = '#/sell/new'; });
  await waitText('Write listing from photos');
  if (await page.$('::-p-xpath(//input[contains(@placeholder,"image URL")])')) throw new Error('adding a photo by URL should be gone');
  const file = await page.waitForSelector('label.photo.add input[type=file]');
  await file.uploadFile(new URL('../../public/icon-512.png', import.meta.url).pathname);
  await page.waitForSelector('.photo img', { timeout: 30000 });
  await fakeAnthropic(page, DRAFT);
  await click('✨ Write listing from photos');
  // The confirmation is a toast outside <main>; wait for the filled-in title instead.
  await page.waitForFunction(() => [...document.querySelectorAll('label.field')].find((l) => l.querySelector('.label')?.textContent === 'Title')?.querySelector('input')?.value, { timeout: 30000 })
    .catch(async () => { throw new Error(`no draft. Toasts: ${await page.evaluate(() => document.querySelector('.toasts')?.innerText)}`); });
  const aiCalls = await page.evaluate(() => window.__aiCalls);
  const title = await page.$eval('::-p-xpath(//label[span[normalize-space(.)="Title"]]//input)', (e) => e.value);
  if (title !== 'Messing bureaulamp, jaren 70') throw new Error('title not filled: ' + title);
  const call = aiCalls[0];
  if (!call || call.headers['x-api-key'] !== 'sk-ant-test-key-123' || call.body.messages[0].content[0].type !== 'image') throw new Error('unexpected AI request');
  if (!call.body.output_config.format.schema.properties.category.enum) throw new Error('category is not constrained');
  console.log('  AI request: model', call.body.model, '| photos', call.body.messages[0].content.filter((c) => c.type === 'image').length, '| key sent only to api.anthropic.com');
  await shot(page, 'Verkoper: na "Schrijf advertentie op basis van foto\'s" zijn titel, beschrijving, categorie, staat en prijs ingevuld, met een tip (AI-antwoord van een nep-server; de echte API is niet aangeroepen)');

  step('escrow advice above €50');
  // Escrow needs an arbiter the seller trusts: one announces itself on the relay.
  const arbSk = generateSecretKey();
  const relay = await Relay.connect(RELAY);
  await relay.publish(finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'xbt-market/arbiter'], ['t', 'xbt-market']], content: JSON.stringify({ escrowBase: hex(secp256k1.getPublicKey(generateSecretKey(), true)), name: 'Extra Arbiter', feePct: 0, active: true, v: 2 }) }, arbSk));
  relay.close();
  await page.evaluate((pk) => { const s = JSON.parse(localStorage.getItem('xbt:settings') || '{}'); s.trustedArbiters = [pk]; localStorage.setItem('xbt:settings', JSON.stringify(s)); }, getPublicKey(arbSk));
  await page.reload({ waitUntil: 'load' });
  await page.evaluate(() => { location.hash = '#/sell/new'; });
  await fill('Title', 'Ledger Nano X');
  const sub = await page.waitForSelector('select[aria-label="Subcategory"]:not([disabled])');
  await page.waitForFunction(() => document.querySelector('select[aria-label="Subcategory"]').options.length > 1);
  await sub.select(await sub.evaluate((e) => e.options[1].value));
  await fill('Price', '80');
  await choose('🛡 Escrow');
  await click('Publish');
  await waitText('Ledger Nano X');
  // A second account looks at the listing.
  const sk2 = generateSecretKey();
  await page.evaluate((p) => { localStorage.setItem('xbt:account', JSON.stringify({ pubkey: p.pk, sk: p.sk, backedUp: true })); }, { sk: hex(sk2), pk: getPublicKey(sk2) });
  page.who = 'buyer';
  await page.evaluate(() => { location.hash = '#/'; });
  await page.reload({ waitUntil: 'load' });
  await waitText('Ledger Nano X');
  await (await page.waitForSelector('a.listing-card')).click();
  await click('🛒 Order now');
  await waitText('recommended');
  await page.waitForFunction(() => [...document.querySelectorAll('label.choice')].find((l) => l.textContent.includes('Escrow (buyer'))?.querySelector('input').checked, { timeout: 5000 })
    .catch(() => { throw new Error('escrow not preselected above €50'); });
  await shot(page, 'Koper: boven €50 is "Met escrow" voorgeselecteerd en gemarkeerd als aanbevolen');
  await choose('⚡ Lightning');
  await waitText('we recommend escrow');
  await shot(page, 'Koper: wie boven €50 toch direct kiest, krijgt een waarschuwing');

  console.log('\nEXTRAS E2E PASSED');
} catch (e) {
  console.error('\nEXTRAS E2E FAILED:', e.message);
  process.exitCode = 1;
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/extras-failure.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}
