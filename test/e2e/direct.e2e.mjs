// End-to-end test of a direct Lightning purchase through the real UI, with the
// mock NWC wallets (no node needed): both connect a wallet, the seller lists
// with carriers (no shipping price), the buyer orders from the chat with
// Lightning and picks PostNL at its live rate, the seller's wallet makes the
// invoice, the buyer's wallet pays it, the buyer sends the address, the seller
// buys a prepaid label (paid over Lightning, QR code in the chat), ships, the
// buyer confirms, and both reviews become "verified". Then an on-chain
// purchase where the buyer switches from Lightning to on-chain first.
// Needs: npm run relay, npm run wallets, npm run sendcloud, npm run service:dev,
// and a build with VITE_API_URL=http://127.0.0.1:8787 (npm run preview).
// Browser: Firefox by default (FIREFOX=…), or Chromium with CHROME=/path/to/chrome.
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync } from 'node:fs';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { sha256 } from '@noble/hashes/sha2.js';
import { execSync } from 'node:child_process';
import { proof, setupPage, settle } from './proof.mjs';

const APP = process.env.APP_URL || 'http://127.0.0.1:4173/';
const RELAY = process.env.RELAY || 'ws://127.0.0.1:7777';
const SHOTS = process.env.SHOTS;
const hex = (b) => Buffer.from(b).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`\n== ${s}`);
const walletKey = (n) => sha256(new TextEncoder().encode(`xbt-mock-wallet/${n}`));
const walletUri = (n) => `nostr+walletconnect://${getPublicKey(walletKey(n))}?relay=${encodeURIComponent(RELAY)}&secret=${hex(walletKey(`${n}/client`))}`;

const people = {};
for (const who of ['seller', 'buyer']) { const sk = generateSecretKey(); people[who] = { sk: hex(sk), pk: getPublicKey(sk), name: who === 'seller' ? 'Sam Seller' : 'Bob Buyer', city: who === 'seller' ? 'Utrecht' : 'Amsterdam' }; }

const chrome = process.env.CHROME;
const browser = await puppeteer.launch({
  browser: chrome ? 'chrome' : 'firefox', executablePath: chrome || process.env.FIREFOX || '/usr/bin/firefox', headless: true, protocolTimeout: 45000,
  ...(chrome ? { args: ['--no-sandbox'] } : {
    userDataDir: (() => { const d = (process.env.PROFILE_DIR || process.env.HOME + '/snap/firefox/common') + '/xbt-direct'; rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; })(),
  }),
});

let current = null;
const lastHash = {};
async function as(who) {
  if (current?.who === who) return current;
  if (current) {
    lastHash[current.who] = await current.evaluate(() => location.hash);
    await current.browserContext().close();
  }
  current = await open(who);
  if (lastHash[who]) await current.evaluate((h) => { location.hash = h; }, lastHash[who]);
  return current;
}

