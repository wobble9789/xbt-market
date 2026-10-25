// End-to-end test of the whole trade flow through the real UI. See README "Testing".
// Full trade through the real UI: arbiter announces, seller lists, buyer sends a
// message, then orders from the chat, seller accepts, buyer sends address,
// arbiter and refund address, both fund (regtest node), seller ships, buyer
// releases, seller co-signs + broadcasts, node confirms payout. Then a dispute
// trade, where the arbiter only joins after the order.
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
for (const who of ['arbiter', 'seller', 'buyer']) { const sk = generateSecretKey(); people[who] = { sk: hex(sk), pk: getPublicKey(sk), name: who[0].toUpperCase() + who.slice(1), city: who === 'seller' ? 'Utrecht' : 'Amsterdam' }; }

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
// Days each person's clock runs ahead, to reach a deadline without waiting.
const shift = {};
async function shiftClock(who, days) {
  shift[who] = days;
  if (current?.who === who) {
    lastHash[who] = await current.evaluate(() => location.hash);
    await current.browserContext().close();
    current = null;
  }
}
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
  if (shift[who]) {
    const ahead = shift[who] * 86400000;
    await page.evaluateOnNewDocument(`(() => { const D = Date; const now = () => D.now() + ${ahead};
      class Shifted extends D { constructor(...a) { if (a.length) super(...a); else super(now()); } static now() { return now(); } }
      window.Date = Shifted; })()`);
  }
  page.on('pageerror', (e) => { if (!/establish a connection/.test(e.message)) console.log(`[${who} pageerror]`, e.message); });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${who} console]`, m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate((p, arbiterPk) => {
    localStorage.setItem('xbt:account', JSON.stringify({ pubkey: p.pk, sk: p.sk, backedUp: true }));
    localStorage.setItem('xbt:settings', JSON.stringify({
      relays: ['ws://127.0.0.1:7777'], network: 'regtest', esploraOverride: { regtest: 'http://127.0.0.1:3006/api' },
      minConfirmations: 1, lang: 'en', trustedArbiters: [arbiterPk], manualRate: { value: 50000, currency: 'EUR' }, currency: 'EUR', country: 'NL',
      address: { name: `${p.name} Tester`, street: 'Kerkstraat', number: '1', postalCode: '1234AB', city: p.city, country: 'NL', email: 'test@example.com' },
    }));
  }, people[who], people.arbiter.pk);
  // The wallet key (encrypted secrets) and the address counter outlive a context.
  if (kept[who]) await page.evaluate((k) => { for (const [n, v] of Object.entries(k)) localStorage.setItem(n, v); }, kept[who]);
  await page.reload({ waitUntil: 'load' });
  page.who = who;
  const close = page.browserContext().close.bind(page.browserContext());
  page.browserContext().close = async () => {
    kept[who] = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => /^xbt:(secrets|payout-index):/.test(k)))).catch(() => kept[who]);
    return close();
  };
  return page;
}
const kept = {};
// Until the page shows coins in the escrow (the arbiter's page loads it once on open).
async function escrowShown(page) {
  for (let i = 0; i < 10; i++) {
    if (/In escrow now\s+0\.\d*[1-9]/.test(await text(page))) return;
    await click(page, 'Refresh');
    await sleep(2000);
  }
  throw new Error('the escrow balance did not show');
}
// The payout address the app filled in for the seller: a fresh one from the wallet key.
async function prefilledPayout(page) {
  await page.waitForFunction(() => /^bcrt1/.test(document.querySelector('input[placeholder="bc1q…"]')?.value || ''), { timeout: 30000 });
  await waitText(page, 'A new address from your wallet');
  const a = await page.$eval('input[placeholder="bc1q…"]', (i) => i.value);
  if (!JSON.parse(cli('getaddressinfo', a)).ismine) throw new Error(`prefilled payout address ${a} is not from the seller's wallet`);
  const hist = JSON.parse(cli('listreceivedbyaddress', '0', 'true', 'true', a))[0];
  if (hist?.txids?.length) throw new Error(`prefilled payout address ${a} was used before`);
  return a;
}

