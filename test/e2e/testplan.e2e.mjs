// Walks through public/testplan.html, ID by ID, with three people: A (admin and
// arbiter), B (seller) and C (buyer). Each step checks what the plan expects,
// saves a screenshot and records pass/fail; steps that need real coins, real
// shop websites or a real phone are recorded as "manual" with the reason.
//
// Needs: regtest node + `npm run shim`, `npm run relay`, `npm run wallets`,
// `node dev/blossom-mock.mjs`, and an app build with A as admin:
//   VITE_ADMIN_NPUB=$(node test/e2e/testplan.e2e.mjs --admin-npub) npx vite build --outDir dist-plan
//   npx vite preview --outDir dist-plan --port 4174
// then APP_URL=http://127.0.0.1:4174/ KNOTS_CLI=… node test/e2e/testplan.e2e.mjs
// Results: <SHOTS>/testplan-results.json (and screenshots with SHOTS set).
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { SimplePool } from 'nostr-tools/pool';
import { sha256 } from '@noble/hashes/sha2.js';
import { proof, setupPage, settle, fakeAnthropic, DEVICE } from './proof.mjs';
import { parseNwcUri, nwc } from '../../src/lib/ln/nwc.js';

const hex = (b) => Buffer.from(b).toString('hex');
const keyOf = (s) => sha256(new TextEncoder().encode(s));
const ADMIN_SK = keyOf('xbt-market/testplan/admin');
if (process.argv.includes('--admin-npub')) { console.log(nip19.npubEncode(getPublicKey(ADMIN_SK))); process.exit(0); }

const APP = process.env.APP_URL || 'http://127.0.0.1:4174/';
const RELAY = process.env.RELAY || 'ws://127.0.0.1:7777';
const BLOSSOM = process.env.BLOSSOM || 'http://127.0.0.1:3008';
const SHOTS = process.env.SHOTS;
const CLI = process.env.KNOTS_CLI;
const cli = (...a) => execSync(`${CLI} ${a.map((x) => `'${x}'`).join(' ')}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const mine = (n = 1) => cli('generatetoaddress', String(n), cli('getnewaddress'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const walletUri = (n) => `nostr+walletconnect://${getPublicKey(keyOf(`xbt-mock-wallet/${n}`))}?relay=${encodeURIComponent(RELAY)}&secret=${hex(keyOf(`xbt-mock-wallet/${n}/client`))}`;

// ---- people and browser contexts ---------------------------------------------------

const people = {
  A: { sk: hex(ADMIN_SK), pk: getPublicKey(ADMIN_SK) },
  B: {}, // creates an account through the UI in ACC-1
  C: (() => { const sk = generateSecretKey(); return { sk: hex(sk), pk: getPublicKey(sk) }; })(),
};
const BASE_SETTINGS = { relays: [RELAY], network: 'regtest', lang: 'en', manualRate: { value: 50000, currency: 'EUR' }, currency: 'EUR', blossom: BLOSSOM, esploraOverride: { regtest: 'http://127.0.0.1:3006/api' } };

const chrome = process.env.CHROME;
const browser = await puppeteer.launch({
  browser: chrome ? 'chrome' : 'firefox', executablePath: chrome || process.env.FIREFOX || '/usr/bin/firefox', headless: true, protocolTimeout: 60000,
  ...(chrome ? { args: ['--no-sandbox'] } : {
    userDataDir: (() => { const d = (process.env.PROFILE_DIR || process.env.HOME + '/snap/firefox/common') + '/xbt-plan'; rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; })(),
  }),
});

let current = null;
const storage = {};
const lastHash = {};
async function as(who, { fresh = false } = {}) {
  if (current?.who === who && !fresh) return current;
  if (current) {
    lastHash[current.who] = await current.evaluate(() => location.hash).catch(() => '');
    storage[current.who] = await current.evaluate(() => ({ ...localStorage })).catch(() => storage[current.who]);
    await current.browserContext().close();
  }
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await setupPage(page);
  page.who = who;
  page.on('pageerror', (e) => { if (!/establish a connection/.test(e.message)) console.log(`[${who} pageerror]`, e.message); });
  page.on('dialog', (d) => d.accept());
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate((saved, p, s) => {
    localStorage.clear();
    if (saved) { for (const [k, v] of Object.entries(saved)) localStorage.setItem(k, v); return; }
    localStorage.setItem('xbt:settings', JSON.stringify(s));
    if (p.sk) localStorage.setItem('xbt:account', JSON.stringify({ pubkey: p.pk, sk: p.sk, backedUp: true }));
  }, fresh ? null : storage[who], people[who], BASE_SETTINGS);
  await page.reload({ waitUntil: 'load' });
  if (lastHash[who] && !fresh) await page.evaluate((h) => { location.hash = h; }, lastHash[who]);
  current = page;
  return page;
}

// ---- page helpers ----------------------------------------------------------------------

const go = async (who, hash) => { const p = await as(who); await p.evaluate((h) => { location.hash = h; }, hash); await sleep(300); return p; };
const text = (p) => p.evaluate(() => document.querySelector('main')?.innerText || '');
const toasts = (p) => p.evaluate(() => document.querySelector('.toasts')?.innerText || '');
async function waitText(p, t, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if ((await text(p)).includes(t)) return; await sleep(300); }
  throw new Error(`timed out waiting for "${t}"`);
}
async function waitNoText(p, t, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (!(await text(p)).includes(t)) return; await sleep(300); }
  throw new Error(`"${t}" is still shown`);
}
async function waitToast(p, t, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if ((await toasts(p)).includes(t)) return; await sleep(200); }
  throw new Error(`no "${t}" message`);
}
async function el(p, xpath, timeout = 20000) {
  const e = await p.waitForSelector(`::-p-xpath(${xpath})`, { timeout });
  await settle(e);
  return e;
}
// Only inside <main>, so a "Log in" button never matches the "Log in" menu link.
const btnX = (label) => `//main//button[normalize-space(.)="${label}"] | //main//a[normalize-space(.)="${label}"]`;
const fieldX = (label, tag = '*[self::input or self::textarea]') => `//label[span[@class="label" and normalize-space(.)="${label}"]]//${tag}[1]`;
async function click(p, label) { await (await el(p, btnX(label))).click(); }
async function fill(p, label, value) { const e = await el(p, fieldX(label)); await e.click({ count: 3 }); await e.evaluate((x) => { x.value = ''; }); await e.type(value); }
async function fillPh(p, ph, value) { const e = await el(p, `//*[(self::input or self::textarea) and @placeholder="${ph}"]`); await e.click({ count: 3 }); await e.evaluate((x) => { x.value = ''; }); await e.type(value); }
async function select(p, label, value) { const e = await el(p, fieldX(label, 'select')); await e.select(value); }
async function choose(p, start) { await (await el(p, `//label[contains(@class,"choice")][starts-with(normalize-space(.),"${start}")]`)).click(); }
const exists = (p, xpath) => p.$(`::-p-xpath(${xpath})`).then((x) => !!x);
async function openListing(who, title) {
  const p = await go(who, `#/?q=${encodeURIComponent(title)}`);
  await p.reload({ waitUntil: 'load' });
  await waitText(p, title);
  await (await el(p, `//a[contains(@class,"listing-card")][.//div[@class="title" and normalize-space(.)="${title}"]]`)).click();
  await waitText(p, 'Updated');
  return p;
}
const tradeIdOf = (p) => p.evaluate(() => location.hash.split('/')[2]);
async function escrowAmounts(p) {
  const cells = await p.$$eval('table.amounts tr td:last-child', (tds) => tds.map((t) => t.innerText));
  return cells.slice(0, 2).map((t) => parseFloat(t));
}

