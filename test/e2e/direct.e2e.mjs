// End-to-end test of a direct Lightning purchase through the real UI, with the
// mock NWC wallets (no node needed): both connect a wallet, the seller lists
// with delivery options, the buyer orders "Direct, Lightning", the seller's
// wallet makes the invoice, the buyer's wallet pays it, the seller ships with
// a tracking code, the buyer confirms, and both reviews become "verified".
// Needs: npm run relay, npm run wallets, npm run build && npm run preview.
// Browser: Firefox by default (FIREFOX=…), or Chromium with CHROME=/path/to/chrome.
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync } from 'node:fs';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { sha256 } from '@noble/hashes/sha2.js';
import { execSync } from 'node:child_process';
import { proof } from './proof.mjs';

const APP = process.env.APP_URL || 'http://127.0.0.1:4173/';
const RELAY = process.env.RELAY || 'ws://127.0.0.1:7777';
const SHOTS = process.env.SHOTS;
const hex = (b) => Buffer.from(b).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`\n== ${s}`);
const walletKey = (n) => sha256(new TextEncoder().encode(`xbt-mock-wallet/${n}`));
const walletUri = (n) => `nostr+walletconnect://${getPublicKey(walletKey(n))}?relay=${encodeURIComponent(RELAY)}&secret=${hex(walletKey(`${n}/client`))}`;