const go = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);
async function text(page) { return page.evaluate(() => document.querySelector('main')?.innerText || ''); }
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
// The first real subcategory of the chosen category.
async function pickSubcategory(page) {
  const sel = await page.waitForSelector('select[aria-label="Subcategory"]:not([disabled])', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('select[aria-label="Subcategory"]').options.length > 1, { timeout: 15000 });
  const v = await sel.evaluate((e) => e.options[1].value);
  await sel.select(v);
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

  step('seller adds the wallet key: a new payout address for every trade');
  // The node wallet's taproot chain: the test's own getnewaddress calls use its
  // segwit chain, so they never hand out the same addresses.
  const sellerDesc = JSON.parse(cli('listdescriptors')).descriptors.find((d) => !d.internal && d.desc.startsWith('tr(')).desc;
  const firstAddr = JSON.parse(cli('deriveaddresses', sellerDesc, '[0,0]'))[0];
  await go(await as('seller'), '#/settings?open=trading');
  await fillPh(await as('seller'), 'zpub… / xpub… / wpkh([…]xpub…/0/*)', sellerDesc);
  await click(await as('seller'), 'Save wallet key');
  await waitText(await as('seller'), 'Wallet key saved (encrypted)');
  await waitText(await as('seller'), firstAddr);
  await waitText(await as('seller'), 'Next trade gets');
  await shot(await as('seller'), 'Verkoper: wallet-sleutel ingesteld; eerste adres ter controle en het adres voor de volgende trade');

  step('seller lists an item (escrow on, carriers without a price)');
  await go(await as('seller'), '#/sell/new');
  await fill(await as('seller'), 'Title', 'Trezor Model One, sealed');
  await fill(await as('seller'), 'Description', 'Never opened. Ships from Utrecht.');
  await pickSubcategory(await as('seller'));
  await fill(await as('seller'), 'Price', '25');
  await choose(await as('seller'), '🛡 Escrow');
  await waitText(await as('seller'), 'Your escrow deposit');
  await shot(await as('seller'), 'Verkoper: nieuwe advertentie met categorie + subcategorie, land, vervoerders zonder prijs, Lightning standaard aan en escrow aangevinkt (borgveld verschijnt)');
  await click(await as('seller'), 'Publish');
  await waitText(await as('seller'), 'Trezor Model One, sealed');

  step('buyer sends a message first');
  await go(await as('buyer'), '#/');
  await waitText(await as('buyer'), 'Trezor Model One');
  await (await (await as('buyer')).waitForSelector('a.listing-card')).click();
  await waitText(await as('buyer'), 'Message the seller');
  await click(await as('buyer'), '💬 Message the seller');
  await click(await as('buyer'), 'Send');
  await (await as('buyer')).waitForFunction(() => location.hash.startsWith('#/trade/'), { timeout: 20000 });
  const tid = await tradeId(await as('buyer'));
  console.log('trade', tid);
  await waitText(await as('buyer'), 'You are buying');
  await waitText(await as('buyer'), 'Is this still available?');

  step('seller answers in the chat');
  await go(await as('seller'), `#/trade/${tid}`);
  await waitText(await as('seller'), 'You are selling');
  await waitText(await as('seller'), 'Is this still available?');
  await fillPh(await as('seller'), 'Write a message…', 'Yes, still sealed!');
  await click(await as('seller'), 'Send');
  await waitText(await as('seller'), 'Yes, still sealed!');
  await shot(await as('seller'), 'Verkoper: vrijblijvend gesprek, met duidelijk "Jij verkoopt aan …"');

  step('buyer orders from the chat');
  await waitText(await as('buyer'), 'Yes, still sealed!', 30000);
  await click(await as('buyer'), '🛒 Order');
  await choose(await as('buyer'), '🛡 Escrow');
  await waitText(await as('buyer'), 'You pay into escrow');
  await choose(await as('buyer'), 'PostNL');
  const priceVal = await (await as('buyer')).$eval('.order-form input[inputmode="decimal"]', (e) => e.value);
  const pageText = await text(await as('buyer'));
  if (/Delivery address|Arbiter|refund/i.test(pageText.split('Messages')[0])) throw new Error('the order form asks for address, arbiter or refund address');
  await shot(await as('buyer'), 'Koper: bestellen vanuit de chat: alleen betaalmethode, land + vervoerder met prijs, prijs en bericht; escrow-berekening zichtbaar, geen adres/arbiter');
  await shot(await as('buyer'), 'Koper: hetzelfde bestelformulier op een telefoon', true);
  console.log('suggested price XBT', priceVal);
  await click(await as('buyer'), 'Send order');
  await waitText(await as('buyer'), 'Waiting for the seller to accept');

  step('seller accepts');
  await waitText(await as('seller'), 'Order from', 30000);
  await waitText(await as('seller'), 'the buyer');
  await shot(await as('seller'), 'Verkoper: "Bestelling van … (de koper)" met prijs, verzending en betaalmethode; Afwijzen-reden pas na tikken');
  const sellerAddr = await prefilledPayout(await as('seller'));
  console.log('fresh payout address', sellerAddr);
  await click(await as('seller'), '✓ Accept');
  await waitText(await as('seller'), 'Waiting for the buyer to choose an arbiter');

  step('buyer sends address, arbiter and refund address');
  await waitText(await as('buyer'), 'A few details for the seller', 30000);
  await (await as('buyer')).waitForFunction(() => [...document.querySelectorAll('.details-form select')].some((s) => s.textContent.includes('Alice Arbiter')), { timeout: 30000 });
  const buyerAddr = cli('getnewaddress', 'buyer', 'bech32');
  await fillPh(await as('buyer'), 'bc1q…', buyerAddr);
  await shot(await as('buyer'), 'Koper: na accepteren pas adres (vooraf ingevuld), arbiter en terugbetaaladres');
  await click(await as('buyer'), 'Send');
  await waitText(await as('buyer'), 'Total needed', 30000);
  await waitText(await as('seller'), 'Total needed', 30000);

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
  // Pay exactly what the page asks: price incl. shipping + 15% from the buyer, 15% from the seller.
  const coin = (t) => Number(t.match(/([\d.]+) XBT/)[1]);
  const buyerPart = coin(amounts[0]);
  const sellerPart = coin(amounts[1]);
  const price = Math.round((buyerPart / 1.15) * 1e8) / 1e8;
  console.log('buyer pays', buyerPart, 'seller pays', sellerPart, 'price', price);
  cli('sendtoaddress', esc, buyerPart.toFixed(8));
  cli('sendtoaddress', esc, sellerPart.toFixed(8));
  mine(1);
  await click(await as('seller'), 'Refresh');
  await waitText(await as('seller'), 'Ship the item', 40000);
  await waitText(await as('seller'), 'Kerkstraat 1');
  await waitText(await as('seller'), 'Paid. Ship by');
  await waitText(await as('seller'), 'Was this your only one? Mark the listing as reserved');
  await shot(await as('seller'), 'Verkoper: escrow volledig betaald en bevestigd door de node, verzendformulier met het adres van de koper');

  step('seller ships');
  await fill(await as('seller'), 'Tracking code', '3SXBT123');
  await click(await as('seller'), 'Mark as shipped');
  await waitText(await as('seller'), 'Shipped with PostNL');
  await waitText(await as('seller'), 'Waiting for the buyer to confirm, until');
  await shot(await as('seller'), 'Verkoper: verzonden met PostNL, trackingcode met Volgen-knop');
  await click(await as('seller'), '📬 Delivered, per the tracking');
  await waitNoText(await as('seller'), '📬 Delivered, per the tracking', 30000);

  step('buyer releases');
  await click(await as('buyer'), 'Refresh');
  await waitText(await as('buyer'), 'Received the item?', 40000);
  await waitText(await as('buyer'), 'The seller says the tracking shows it was delivered', 30000);
  await waitText(await as('buyer'), 'Check it and confirm below, or open a dispute, before');
  await shot(await as('buyer'), 'Koper: geleverd volgens de verkoper; 2 dagen om te bevestigen of te klagen');
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
  if (!(got > price + sellerPart - 0.00001 && back > buyerPart - price - 0.00001)) throw new Error('unexpected payout amounts');
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
  await pickSubcategory(await as('seller'));
  await fill(await as('seller'), 'Price', '10');
  await choose(await as('seller'), '🛡 Escrow');
  await click(await as('seller'), 'Publish');
  await waitText(await as('seller'), 'Vintage lamp');
  await go(await as('buyer'), '#/?q=lamp');
  await (await as('buyer')).reload({ waitUntil: 'load' });
  await waitText(await as('buyer'), 'Vintage lamp');
  await (await (await as('buyer')).waitForSelector('a.listing-card')).click();
  await click(await as('buyer'), '🛒 Order now');
  await (await as('buyer')).waitForFunction((t) => location.hash.startsWith('#/trade/') && !location.hash.includes(t), { timeout: 20000 }, tid);
  const tid2 = await tradeId(await as('buyer'));
  await choose(await as('buyer'), '🛡 Escrow');
  await choose(await as('buyer'), '🤝 Pick up');
  await click(await as('buyer'), 'Send order');
  await waitText(await as('buyer'), 'Waiting for the seller to accept');
  await go(await as('seller'), `#/trade/${tid2}`);
  await waitText(await as('seller'), 'Order from', 30000);
  const sellerAddr2 = await prefilledPayout(await as('seller'));
  if (sellerAddr2 === sellerAddr) throw new Error('the second trade got the same payout address');
  await click(await as('seller'), '✓ Accept');
  await waitText(await as('seller'), 'Waiting for the buyer to choose an arbiter', 30000);
  await waitText(await as('buyer'), 'A few details for the seller', 30000);
  await (await as('buyer')).waitForFunction(() => [...document.querySelectorAll('.details-form select')].some((s) => s.textContent.includes('Alice Arbiter')), { timeout: 30000 });
  if ((await text(await as('buyer'))).includes('Delivery address')) throw new Error('pick-up must not ask for an address');
  await fillPh(await as('buyer'), 'bc1q…', buyerAddr);
  await click(await as('buyer'), 'Send');
  await waitText(await as('buyer'), 'Total needed', 30000);
  // The seller's app forwards its accept to the arbiter, who joined after it.
  await waitText(await as('seller'), 'Total needed', 30000);
  await sleep(3000);
  const esc3 = await escrowAddress(await as('buyer'));
  cli('sendtoaddress', esc3, '0.00023'); // 0.0002 + 15%
  cli('sendtoaddress', esc3, '0.00003');
  mine(1);
  await click(await as('buyer'), 'Refresh');
  await waitText(await as('buyer'), 'Fully paid', 40000);
  await click(await as('buyer'), 'Open a dispute');
  await fillPh(await as('buyer'), 'What went wrong?', 'Seller does not ship and does not answer.');
  await click(await as('buyer'), 'Open dispute');
  await waitText(await as('buyer'), 'Dispute opened by the buyer');
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

  // An escrow trade with shipping, paid in full by both: returns what each paid.
  async function paidEscrowTrade(title) {
    await go(await as('seller'), '#/sell/new');
    await fill(await as('seller'), 'Title', title);
    await pickSubcategory(await as('seller'));
    await fill(await as('seller'), 'Price', '10');
    await choose(await as('seller'), '🛡 Escrow');
    await click(await as('seller'), 'Publish');
    await waitText(await as('seller'), title);
    await go(await as('buyer'), `#/?q=${encodeURIComponent(title)}`);
    // Firefox sometimes never reports the reload as loaded; the text check below decides.
    await (await as('buyer')).reload({ waitUntil: 'load', timeout: 15000 }).catch(() => {});
    await waitText(await as('buyer'), title);
    const before = await (await as('buyer')).evaluate(() => location.hash);
    await (await (await as('buyer')).waitForSelector(`::-p-xpath(//a[contains(@class,"listing-card")][contains(., "${title}")])`)).click();
    await click(await as('buyer'), '🛒 Order now');
    await (await as('buyer')).waitForFunction((b) => location.hash.startsWith('#/trade/') && location.hash !== b, { timeout: 20000 }, before);
    const id = await tradeId(await as('buyer'));
    await choose(await as('buyer'), '🛡 Escrow');
    await choose(await as('buyer'), 'PostNL');
    await click(await as('buyer'), 'Send order');
    await waitText(await as('buyer'), 'Waiting for the seller to accept');
    await go(await as('seller'), `#/trade/${id}`);
    await waitText(await as('seller'), 'Order from', 30000);
    const payoutTo = await prefilledPayout(await as('seller'));
    await click(await as('seller'), '✓ Accept');
    await waitText(await as('seller'), 'Waiting for the buyer to choose an arbiter', 30000);
    await go(await as('buyer'), `#/trade/${id}`);
    await waitText(await as('buyer'), 'A few details for the seller', 30000);
    await (await as('buyer')).waitForFunction(() => [...document.querySelectorAll('.details-form select')].some((s) => s.textContent.includes('Alice Arbiter')), { timeout: 30000 });
    await fillPh(await as('buyer'), 'bc1q…', buyerAddr);
    await click(await as('buyer'), 'Send');
    await waitText(await as('buyer'), 'Total needed', 30000);
    await waitText(await as('seller'), 'Total needed', 30000);
    await sleep(3000);
    const amounts = await (await as('buyer')).$$eval('table.amounts tr td:last-child', (tds) => tds.map((t) => t.innerText));
    const coin = (t) => Number(t.match(/([\d.]+) XBT/)[1]);
    const paid = { buyer: coin(amounts[0]), seller: coin(amounts[1]) };
    const addr = await escrowAddress(await as('buyer'));
    cli('sendtoaddress', addr, paid.buyer.toFixed(8));
    cli('sendtoaddress', addr, paid.seller.toFixed(8));
    mine(1);
    await click(await as('buyer'), 'Refresh');
    await waitText(await as('buyer'), 'The seller ships by', 40000);
    return { id, paid, payoutTo };
  }
  const received = (addr) => Number(cli('getreceivedbyaddress', addr, '1'));

  step('deadline: the seller does not ship; 6 days later the buyer asks a refund, the arbiter rules the seller at fault');
  const late = await paidEscrowTrade('Oude radio');
  await shiftClock('buyer', 6);
  await go(await as('buyer'), `#/trade/${late.id}`);
  await waitText(await as('buyer'), 'The seller did not ship in time', 40000);
  await shot(await as('buyer'), 'Koper: 6 dagen later niet verzonden, knop om het geld terug te vragen');
  await click(await as('buyer'), 'Ask for a refund');
  await waitText(await as('buyer'), 'Dispute opened by the buyer', 30000);
  await waitText(await as('buyer'), 'The seller has until', 30000);
  await go(await as('seller'), `#/trade/${late.id}`);
  await waitText(await as('seller'), 'Answer in the chat before', 30000);
  await shiftClock('arbiter', 10);
  await go(await as('arbiter'), `#/trade/${late.id}`);
  await waitText(await as('arbiter'), 'The seller did not answer within 3 days. You may rule for the buyer.', 40000);
  await escrowShown(await as('arbiter'));
  await click(await as('arbiter'), 'Propose a ruling');
  await click(await as('arbiter'), 'Seller at fault: everything to the buyer');
  const sellerGets = await (await as('arbiter')).$eval('::-p-xpath(//label[span[normalize-space(.)="Seller receives (XBT)"]]//input)', (i) => i.value);
  if (Number(sellerGets) !== 0) throw new Error(`seller at fault should get nothing, got ${sellerGets}`);
  await shot(await as('arbiter'), 'Arbiter: verkoper reageerde niet binnen 3 dagen; "verkoper schuldig" geeft alles aan de koper');
  await click(await as('arbiter'), 'Sign and propose');
  await waitText(await as('arbiter'), 'Arbiter ruling', 30000);
  const buyerBefore = received(buyerAddr);
  await go(await as('buyer'), `#/trade/${late.id}`);
  await waitText(await as('buyer'), 'Arbiter ruling', 30000);
  await click(await as('buyer'), 'Agree and sign');
  await waitText(await as('buyer'), 'Broadcast:', 40000);
  mine(1);
  const refund = received(buyerAddr) - buyerBefore;
  console.log(`  buyer got ${refund} XBT back (paid ${late.paid.buyer}, seller deposit ${late.paid.seller})`);
  if (refund < late.paid.buyer + late.paid.seller - 0.00002) throw new Error('the buyer should get the seller\'s deposit too');

  step('deadline: the buyer does not confirm; after the deadline the seller asks the arbiter, who co-signs the release');
  await shiftClock('buyer', 0);
  const quiet = await paidEscrowTrade('Oude camera');
  await go(await as('seller'), `#/trade/${quiet.id}`);
  await waitText(await as('seller'), 'Ship the item', 40000);
  await fill(await as('seller'), 'Tracking code', '3SXBT456');
  await click(await as('seller'), 'Mark as shipped');
  await waitText(await as('seller'), 'Shipped with PostNL');
  await click(await as('seller'), '📬 Delivered, per the tracking');
  await waitNoText(await as('seller'), '📬 Delivered, per the tracking', 30000);
  await shiftClock('seller', 3);
  await go(await as('seller'), `#/trade/${quiet.id}`);
  await waitText(await as('seller'), 'The buyer did not confirm in time', 40000);
  await click(await as('seller'), 'Ask the arbiter to pay out');
  await waitText(await as('seller'), 'Dispute opened by the seller', 30000);
  await waitText(await as('seller'), 'Release to seller', 30000);
  await shiftClock('buyer', 3);
  await go(await as('buyer'), `#/trade/${quiet.id}`);
  await waitText(await as('buyer'), 'Answer in the chat before', 30000);
  if ((await text(await as('buyer'))).includes('Open a dispute')) throw new Error('the buyer can still complain after the deadline');
  await shiftClock('arbiter', 7);
  await go(await as('arbiter'), `#/trade/${quiet.id}`);
  await waitText(await as('arbiter'), 'The buyer did not answer within 3 days. You may rule for the seller.', 40000);
  await escrowShown(await as('arbiter'));
  const sellerBefore = received(quiet.payoutTo);
  await click(await as('arbiter'), 'Agree and sign');
  await waitText(await as('arbiter'), 'Broadcast:', 40000);
  mine(1);
  const payout = received(quiet.payoutTo) - sellerBefore;
  console.log(`  seller got ${payout} XBT`);
  if (payout < 0.0001 + quiet.paid.seller - 0.00002) throw new Error('the seller should get the price and their deposit');

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