// Each role keeps its localStorage (account, encrypted wallet link) between contexts.
const storage = {};
async function open(who) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await setupPage(page);
  page.on('pageerror', (e) => { if (!/establish a connection/.test(e.message)) console.log(`[${who} pageerror]`, e.message); });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${who} console]`, m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate((p, saved, relay) => {
    if (saved) { for (const [k, v] of Object.entries(saved)) localStorage.setItem(k, v); return; }
    localStorage.setItem('xbt:account', JSON.stringify({ pubkey: p.pk, sk: p.sk, backedUp: true }));
    localStorage.setItem('xbt:settings', JSON.stringify({
      relays: [relay], network: 'regtest', lang: 'en', manualRate: { value: 50000, currency: 'EUR' }, currency: 'EUR', country: 'NL',
      address: { name: p.name, street: 'Kerkstraat', number: '1', postalCode: '1234AB', city: p.city, country: 'NL', email: 'test@example.com' },
    }));
  }, people[who], storage[who], RELAY);
  await page.reload({ waitUntil: 'load' });
  page.who = who;
  const close = page.browserContext().close.bind(page.browserContext());
  page.browserContext().close = async () => { storage[who] = await page.evaluate(() => ({ ...localStorage })); return close(); };
  return page;
}

const go = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);
const text = (page) => page.evaluate(() => document.querySelector('main')?.innerText || '');
async function waitText(page, t, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if ((await text(page)).includes(t)) return; await sleep(400); }
  throw new Error(`[${page.who}] timed out waiting for "${t}". Page:\n${(await text(page)).slice(0, 1500)}`);
}
async function waitNoText(page, t, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (!(await text(page)).includes(t)) return; await sleep(400); }
  throw new Error(`[${page.who}] "${t}" did not go away`);
}
async function click(page, label) {
  console.log(`  [${page.who}] click ${label}`);
  const el = await page.waitForSelector(`::-p-xpath(//button[normalize-space(.)="${label}"] | //a[normalize-space(.)="${label}"])`, { timeout: 30000 });
  await settle(el);
  await el.click();
}
async function fill(page, labelText, value) {
  const el = await page.waitForSelector(`::-p-xpath(//label[span[@class="label" and normalize-space(.)="${labelText}"]]//*[self::input or self::textarea][1])`, { timeout: 15000 });
  await settle(el);
  await el.click({ count: 3 });
  await el.type(value);
}
async function fillPh(page, ph, value) {
  const el = await page.waitForSelector(`::-p-xpath(//*[(self::input or self::textarea) and @placeholder="${ph}"])`, { timeout: 15000 });
  await settle(el);
  await el.click({ count: 3 });
  await el.type(value);
}
async function clickIn(page, scope, label) {
  console.log(`  [${page.who}] click ${label} in ${scope}`);
  const el = await page.waitForSelector(`::-p-xpath(//*[contains(concat(" ",@class," ")," ${scope} ")]//button[normalize-space(.)="${label}"])`, { timeout: 30000 });
  await settle(el);
  await el.click();
}
async function pickSubcategory(page) {
  const sel = await page.waitForSelector('select[aria-label="Subcategory"]:not([disabled])', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('select[aria-label="Subcategory"]').options.length > 1, { timeout: 15000 });
  await sel.select(await sel.evaluate((e) => e.options[1].value));
}
async function choose(page, labelStart) {
  console.log(`  [${page.who}] choose ${labelStart}`);
  const el = await page.waitForSelector(`::-p-xpath(//label[contains(@class,"choice")][starts-with(normalize-space(.),"${labelStart}")])`, { timeout: 15000 });
  await settle(el);
  await el.click();
}
const shot = (page, caption, opts) => proof(page, 'direct', caption, opts);
const CLI = process.env.KNOTS_CLI;
const cli = (...a) => execSync(`${CLI} ${a.map((x) => `'${x}'`).join(' ')}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

try {
  for (const who of ['seller', 'buyer']) {
    step(`${who} connects a Lightning wallet`);
    await go(await as(who), '#/settings?open=lightning');
    await fillPh(await as(who), 'nostr+walletconnect://…', walletUri(who));
    await click(await as(who), 'Connect');
    await waitText(await as(who), '✓ Connected', 30000);
    await click(await as(who), 'Balance');
    await waitText(await as(who), 'sats', 30000);
    await shot(await as(who), `${who === 'seller' ? 'Verkoper' : 'Koper'}: Lightning-wallet gekoppeld via Nostr Wallet Connect, saldo opgehaald uit de wallet`);
  }

  step('seller lists: carriers without a price, Lightning and on-chain');
  await go(await as('seller'), '#/sell/new');
  await fill(await as('seller'), 'Title', 'Desk lamp, brass');
  await fill(await as('seller'), 'Description', 'Works fine.');
  await pickSubcategory(await as('seller'));
  await fill(await as('seller'), 'Price', '20');
  await choose(await as('seller'), 'On-chain');
  await shot(await as('seller'), 'Verkoper: vervoerders aanvinken zonder prijs (ook goedkope internationale), pakketgrootte, verzendgebied; Lightning en on-chain aan, escrow uit');
  await click(await as('seller'), 'Publish');
  await waitText(await as('seller'), 'Desk lamp, brass');

  step('buyer orders from the chat, paying over Lightning, PostNL at its live rate');
  await go(await as('buyer'), '#/');
  await waitText(await as('buyer'), 'Desk lamp');
  await (await (await as('buyer')).waitForSelector('a.listing-card')).click();
  await waitText(await as('buyer'), 'Lightning');
  await shot(await as('buyer'), 'Koper: advertentie toont vervoerders, verzendgebied en betaalmethodes; knoppen "Bericht" en "Bestellen"');
  await click(await as('buyer'), '🛒 Order now');
  await (await as('buyer')).waitForFunction(() => location.hash.startsWith('#/trade/'), { timeout: 20000 });
  const tid = await (await as('buyer')).evaluate(() => location.hash.split('/')[2]);
  await waitText(await as('buyer'), '€6.95', 30000); // PostNL NL→NL, size M, from the Sendcloud mock
  await choose(await as('buyer'), 'PostNL');
  await choose(await as('buyer'), '⚡ Lightning');
  await shot(await as('buyer'), 'Koper: bestellen in de chat: Lightning, PostNL met live prijs, totaal = prijs + verzending');
  await shot(await as('buyer'), 'Koper: hetzelfde bestelformulier op een telefoon', { mobile: true });
  await click(await as('buyer'), 'Send order');
  await waitText(await as('buyer'), 'Waiting for the seller to accept');

  step('seller accepts and sends an invoice from their wallet');
  await go(await as('seller'), `#/trade/${tid}`);
  await waitText(await as('seller'), 'Order from');
  await shot(await as('seller'), 'Verkoper: bestelling met betaalwijze, vervoerder, land en prijs');
  await click(await as('seller'), '✓ Accept');
  await waitText(await as('seller'), 'Send a payment request');
  await click(await as('seller'), 'Create invoice with my wallet');
  await waitText(await as('seller'), 'Payment request:', 60000);
  await waitText(await as('seller'), 'I received the payment'); // request sent before closing this browser

  step('buyer sends the address and pays with their wallet');
  await waitText(await as('buyer'), 'A few details for the seller', 30000);
  await waitText(await as('buyer'), 'Delivery address');
  await clickIn(await as('buyer'), 'details-form', 'Send details');
  await waitNoText(await as('buyer'), 'A few details for the seller');
  await waitText(await as('buyer'), 'Pay with my wallet', 30000);
  await shot(await as('buyer'), 'Koper: betaalverzoek in de chat met QR-code, factuur, netwerk (lnbcrt) en "Betaal met mijn wallet"');
  await click(await as('buyer'), '⚡ Pay with my wallet');
  await waitText(await as('buyer'), 'Paid. The Lightning preimage proves it.', 60000);
  await waitText(await as('buyer'), 'The seller ships by');

  step('seller buys a prepaid label over Lightning and gets a QR code');
  await waitText(await as('seller'), 'Paid. The Lightning preimage proves it.', 30000);
  await waitText(await as('seller'), 'Bob Buyer');
  await waitText(await as('seller'), 'Paid. Ship by');
  await click(await as('seller'), 'Get the label price');
  await waitText(await as('seller'), 'Buy label');
  await click(await as('seller'), 'Buy label €6.95');
  await click(await as('seller'), '⚡ Pay with my wallet');
  await waitText(await as('seller'), 'Show this QR code', 60000);
  const qrOk = await (await as('seller')).waitForFunction(() => { const i = document.querySelector('img.label-qr'); return i && i.complete && i.naturalWidth > 0; }, { timeout: 20000 }).then(() => true, () => false);
  if (!qrOk) throw new Error('the label QR code did not load');
  await shot(await as('seller'), 'Verkoper: verzendlabel betaald via Lightning; QR-code voor het PostNL-punt, label als PDF en trackingcode in de chat');
  const tracking = await (await as('seller')).$eval('.label-card code', (e) => e.textContent.trim());
  await click(await as('seller'), 'Mark as shipped');
  await waitText(await as('seller'), 'Shipped with PostNL');
  const track = await (await as('seller')).$eval('a.btn.small[target=_blank]', (a) => a.href);
  if (!track.startsWith(`https://postnl.nl/tracktrace/?B=${tracking}`)) throw new Error('unexpected tracking link ' + track);

  step('buyer confirms receipt and both review');
  await waitText(await as('buyer'), 'Shipped with PostNL', 30000);
  await waitText(await as('buyer'), 'Track');
  await shot(await as('buyer'), 'Koper: verzonden met PostNL, trackingcode van het label met Volgen-knop');
  await click(await as('buyer'), 'Yes, received');
  await waitText(await as('buyer'), 'Leave a review', 30000);
  await click(await as('buyer'), 'Publish review');
  await waitNoText(await as('buyer'), 'Leave a review');
  await waitText(await as('seller'), 'Leave a review', 30000);
  await click(await as('seller'), 'Publish review');
  await waitNoText(await as('seller'), 'Leave a review');
  await sleep(1500);
  await go(await as('buyer'), `#/u/${people.seller.pk}`);
  await waitText(await as('buyer'), '1 verified trades', 20000);
  await shot(await as('buyer'), 'Profiel verkoper: de Lightning-aankoop telt als geverifieerde trade');
  await go(await as('buyer'), `#/trade/${tid}`);
  await waitText(await as('buyer'), 'Received');
  await shot(await as('buyer'), 'Koper: chat met de stappen als tijdlijn (bestelling, geaccepteerd, betaalverzoek, betaald, label, verzonden, ontvangen)');

  if (CLI) {
    step('on-chain purchase: the buyer asks to switch from Lightning to on-chain');
    await go(await as('seller'), '#/sell/new');
    await fill(await as('seller'), 'Title', 'Bike lights set');
    await pickSubcategory(await as('seller'));
    await fill(await as('seller'), 'Price', '15');
    await choose(await as('seller'), 'On-chain');
    await click(await as('seller'), 'Publish');
    await waitText(await as('seller'), 'Bike lights set');
    await go(await as('buyer'), '#/?q=bike');
    await (await as('buyer')).reload({ waitUntil: 'load' });
    await waitText(await as('buyer'), 'Bike lights set');
    await (await (await as('buyer')).waitForSelector('a.listing-card')).click();
    await click(await as('buyer'), '🛒 Order now');
    await (await as('buyer')).waitForFunction((t) => location.hash.startsWith('#/trade/') && !location.hash.includes(t), { timeout: 20000 }, tid);
    const tid2 = await (await as('buyer')).evaluate(() => location.hash.split('/')[2]);
    await choose(await as('buyer'), '🤝 Pick up');
    await click(await as('buyer'), 'Send order');
    await waitText(await as('buyer'), 'Waiting for the seller to accept');
    await click(await as('buyer'), '🔁 Change payment method');
    await choose(await as('buyer'), 'On-chain');
    await click(await as('buyer'), 'Ask');
    await waitText(await as('buyer'), 'Waiting for an answer');
    await go(await as('seller'), `#/trade/${tid2}`);
    await waitText(await as('seller'), 'asks to pay with', 30000);
    await shot(await as('seller'), 'Verkoper: de koper vraagt om van Lightning naar on-chain te wisselen; akkoord of weigeren');
    await click(await as('seller'), '✓ Agree');
    await waitText(await as('seller'), 'Payment method changed');
    await click(await as('seller'), '✓ Accept');
    const sellerAddr = cli('getnewaddress', 'direct-seller', 'bech32');
    await fill(await as('seller'), 'Your XBT address', sellerAddr);
    await click(await as('seller'), 'Request 0.0003 XBT');
    await waitText(await as('seller'), 'I received the payment');
    await waitText(await as('buyer'), 'Payment request:', 30000);
    await shot(await as('buyer'), 'Koper: na de wissel een on-chain betaalverzoek met adres en QR-code');
    const txid = cli('sendtoaddress', sellerAddr, '0.0003');
    cli('generatetoaddress', '1', cli('getnewaddress'));
    await fillPh(await as('buyer'), 'Payment txid', txid);
    await click(await as('buyer'), 'I paid');
    await waitText(await as('buyer'), '1 confirmations', 30000);
    await waitText(await as('seller'), 'The buyer reports a payment', 30000);
    await click(await as('seller'), 'I received the payment');
    await waitText(await as('seller'), 'The seller confirmed receiving the payment');
    await shot(await as('seller'), 'Verkoper: on-chain betaling gecontroleerd en bevestigd, klaar voor de overdracht');
  } else {
    console.log('(skipping the on-chain part: set KNOTS_CLI to run it against a regtest node)');
  }

  console.log('\nDIRECT E2E PASSED');
} catch (e) {
  console.error('\nDIRECT E2E FAILED:', e.message);
  process.exitCode = 1;
  if (current && SHOTS) await current.screenshot({ path: `${SHOTS}/direct-failure.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}