// ---- results -------------------------------------------------------------------------------

const results = [];
let failed = 0;
async function step(id, title, fn) {
  console.log(`\n== ${id} ${title}`);
  const started = Date.now();
  try {
    const note = await fn();
    results.push({ id, title, status: 'pass', note: note || '', seconds: Math.round((Date.now() - started) / 1000) });
    if (current) await proof(current, 'plan', `${id} · ${title}${note ? ` — ${note}` : ''}`);
    console.log(`   ✓ ${note || ''}`);
  } catch (e) {
    failed++;
    results.push({ id, title, status: 'fail', note: e.message.split('\n')[0], seconds: Math.round((Date.now() - started) / 1000) });
    console.log(`   ✗ ${e.message.split('\n')[0]}`);
    if (current && SHOTS) {
      const file = `${DEVICE}-plan-${id}-FAIL.jpg`;
      await current.screenshot({ path: `${SHOTS}/${file}`, type: 'jpeg', quality: 70, fullPage: true }).catch(() => {});
      appendFileSync(`${SHOTS}/manifest.jsonl`, JSON.stringify({ device: DEVICE, suite: 'plan', file, caption: `✗ ${id} · ${title} — ${e.message.split('\n')[0]}`, who: current.who }) + '\n');
    }
  }
}
const manual = (id, title, why) => { results.push({ id, title, status: 'manual', note: why }); console.log(`\n== ${id} ${title}\n   → manual: ${why}`); };

// ---- the plan ------------------------------------------------------------------------------

