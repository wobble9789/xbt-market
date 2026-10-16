// End-to-end test of the whole trade flow through the real UI. See README "Testing".
// Full trade through the real UI: arbiter announces, seller lists, buyer offers,
// seller accepts, both fund (regtest node), seller ships, buyer releases,
// seller co-signs + broadcasts, node confirms payout. Then a dispute trade.
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { proof, setupPage, settle } from './proof.mjs';

const APP = process.env.APP_URL || (process.env.APP_URL || 'http://127.0.0.1:4173/');
const CLI = process.env.KNOTS_CLI;
const cli = (...a) => execSync(`${CLI} ${a.map((x) => `'${x}'`).join(' ')}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const mine = (n = 1) => cli('generatetoaddress', String(n), cli('getnewaddress'));
const hex = (b) => Buffer.from(b).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`\n== ${s}`);
const SHOTS = process.env.SHOTS;
const shot = (page, caption, mobile = false) => proof(page, 'escrow', caption, { mobile });

const people = {};
for (const who of ['arbiter', 'seller', 'buyer']) { const sk = generateSecretKey(); people[who] = { sk: hex(sk), pk: getPublicKey(sk) }; }

// Firefox by default (FIREFOX=…), or Chromium with CHROME=/path/to/chrome.
const chrome = process.env.CHROME;
const browser = await puppeteer.launch({
  browser: chrome ? 'chrome' : 'firefox', executablePath: chrome || process.env.FIREFOX || '/usr/bin/firefox', headless: true, protocolTimeout: 45000,
  ...(chrome ? { args: ['--no-sandbox'] } : {
    userDataDir: (() => { const d = (process.env.PROFILE_DIR || process.env.HOME + '/snap/firefox/common') + '/xbt-e2e'; rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; })(),
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

async function open(who) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await setupPage(page);
  page.on('pageerror', (e) => { if (!/establish a connection/.test(e.message)) console.log(`[${who} pageerror]`, e.message); });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${who} console]`, m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate((p, arbiterPk) => {
    localStorage.setItem('xbt:account', JSON.stringify({ pubkey: p.pk, sk: p.sk, backedUp: true }));
    localStorage.setItem('xbt:settings', JSON.stringify({
      relays: ['ws://127.0.0.1:7777'], network: 'regtest', esploraOverride: { regtest: 'http://127.0.0.1:3006/api' },
      minConfirmations: 1, lang: 'en', trustedArbiters: [arbiterPk], manualRate: { value: 50000, currency: 'EUR' }, currency: 'EUR',
    }));
  }, people[who], people.arbiter.pk);
  await page.reload({ waitUntil: 'load' });
  page.who = who;
  return page;
}

const go = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);
async function text(page) { return page.evaluate(() => document.querySelector('main').innerText); }
async function waitText(page, t, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if ((await text(page)).includes(t)) return; await sleep(400); }
  const diag = await page.evaluate(() => JSON.stringify({ n: Object.keys(window.xbt.inbox.get().rumors).length, syncing: window.xbt.inbox.get().syncing, conn: [...window.xbt.pool.listConnectionStatus()], hash: location.hash }));
  throw new Error(`[${page.who}] timed out waiting for "${t}". diag ${diag} Page:\n${(await text(page)).slice(0, 1500)}`);
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
  console.log(`  [${page.who}] fill ${labelText}`);
  const el = await page.waitForSelector(`::-p-xpath(//label[span[@class="label" and normalize-space(.)="${labelText}"]]//*[self::input or self::textarea][1])`, { timeout: 15000 });
  await settle(el);
  await el.click({ count: 3 });
  await el.type(value);
}
async function choose(page, labelStart) {
  console.log(`  [${page.who}] choose ${labelStart}`);
  const el = await page.waitForSelector(`::-p-xpath(//label[contains(@class,"choice")][starts-with(normalize-space(.),"${labelStart}")])`, { timeout: 15000 });
  await settle(el);
  await el.click();
}
async function fillPh(page, ph, value) {
  const el = await page.waitForSelector(`::-p-xpath(//*[(self::input or self::textarea) and @placeholder="${ph}"])`, { timeout: 15000 });
  await settle(el);
  await el.click({ count: 3 });
  await el.type(value);
}
const escrowAddress = (page) => page.$eval('.addr code', (e) => e.textContent.trim());
const tradeId = (page) => page.evaluate(() => location.hash.split('/')[2]);