const people = {};
for (const who of ['seller', 'buyer']) { const sk = generateSecretKey(); people[who] = { sk: hex(sk), pk: getPublicKey(sk) }; }

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
  page.on('pageerror', (e) => { if (!/establish a connection/.test(e.message)) console.log(`[${who} pageerror]`, e.message); });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${who} console]`, m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate((p, saved, relay) => {
    if (saved) { for (const [k, v] of Object.entries(saved)) localStorage.setItem(k, v); return; }
    localStorage.setItem('xbt:account', JSON.stringify({ pubkey: p.pk, sk: p.sk, backedUp: true }));
    localStorage.setItem('xbt:settings', JSON.stringify({ relays: [relay], network: 'regtest', lang: 'en', manualRate: { value: 50000, currency: 'EUR' }, currency: 'EUR' }));
  }, people[who], storage[who], RELAY);
  await page.reload({ waitUntil: 'load' });
  page.who = who;
  const close = page.browserContext().close.bind(page.browserContext());
  page.browserContext().close = async () => { storage[who] = await page.evaluate(() => ({ ...localStorage })); return close(); };
  return page;
}

const go = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);
const text = (page) => page.evaluate(() => document.querySelector('main').innerText);
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
  await el.click();
}
async function fill(page, labelText, value) {
  const el = await page.waitForSelector(`::-p-xpath(//label[span[@class="label" and normalize-space(.)="${labelText}"]]//*[self::input or self::textarea][1])`, { timeout: 15000 });
  await el.click({ count: 3 });
  await el.type(value);
}
async function fillPh(page, ph, value) {
  const el = await page.waitForSelector(`::-p-xpath(//*[(self::input or self::textarea) and @placeholder="${ph}"])`, { timeout: 15000 });
  await el.click({ count: 3 });
  await el.type(value);
}
async function choose(page, labelStart) {
  console.log(`  [${page.who}] choose ${labelStart}`);
  const el = await page.waitForSelector(`::-p-xpath(//label[contains(@class,"choice")][starts-with(normalize-space(.),"${labelStart}")])`, { timeout: 15000 });
  await el.click();
}
const shot = (page, caption, opts) => proof(page, 'direct', caption, opts);
const CLI = process.env.KNOTS_CLI;
const cli = (...a) => execSync(`${CLI} ${a.map((x) => `'${x}'`).join(' ')}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

try {
  for (const who of ['seller', 'buyer']) {
    step(`${who} connects a Lightning wallet`);
    await go(await as(who), '#/settings');
    await fillPh(await as(who), 'nostr+walletconnect://…', walletUri(who));
    await click(await as(who), 'Connect');
    await waitText(await as(who), '✓ Connected', 30000);
    await click(await as(who), 'Balance');
    await waitText(await as(who), 'sats', 30000);
    await shot(await as(who), `${who === 'seller' ? 'Verkoper' : 'Koper'}: Lightning-wallet gekoppeld via Nostr Wallet Connect, saldo opgehaald uit de wallet`);
  }

  step('seller lists with two delivery options');
  await go(await as('seller'), '#/sell/new');
  await fill(await as('seller'), 'Title', 'Desk lamp, brass');
  await fill(await as('seller'), 'Description', 'Works fine.');
  await fill(await as('seller'), 'Price', '20');
  await fillPh(await as('seller'), 'Price', '4.95');
  await click(await as('seller'), '+ Add option');
  await shot(await as('seller'), 'Verkoper: advertentieformulier met bezorgopties (PostNL €4,95, Ophalen) en de drie betaalmethodes');
  await click(await as('seller'), 'Publish');
  await waitText(await as('seller'), 'Desk lamp, brass');

  step('buyer orders, paying directly over Lightning');
  await go(await as('buyer'), '#/');
  await waitText(await as('buyer'), 'Desk lamp');
  await (await (await as('buyer')).waitForSelector('a.listing-card')).click();
  await waitText(await as('buyer'), 'Direct, Lightning');
  await shot(await as('buyer'), 'Koper: advertentie toont bezorgopties en betaalmethodes');
  await click(await as('buyer'), 'Buy');
  await choose(await as('buyer'), 'PostNL');
  await choose(await as('buyer'), 'Direct, Lightning');
  await fill(await as('buyer'), 'Shipping address', 'Bob Buyer\nKerkstraat 1\n1234 AB Amsterdam');
  await shot(await as('buyer'), 'Koper: bestelformulier, PostNL en "Direct, Lightning" gekozen, waarschuwing zonder kopersbescherming');
  await shot(await as('buyer'), 'Koper: hetzelfde bestelformulier op een telefoon', { mobile: true });
  await click(await as('buyer'), 'Send order');
  await (await as('buyer')).waitForFunction(() => location.hash.startsWith('#/trade/'), { timeout: 20000 });
  const tid = await (await as('buyer')).evaluate(() => location.hash.split('/')[2]);
  await waitText(await as('buyer'), 'Waiting for the seller to accept');
  await shot(await as('buyer'), 'Koper: bestelling verstuurd, wacht op de verkoper; geen escrow en geen arbiter');

  step('seller accepts and sends an invoice from their wallet');
  await go(await as('seller'), `#/trade/${tid}`);
  await waitText(await as('seller'), 'New order');
  await shot(await as('seller'), 'Verkoper: nieuwe bestelling met betaalwijze, bezorgoptie en verzendadres');
  await click(await as('seller'), 'Accept');
  await waitText(await as('seller'), 'Send a payment request');
  await shot(await as('seller'), 'Verkoper: betaalverzoek sturen via de gekoppelde wallet, een Lightning-adres of een geplakte factuur');
  await click(await as('seller'), 'Create invoice with my wallet');
  await waitText(await as('seller'), 'Payment request:', 60000);
  await waitText(await as('seller'), 'I received the payment'); // request sent before closing this browser

  step('buyer pays with their wallet');
  await waitText(await as('buyer'), 'Pay with my wallet', 30000);
  await shot(await as('buyer'), 'Koper: betaalverzoek in de chat met QR-code, factuur, netwerk (lnbcrt) en "Betaal met mijn wallet"');
  await click(await as('buyer'), '⚡ Pay with my wallet');
  await waitText(await as('buyer'), 'Paid. The Lightning preimage proves it.', 60000);
  await shot(await as('buyer'), 'Koper: met één tik betaald; het preimage bewijst de betaling');

  step('seller sees the payment and ships');
  await waitText(await as('seller'), 'Paid. The Lightning preimage proves it.', 30000);
  await shot(await as('seller'), 'Verkoper: ziet de bewezen betaling, verzendformulier met de vervoerder van de koper en links naar Sendcloud/Packlink');
  await fill(await as('seller'), 'Tracking code', '3SXBT9876');
  await click(await as('seller'), 'Mark as shipped');
  await waitText(await as('seller'), 'Shipped with PostNL');
  const track = await (await as('seller')).$eval('a.btn.small[target=_blank]', (a) => a.href);
  if (!track.startsWith('https://postnl.nl/tracktrace/?B=3SXBT9876')) throw new Error('unexpected tracking link ' + track);

  step('buyer confirms receipt and both review');
  await waitText(await as('buyer'), 'Shipped with PostNL', 30000);
  await waitText(await as('buyer'), 'Track');
  await shot(await as('buyer'), 'Koper: verzonden met PostNL, trackingcode met Volgen-knop naar postnl.nl');
  await click(await as('buyer'), 'Yes, received');
  await waitText(await as('buyer'), 'Leave a review', 30000);
  await shot(await as('buyer'), 'Koper: ontvangst bevestigd, status Afgerond, review achterlaten');
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
  await shot(await as('buyer'), 'Koper: chat met de stappen als tijdlijn (bestelling, geaccepteerd, betaalverzoek, betaald, verzonden, ontvangen)');

  if (CLI) {
    step('direct on-chain purchase, checked against the regtest node');
    await go(await as('seller'), '#/sell/new');
    await fill(await as('seller'), 'Title', 'Bike lights set');
    await fill(await as('seller'), 'Price', '15');
    await click(await as('seller'), 'Publish');
    await waitText(await as('seller'), 'Bike lights set');
    await go(await as('buyer'), '#/?q=bike');
    await (await as('buyer')).reload({ waitUntil: 'load' });
    await waitText(await as('buyer'), 'Bike lights set');
    await (await (await as('buyer')).waitForSelector('a.listing-card')).click();
    await click(await as('buyer'), 'Buy');
    await choose(await as('buyer'), 'Direct, on chain');
    await click(await as('buyer'), 'Send order');
    await (await as('buyer')).waitForFunction((t) => location.hash.startsWith('#/trade/') && !location.hash.includes(t), { timeout: 20000 }, tid);
    const tid2 = await (await as('buyer')).evaluate(() => location.hash.split('/')[2]);
    await go(await as('seller'), `#/trade/${tid2}`);
    await waitText(await as('seller'), 'New order');
    await click(await as('seller'), 'Accept');
    const sellerAddr = cli('getnewaddress', 'direct-seller', 'bech32');
    await fill(await as('seller'), 'Your XBT address', sellerAddr);
    await click(await as('seller'), 'Request 0.0003 XBT');
    await waitText(await as('seller'), 'I received the payment');
    await waitText(await as('buyer'), 'Payment request:', 30000);
    await shot(await as('buyer'), 'Koper: on-chain betaalverzoek met adres en QR-code');
    const txid = cli('sendtoaddress', sellerAddr, '0.0003');
    cli('generatetoaddress', '1', cli('getnewaddress'));
    await fillPh(await as('buyer'), 'Payment txid', txid);
    await click(await as('buyer'), 'I paid');
    await waitText(await as('buyer'), '1 confirmations', 30000);
    await shot(await as('buyer'), 'Koper: txid gemeld; de app controleert bij de node: volledig bedrag, 1 bevestiging');
    await waitText(await as('seller'), 'The buyer reports a payment', 30000);
    await click(await as('seller'), 'I received the payment');
    await waitText(await as('seller'), 'The seller confirmed receiving the payment');
    await shot(await as('seller'), 'Verkoper: on-chain betaling gecontroleerd en bevestigd, klaar om te verzenden');
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