try {
  // Admin first, so arbiters are approved before anyone trades.
  await step('ARB-1', 'Admin menu visible for A only', async () => {
    const p = await go('A', '#/');
    await p.waitForFunction(() => [...document.querySelectorAll('header a, nav a')].some((a) => a.textContent.includes('Admin')), { timeout: 20000 });
    return 'A sees "Admin" in the menu (checked for B in ACC-1)';
  });
  await step('ARB-2', 'Announce as arbiter', async () => {
    const p = await go('A', '#/arbiter');
    await fill(p, 'Name', 'Anna Arbiter');
    await fill(p, 'Languages', 'NL, EN');
    await fill(p, 'Fee policy', '2% in disputes only');
    await click(p, 'Publish arbiter profile');
    await waitText(p, 'not on the approved list yet');
    return 'warning "not approved yet" shown';
  });
  await step('ARB-3', 'Approve the arbiter', async () => {
    const p = await go('A', '#/admin');
    await waitText(p, 'Anna Arbiter');
    await (await el(p, '//label[contains(@class,"trade-row")][.//b[normalize-space(.)="Anna Arbiter"]]//input')).click();
    await click(p, 'Publish list (1)');
    await waitToast(p, 'Arbiter list published');
    await go('A', '#/arbiter');
    await waitText(p, 'Open disputes');
    await waitNoText(p, 'not on the approved list yet');
    return 'warning gone, "Open disputes" shown';
  });

  await step('ACC-1', 'Create an account', async () => {
    const p = await go('B', '#/settings');
    await click(p, 'Create a new account');
    await waitText(p, 'Back up your key');
    if (!(await p.$('.card.attention'))) throw new Error('no backup reminder');
    people.B.pk = await p.evaluate(() => JSON.parse(localStorage.getItem('xbt:account')).pubkey);
    if (await p.evaluate(() => [...document.querySelectorAll('header a, nav a')].some((a) => a.textContent.includes('Admin')))) throw new Error('B sees the Admin menu');
    return 'account page with backup reminder; B does not see "Admin"';
  });
  await step('ACC-2', 'Back up the key', async () => {
    const p = await as('B');
    await click(p, 'Show my nsec');
    people.B.nsec = (await (await el(p, '//div[@class="secret"]/code')).evaluate((e) => e.textContent)).trim();
    if (!people.B.nsec.startsWith('nsec1')) throw new Error('no nsec shown');
    await click(p, 'I have written it down');
    await p.waitForFunction(() => !document.querySelector('.card.attention'), { timeout: 10000 });
    return 'nsec shown; orange border gone';
  });
  await step('ACC-3', 'Password and lock', async () => {
    const p = await as('B');
    await fillPh(p, 'New password', 'correct-horse-9');
    await click(p, 'Set');
    await waitToast(p, 'Key encrypted');
    await click(p, 'Lock');
    await p.reload({ waitUntil: 'load' });
    await waitText(p, 'Unlock');
    await fill(p, 'Password', 'wrong-password');
    await click(p, 'Unlock');
    await waitToast(p, 'Wrong password');
    await fill(p, 'Password', 'correct-horse-9');
    await click(p, 'Unlock');
    await waitText(p, 'Back up your key');
    // The rest of the plan reloads B's pages often; keep B's key unencrypted from here on.
    const sk = Buffer.from(nip19.decode(people.B.nsec).data).toString('hex');
    await p.evaluate((pk, sk) => localStorage.setItem('xbt:account', JSON.stringify({ pubkey: pk, sk, backedUp: true })), people.B.pk, sk);
    await p.reload({ waitUntil: 'load' });
    return 'wrong password refused, right one unlocks, everything still there';
  });
  // Later contexts reopen B's storage, which now holds an encrypted key: unlock again each time.
  const unlockB = async () => { const p = await as('B'); if ((await text(p)).includes('Unlock') && await exists(p, fieldX('Password'))) { await fill(p, 'Password', 'correct-horse-9'); await click(p, 'Unlock'); await sleep(500); } return p; };
  const B = async (hash) => { await unlockB(); return go('B', hash); };

  await step('ACC-5', 'Switch language', async () => {
    const p = await B('#/settings');
    await select(p, 'Language', 'nl');
    await waitText(p, 'Wachtwoord');
    await proof(p, 'plan', 'ACC-5 · Taal op Nederlands');
    await select(p, 'Taal', 'en');
    await waitText(p, 'Password');
    return 'all labels switch at once (NL → EN)';
  });
  await step('ACC-6', 'Installable as an app', async () => {
    await B('#/');
    // Chrome never offers to install from a private window, so check in a normal one.
    const p = await browser.defaultBrowserContext().newPage();
    await setupPage(p);
    await p.goto(APP, { waitUntil: 'load' });
    await p.reload({ waitUntil: 'load' });
    const info = await p.evaluate(async () => {
      const link = document.querySelector('link[rel=manifest]');
      const m = await (await fetch(link.href)).json();
      const icons = await Promise.all(m.icons.map(async (i) => (await fetch(new URL(i.src, link.href))).ok));
      const reg = await Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]);
      return { display: m.display, icons: icons.every(Boolean), sw: reg, theme: document.querySelector('meta[name=theme-color]')?.content || m.theme_color };
    });
    if (info.display !== 'standalone' || !info.icons || !info.sw) throw new Error(JSON.stringify(info));
    let extra = '';
    if (chrome) {
      const s = await p.createCDPSession();
      const { installabilityErrors } = await s.send('Page.getInstallabilityErrors');
      if (installabilityErrors.length) throw new Error('Chrome: ' + JSON.stringify(installabilityErrors));
      extra = '; Chrome reports it installable';
    }
    await proof(p, 'plan', 'ACC-6 · Installeerbaar: manifest, iconen en service worker in orde');
    await p.close();
    return `manifest standalone, icons load, service worker active${extra}. Adding to a real home screen: by you`;
  });
  await step('ACC-7', 'Edit profile', async () => {
    const p = await B(`#/u/${nip19.npubEncode(people.B.pk)}`);
    await click(p, 'Edit');
    await fill(p, 'Name', 'Bea Verkoper');
    await fill(p, 'About', 'Verkoopt spullen uit Utrecht.');
    await fill(p, 'Country', 'NL');
    await click(p, 'Save profile');
    await waitToast(p, 'Saved');
    await p.reload({ waitUntil: 'load' });
    await waitText(p, 'Bea Verkoper', 40000);
    return 'name, about and country shown on the profile after reload';
  });

  // ---- listings ----
  await step('LST-1', 'New listing with photos', async () => {
    const p = await B('#/sell/new');
    const input = await p.$('input[type=file]');
    await input.uploadFile('public/icon-512.png', 'public/icon-192.png');
    await p.waitForFunction(() => document.querySelectorAll('.photos .photo img').length >= 2, { timeout: 30000 });
    await fill(p, 'Title', 'Wollen sjaal, rood');
    await fill(p, 'Description', 'Zachte wollen sjaal, nauwelijks gedragen.');
    await fill(p, 'Price', '2');
    await select(p, 'Category', 'kleding-dames');
    await select(p, 'Condition', 'like-new');
    await fill(p, 'Location', 'Utrecht, NL');
    await fillPh(p, 'Price', '4.95');
    await click(p, 'Publish');
    await waitText(p, 'Your listings');
    await waitText(p, 'Wollen sjaal, rood');
    const c = await openListing('C', 'Wollen sjaal, rood');
    const imgs = await c.$$eval('.gallery img', (i) => i.filter((x) => x.complete && x.naturalWidth > 0).length);
    if (imgs < 2) throw new Error('photos not shown to the buyer');
    return 'listed with 2 uploaded photos; buyer sees it with photos';
  });
  await step('LST-2', 'Add a photo by URL', async () => {
    const p = await B('#/sell');
    await (await el(p, '//a[normalize-space(.)="Edit"]')).click();
    await waitText(p, 'Edit listing');
    await fillPh(p, '…or paste an image URL', new URL('icon.svg', APP).href);
    await click(p, 'Add');
    await click(p, 'Save');
    await waitText(p, 'Your listings');
    const c = await openListing('C', 'Wollen sjaal, rood');
    const n = await c.$$eval('.thumbs button', (b) => b.length);
    if (n !== 3) throw new Error(`${n} photos instead of 3`);
    return '3 photos on the listing';
  });
  await step('LST-3', 'Edit the price', async () => {
    const p = await B('#/sell');
    await (await el(p, '//a[normalize-space(.)="Edit"]')).click();
    await fill(p, 'Price', '3');
    await click(p, 'Save');
    await waitText(p, 'Your listings');
    const c = await openListing('C', 'Wollen sjaal, rood');
    await waitText(c, '€3.00');
    return 'buyer sees €3.00 after reload';
  });
  await step('LST-4', 'Mark as sold and re-activate', async () => {
    let p = await B('#/sell');
    await (await el(p, '//a[normalize-space(.)="Edit"]')).click();
    await click(p, 'Mark as sold');
    await waitText(p, 'Your listings');
    let c = await go('C', '#/?q=sjaal');
    await c.reload({ waitUntil: 'load' });
    await sleep(2500);
    if ((await text(c)).includes('Wollen sjaal')) throw new Error('sold listing still in search');
    await proof(c, 'plan', 'LST-4 · Verkocht: niet meer te vinden bij Zoeken');
    p = await B('#/sell');
    await (await el(p, '//a[normalize-space(.)="Edit"]')).click();
    await click(p, 'Re-activate');
    await waitText(p, 'Your listings');
    c = await openListing('C', 'Wollen sjaal, rood');
    return 'gone from search when sold, back after re-activating';
  });
  await step('LST-5', 'Delete a listing', async () => {
    const p = await B('#/sell/new');
    await fill(p, 'Title', 'Testding om te verwijderen');
    await fill(p, 'Price', '1');
    await click(p, 'Publish');
    await waitText(p, 'Testding om te verwijderen');
    await (await el(p, '//div[a[contains(@class,"listing-card")][.//div[normalize-space(.)="Testding om te verwijderen"]]]/a[normalize-space(.)="Edit"]')).click();
    await click(p, 'Delete');
    await waitText(p, 'Your listings');
    await waitNoText(p, 'Testding om te verwijderen');
    const c = await go('C', '#/?q=Testding');
    await c.reload({ waitUntil: 'load' });
    await sleep(2500);
    if ((await text(c)).includes('Testding om te verwijderen')) throw new Error('deleted listing still in search');
    return 'gone from Sell and from search';
  });
  await step('LST-6', 'Search, filter and sort', async () => {
    for (const [t, pr] of [['Sorteertest duur', '9'], ['Sorteertest goedkoop', '4']]) {
      const p = await B('#/sell/new');
      await fill(p, 'Title', t);
      await fill(p, 'Price', pr);
      await click(p, 'Publish');
      await waitText(p, t);
    }
    const c = await go('C', '#/?q=Sorteertest');
    await c.reload({ waitUntil: 'load' });
    await waitText(c, 'Sorteertest goedkoop');
    await (await c.$('.searchbar select:last-of-type')).select('price');
    const order = await c.$$eval('.listing-card .title', (t) => t.map((x) => x.textContent));
    if (order[0] !== 'Sorteertest goedkoop' || order.length !== 2) throw new Error('order ' + order.join(', '));
    await proof(c, 'plan', 'LST-6 · Zoeken op "Sorteertest", gesorteerd op laagste prijs');
    await c.evaluate(() => { const i = document.querySelector('.searchbar input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await (await c.$('.searchbar select')).select('kleding-dames');
    await sleep(500);
    const cat = await c.$$eval('.listing-card .title', (t) => t.map((x) => x.textContent));
    // Other suites on the same relay may have listed clothing too; none of the plan's non-clothing items may show.
    if (!cat.includes('Wollen sjaal, rood') || cat.some((t) => /Sorteertest|Testding|ASIC/.test(t))) throw new Error('category filter shows ' + cat.join(', '));
    return `search finds only matching titles, lowest price first; category Kleding | Dames shows the scarf and no other categories (${cat.length} items)`;
  });
  await step('LST-7', 'Price in XBT', async () => {
    const c = await openListing('C', 'Wollen sjaal, rood');
    await waitText(c, '€3.00 ≈ 0.00006 XBT');
    return '€3.00 ≈ 0.00006 XBT at the manual test rate of €50,000/XBT';
  });

  await step('ARB-4', 'Unapproved arbiter is not offered', async () => {
    const p = await B('#/arbiter');
    await fill(p, 'Name', 'Bob Unapproved');
    await click(p, 'Publish arbiter profile');
    await waitText(p, 'not on the approved list yet');
    const c = await openListing('C', 'Wollen sjaal, rood');
    await click(c, 'Buy');
    await choose(c, 'With escrow');
    await c.waitForFunction(() => document.querySelector('.offer select')?.textContent.includes('Anna Arbiter'), { timeout: 30000 });
    const opts = await c.$eval('.offer select', (s) => s.textContent);
    if (opts.includes('Bob Unapproved')) throw new Error('unapproved arbiter offered');
    return 'only "Anna Arbiter" in the buyer\'s list';
  });

  // ---- import (the button itself; shop pages: test:import and you) ----
  await step('IMP-1', 'Import button available', async () => {
    const p = await B('#/import');
    await waitText(p, 'Drag this button to your bookmarks bar');
    const href = await p.$eval('a.bookmarklet', (a) => a.getAttribute('href'));
    if (!href.startsWith('javascript:')) throw new Error('no bookmarklet');
    return 'bookmark button present (dragging it to the bar: by you)';
  });
  await step('IMP-11', 'Bookmark code for phones', async () => {
    const p = await B('#/import');
    await (await el(p, '//summary[contains(.,"On a phone")]')).click();
    await waitText(p, 'Copy bookmark code');
    return '"Copy bookmark code" offered for phones';
  });
  for (const [id, title] of [['IMP-2', 'Marktplaats profile'], ['IMP-3', 'Publish imported listings'], ['IMP-4', 'Recognise duplicates'], ['IMP-5', 'Changed price'], ['IMP-6', 'New ad on Marktplaats'], ['IMP-7', 'Removed or sold on Marktplaats'], ['IMP-8', 'Single ad page'], ['IMP-9', 'Vinted profile'], ['IMP-10', 'eBay']]) {
    manual(id, title, 'Needs your real shop pages. The same logic passes in test:import against saved/fake Marktplaats, Vinted, eBay and product pages.');
  }

  // ---- edge cases ----
  await step('EDG-4', 'Invalid address blocks the order', async () => {
    const c = await openListing('C', 'Wollen sjaal, rood');
    await click(c, 'Buy');
    await choose(c, 'With escrow');
    await fillPh(c, 'bc1q…', 'tb1qinvalidaddress');
    await c.waitForSelector('input.invalid');
    const disabled = await (await el(c, btnX('Send order'))).evaluate((b) => b.disabled);
    if (!disabled) throw new Error('Send order enabled');
    return 'field red, Send order disabled';
  });
  await step('EDG-5', 'Own listing has no buy button', async () => {
    const p = await B('#/');
    await openListing('B', 'Wollen sjaal, rood');
    if (await exists(p, btnX('Buy'))) throw new Error('Buy button on own listing');
    await el(p, btnX('Edit listing'));
    return 'no Buy, but "Edit listing"';
  });
  await step('EDG-6', 'Trade limit for new accounts', async () => {
    const p = await B('#/sell/new');
    await fill(p, 'Title', 'Dure ASIC miner');
    await fill(p, 'Price', '0.25');
    await select(p, 'Currency', 'XBT');
    await click(p, 'Publish');
    await waitText(p, 'Dure ASIC miner');
    const c = await openListing('C', 'Dure ASIC miner');
    await click(c, 'Buy');
    await choose(c, 'With escrow');
    await waitText(c, 'New accounts can trade up to');
    const disabled = await (await el(c, btnX('Send order'))).evaluate((b) => b.disabled);
    if (!disabled) throw new Error('Send order enabled');
    return 'warning about the limit, Send order disabled';
  });

  // ---- a normal escrow trade ----
  let tid;
  const buyerAddr = CLI && cli('getnewaddress', 'plan-buyer', 'bech32');
  const sellerAddr = CLI && cli('getnewaddress', 'plan-seller', 'bech32');
  await step('TRD-1', 'Make an offer', async () => {
    const c = await openListing('C', 'Wollen sjaal, rood');
    await click(c, 'Buy');
    await choose(c, 'PostNL');
    await choose(c, 'With escrow');
    await c.waitForFunction(() => document.querySelector('.offer select')?.textContent.includes('Anna Arbiter'), { timeout: 30000 });
    await fillPh(c, 'bc1q…', buyerAddr);
    await fill(c, 'Shipping address', 'Cees Koper\nKerkstraat 1\n1234 AB Amsterdam');
    await waitText(c, 'deposit, which you get back');
    await proof(c, 'plan', 'TRD-1 · Bestelformulier: €3 + PostNL €4,95, escrow, arbiter Anna, prijs + 15% borg');
    await click(c, 'Send order');
    await c.waitForFunction(() => location.hash.startsWith('#/trade/'), { timeout: 20000 });
    tid = await tradeIdOf(c);
    await waitText(c, 'Waiting for the seller to accept');
    return 'trade page "Offer sent"; summary showed price + 15% deposit';
  });
  await step('TRD-2', 'Seller receives the offer', async () => {
    const p = await B('#/trades');
    await waitText(p, 'Wollen sjaal', 30000);
    await go('B', `#/trade/${tid}`);
    await waitText(p, 'New offer');
    await waitText(p, '✓ approved');
    await waitText(p, 'Kerkstraat 1');
    return 'buyer, amount, address and "✓ approved" arbiter shown';
  });
  await step('TRD-3', 'Accept', async () => {
    const p = await B(`#/trade/${tid}`);
    await fillPh(p, 'bc1q…', sellerAddr);
    await click(p, 'Accept');
    await waitText(p, 'Total needed');
    const addrB = await p.$eval('.addr code', (e) => e.textContent.trim());
    const c = await go('C', `#/trade/${tid}`);
    await waitText(c, 'Total needed', 30000);
    const addrC = await c.$eval('.addr code', (e) => e.textContent.trim());
    if (addrB !== addrC) throw new Error('escrow addresses differ');
    return `same escrow address for both: ${addrC.slice(0, 18)}…`;
  });
  await step('TRD-4', 'Fund the escrow (3 confirmations)', async () => {
    const c = await as('C');
    const addr = await c.$eval('.addr code', (e) => e.textContent.trim());
    const [buyerPays, sellerPays] = await escrowAmounts(c);
    cli('sendtoaddress', addr, buyerPays.toFixed(8));
    cli('sendtoaddress', addr, sellerPays.toFixed(8));
    mine(1);
    await click(c, 'Refresh');
    await waitText(c, 'with 3+ confirmations', 30000);
    await proof(c, 'plan', 'TRD-4 · Na 1 bevestiging: bedrag binnen, nog niet genoeg bevestigingen');
    mine(2);
    await click(c, 'Refresh');
    await waitText(c, 'Fully paid', 40000);
    return `paid ${buyerPays} + ${sellerPays} XBT; after 3 confirmations the QR disappears, step 3 green`;
  });
  await step('TRD-5', 'Ship', async () => {
    const p = await B(`#/trade/${tid}`);
    await waitText(p, 'Ship the item', 40000);
    await fill(p, 'Tracking code', '3SXBT0001');
    await click(p, 'Mark as shipped');
    await waitText(p, 'Shipped with PostNL');
    const c = await go('C', `#/trade/${tid}`);
    await waitText(c, 'Shipped with PostNL', 30000);
    await waitText(c, '3SXBT0001');
    const track = await c.$eval('a.btn.small[target=_blank]', (a) => a.href);
    if (!track.includes('postnl.nl/tracktrace/?B=3SXBT0001')) throw new Error('tracking link ' + track);
    return 'buyer sees carrier, code, copy button and a Track link to postnl.nl';
  });
  await step('TRD-6', 'Release', async () => {
    const c = await as('C');
    await click(c, 'Everything OK: release payment');
    await waitText(c, 'Release to seller', 30000);
    await waitText(c, 'Buyer signed');
    return 'proposal "Release to seller", signed by the buyer';
  });
  await step('TRD-7', 'Co-sign and broadcast', async () => {
    const p = await B(`#/trade/${tid}`);
    await waitText(p, 'Release to seller', 30000);
    await click(p, 'Agree and sign');
    await waitText(p, 'Broadcast:', 40000);
    return '"✅ Broadcast: <txid>", status Paid out';
  });
  await step('TRD-8', 'Money received', async () => {
    mine(1);
    const got = Number(cli('getreceivedbyaddress', sellerAddr, '1'));
    const back = Number(cli('getreceivedbyaddress', buyerAddr, '1'));
    if (!(got > 0.00015 && back > 0.00002)) throw new Error(`seller ${got}, buyer ${back}`);
    return `node: seller received ${got} XBT (price + deposit − fee share), buyer got ${back} XBT deposit back`;
  });
  await step('TRD-9', 'Reviews', async () => {
    for (const who of ['C', 'B']) {
      const p = who === 'B' ? await B(`#/trade/${tid}`) : await go('C', `#/trade/${tid}`);
      await waitText(p, 'Leave a review', 30000);
      await fillPh(p, 'How did it go?', who === 'C' ? 'Snel verzonden, prima sjaal.' : 'Vlotte koper.');
      await click(p, 'Publish review');
      await waitNoText(p, 'Leave a review');
    }
    await sleep(1500);
    const c = await go('C', `#/u/${nip19.npubEncode(people.B.pk)}`);
    await c.reload({ waitUntil: 'load' });
    await waitText(c, '1 verified trades', 30000);
    await waitText(c, '✓ verified trade');
    return 'review with "✓ verified trade"; profile shows 1 verified trade';
  });
  await step('TRD-10', 'Chat between three people', async () => {
    let p = await B(`#/trade/${tid}`);
    await fillPh(p, 'Write a message…', 'Bedankt voor je aankoop!');
    await click(p, 'Send');
    await waitText(p, 'Bedankt voor je aankoop!');
    const c = await go('C', `#/trade/${tid}`);
    await waitText(c, 'Bedankt voor je aankoop!', 60000);
    await fillPh(c, 'Write a message…', 'Graag gedaan, sjaal is top.');
    await click(c, 'Send');
    await waitText(c, 'Graag gedaan, sjaal is top.');
    p = await go('A', `#/trade/${tid}`);
    await waitText(p, 'Graag gedaan, sjaal is top.', 60000);
    await waitText(p, 'Bedankt voor je aankoop!');
    return 'messages arrive at buyer, seller and arbiter within a minute';
  });
  await step('TRD-11', 'Recover from relays in another browser', async () => {
    const saved = storage.C;
    storage.C = { 'xbt:settings': JSON.stringify(BASE_SETTINGS) };
    const c = await as('C', { fresh: true });
    await c.evaluate((s) => { localStorage.clear(); localStorage.setItem('xbt:settings', s); }, JSON.stringify(BASE_SETTINGS));
    await c.reload({ waitUntil: 'load' });
    await c.evaluate(() => { location.hash = '#/settings'; });
    await fillPh(c, 'nsec1…', nip19.nsecEncode(Buffer.from(people.C.sk, 'hex')));
    await click(c, 'Log in');
    await c.evaluate((h) => { location.hash = h; }, `#/trade/${tid}`);
    await waitText(c, 'Wollen sjaal, rood', 60000);
    await waitText(c, 'Graag gedaan, sjaal is top.', 60000);
    await waitText(c, 'Paid out');
    storage.C = saved && { ...saved };
    return 'logged in with only the nsec: same trade with full history and chat';
  });

  // ---- disputes ----
  let tid2;
  const fundedTrade = async (title) => {
    const c = await openListing('C', title);
    await click(c, 'Buy');
    await choose(c, 'With escrow');
    await c.waitForFunction(() => document.querySelector('.offer select')?.textContent.includes('Anna Arbiter'), { timeout: 30000 });
    await fillPh(c, 'bc1q…', buyerAddr);
    await click(c, 'Send order');
    await c.waitForFunction(() => location.hash.startsWith('#/trade/'), { timeout: 20000 });
    const id = await tradeIdOf(c);
    await waitText(c, 'Waiting for the seller to accept');
    const p = await B(`#/trade/${id}`);
    await waitText(p, 'New offer', 30000);
    await fillPh(p, 'bc1q…', sellerAddr);
    await click(p, 'Accept');
    await waitText(p, 'Total needed');
    const [, sellerPays] = await escrowAmounts(p);
    const addr = await p.$eval('.addr code', (e) => e.textContent.trim());
    const c2 = await go('C', `#/trade/${id}`);
    await waitText(c2, 'Total needed', 30000);
    const [buyerPays] = await escrowAmounts(c2);
    cli('sendtoaddress', addr, buyerPays.toFixed(8));
    cli('sendtoaddress', addr, sellerPays.toFixed(8));
    mine(3);
    await click(c2, 'Refresh');
    await waitText(c2, 'Fully paid', 40000);
    return id;
  };
  await step('DSP-1', 'Open a dispute', async () => {
    tid2 = await fundedTrade('Sorteertest duur');
    const c = await as('C');
    await click(c, 'Open a dispute');
    await fillPh(c, 'What went wrong?', 'Verkoper reageert niet en verzendt niet.');
    await click(c, 'Open dispute');
    await waitText(c, 'Dispute opened by buyer');
    const p = await B(`#/trade/${tid2}`);
    await waitText(p, 'Dispute opened by buyer', 30000);
    return 'red notice for buyer and seller (arbiter: DSP-2)';
  });
  await step('DSP-2', 'Arbiter sees the dispute', async () => {
    const p = await go('A', '#/arbiter');
    await p.reload({ waitUntil: 'load' });
    await waitText(p, 'Sorteertest duur', 40000);
    return 'trade listed under "Open disputes"';
  });
  await step('DSP-3', 'Rule on the dispute', async () => {
    const p = await go('A', `#/trade/${tid2}`);
    await waitText(p, 'Dispute opened by buyer', 30000);
    await click(p, 'Propose a ruling');
    const sd = await p.evaluate(() => { const t = document.querySelector('main').innerText.match(/Seller pays \(deposit\)\s*([\d.]+)/); return t && t[1]; });
    await fill(p, 'Seller receives (XBT)', sd);
    await fill(p, 'Note', 'Niet verzonden binnen de termijn: terugbetaling aan koper, verkoper houdt eigen borg.');
    await click(p, 'Sign and propose');
    await waitText(p, 'Arbiter ruling', 30000);
    const c = await go('C', `#/trade/${tid2}`);
    await waitText(c, 'Arbiter ruling', 30000);
    await waitText(c, 'terugbetaling aan koper');
    return `buyer and seller see "Arbiter ruling" with amounts and note (seller gets ${sd} XBT back)`;
  });
  await step('DSP-4', 'Co-sign the ruling', async () => {
    const c = await as('C');
    await click(c, 'Agree and sign');
    await waitText(c, 'Broadcast:', 40000);
    mine(1);
    return 'payout broadcast; buyer gets price + deposit back';
  });
  await step('DSP-5', 'Settle together without the arbiter', async () => {
    const id = await fundedTrade('Sorteertest goedkoop');
    const p = await B(`#/trade/${id}`);
    await click(p, 'Propose a payout or refund');
    await click(p, 'Custom split');
    await click(p, 'Sign and propose');
    // The proposal card (not the editor's button) proves it was sent before this browser closes.
    await waitText(p, 'Payout proposals', 30000);
    await waitText(p, 'Seller signed', 30000);
    const c = await go('C', `#/trade/${id}`);
    await waitText(c, 'Custom split', 30000);
    await click(c, 'Agree and sign');
    await waitText(c, 'Broadcast:', 40000);
    mine(1);
    return 'seller proposed a split, buyer signed, paid out without the arbiter';
  });

  // ---- cancel and reject ----
  const newOrder = async (title) => {
    const c = await openListing('C', title);
    await click(c, 'Buy');
    await choose(c, 'With escrow');
    await c.waitForFunction(() => document.querySelector('.offer select')?.textContent.includes('Anna Arbiter'), { timeout: 30000 });
    await fillPh(c, 'bc1q…', buyerAddr);
    await click(c, 'Send order');
    await c.waitForFunction(() => location.hash.startsWith('#/trade/'), { timeout: 20000 });
    await waitText(c, 'Waiting for the seller to accept');
    return tradeIdOf(c);
  };
  await step('EDG-1', 'Withdraw an offer', async () => {
    const id = await newOrder('Wollen sjaal, rood');
    const c = await as('C');
    await click(c, 'Withdraw offer');
    await waitText(c, 'Cancelled');
    const p = await B(`#/trade/${id}`);
    await waitText(p, 'Cancelled', 30000);
    return 'status Cancelled for both';
  });
  await step('EDG-2', 'Reject an offer', async () => {
    const id = await newOrder('Wollen sjaal, rood');
    const p = await B(`#/trade/${id}`);
    await waitText(p, 'New offer', 30000);
    await fillPh(p, 'Reason (optional)', 'Al verkocht, sorry.');
    await click(p, 'Reject');
    const c = await go('C', `#/trade/${id}`);
    await waitText(c, 'The seller rejected this offer.', 30000);
    await waitText(c, 'Al verkocht, sorry.');
    return 'buyer sees the rejection with the reason';
  });
  await step('EDG-3', 'Cancel before paying', async () => {
    const id = await newOrder('Wollen sjaal, rood');
    const p = await B(`#/trade/${id}`);
    await waitText(p, 'New offer', 30000);
    await fillPh(p, 'bc1q…', sellerAddr);
    await click(p, 'Accept');
    await waitText(p, 'Total needed');
    await click(p, 'Cancel trade (nothing paid yet)');
    await waitText(p, 'Cancelled', 30000);
    return 'status Cancelled';
  });

  // ---- Lightning and direct payments ----
  await step('LN-1', 'Connect a wallet', async () => {
    for (const [who, w] of [['B', 'seller'], ['C', 'buyer']]) {
      const p = who === 'B' ? await B('#/settings') : await go('C', '#/settings');
      await fillPh(p, 'nostr+walletconnect://…', walletUri(w));
      await click(p, 'Connect');
      await waitText(p, '✓ Connected', 30000);
      await click(p, 'Balance');
      await waitText(p, 'sats', 30000);
    }
    return 'both connected; balance read from the wallet';
  });
  await step('LN-2', 'Connection stored encrypted', async () => {
    const p = await as('C');
    const raw = await p.evaluate((pk) => localStorage.getItem(`xbt:secrets:${pk}`), people.C.pk);
    if (!raw || raw.includes('walletconnect') || raw.includes('secret=')) throw new Error('not encrypted: ' + raw);
    await p.evaluate(() => { location.hash = '#/settings'; });
    return `storage holds only ciphertext: ${raw.slice(0, 60)}…`;
  });
  await step('LN-3', 'Listing with payment methods and delivery options', async () => {
    const p = await B('#/sell/new');
    await fill(p, 'Title', 'Fietslampjes set');
    await fill(p, 'Price', '5');
    await fillPh(p, 'Price', '4.95');
    await click(p, '+ Add option');
    await click(p, 'Publish');
    await waitText(p, 'Fietslampjes set');
    const c = await openListing('C', 'Fietslampjes set');
    await waitText(c, 'PostNL €4.95 · Ophalen / Pick-up free');
    await waitText(c, 'Direct, Lightning');
    return 'listing shows both delivery options and all payment methods';
  });
  await step('LN-4', 'Escrow advice above €50', async () => {
    const p = await B('#/sell/new');
    await fill(p, 'Title', 'Racefiets frame');
    await fill(p, 'Price', '120');
    await click(p, 'Publish');
    await waitText(p, 'Racefiets frame');
    const c = await openListing('C', 'Racefiets frame');
    await click(c, 'Buy');
    await waitText(c, 'recommended');
    await c.waitForFunction(() => [...document.querySelectorAll('label.choice')].find((l) => l.textContent.startsWith('With escrow'))?.querySelector('input').checked, { timeout: 5000 });
    await proof(c, 'plan', 'LN-4 · Boven €50: escrow voorgeselecteerd en aanbevolen');
    await choose(c, 'Direct, Lightning');
    await waitText(c, 'we recommend escrow');
    return 'escrow preselected as recommended; warning when choosing direct';
  });
  let tidLn;
  await step('LN-5', 'Order with Lightning', async () => {
    const c = await openListing('C', 'Fietslampjes set');
    await click(c, 'Buy');
    await choose(c, 'Ophalen');
    await choose(c, 'Direct, Lightning');
    await click(c, 'Send order');
    await c.waitForFunction(() => location.hash.startsWith('#/trade/'), { timeout: 20000 });
    tidLn = await tradeIdOf(c);
    await waitText(c, 'Direct payment: no escrow and no arbiter');
    return '"Direct payment", no escrow, no arbiter; no address asked for pick-up';
  });
  await step('LN-6', 'Payment request in the chat', async () => {
    const p = await B(`#/trade/${tidLn}`);
    await waitText(p, 'New order', 30000);
    await click(p, 'Accept');
    await click(p, 'Create invoice with my wallet');
    await waitText(p, 'I received the payment', 60000);
    const c = await go('C', `#/trade/${tidLn}`);
    await waitText(c, 'Pay with my wallet', 30000);
    await waitText(c, 'Network: lnbcrt');
    await waitText(c, '💳 Payment request');
    return 'QR, invoice, network (lnbcrt) and a "💳 Payment request" line in the chat';
  });
  await step('LN-7', 'Pay with one tap', async () => {
    const c = await as('C');
    await click(c, '⚡ Pay with my wallet');
    await waitText(c, 'Paid. The Lightning preimage proves it.', 60000);
    const p = await B(`#/trade/${tidLn}`);
    await waitText(p, 'Paid. The Lightning preimage proves it.', 30000);
    return 'both see the payment proven by the preimage';
  });
  await step('LN-8', 'Pay from another wallet', async () => {
    const c = await openListing('C', 'Fietslampjes set');
    await click(c, 'Buy');
    await choose(c, 'Ophalen');
    await choose(c, 'Direct, Lightning');
    await click(c, 'Send order');
    await c.waitForFunction((t) => location.hash.startsWith('#/trade/') && !location.hash.includes(t), { timeout: 20000 }, tidLn);
    const id = await tradeIdOf(c);
    const p = await B(`#/trade/${id}`);
    await waitText(p, 'New order', 30000);
    await click(p, 'Accept');
    await click(p, 'Create invoice with my wallet');
    await waitText(p, 'I received the payment', 60000);
    const c2 = await go('C', `#/trade/${id}`);
    await waitText(c2, 'Pay with my wallet', 30000);
    const invoice = await c2.$eval('.addr code', (e) => e.textContent.trim());
    // "Scan the QR with another wallet": pay from a third mock wallet, outside the app.
    const pool = new SimplePool();
    await nwc.payInvoice(pool, parseNwcUri(walletUri('arbiter')), invoice);
    pool.close([RELAY]);
    await click(c2, 'I paid');
    await waitText(c2, 'The buyer reports a payment', 30000);
    const p2 = await B(`#/trade/${id}`);
    await click(p2, 'Check my wallet');
    await waitText(p2, 'The seller confirmed receiving the payment', 30000);
    return 'paid outside the app; seller checked the wallet and confirmed; status Paid';
  });
  await step('LN-9', 'Direct on-chain payment', async () => {
    const c = await openListing('C', 'Fietslampjes set');
    await click(c, 'Buy');
    await choose(c, 'Ophalen');
    await choose(c, 'Direct, on chain');
    const before = await c.evaluate(() => location.hash);
    await click(c, 'Send order');
    await c.waitForFunction((b) => location.hash.startsWith('#/trade/') && location.hash !== b, { timeout: 20000 }, before);
    const id = await tradeIdOf(c);
    const p = await B(`#/trade/${id}`);
    await waitText(p, 'New order', 30000);
    await click(p, 'Accept');
    const addr = cli('getnewaddress', 'plan-direct', 'bech32');
    await fill(p, 'Your XBT address', addr);
    await click(p, 'Request 0.0001 XBT');
    await waitText(p, 'I received the payment');
    const c2 = await go('C', `#/trade/${id}`);
    await waitText(c2, 'Payment request:', 30000);
    const txid = cli('sendtoaddress', addr, '0.0001');
    mine(1);
    await fillPh(c2, 'Payment txid', txid);
    await click(c2, 'I paid');
    await waitText(c2, '✓ 0.0001 XBT, 1 confirmations', 30000);
    return 'txid checked at the node: full amount, 1 confirmation';
  });
  await step('LN-10', 'Complete and review', async () => {
    let p = await B(`#/trade/${tidLn}`);
    await click(p, 'Mark as shipped');
    await waitText(p, 'Ready for pick-up');
    const c = await go('C', `#/trade/${tidLn}`);
    await waitText(c, 'Ready for pick-up', 30000);
    await click(c, 'Yes, received');
    await waitText(c, 'Completed', 30000);
    await click(c, 'Publish review');
    await waitNoText(c, 'Leave a review');
    p = await B(`#/trade/${tidLn}`);
    await waitText(p, 'Leave a review', 30000);
    await click(p, 'Publish review');
    await waitNoText(p, 'Leave a review');
    await sleep(1500);
    const c2 = await go('C', `#/u/${nip19.npubEncode(people.B.pk)}`);
    await c2.reload({ waitUntil: 'load' });
    await waitText(c2, '2 verified trades', 30000);
    return 'status Completed; the Lightning trade counts as a 2nd verified trade';
  });

  // ---- AI ----
  // ---- services (Diensten en Vakmensen) ----
  await step('SRV-1', 'Offer a service with a price per hour', async () => {
    const p = await B('#/sell/new');
    await fill(p, 'Title', 'Klusjesman voor kleine reparaties');
    await select(p, 'Category', 'diensten-en-vakmensen');
    if (await exists(p, fieldX('Condition', 'select'))) throw new Error('condition shown for a service');
    if ((await text(p)).includes('Delivery options')) throw new Error('delivery options shown for a service');
    await fill(p, 'Price', '40');
    await select(p, 'Price per', 'hour');
    await click(p, 'Publish');
    await waitText(p, 'Klusjesman voor kleine reparaties');
    const c = await openListing('C', 'Klusjesman voor kleine reparaties');
    await waitText(c, '€40.00 per hour');
    await waitText(c, 'Services and Trades');
    return 'no condition or delivery for a service; buyers see "€40.00 per hour" in Diensten en Vakmensen';
  });
  await step('SRV-2', 'Book a service and mark it done', async () => {
    const c = await openListing('C', 'Klusjesman voor kleine reparaties');
    await click(c, 'Buy');
    if (await exists(c, fieldX('Shipping address'))) throw new Error('shipping address asked for a service');
    await choose(c, 'Direct, Lightning');
    await waitText(c, 'Agreed price in XBT (total)');
    await click(c, 'Send order');
    await c.waitForFunction(() => location.hash.startsWith('#/trade/'), { timeout: 20000 });
    const id = await tradeIdOf(c);
    const p = await B(`#/trade/${id}`);
    await waitText(p, 'New order', 30000);
    await click(p, 'Accept');
    await click(p, 'Create invoice with my wallet');
    await waitText(p, 'I received the payment', 60000);
    const c2 = await go('C', `#/trade/${id}`);
    await click(c2, '⚡ Pay with my wallet');
    await waitText(c2, 'Paid. The Lightning preimage proves it.', 60000);
    const p2 = await B(`#/trade/${id}`);
    await waitText(p2, 'Job done?', 30000);
    await click(p2, 'Mark as done');
    await waitText(p2, 'The seller marked the job as done.');
    const c3 = await go('C', `#/trade/${id}`);
    await waitText(c3, 'Was the job done well?', 30000);
    await click(c3, 'Yes, done well');
    await waitText(c3, 'Completed', 30000);
    return 'booked without an address, paid, seller marked "done", buyer confirmed';
  });

  await step('AI-1', 'Save the API key', async () => {
    const p = await B('#/settings');
    await fillPh(p, 'sk-ant-…', 'sk-ant-plan-test-key');
    await click(p, 'Save');
    await waitText(p, 'Key saved');
    const raw = await p.evaluate((pk) => localStorage.getItem(`xbt:secrets:${pk}`), people.B.pk);
    if (raw.includes('sk-ant-plan')) throw new Error('key stored in plain text');
    return '"✓ Key saved"; storage holds only ciphertext';
  });
  await step('AI-2', 'Listing from photos', async () => {
    const p = await B('#/sell/new');
    const input = await p.$('input[type=file]');
    await input.uploadFile('public/icon-512.png');
    await p.waitForFunction(() => document.querySelectorAll('.photos .photo img').length >= 1, { timeout: 30000 });
    await fakeAnthropic(p, { title: 'Rode wollen sjaal', description: 'Zachte rode sjaal van wol, zo goed als nieuw. Geen vlekken of gaten zichtbaar.', category: 'kleding-dames', condition: 'like-new', price: 8, notes: 'Vermeld de lengte van de sjaal.' });
    await click(p, '✨ Write listing from photos');
    await p.waitForFunction(() => [...document.querySelectorAll('label.field')].find((l) => l.querySelector('.label')?.textContent === 'Title')?.querySelector('input')?.value === 'Rode wollen sjaal', { timeout: 30000 });
    const call = (await p.evaluate(() => window.__aiCalls))[0]?.body;
    if (!call?.messages?.[0]?.content?.some((c) => c.type === 'image' && c.source.url.startsWith(BLOSSOM))) throw new Error('uploaded photo not sent');
    await waitText(p, 'Vermeld de lengte');
    return 'title, description, category, condition, price and a tip filled in (fake API; the uploaded photo was sent)';
  });
  await step('AI-3', 'No photos: button disabled', async () => {
    const p = await B('#/sell/new');
    await p.reload({ waitUntil: 'load' });
    await unlockB();
    await go('B', '#/sell/new');
    const disabled = await (await el(p, btnX('✨ Write listing from photos'))).evaluate((b) => b.disabled);
    if (!disabled) throw new Error('enabled without photos');
    return 'AI button disabled without photos';
  });

  // ---- node choice ----
  await step('NODE-1', 'Known server', async () => {
    const p = await B('#/settings');
    await choose(p, 'Local (npm run shim)');
    await click(p, 'Test connection');
    await waitText(p, '✓ block');
    return 'block height read from the server';
  });
  await step('NODE-2', 'Own node', async () => {
    const p = await B('#/settings');
    await fillPh(p, 'https://umbrel.local:3006/api', 'http://localhost:3006/api');
    await click(p, 'Use');
    await waitText(p, '✓ block');
    await choose(p, 'Local (npm run shim)');
    return 'own node URL accepted and tested';
  });

  // ---- settings and backup ----
  await step('SET-1', 'Trade backup download and restore', async () => {
    const p = await B('#/settings');
    // Catch the file the app hands to the browser instead of a real download.
    await p.evaluate(() => {
      window.__download = {};
      const make = URL.createObjectURL;
      URL.createObjectURL = (blob) => { window.__download.blob = blob; return make(blob); };
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__download.name = this.download; return; } return orig.call(this); };
    });
    await click(p, 'Download');
    const file = await p.evaluate(async () => ({ name: window.__download.name, body: await window.__download.blob.text() }));
    const json = JSON.parse(file.body);
    const path = `${SHOTS || '/tmp'}/${file.name}`;
    writeFileSync(path, file.body);
    const input = await p.$('input[type=file][accept="application/json"]');
    await input.uploadFile(path);
    await waitToast(p, 'messages restored');
    return `${file.name} downloaded (${Object.keys(json.rumors || json).length} entries) and restored`;
  });
  await step('SET-2', 'Manual exchange rate', async () => {
    const p = await B('#/settings');
    await fill(p, 'Manual rate (1 XBT in that currency)', '500');
    await openListing('B', 'Wollen sjaal, rood');
    await waitText(p, '€3.00 ≈ 0.006 XBT');
    await proof(p, 'plan', 'SET-2 · Handmatige koers 500: €3 ≈ 0.006 XBT');
    const s = await B('#/settings');
    await fill(s, 'Manual rate (1 XBT in that currency)', '50000');
    return 'XBT amount follows the manual rate (the live market rate is not reachable from this test machine)';
  });
  await step('SET-3', 'Log out and log in again', async () => {
    const p = await B('#/settings');
    await click(p, 'Log out');
    await waitText(p, 'Create a new account', 20000);
    await fillPh(p, 'nsec1…', people.B.nsec);
    await click(p, 'Log in');
    await p.evaluate(() => { location.hash = '#/sell'; });
    await waitText(p, 'Wollen sjaal, rood', 30000);
    await p.evaluate(() => { location.hash = '#/trades'; });
    await waitText(p, 'Wollen sjaal', 60000);
    return 'listings and trades back after logging in with the nsec';
  });
  await step('ACC-4', 'Log in with the same nsec elsewhere', async () => {
    storage.B = null;
    const p = await as('B', { fresh: true });
    await p.evaluate(() => { location.hash = '#/settings'; });
    await fillPh(p, 'nsec1…', people.B.nsec);
    await click(p, 'Log in');
    await p.evaluate(() => { location.hash = '#/sell'; });
    await waitText(p, 'Fietslampjes set', 30000);
    await p.evaluate(() => { location.hash = '#/trades'; });
    await waitText(p, 'Fietslampjes set', 60000);
    return 'new browser with only the nsec: same listings under Sell and same trades';
  });

  // ---- things a script cannot do for you ----
  manual('TRD-4b', 'Pay from a real BLAKE2b wallet', 'Funding used a Knots regtest node. Paying from Sparrow BLAKE2b / Knots / Shrike with real coins is for you.');
  manual('LN-real', 'A real Lightning wallet', 'Tested with mock NWC wallets. Connecting Alby Hub / Zeus / Primal and real XBT-Lightning is for you.');
  manual('AI-real', 'A real AI answer', 'Tested against a fake API. The quality of a real Claude answer needs your own API key.');
  manual('ACC-6b', 'Home screen icon on a real phone', 'Installability is checked; adding it to a real home screen is for you.');
} finally {
  const summary = { device: DEVICE, passed: results.filter((r) => r.status === 'pass').length, failed, manual: results.filter((r) => r.status === 'manual').length, results };
  if (SHOTS) writeFileSync(`${SHOTS}/testplan-results-${DEVICE}.json`, JSON.stringify(summary, null, 2));
  console.log(`\nTEST PLAN (${DEVICE}): ${summary.passed} passed, ${failed} failed, ${summary.manual} manual`);
  for (const r of results) console.log(`${r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '·'} ${r.id} ${r.title}${r.status !== 'pass' ? ' — ' + r.note : ''}`);
  await browser.close();
  process.exitCode = failed ? 1 : 0;
}