try {
  
  step('arbiter announces');
  await go(await as('arbiter'), '#/arbiter');
  await fill(await as('arbiter'), 'Name', 'Alice Arbiter');
  await fill(await as('arbiter'), 'Languages', 'NL, EN');
  await click(await as('arbiter'), 'Publish arbiter profile');
  await waitText(await as('arbiter'), 'Your arbiter profile');

  step('seller lists an item');
  await go(await as('seller'), '#/sell/new');
  await fill(await as('seller'), 'Title', 'Trezor Model One, sealed');
  await fill(await as('seller'), 'Description', 'Never opened. Ships from Utrecht.');
  await fill(await as('seller'), 'Price', '25');
  await fillPh(await as('seller'), 'Price', '5'); // PostNL delivery option
  await click(await as('seller'), 'Publish');
  await waitText(await as('seller'), 'Trezor Model One, sealed');

  step('buyer finds it and offers');
  await go(await as('buyer'), '#/');
  await waitText(await as('buyer'), 'Trezor Model One');
  await (await (await as('buyer')).waitForSelector('a.listing-card')).click();
  await click(await as('buyer'), 'Buy');
  await choose(await as('buyer'), 'With escrow');
  await (await as('buyer')).waitForFunction(() => document.querySelector('.offer select')?.textContent.includes('Alice Arbiter'), { timeout: 30000 });
  const buyerAddr = cli('getnewaddress', 'buyer', 'bech32');
  await fillPh(await as('buyer'), 'bc1q…', buyerAddr);
  await fill(await as('buyer'), 'Shipping address', 'Bob Buyer\nKerkstraat 1\n1234 AB Amsterdam');
  const priceVal = await (await as('buyer')).$eval('.offer input[inputmode="decimal"]', (e) => e.value);
  await shot(await as('buyer'), 'Koper: bestelformulier met bezorgoptie, "Met escrow" gekozen, arbiter en verzendadres');
  await shot(await as('buyer'), 'Koper: hetzelfde bestelformulier op een telefoon', true);
  console.log('suggested price XBT', priceVal, '(30 EUR at 50000 EUR/XBT = 0.0006)');
  await click(await as('buyer'), 'Send order');
  await (await as('buyer')).waitForFunction(() => location.hash.startsWith('#/trade/'), { timeout: 20000 });
  const tid = await tradeId(await as('buyer'));
  console.log('trade', tid);
  await waitText(await as('buyer'), 'Waiting for the seller');

  step('seller accepts');
  await go(await as('seller'), `#/trade/${tid}`);
  await waitText(await as('seller'), 'New offer');
  await waitText(await as('seller'), 'approved');
  await shot(await as('seller'), 'Verkoper: nieuw bod met ✓ goedgekeurde arbiter, borg en verzendadres');
  const sellerAddr = cli('getnewaddress', 'seller', 'bech32');
  await fillPh(await as('seller'), 'bc1q…', sellerAddr);
  await click(await as('seller'), 'Accept');
  await waitText(await as('seller'), 'Total needed');

  step('both fund the escrow');
  await waitText(await as('buyer'), 'Total needed');
  const esc = await escrowAddress(await as('buyer'));
  const esc2 = await escrowAddress(await as('seller'));
  if (esc !== esc2) throw new Error(`escrow mismatch ${esc} vs ${esc2}`);
  console.log('escrow', esc);
  await shot(await as('buyer'), 'Koper: escrow-adres met QR-code en bedragen na accepteren (zelfde adres als de verkoper)');
  await shot(await as('buyer'), 'Koper: escrow-betaalscherm op een telefoon', true);
  // amounts: buyer price+15%, seller 15%
  const amounts = await (await as('buyer')).$$eval('table.amounts tr td:last-child', (tds) => tds.map((t) => t.innerText));
  console.log('amount table', amounts);
  cli('sendtoaddress', esc, '0.00069');   // 0.0006 + 15%
  cli('sendtoaddress', esc, '0.00009');   // 15% of 0.0006
  mine(1);
  await click(await as('seller'), 'Refresh');
  await waitText(await as('seller'), 'Ship the item', 40000);
  await shot(await as('seller'), 'Verkoper: escrow volledig betaald en bevestigd door de node, verzendformulier met vervoerder');

  step('seller ships');
  await fill(await as('seller'), 'Tracking code', '3SXBT123');
  await click(await as('seller'), 'Mark as shipped');
  await waitText(await as('seller'), 'Shipped with PostNL');
  await shot(await as('seller'), 'Verkoper: verzonden met PostNL, trackingcode met Volgen-knop');

  step('buyer releases');
  await click(await as('buyer'), 'Refresh');
  await waitText(await as('buyer'), 'Received the item?', 40000);
  await click(await as('buyer'), 'Everything OK: release payment');
  await waitText(await as('buyer'), 'Payout proposals', 30000);

  step('seller co-signs and broadcasts');
  await waitText(await as('seller'), 'Release to seller', 30000);
  await shot(await as('seller'), 'Verkoper: vrijgave-voorstel, getekend door de koper, klaar om mee te tekenen');
  await waitText(await as('seller'), 'Release to seller', 30000);
  await click(await as('seller'), 'Agree and sign');
  await waitText(await as('seller'), 'Broadcast:', 40000);
  await shot(await as('seller'), 'Verkoper: meegetekend en verzonden, uitbetalings-txid zichtbaar');
  mine(1);
  const got = Number(cli('getreceivedbyaddress', sellerAddr, '1'));
  const back = Number(cli('getreceivedbyaddress', buyerAddr, '1'));
  console.log(`seller received ${got} XBT, buyer got back ${back} XBT`);
  if (!(got > 0.00068 && back > 0.00008)) throw new Error('unexpected payout amounts');
  console.log(`  node check: seller ${got} XBT, buyer ${back} XBT`);

  step('reviews');
  await shot(await as('buyer'), 'Koper: escrow uitbetaald via de echte regtest-node, status Uitbetaald');
  await waitText(await as('buyer'), 'Leave a review', 30000);
  await click(await as('buyer'), 'Publish review');
  await waitNoText(await as('buyer'), 'Leave a review');
  await waitText(await as('seller'), 'Leave a review', 30000);
  await click(await as('seller'), 'Publish review');
  await waitNoText(await as('seller'), 'Leave a review');
  await sleep(1500);
  await go(await as('buyer'), `#/u/${people.seller.pk}`);
  await waitText(await as('buyer'), '1 verified trades', 20000);
  await shot(await as('buyer'), 'Profiel verkoper: 1 geverifieerde trade na reviews van beide kanten');
  await go(await as('buyer'), '#/');
  await sleep(1500);
  await shot(await as('buyer'), 'Zoeken: advertentieoverzicht');
  await shot(await as('buyer'), 'Zoeken op een telefoon', true);

  step('dispute trade: arbiter rules a refund, buyer co-signs');
  await go(await as('seller'), '#/sell/new');
  await fill(await as('seller'), 'Title', 'Vintage lamp');
  await fill(await as('seller'), 'Price', '10');
  await click(await as('seller'), 'Publish');
  await waitText(await as('seller'), 'Vintage lamp');
  await go(await as('buyer'), '#/?q=lamp');
  await (await as('buyer')).reload({ waitUntil: 'load' });
  await waitText(await as('buyer'), 'Vintage lamp');
  await (await (await as('buyer')).waitForSelector('a.listing-card')).click();
  await click(await as('buyer'), 'Buy');
  await choose(await as('buyer'), 'With escrow');
  await (await as('buyer')).waitForFunction(() => document.querySelector('.offer select')?.textContent.includes('Alice Arbiter'), { timeout: 30000 });
  await fillPh(await as('buyer'), 'bc1q…', buyerAddr);
  await click(await as('buyer'), 'Send order');
  await (await as('buyer')).waitForFunction((t) => location.hash.startsWith('#/trade/') && !location.hash.includes(t), { timeout: 20000 }, tid);
  const tid2 = await tradeId(await as('buyer'));
  await go(await as('seller'), `#/trade/${tid2}`);
  await waitText(await as('seller'), 'New offer');
  await fillPh(await as('seller'), 'bc1q…', sellerAddr);
  await click(await as('seller'), 'Accept');
  await waitText(await as('seller'), 'Total needed', 30000); // accept sent before closing this browser
  await waitText(await as('buyer'), 'Total needed', 30000);
  const esc3 = await escrowAddress(await as('buyer'));
  cli('sendtoaddress', esc3, '0.00023'); // 0.0002 + 15%
  cli('sendtoaddress', esc3, '0.00003');
  mine(1);
  await click(await as('buyer'), 'Refresh');
  await waitText(await as('buyer'), 'Fully paid', 40000);
  await click(await as('buyer'), 'Open a dispute');
  await fillPh(await as('buyer'), 'What went wrong?', 'Seller does not ship and does not answer.');
  await click(await as('buyer'), 'Open dispute');
  await waitText(await as('buyer'), 'Dispute opened by buyer');
  await shot(await as('buyer'), 'Koper: geschil geopend na betalen, rode melding en chat-tijdlijn');

  await go(await as('arbiter'), '#/arbiter');
  await waitText(await as('arbiter'), 'Open disputes');
  await waitText(await as('arbiter'), 'Vintage lamp', 30000);
  await shot(await as('arbiter'), 'Arbiter: het geschil staat onder Open geschillen');
  await go(await as('arbiter'), `#/trade/${tid2}`);
  await waitText(await as('arbiter'), 'Propose a ruling');
  await click(await as('arbiter'), 'Propose a ruling');
  // refund: seller gets only their deposit back
  const sellerField = await (await as('arbiter')).waitForSelector('::-p-xpath(//label[span[normalize-space(.)="Seller receives (XBT)"]]//input)');
  await sellerField.click({ count: 3 });
  await sellerField.type('0.00003');
  await fill(await as('arbiter'), 'Note', 'No shipment within the deadline: refund to buyer, seller keeps own deposit.');
  await shot(await as('arbiter'), 'Arbiter: uitspraak in het geschil (terugbetaling aan koper) met toelichting');
  await click(await as('arbiter'), 'Sign and propose');
  await waitText(await as('arbiter'), 'Arbiter ruling', 30000); // sent before closing this browser
  await waitText(await as('buyer'), 'Arbiter ruling', 30000);
  await click(await as('buyer'), 'Agree and sign');
  await waitText(await as('buyer'), 'Broadcast:', 40000);
  await shot(await as('buyer'), 'Koper: uitspraak meegetekend, terugbetaling verzonden');
  mine(1);
  console.log('buyer refund total now', cli('getreceivedbyaddress', buyerAddr, '1'));

  console.log('\nE2E PASSED');
} catch (e) {
  console.error('\nE2E FAILED:', e.message);
  process.exitCode = 1;
  if (current) {
    try {
      console.error(`[${current.who}] at ${await current.evaluate(() => location.hash)}:\n` + (await current.evaluate(() => document.body.innerText)).slice(0, 2000));
      if (SHOTS) await current.screenshot({ path: `${SHOTS}/failure.png`, fullPage: true });
    } catch (err) { console.error('could not capture failure state', err.message); }
  }
} finally {
  await browser.close();
}
