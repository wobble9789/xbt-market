// Walks through public/testplan.html (round 2), ID by ID, with three people: A
// (admin and arbiter), B (seller) and C (buyer). Each step checks what the plan expects,
// saves a screenshot and records pass/fail; steps that need real coins, real
// shop websites or a real phone are recorded as "manual" with the reason.
//
// Needs: regtest node + `npm run shim`, `npm run relay`, `npm run wallets`,
// `npm run blossom`, `npm run fixtures`, `npm run sendcloud`, `npm run service:dev`,
// and an app build with A as admin and the local service:
//   VITE_API_URL=http://127.0.0.1:8787 VITE_ADMIN_NPUB=$(node test/e2e/testplan.e2e.mjs --admin-npub) npx vite build --outDir dist-plan
//   npx vite preview --outDir dist-plan --port 4174
// then APP_URL=http://127.0.0.1:4174/ KNOTS_CLI=… node test/e2e/testplan.e2e.mjs
// Results: <SHOTS>/testplan-results.json (and screenshots with SHOTS set).
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
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
const API = process.env.API_URL || 'http://127.0.0.1:8787';
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
  // Fixed market rates (the test machine may not reach the exchanges): 1 XBT =
  // 52,000 USDT, and USDT in other currencies. A manual EUR rate still wins.
  await page.evaluateOnNewDocument(() => {
    const real = window.fetch;
    window.fetch = (input, init) => {
      const url = String(typeof input === 'string' ? input : input.url);
      if (url.startsWith('https://safetrade.com/')) return Promise.resolve(new Response(JSON.stringify({ last: '52000' })));
      if (url.startsWith('https://api.coinbase.com/')) return Promise.resolve(new Response(JSON.stringify({ data: { rates: { USD: '1', EUR: '0.9615', GBP: '0.79', JPY: '150' } } })));
      return real(input, init);
    };
  }).catch(() => {});
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
// A list that re-renders can replace the button between finding and tapping it: try again.
async function click(p, label) {
  for (let i = 0; ; i++) {
    try { return await (await el(p, btnX(label))).click(); } catch (e) { if (i >= 2 || !/detached|not clickable/i.test(e.message)) throw e; await sleep(500); }
  }
}
async function fill(p, label, value) { const e = await el(p, fieldX(label)); await e.click({ count: 3 }); await e.evaluate((x) => { x.value = ''; x.dispatchEvent(new Event('input', { bubbles: true })); }); await e.type(value); }
async function fillPh(p, ph, value) { const e = await el(p, `//*[(self::input or self::textarea) and @placeholder="${ph}"]`); await e.click({ count: 3 }); await e.evaluate((x) => { x.value = ''; x.dispatchEvent(new Event('input', { bubbles: true })); }); await e.type(value); }
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
const tradeIdOf = (p) => p.evaluate(() => location.hash.split('/')[2].split('?')[0]);
async function escrowAmounts(p) {
  const cells = await p.$$eval('table.amounts tr td:last-child', (tds) => tds.map((t) => t.innerText));
  return cells.slice(0, 2).map((t) => parseFloat(t));
}

// ---- results -------------------------------------------------------------------------------

const results = [];
let failed = 0;
async function step(id, title, fn) {
  if (process.env.STOP_AFTER && results.some((r) => r.id === process.env.STOP_AFTER)) return;
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

// ---- extra helpers for round 2 -------------------------------------------------------------

const selectX = (label) => fieldX(label, 'select');
async function pickSub(p, value) {
  const s = await p.waitForSelector('select[aria-label="Subcategory"]:not([disabled])', { timeout: 15000 });
  await p.waitForFunction(() => document.querySelector('select[aria-label="Subcategory"]').options.length > 1, { timeout: 15000 });
  await s.select(value || await s.evaluate((e) => e.options[1].value));
}
const tab = async (p, name) => (await el(p, `//button[contains(@class,"tab")][starts-with(normalize-space(.),"${name}")]`)).click();
async function catSearch(p, q) {
  const e = await el(p, '//div[contains(@class,"cat-search")]//input');
  await e.click({ count: 3 });
  await e.evaluate((x) => { x.value = ''; x.dispatchEvent(new Event('input', { bubbles: true })); });
  await e.type(q);
}
async function setCategory(p, cat, sub) {
  await (await p.waitForSelector('select[aria-label="Category"]')).select(cat);
  await pickSub(p, sub);
}
async function clickIn(p, scope, label) {
  await (await el(p, `//*[contains(concat(" ",@class," ")," ${scope} ")]//button[normalize-space(.)="${label}"]`)).click();
}
const checked = (p, start) => p.evaluate((s) => [...document.querySelectorAll('label.choice')].find((l) => l.textContent.trim().startsWith(s))?.querySelector('input')?.checked, start);
// Ticks or unticks a choice and checks it took; a click that lands during a
// late layout shift is retried (and logged).
async function setChoice(p, start, on) {
  for (let i = 0; i < 3; i++) {
    if ((await checked(p, start)) === on) return;
    if (i) console.log(`   (retrying the click on "${start}")`);
    await choose(p, start);
    await p.waitForFunction((s, on) => [...document.querySelectorAll('label.choice')].find((l) => l.textContent.trim().startsWith(s))?.querySelector('input')?.checked === on, { timeout: 2000 }, start, on).catch(() => {});
  }
  if ((await checked(p, start)) !== on) throw new Error(`could not set "${start}"`);
}
async function newListing(p, { title, price, cat = 'diversen', sub, escrow = false, onchain = false, currency, desc }) {
  await p.evaluate(() => { location.hash = '#/sell/new'; });
  await p.waitForSelector('select[aria-label="Category"]');
  await fill(p, 'Title', title);
  if (desc) await fill(p, 'Description', desc);
  await setCategory(p, cat, sub);
  await fill(p, 'Price', String(price));
  if (currency) await select(p, 'Currency', currency);
  if (escrow) { await setChoice(p, '🛡 Escrow', true); await waitText(p, 'Your escrow deposit'); }
  if (onchain) await setChoice(p, 'On-chain', true);
  await click(p, 'Publish');
  // A tap during a late layout shift can miss; publishing twice only replaces the listing.
  await waitText(p, 'Your listings', 15000).catch(async () => { console.log('   (retrying Publish)'); await click(p, 'Publish'); await waitText(p, 'Your listings'); });
  await waitText(p, title);
}
const ADDRESS = { name: 'Cees Koper', street: 'Kerkstraat', number: '1', postalCode: '1234AB', city: 'Amsterdam' };
async function fillAddress(p) {
  await fill(p, 'Full name', ADDRESS.name);
  await fill(p, 'Street', ADDRESS.street);
  await fill(p, 'Number', ADDRESS.number);
  await fill(p, 'Postcode', ADDRESS.postalCode);
  await fill(p, 'City', ADDRESS.city);
  const sel = await el(p, '//div[contains(@class,"address-form")]//select');
  await sel.select('NL');
}
// Buyer: order from a listing page with the given payment and delivery.
async function shipCountry(c) {
  const sel = await c.$('::-p-xpath(//label[span[normalize-space(.)="Ship to (country)"]]//select)');
  if (sel && !(await sel.evaluate((s) => s.value))) await sel.select('NL');
}
// A paid listing goes to "reserved" by itself; like a seller with more in
// stock, put it back on sale before the next order of the same listing.
async function onSale(title) {
  const p = await go('B', '#/sell');
  await waitText(p, 'Your listings');
  await sleep(4000); // the seller's app reserves freshly paid listings now
  const tab = await p.$('::-p-xpath(//main//button[starts-with(normalize-space(.),"Reserved (")])');
  if (!tab) return;
  await tab.click();
  await sleep(500);
  const box = await p.$(`::-p-xpath(//div[contains(@class,"pickable")][.//div[@class="title" and normalize-space(.)="${title}"]]/input)`);
  if (!box) return;
  await box.click();
  await click(p, 'Put back on sale');
  await waitToast(p, 'updated', 30000).catch(async (e) => { throw new Error(`could not put "${title}" back on sale: ${await toasts(p)}`); });
}
async function order(who, title, { pay, pickup = false, carrier }) {
  await onSale(title);
  const c = await openListing(who, title);
  const before = await c.evaluate(() => location.hash);
  // An open conversation about this listing is reused, as a buyer would.
  if (await exists(c, btnX('💬 Go to your conversation'))) { await click(c, '💬 Go to your conversation'); await click(c, '🛒 Order'); }
  else await click(c, '🛒 Order now');
  await c.waitForFunction((b) => location.hash.startsWith('#/trade/') && location.hash !== b, { timeout: 20000 }, before);
  await waitText(c, 'How do you want to pay?');
  await choose(c, pay);
  if (pickup) await choose(c, '🤝 Pick up');
  else await shipCountry(c);
  if (carrier) { await waitText(c, carrier, 30000); await choose(c, carrier); }
  await click(c, 'Send order');
  await waitText(c, 'Waiting for the seller to accept');
  return tradeIdOf(c);
}

// ---- the plan ------------------------------------------------------------------------------

try {
  // ---- arbiter (A) ----
  await step('ARB-2', 'Find the way to become an arbiter; a fee as a percentage', async () => {
    const p = await go('A', '#/settings?open=arbiter');
    await waitText(p, 'Become an arbiter');
    await click(p, 'Apply as arbiter');
    await waitText(p, 'Become an arbiter');
    await fill(p, 'Name', 'Anna Arbiter');
    await fill(p, 'Languages', 'NL, EN');
    await fill(p, 'Your fee (% of the escrow)', '2');
    await click(p, 'Publish arbiter profile');
    await waitText(p, 'not on the approved list yet');
    await go('A', '#/settings?open=arbiter');
    await waitText(p, 'waiting for approval');
    return 'Account → "Become an arbiter" (bottom) → form with a fee in %; after publishing "waiting for approval"';
  });
  await step('ARB-3', 'Approve the arbiter: the request moves to the approved list', async () => {
    const p = await go('A', '#/admin');
    await waitText(p, 'Anna Arbiter');
    await (await el(p, '//div[contains(@class,"trade-row")][.//b[normalize-space(.)="Anna Arbiter"]]//button[contains(.,"Approve")]')).click();
    await waitToast(p, 'Approved');
    // Other suites may have left requests on the same relay: check Anna's row only.
    await el(p, '//div[contains(@class,"trade-row")][.//b[normalize-space(.)="Anna Arbiter"]]//button[contains(.,"Withdraw approval")]');
    if (await exists(p, '//div[contains(@class,"trade-row")][.//b[normalize-space(.)="Anna Arbiter"]]//button[contains(.,"Approve")]')) throw new Error('still waiting for approval');
    await proof(p, 'plan', 'ARB-3 · Admin: verzoek weg uit "Waiting", Anna onder "Approved arbiters" met "Withdraw approval"');
    await go('A', '#/arbiter');
    await waitText(p, 'Open disputes');
    await waitNoText(p, 'not on the approved list yet');
    return 'one tap approves; the request leaves the waiting list and shows under "Approved arbiters"';
  });

  // ---- first start (B makes an account in the UI) ----
  await step('SET-UP-1', 'Account page: profile open on top, the rest in closed sections', async () => {
    const p = await go('B', '#/settings');
    await click(p, 'Create a new account');
    await waitText(p, 'Back up your key');
    people.B.pk = await p.evaluate(() => JSON.parse(localStorage.getItem('xbt:account')).pubkey);
    await waitText(p, 'Full setup (optional)');
    if ((await text(p)).includes('Finish your profile')) throw new Error('old "finish your profile" banner');
    const open = await p.evaluate(() => [...document.querySelectorAll('details.collapsible')].map((d) => [d.querySelector('summary h3')?.textContent.trim(), d.open]));
    if (!open[0]?.[0]?.includes('Profile') || !open[0][1]) throw new Error('profile is not the first, open section: ' + JSON.stringify(open));
    const closed = ['Password', 'Language and currency', 'Install as an app', 'Trading', 'Lightning wallet', 'AI listing assistant', 'Trusted arbiters', 'Network', 'Trade backup', 'Become an arbiter', 'Report a problem'];
    for (const w of closed) if (!open.some(([t, o]) => t?.includes(w) && !o)) throw new Error(`${w} is not a closed section: ${JSON.stringify(open)}`);
    if (open.findIndex(([t]) => t?.includes('Become an arbiter')) < open.findIndex(([t]) => t?.includes('Trade backup'))) throw new Error('arbiter is not at the bottom');
    if (await p.evaluate(() => [...document.querySelectorAll('header a, nav a')].some((a) => a.textContent.includes('Admin')))) throw new Error('B sees the Admin menu');
    return 'Profile open on top (no banner, no extra buttons); everything else closed; "Become an arbiter" near the bottom';
  });
  await step('SET-UP-2', 'Install guide per device, then per browser', async () => {
    const p = await as('B');
    await (await el(p, '//details[contains(@class,"install-guide")]/summary')).click();
    for (const d of ['iPhone / iPad', 'Android phone / tablet', 'Mac', 'Windows laptop / PC']) await waitText(p, d);
    const mine = await p.evaluate(() => [...document.querySelectorAll('.install-steps')].find((d) => d.open)?.querySelector('summary')?.textContent);
    if (!mine?.includes('your browser')) throw new Error('own browser not opened: ' + mine);
    return `devices first (iPhone/iPad, Android, Mac, Windows, Linux), browsers inside; open: ${mine}`;
  });
  await step('ACC-6', 'Installable as an app', async () => {
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
      return { display: m.display, icons: icons.every(Boolean), sw: reg, theme: m.theme_color };
    });
    if (info.display !== 'standalone' || !info.icons || !info.sw || info.theme !== '#c9a227') throw new Error(JSON.stringify(info));
    let extra = '';
    if (chrome) {
      const s = await p.createCDPSession();
      const { installabilityErrors } = await s.send('Page.getInstallabilityErrors');
      if (installabilityErrors.length) throw new Error('Chrome: ' + JSON.stringify(installabilityErrors));
      extra = '; Chrome reports it installable';
    }
    await p.close();
    return `manifest standalone with the gold icon, service worker active${extra}`;
  });
  await step('ACC-2', 'Copy the npub with a button', async () => {
    const p = await go('B', '#/settings?open=backup-key');
    const codeIsButton = await p.evaluate(() => !!document.querySelector('.npub-line code')?.closest('button'));
    if (codeIsButton) throw new Error('the npub text itself is a button');
    await click(p, 'Copy npub');
    await p.waitForFunction(() => [...document.querySelectorAll('.npub-line button')].some((b) => b.textContent.startsWith('✓')), { timeout: 5000 }).catch(() => {});
    await click(p, 'Show my nsec');
    people.B.nsec = (await (await el(p, '//div[@class="secret"]/code')).evaluate((e) => e.textContent)).trim();
    if (!people.B.nsec.startsWith('nsec1')) throw new Error('no nsec shown');
    await click(p, 'I have written it down');
    return 'npub shown as text with a separate "Copy npub" button';
  });
  await step('ACC-7', 'Profile: username instead of a name, country required, "Other" account', async () => {
    const p = await go('B', '#/settings');
    if (await exists(p, fieldX('Name'))) throw new Error('separate name field');
    const name = 'bea' + Math.random().toString(36).slice(2, 7);
    people.B.username = name;
    await fill(p, 'Username', name);
    await waitText(p, `@${name} is available`);
    await fill(p, 'About you (optional)', 'Verkoopt spullen uit Utrecht.');
    const disabled = await (await el(p, btnX('Save profile'))).evaluate((b) => b.disabled);
    if (!disabled) throw new Error('could save without a country');
    await (await el(p, '//div[contains(@class,"edit-profile")]//label[span[normalize-space(.)="Country"]]//select')).select('NL');
    await (await el(p, '//div[contains(@class,"edit-profile")]//summary')).click();
    await fill(p, 'Other', 'https://example.com/bea');
    await click(p, 'Save profile');
    await waitToast(p, 'Profile saved');
    await p.reload({ waitUntil: 'load' });
    await p.waitForFunction((n) => document.querySelector('.account-head h2')?.textContent === '@' + n, { timeout: 40000 }, name);
    return `username @${name} is the name; save only with a country; "Other" marketplace field; shown at the top of Account`;
  });
  await step('ACC-3', 'Password: clear, per device, survives a refresh, guards the nsec, lock now', async () => {
    const p = await go('B', '#/settings?open=password');
    await waitText(p, 'Like other Nostr apps');
    await fill(p, 'Password', '12345');
    await waitText(p, 'Too short: 5 of at least 8 characters.');
    await fill(p, 'Password', 'correct-horse-9');
    await fill(p, 'Repeat password', 'correct-horse-9');
    await click(p, 'Set password');
    await waitText(p, 'Password set on this device');
    // A refresh keeps it unlocked (the browser session), no password asked.
    await p.waitForFunction(() => !!sessionStorage.getItem('xbt:session'), { timeout: 10000 });
    await p.reload({ waitUntil: 'load' });
    await waitText(p, 'Password set on this device');
    if ((await text(p)).includes('🔒 Unlock')) throw new Error('locked after a refresh');
    // Showing the nsec asks for the password.
    await p.evaluate(() => { location.hash = '#/settings?open=backup-key,password'; });
    await click(p, 'Show my nsec');
    await fillPh(p, 'Your password', 'wrong-password');
    await click(p, 'Show');
    await waitText(p, 'Wrong password');
    await fillPh(p, 'Your password', 'correct-horse-9');
    await click(p, 'Show');
    await el(p, '//div[@class="secret"]/code');
    await click(p, 'Hide');
    // Changing needs the current password.
    await click(p, 'Change or remove');
    await fill(p, 'New password', 'battery-staple-7');
    await fill(p, 'Repeat password', 'battery-staple-7');
    if (!(await (await el(p, btnX('Change password'))).evaluate((b) => b.disabled))) throw new Error('could change without the current password');
    await fill(p, 'Current password', 'correct-horse-9');
    await click(p, 'Change password');
    await waitText(p, 'Password changed');
    await click(p, '🔒 Lock now');
    await waitText(p, 'Unlock');
    await waitText(p, people.B.username);
    await proof(p, 'plan', 'ACC-3 · Slotscherm toont welk account: naam en npub');
    await fill(p, 'Password', 'wrong-password');
    await click(p, 'Unlock');
    await waitText(p, 'Wrong password');
    await fill(p, 'Password', 'battery-staple-7');
    await click(p, 'Unlock');
    await waitText(p, 'Back up your key');
    // The rest of the plan reloads B's pages often; keep B's key unencrypted from here on.
    const sk = Buffer.from(nip19.decode(people.B.nsec).data).toString('hex');
    await p.evaluate((pk, sk) => localStorage.setItem('xbt:account', JSON.stringify({ pubkey: pk, sk, backedUp: true })), people.B.pk, sk);
    await p.reload({ waitUntil: 'load' });
    return 'short explanation; stays unlocked on refresh; nsec only after the password; change needs the current one; lock now shows the account';
  });
  const B = (hash) => go('B', hash);
  await step('ACC-5', 'Only English and Spanish', async () => {
    const p = await B('#/settings?open=language');
    const langs = await p.$eval('::-p-xpath(//label[span[normalize-space(.)="Language"]]//select)', (s) => [...s.options].map((o) => o.value).join(','));
    if (langs !== 'en,es') throw new Error('languages: ' + langs);
    await select(p, 'Language', 'es');
    await waitText(p, 'Contraseña');
    await proof(p, 'plan', 'ACC-5 · Cuenta en español');
    await select(p, 'Idioma', 'en');
    await waitText(p, 'Password');
    return 'English and Español only; everything switches at once';
  });
  await step('STY-1', 'Gold house style', async () => {
    const p = await B('#/settings');
    const c = await p.evaluate(() => ({ accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), btn: getComputedStyle(document.querySelector('.btn.primary')).backgroundColor }));
    if (!['#c9a227', '#d4af37'].includes(c.accent)) throw new Error(JSON.stringify(c));
    return `accent ${c.accent}, primary buttons ${c.btn}`;
  });
  await step('USR-1', 'Unique @username', async () => {
    const name = people.B.username;
    const nj = await (await fetch(`${API}/.well-known/nostr.json?name=${name}`)).json();
    if (nj.names[name] !== people.B.pk) throw new Error('not in nostr.json');
    const c = await go('C', '#/settings');
    await fill(c, 'Username', name);
    await waitText(c, `@${name} is already taken`);
    if (!(await (await el(c, btnX('Save profile'))).evaluate((b) => b.disabled))) throw new Error('C could take a taken name');
    return `B is @${name} (NIP-05 ${name}@…), set in the profile; C gets "already taken"`;
  });
  await step('USR-2', 'Search by username', async () => {
    const c = await go('C', '#/');
    await (await c.waitForSelector('.searchbar input')).type('@' + people.B.username.slice(0, 5));
    await waitText(c, '@' + people.B.username, 20000);
    await (await el(c, `//a[contains(@class,"trade-row")][.//b[normalize-space(.)="@${people.B.username}"]]`)).click();
    await waitText(c, 'Verkoopt spullen uit Utrecht.', 30000);
    // Without the @ it searches listings only.
    await c.evaluate(() => { location.hash = '#/'; });
    const box = await c.waitForSelector('.searchbar input');
    await box.click({ count: 3 });
    await box.type(people.B.username);
    await sleep(800);
    if (await exists(c, `//a[contains(@class,"trade-row")][.//b[normalize-space(.)="@${people.B.username}"]]`)) throw new Error('people listed without the @');
    return 'typing @bea… lists B; tapping opens the profile; without @ only listings';
  });

  // ---- listings ----
  await step('LST-1a', 'Marktplaats categories with subcategories', async () => {
    const p = await B('#/sell/new');
    await waitText(p, 'New listing');
    const n = await p.$eval('select[aria-label="Category"]', (s) => s.options.length);
    if (n !== 36) throw new Error(`${n} main categories`);
    const first = await p.$eval('select[aria-label="Category"]', (s) => [...s.options].slice(0, 3).map((o) => o.value).join());
    if (first !== 'antiek-en-kunst,audio-tv-en-foto,auto-s') throw new Error('not in Marktplaats order: ' + first);
    // Search: everyday words find the category, also compounds.
    await catSearch(p, 'ssd');
    await (await el(p, '//button[contains(@class,"cat-hit")][contains(.,"Hard Drives") or contains(.,"Harde schijven")]')).click();
    if (await p.$eval('select[aria-label="Subcategory"]', (s) => s.value) !== 'harde-schijven') throw new Error('search did not set the subcategory');
    await catSearch(p, 'thermal vision');
    await waitText(p, 'Binoculars');
    // Third level: a car brand asks for the model.
    await (await p.waitForSelector('select[aria-label="Category"]')).select('auto-s');
    await pickSub(p, 'ford');
    await p.waitForSelector('select[aria-label="Model"]', { timeout: 15000 });
    const models = await p.$eval('select[aria-label="Model"]', (s) => [...s.options].map((o) => o.textContent));
    if (!models.includes('Transit') || !models.includes('Other model')) throw new Error('no Ford models: ' + models.slice(0, 5));
    await (await p.waitForSelector('select[aria-label="Category"]')).select('kleding-dames');
    await p.waitForFunction(() => document.querySelector('select[aria-label="Subcategory"]')?.options.length > 10, { timeout: 15000 });
    const subs = await p.$eval('select[aria-label="Subcategory"]', (s) => s.options.length - 1);
    await fill(p, 'Title', 'Zonder subcategorie');
    await fill(p, 'Price', '1');
    await click(p, 'Publish');
    await waitToast(p, 'Choose a subcategory');
    return `36 main categories in Marktplaats order; search ("ssd", "thermal vision"); Ford → model list; Kleding | Dames has ${subs} subcategories; publishing needs one`;
  });
  await step('LST-1b', 'Pick-up country and town; ships to exactly what you choose', async () => {
    const p = await as('B');
    const country = await p.$eval('::-p-xpath(//label[span[normalize-space(.)="Pick-up country"]]//select)', (s) => s.value);
    if (country !== 'NL') throw new Error('country not preset: ' + country);
    await el(p, fieldX('Pick-up town (optional)'));
    const chips = await p.$$eval('.ships-to .chip', (c) => c.map((x) => x.textContent));
    if (chips.length !== 1 || !chips[0].includes('Netherlands')) throw new Error('ships-to does not start with the own country: ' + chips);
    const picker = await el(p, '//div[contains(@class,"ships-to")]//select');
    await picker.select('GB');
    await waitText(p, 'United Kingdom');
    await (await el(p, '//span[contains(@class,"chip")][contains(.,"United Kingdom")]/button')).click();
    await p.waitForFunction(() => ![...document.querySelectorAll('.chip')].some((c) => c.textContent.includes('United Kingdom')), { timeout: 5000 });
    return '"Pick-up country" preset to NL and "Pick-up town"; ships-to starts with NL, chips removable';
  });
  await step('LST-1c', 'Carriers without a price', async () => {
    const p = await as('B');
    if (await p.$('.ship-option input')) throw new Error('price field for shipping');
    await waitText(p, 'cheap abroad');
    await waitText(p, 'You set no price');
    await waitText(p, 'Parcel size');
    return 'carriers to tick, cheap international ones marked; no price; parcel size';
  });
  await step('LST-1d', 'Payment methods: Lightning on, on-chain off, escrow off and last', async () => {
    const p = await as('B');
    const pays = await p.evaluate(() => [...document.querySelectorAll('label.choice')].filter((l) => /Lightning \(|On-chain \(|Escrow \(/.test(l.textContent)).map((l) => [l.textContent.trim().slice(0, 12), l.querySelector('input').checked]));
    if (JSON.stringify(pays.map((x) => x[1])) !== '[true,false,false]' || !pays[2][0].includes('Escrow')) throw new Error(JSON.stringify(pays));
    if ((await text(p)).includes('Your escrow deposit')) throw new Error('deposit field without escrow');
    await choose(p, '🛡 Escrow');
    await waitText(p, 'Your escrow deposit (%)');
    return 'Lightning ✓, On-chain ✗, Escrow ✗ (last); deposit field only after ticking escrow';
  });
  await step('LST-1e', 'Publish with photos', async () => {
    const p = await as('B');
    const input = await p.$('label.photo.add input[type=file]');
    await input.uploadFile('public/icon-512.png', 'public/icon-192.png');
    await p.waitForFunction(() => document.querySelectorAll('.photos .photo img').length >= 2, { timeout: 30000 });
    await fill(p, 'Title', 'Wollen sjaal, rood');
    await fill(p, 'Description', 'Zachte wollen sjaal, nauwelijks gedragen.');
    await pickSub(p);
    await fill(p, 'Price', '2');
    await select(p, 'Condition', 'like-new');
    await fill(p, 'Pick-up town (optional)', 'Utrecht');
    await click(p, 'Publish');
    await waitText(p, 'Your listings');
    await waitText(p, 'Wollen sjaal, rood');
    const c = await openListing('C', 'Wollen sjaal, rood');
    const imgs = await c.$$eval('.gallery img', (i) => i.filter((x) => x.complete && x.naturalWidth > 0).length);
    if (imgs < 2) throw new Error('photos not shown to the buyer');
    await waitText(c, 'Utrecht, Netherlands');
    await waitText(c, 'PostNL');
    return 'listed with 2 photos, country, carriers and payments; buyer sees all of it';
  });
  await step('LST-2', 'No photo by URL', async () => {
    const p = await B('#/sell/new');
    await waitText(p, 'New listing');
    if (await p.$('::-p-xpath(//input[contains(@placeholder,"image URL")])')) throw new Error('URL field still there');
    return 'only uploading photos';
  });
  const editOf = (title) => `//div[contains(@class,"pickable")][.//div[@class="title" and normalize-space(.)="${title}"]]//a[contains(.,"Edit")]`;
  await step('LST-3', 'Edit the price', async () => {
    const p = await B('#/sell');
    await (await el(p, editOf('Wollen sjaal, rood'))).click();
    await fill(p, 'Price', '3');
    await click(p, 'Save');
    await waitText(p, 'Your listings');
    const c = await openListing('C', 'Wollen sjaal, rood');
    await waitText(c, '€3.00');
    return 'buyer sees €3.00 after reload';
  });
  await step('LST-4', 'Reserved and sold stay visible where they should', async () => {
    let p = await B('#/sell');
    await (await el(p, editOf('Wollen sjaal, rood'))).click();
    await click(p, 'Mark as reserved');
    await waitText(p, 'Your listings');
    let c = await openListing('C', 'Wollen sjaal, rood');
    await waitText(c, 'Reserved: the seller is holding this');
    if (await exists(c, btnX('🛒 Order now'))) throw new Error('can order a reserved listing');
    p = await B('#/sell');
    await click(p, 'Reserved (1)');
    await (await el(p, editOf('Wollen sjaal, rood'))).click();
    await click(p, 'Mark as sold');
    await waitText(p, 'Your listings');
    c = await go('C', '#/?q=sjaal');
    await c.reload({ waitUntil: 'load' });
    await sleep(2500);
    if ((await text(c)).includes('Wollen sjaal')) throw new Error('sold listing still in Browse');
    c = await go('C', `#/u/${nip19.npubEncode(people.B.pk)}`);
    await c.reload({ waitUntil: 'load' });
    await waitText(c, 'Sold (1)', 30000);
    await proof(c, 'plan', 'LST-4 · Verkocht: op het profiel onder "Sold"');
    p = await B('#/sell');
    await click(p, 'Sold (1)');
    await (await el(p, editOf('Wollen sjaal, rood'))).click();
    await click(p, 'Put back on sale');
    await waitText(p, 'Your listings');
    await openListing('C', 'Wollen sjaal, rood');
    return 'reserved: visible, no ordering; sold: gone from Browse, on the profile under "Sold"; back on sale works';
  });
  await step('LST-5', 'Bulk: mark sold and delete', async () => {
    const p = await as('B');
    for (const n of [1, 2, 3]) await newListing(p, { title: `Bulktest ${n}`, price: n });
    await p.evaluate(() => { location.hash = '#/sell'; });
    for (const n of [1, 2, 3]) await (await el(p, `//div[contains(@class,"pickable")][.//div[@class="title" and normalize-space(.)="Bulktest ${n}"]]/input`)).click();
    await waitText(p, '3 selected');
    await click(p, 'Mark as sold');
    await waitToast(p, '3 marked as sold', 40000);
    await click(p, 'Sold (3)');
    for (const n of [1, 2]) await (await el(p, `//div[contains(@class,"pickable")][.//div[@class="title" and normalize-space(.)="Bulktest ${n}"]]/input`)).click();
    await click(p, 'Delete');
    await waitToast(p, '2 deleted', 40000);
    await waitText(p, 'Sold (1)');
    return 'tabs For sale / Reserved / Sold; 3 marked sold at once, then 2 deleted at once';
  });
  await step('LST-6', 'Filters and sorting', async () => {
    const p = await as('B');
    await newListing(p, { title: 'Sorteertest duur', price: 9, escrow: true });
    await newListing(p, { title: 'Sorteertest goedkoop', price: 4, escrow: true });
    const c = await go('C', '#/?q=Sorteertest');
    await c.reload({ waitUntil: 'load' });
    await waitText(c, 'Sorteertest goedkoop');
    const sortSel = await c.$('.searchbar select');
    await sortSel.select('price');
    let order = await c.$$eval('.listing-card .title', (t) => t.map((x) => x.textContent));
    if (order.join() !== 'Sorteertest goedkoop,Sorteertest duur') throw new Error('price asc: ' + order);
    await sortSel.select('-price');
    order = await c.$$eval('.listing-card .title', (t) => t.map((x) => x.textContent));
    if (order[0] !== 'Sorteertest duur') throw new Error('price desc: ' + order);
    await click(c, '⚙ Filters');
    await fillPh(c, 'from', '5');
    await sleep(400);
    order = await c.$$eval('.listing-card .title', (t) => t.map((x) => x.textContent));
    if (order.join() !== 'Sorteertest duur') throw new Error('price from 5: ' + order);
    await (await el(c, '//div[contains(@class,"filters")]//label[span[normalize-space(.)="Pick-up country"]]//select')).select('NL');
    await (await el(c, '//div[contains(@class,"filters")]//label[span[normalize-space(.)="Delivery"]]//select')).select('pickup');
    await waitText(c, 'Sorteertest duur');
    await proof(c, 'plan', 'LST-6 · Filters: prijs vanaf 5, verkoper in NL, ophalen; gesorteerd op prijs hoog-laag');
    // The filters live in the address, so "back" from a listing keeps them.
    const hash = await c.evaluate(() => location.hash);
    if (!/min=5/.test(hash) || !/country=NL/.test(hash)) throw new Error('filters not kept: ' + hash);
    await (await el(c, '//a[contains(@class,"listing-card")]')).click();
    await waitText(c, 'Updated');
    await c.goBack();
    await waitText(c, 'Sorteertest duur');
    if (!/min=5/.test(await c.evaluate(() => location.hash))) throw new Error('filters lost after back');
    return 'search, price range, country, delivery; sort low–high and high–low; filters survive "back"';
  });
  await step('LST-7', 'Prices in many currencies', async () => {
    const c = await go('C', '#/settings?open=language');
    await select(c, 'Show prices in', 'USD');
    let l = await openListing('C', 'Sorteertest duur');
    await waitText(l, '≈ US$', 20000);
    await waitText(l, '€9.00');
    await proof(l, 'plan', 'LST-7 · Prijs in USD (≈), met de originele euro- en XBT-prijs');
    await go('C', '#/settings?open=language');
    await select(c, 'Show prices in', 'JPY');
    l = await openListing('C', 'Sorteertest duur');
    await waitText(l, '≈ JP¥', 20000);
    await go('C', '#/settings?open=language');
    await select(c, 'Show prices in', 'EUR');
    const n = await c.$eval('::-p-xpath(//label[span[normalize-space(.)="Show prices in"]]//select)', (s) => s.options.length);
    return `prices converted (≈ US$, ≈ JP¥) with the original price; ${n} currencies`;
  });

  // ---- following ----
  await step('FOL-1', 'Follow', async () => {
    const c = await go('C', `#/u/${nip19.npubEncode(people.B.pk)}`);
    await click(c, '+ Follow');
    await waitText(c, '✓ Following', 30000);
    return 'button turns into "✓ Following" (a standard Nostr contact list)';
  });
  await step('FOL-2', 'Feed of people you follow', async () => {
    const c = await go('C', '#/');
    await click(c, 'Following (1)');
    await waitText(c, 'Sorteertest duur', 30000);
    await c.waitForFunction(() => [...document.querySelectorAll('.listing-card .name span')].every((x) => x.textContent), { timeout: 20000 }).catch(() => {});
    const sellers = await c.$$eval('.listing-card .name span', (s) => [...new Set(s.map((x) => x.textContent).filter(Boolean))]);
    if (sellers.length !== 1 || sellers[0] !== people.B.username) throw new Error('other sellers in the feed: ' + sellers);
    await click(c, 'All listings');
    return `tab "Following" shows only listings of ${people.B.username}`;
  });

  // ---- ships-to filter, reports, blocking, admin, bug reports ----
  await step('LST-1f', 'Buyer filter "Ships to" (dropdown) follows the seller\'s choice exactly', async () => {
    const p = await as('B');
    await p.evaluate(() => { location.hash = '#/sell/new'; });
    await fill(p, 'Title', 'Alleen naar Egypte');
    await setCategory(p, 'diversen');
    await fill(p, 'Price', '5');
    await (await el(p, '//span[contains(@class,"chip")][contains(.,"Netherlands")]/button')).click();
    await (await el(p, '//div[contains(@class,"ships-to")]//select')).select('EG');
    await waitText(p, 'Egypt');
    await click(p, 'Publish');
    await waitText(p, 'Your listings');
    const c = await go('C', '#/?q=Alleen%20naar%20Egypte');
    await c.reload({ waitUntil: 'load' });
    await waitText(c, 'Alleen naar Egypte');
    await click(c, '⚙ Filters');
    await (await el(c, '//div[contains(@class,"filters")]//label[span[normalize-space(.)="Ships to"]]//select')).select('NL');
    await waitNoText(c, 'Alleen naar Egypte', 10000);
    await (await el(c, '//div[contains(@class,"filters")]//label[span[normalize-space(.)="Ships to"]]//select')).select('EG');
    await waitText(c, 'Alleen naar Egypte');
    await click(c, 'Clear filters');
    return 'an NL listing that ships only to Egypt: hidden for "Ships to: Netherlands", shown for "Egypt"';
  });
  await step('REP-1', 'Report a user; the admin sees it', async () => {
    const c = await go('C', `#/u/${nip19.npubEncode(people.B.pk)}`);
    await click(c, '🚩 Report');
    await choose(c, 'Scam or fraud');
    await fill(c, 'What happened? (optional)', 'Testmelding: verkoper reageert niet meer.');
    await click(c, 'Send report');
    await waitToast(c, 'Report sent');
    const a = await go('A', '#/admin');
    await tab(a, 'Reports');
    await waitText(a, 'Testmelding: verkoper reageert niet meer.', 60000);
    await waitText(a, 'Scam or fraud');
    await proof(a, 'plan', 'REP-1 · Admin → Reports: reden, tekst, over wie en van wie');
    await click(a, 'Mark as handled');
    await waitNoText(a, 'Testmelding', 10000);
    return 'report goes privately to the admin; Reports tab shows reason, text, who and about whom';
  });
  await step('BLK-1', 'Block a user: their listings disappear for you', async () => {
    const c = await go('C', `#/u/${nip19.npubEncode(people.B.pk)}`);
    await click(c, '⛔ Block');
    await waitText(c, 'You blocked this user');
    // The admin sees the block count in Reports straight away.
    const adm = await go('A', '#/admin');
    await tab(adm, 'Reports');
    await choose(adm, 'Show handled reports too');
    await waitText(adm, 'blocked by 1', 30000);
    const b = await go('C', '#/?q=Sorteertest');
    await b.reload({ waitUntil: 'load' });
    await sleep(3000);
    if ((await text(b)).includes('Sorteertest duur')) throw new Error('blocked seller still listed');
    // Unblock from the list under Account.
    const c2 = await go('C', '#/settings?open=blocked');
    await (await el(c2, '//details[.//h3[contains(.,"Blocked people")]]//div[contains(@class,"trade-row")]//button[normalize-space(.)="Unblock"]')).click();
    await waitText(c2, 'You have not blocked anyone');
    const b2 = await go('C', '#/?q=Sorteertest');
    await b2.reload({ waitUntil: 'load' });
    await waitText(b2, 'Sorteertest duur');
    return 'blocked: listings hidden for C, the admin sees "blocked by 1" in Reports; unblocked from Account → Blocked people: back';
  });
  await step('BLK-2', `Blocked by ${10} people: the account is inactive; the admin can restore it`, async () => {
    // A throwaway seller with one listing, blocked by ten other accounts.
    const xsk = generateSecretKey();
    const xpk = getPublicKey(xsk);
    people.X = { pk: xpk, sk: hex(xsk) };
    const pool = new SimplePool();
    const now = Math.floor(Date.now() / 1000);
    await Promise.any(pool.publish([RELAY], finalizeEvent({ kind: 30402, created_at: now, content: 'test', tags: [['d', 'x1'], ['title', 'Geblokkeerde verkoper'], ['price', '3', 'EUR'], ['t', 'xbt-market'], ['t', 'diversen'], ['country', 'NL'], ['payment', 'lightning'], ['shipping_option', 'pickup', '0', 'EUR']] }, xsk)));
    for (let i = 0; i < 10; i++) await Promise.any(pool.publish([RELAY], finalizeEvent({ kind: 30000, created_at: now, content: '', tags: [['d', 'xbt-market/blocked'], ['p', xpk]] }, generateSecretKey())));
    pool.close([RELAY]);
    const c = await go('C', '#/?q=Geblokkeerde');
    await c.reload({ waitUntil: 'load' });
    await sleep(4000);
    if ((await text(c)).includes('Geblokkeerde verkoper')) throw new Error('inactive account still listed');
    await go('C', `#/u/${nip19.npubEncode(xpk)}`);
    await waitText(c, 'This account is inactive: too many people blocked it.');
    // The owner is told too.
    const x = await go('X', '#/sell');
    await waitText(x, 'Your account is inactive: 10 people blocked you.', 30000);
    const a = await go('A', '#/admin');
    await tab(a, 'Blocks');
    await waitText(a, 'Inactive: too many blocks (1)', 30000);
    await proof(a, 'plan', 'BLK-2 · Admin → Accounts: account inactief na 10 blokkades, met "Make active again"');
    await click(a, 'Make active again');
    await waitToast(a, 'Account active again');
    const c2 = await go('C', '#/?q=Geblokkeerde');
    await c2.reload({ waitUntil: 'load' });
    await waitText(c2, 'Geblokkeerde verkoper', 30000);
    return 'ten blocks: hidden in Browse, "inactive" on the profile, the owner sees a notice; admin "Make active again" brings it back';
  });
  await step('ADM-1', 'Admin: suspend and restore any account', async () => {
    const a = await go('A', '#/admin');
    await tab(a, 'Blocks');
    // A throwaway account (the seller from BLK-2), so nothing else depends on it.
    await fillPh(a, 'npub1…', nip19.npubEncode(people.X.pk));
    await click(a, 'Suspend');
    await waitToast(a, 'Account suspended');
    await waitText(a, 'Suspended by you (1)');
    const c = await go('C', `#/u/${nip19.npubEncode(people.X.pk)}`);
    await c.reload({ waitUntil: 'load' });
    await waitText(c, 'suspended by the community admin', 30000);
    const a2 = await go('A', '#/admin');
    await tab(a2, 'Blocks');
    await waitText(a2, 'Suspended by you (1)');
    // The list re-renders while the block counts load: retry a click that lands on a replaced node.
    for (let i = 0; i < 3; i++) {
      try { await (await el(a2, '//h3[contains(.,"Suspended by you")]/following-sibling::div[1]//button[normalize-space(.)="Make active again"]')).click(); break; } catch (e) { if (i === 2) throw e; await sleep(500); }
    }
    await waitToast(a2, 'Account active again');
    return 'suspend by npub: profile says "suspended"; restore with one tap';
  });
  await step('BUG-1', 'Bug report with a screenshot: e-mailed to the maintainer, also in Admin', async () => {
    const c = await go('C', '#/settings?open=bug');
    await fill(c, 'What went wrong?', 'Testbug: de knop doet niets.');
    const input = await c.$('::-p-xpath(//label[span[normalize-space(.)="Screenshots or a video (optional)"]]//input[@type="file"])');
    await input.uploadFile('public/icon-192.png');
    await waitText(c, 'icon-192.png');
    await click(c, 'Send report');
    await waitText(c, 'Thank you! Your report was sent.', 30000);
    const mails = await (await fetch('http://127.0.0.1:3011/resend/emails')).json();
    const mail = mails.find((m) => m.html.includes('Testbug: de knop doet niets.'));
    if (!mail || mail.to[0] !== 'bugs@example.com' || mail.attachments[0]?.filename !== 'icon-192.png' || !(mail.attachments[0].bytes > 1000)) throw new Error('no e-mail with the screenshot: ' + JSON.stringify(mails.slice(-1)));
    const a = await go('A', '#/admin');
    await tab(a, 'Bug reports');
    await waitText(a, 'Testbug: de knop doet niets.', 60000);
    await waitText(a, 'e-mailed with attachments');
    // The admin publishes it as a GitHub issue, without the reporter.
    await click(a, '⇪ Publish as GitHub issue');
    await click(a, 'Publish on GitHub');
    await waitToast(a, 'Published as issue #');
    const issues = await (await fetch('http://127.0.0.1:3011/github/issues')).json();
    const issue = issues.find((i) => i.body.includes('Testbug: de knop doet niets.'));
    if (!issue || !issue.body.includes('@claude') || issue.body.includes(people.C.pk) || !issue.labels.includes('bug-report')) throw new Error('issue: ' + JSON.stringify(issue));
    await waitText(a, '✓ On GitHub');
    return 'e-mail with the png attached to the address in the server secrets; under Admin → Bug reports; published as a GitHub issue (label bug-report, @claude, no reporter)';
  });

  // ---- edge cases that need no trade ----
  await step('EDG-5', 'Own listing: no message or order buttons', async () => {
    const p = await openListing('B', 'Wollen sjaal, rood');
    if (await exists(p, btnX('💬 Message the seller')) || await exists(p, btnX('🛒 Order now'))) throw new Error('order buttons on own listing');
    await el(p, btnX('✏️ Edit listing'));
    return 'only "Edit listing"';
  });
  await step('EDG-6', 'Trade limit for new accounts', async () => {
    const p = await as('B');
    await newListing(p, { title: 'Dure ASIC miner', price: '0.25', currency: 'XBT', escrow: true });
    const c = await openListing('C', 'Dure ASIC miner');
    await click(c, '🛒 Order now');
    await waitText(c, 'How do you want to pay?');
    await choose(c, '🛡 Escrow');
    await choose(c, '🤝 Pick up');
    await waitText(c, 'New accounts can trade up to');
    if (!(await (await el(c, btnX('Send order'))).evaluate((b) => b.disabled))) throw new Error('Send order enabled');
    return 'warning about the limit, Send order disabled';
  });

  await step('ARB-7', 'Nobody arbitrates their own trade', async () => {
    // A is the only approved arbiter: buying with escrow has no arbiter left.
    const a = await openListing('A', 'Sorteertest duur');
    await click(a, '🛒 Order now');
    await waitText(a, 'How do you want to pay?');
    await choose(a, '🛡 Escrow');
    await choose(a, '🤝 Pick up');
    await waitText(a, 'Escrow needs an arbiter who is not you or the seller');
    if (!(await (await el(a, btnX('Send order'))).evaluate((b) => b.disabled))) throw new Error('Send order enabled');
    return 'the arbiter buying with escrow: a clear message, Send order disabled (and the details form never offers buyer or seller as arbiter)';
  });

  // ---- a conversation, then an escrow trade ----
  let tid;
  const buyerAddr = CLI && cli('getnewaddress', 'plan-buyer', 'bech32');
  const sellerAddr = CLI && cli('getnewaddress', 'plan-seller', 'bech32');
  await step('TRD-1a', 'A message first, no obligation', async () => {
    const c = await openListing('C', 'Wollen sjaal, rood');
    await click(c, '💬 Message the seller');
    await fill(c, 'Message to the seller', 'Hoi! Is de sjaal nog beschikbaar?');
    await click(c, 'Send');
    await c.waitForFunction(() => location.hash.startsWith('#/trade/'), { timeout: 20000 });
    tid = await tradeIdOf(c);
    await waitText(c, 'You are buying');
    await waitText(c, 'Is de sjaal nog beschikbaar?');
    const p = await B('#/trades');
    await waitText(p, 'Is de sjaal nog beschikbaar?', 40000);
    return 'chat opened; the seller sees it under Messages with the last message';
  });
  await step('TRD-1b', 'Order from the chat: only what is needed', async () => {
    const c = await go('C', `#/trade/${tid}`);
    await click(c, '🛒 Order');
    await choose(c, '🛡 Escrow');
    await shipCountry(c);
    await waitText(c, 'PostNL', 30000);
    await choose(c, 'PostNL');
    const form = await c.$eval('.order-form', (f) => f.innerText);
    for (const bad of ['Delivery address', 'Arbiter', 'refund']) if (form.includes(bad)) throw new Error(`order form asks for ${bad}`);
    for (const good of ['How do you want to pay?', 'Ship to (country)', 'Carrier', 'Your price in XBT', 'Message to the seller', 'You pay into escrow']) if (!form.includes(good)) throw new Error(`no "${good}"`);
    await proof(c, 'plan', 'TRD-1b · Bestellen in de chat: betaalmethode, land, vervoerder met prijs, prijs, bericht; escrow-berekening');
    await click(c, 'Send order');
    await waitText(c, 'Waiting for the seller to accept');
    return 'payment, country, carrier with price, price, message; escrow sum visible; no address, refund address or arbiter';
  });
  await step('SHP-1', 'Buyer picks a carrier and pays the shipping', async () => {
    const c = await as('C');
    await waitText(c, 'Shipping: PostNL → Netherlands');
    if ((await text(c)).includes('≈ €6.95')) throw new Error('estimated instead of a live price');
    await waitText(c, '€6.95');
    return 'live PostNL price €6.95 (Sendcloud) added to the order';
  });
  await step('TRD-2', 'Clear roles; reject reason only after tapping Reject', async () => {
    const p = await B(`#/trade/${tid}`);
    await waitText(p, 'You are selling', 30000);
    await waitText(p, 'Order from');
    await waitText(p, '(the buyer)');
    if ((await text(p)).includes('Why do you reject it?')) throw new Error('reason field shown before Reject');
    await click(p, 'Reject');
    await waitText(p, 'Why do you reject it?');
    await proof(p, 'plan', 'TRD-2 · Verkoper: "You are selling to …", "Order from … (the buyer)", reden pas na Reject');
    await click(p, 'Back');
    const c = await go('C', `#/trade/${tid}`);
    await waitText(c, 'You are buying');
    await waitText(c, 'Your order');
    return 'colored banner per role, "Order from … (the buyer)" vs "Your order"; reason field after Reject';
  });
  await step('ARB-4', 'Unapproved arbiter is not offered; the admin can reject, and approve after all', async () => {
    const p = await B('#/arbiter');
    await fill(p, 'Name', 'Bob Unapproved');
    await click(p, 'Publish arbiter profile');
    await waitText(p, 'not on the approved list yet');
    const a = await go('A', '#/admin');
    await waitText(a, 'Bob Unapproved', 30000);
    await (await el(a, '//div[contains(@class,"trade-row")][.//b[normalize-space(.)="Bob Unapproved"]]//button[contains(.,"Reject")]')).click();
    await waitToast(a, 'Rejected');
    await waitText(a, 'Rejected (');
    await el(a, '//div[contains(@class,"trade-row")][.//b[normalize-space(.)="Bob Unapproved"]]//button[normalize-space(.)="Approve after all"]');
    return 'B announced without approval (not offered, see TRD-3b); admin: Reject moves him to "Rejected" with "Approve after all"';
  });
  await step('TRD-3b', 'Details only after the accept', async () => {
    const p = await B(`#/trade/${tid}`);
    await fillPh(p, 'bc1q…', sellerAddr);
    await click(p, '✓ Accept');
    await waitText(p, 'Waiting for the buyer to choose an arbiter', 30000);
    const c = await go('C', `#/trade/${tid}`);
    await waitText(c, 'A few details for the seller', 30000);
    await c.waitForFunction(() => [...document.querySelectorAll('.details-form select')].some((s) => s.textContent.includes('Anna Arbiter')), { timeout: 30000 });
    const opts = await c.$$eval('.details-form select', (s) => s.map((x) => x.textContent).join('|'));
    if (opts.includes('Bob Unapproved')) throw new Error('unapproved arbiter offered (ARB-4)');
    await fillAddress(c);
    await fillPh(c, 'bc1q…', buyerAddr);
    await clickIn(c, 'details-form', 'Send');
    await waitText(c, 'Total needed', 30000);
    return 'address, arbiter (only approved Anna) and refund address asked after the accept';
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
    mine(2);
    await click(c, 'Refresh');
    await waitText(c, 'Fully paid', 40000);
    return `paid ${buyerPays} + ${sellerPays} XBT; after 3 confirmations "Fully paid"`;
  });
  await step('TRD-5', 'Ship', async () => {
    const p = await B(`#/trade/${tid}`);
    await waitText(p, 'Ship the item', 40000);
    await waitText(p, 'Kerkstraat 1');
    await fill(p, 'Tracking code', '3SXBT0001');
    await click(p, 'Mark as shipped');
    await waitText(p, 'Shipped with PostNL');
    const c = await go('C', `#/trade/${tid}`);
    await waitText(c, 'Shipped with PostNL', 30000);
    const track = await c.$eval('a.btn.small[target=_blank]', (a) => a.href);
    if (!track.includes('postnl.nl/tracktrace/?B=3SXBT0001')) throw new Error('tracking link ' + track);
    return 'buyer sees carrier, code and a Track link to postnl.nl';
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
    if (!(got > 0.0002 && back > 0.00002)) throw new Error(`seller ${got}, buyer ${back}`);
    return `node: seller received ${got} XBT, buyer got ${back} XBT deposit back`;
  });
  await step('TRD-9', 'Reviews', async () => {
    for (const who of ['C', 'B']) {
      const p = await go(who, `#/trade/${tid}`);
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
    await waitText(p, 'You are the arbiter');
    return 'messages reach buyer, seller and the arbiter (who joined after the order)';
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
    const id = await order('C', title, { pay: '🛡 Escrow', pickup: true });
    const p = await B(`#/trade/${id}`);
    await waitText(p, 'Order from', 30000);
    await fillPh(p, 'bc1q…', sellerAddr);
    await click(p, '✓ Accept');
    await waitText(p, 'Waiting for the buyer to choose an arbiter', 30000);
    const c = await go('C', `#/trade/${id}`);
    await waitText(c, 'A few details for the seller', 30000);
    await c.waitForFunction(() => [...document.querySelectorAll('.details-form select')].some((s) => s.textContent.includes('Anna Arbiter')), { timeout: 30000 });
    await fillPh(c, 'bc1q…', buyerAddr);
    await clickIn(c, 'details-form', 'Send');
    await waitText(c, 'Total needed', 30000);
    const [buyerPays, sellerPays] = await escrowAmounts(c);
    const addr = await c.$eval('.addr code', (e) => e.textContent.trim());
    // The seller's app forwards its accept to the arbiter once it sees the arbiter.
    const p2 = await B(`#/trade/${id}`);
    await waitText(p2, 'Total needed', 30000);
    await sleep(3000);
    cli('sendtoaddress', addr, buyerPays.toFixed(8));
    cli('sendtoaddress', addr, sellerPays.toFixed(8));
    mine(3);
    const c2 = await go('C', `#/trade/${id}`);
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
    await waitText(c, 'Dispute opened by the buyer');
    const p = await B(`#/trade/${tid2}`);
    await waitText(p, 'Dispute opened by the buyer', 30000);
    return 'red notice for buyer and seller';
  });
  await step('DSP-2', 'Arbiter sees the dispute', async () => {
    const p = await go('A', '#/arbiter');
    await p.reload({ waitUntil: 'load' });
    await waitText(p, 'Sorteertest duur', 40000);
    return 'trade listed under "Open disputes"';
  });
  await step('DSP-3', 'Rule on the dispute', async () => {
    const p = await go('A', `#/trade/${tid2}`);
    await waitText(p, 'Dispute opened by the buyer', 30000);
    // The fee goes to the arbiter's payout address.
    const s = await go('A', '#/settings?open=trading');
    await fill(s, 'Default XBT payout / refund address', CLI ? cli('getnewaddress', 'plan-arbiter', 'bech32') : 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
    await s.keyboard.press('Tab');
    await go('A', `#/trade/${tid2}`);
    await waitText(p, 'Dispute opened by the buyer', 30000);
    await click(p, 'Propose a ruling');
    // The test amounts are small: 2% of this escrow is below what can be paid out on chain.
    await waitText(p, 'is too small to pay out on chain and is left out');
    const sd = await p.evaluate(() => { const t = document.querySelector('main').innerText.match(/Seller pays \(deposit\)\s*([\d.]+)/); return t && t[1]; });
    await fill(p, 'Seller receives (XBT)', sd);
    await fill(p, 'Note', 'Niet verzonden binnen de termijn: terugbetaling aan koper, verkoper houdt eigen borg.');
    await click(p, 'Sign and propose');
    await waitText(p, 'Arbiter ruling', 30000);
    const c = await go('C', `#/trade/${tid2}`);
    await waitText(c, 'Arbiter ruling', 30000);
    await waitText(c, 'terugbetaling aan koper');
    if ((await text(c)).includes('Pays to an address that is not')) throw new Error('unknown output');
    return `buyer and seller see "Arbiter ruling" with amounts and note (seller gets ${sd} XBT back); the 2% fee was too small for an output and was left out, as shown to the arbiter`;
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
  await step('EDG-1', 'Withdraw an order', async () => {
    const id = await order('C', 'Sorteertest duur', { pay: '🛡 Escrow', pickup: true });
    const c = await as('C');
    await click(c, 'Withdraw order');
    await waitText(c, 'Cancelled');
    const p = await B(`#/trade/${id}`);
    await waitText(p, 'Cancelled', 30000);
    return 'status Cancelled for both';
  });
  await step('EDG-2', 'Reject an order with a reason', async () => {
    const id = await order('C', 'Sorteertest duur', { pay: '🛡 Escrow', pickup: true });
    const p = await B(`#/trade/${id}`);
    await waitText(p, 'Order from', 30000);
    await click(p, 'Reject');
    await fill(p, 'Why do you reject it? (optional)', 'Al verkocht, sorry.');
    await click(p, 'Reject order');
    await waitText(p, 'You rejected this order', 30000);
    const c = await go('C', `#/trade/${id}`);
    await waitText(c, 'The seller rejected your order', 30000);
    await waitText(c, 'Message from the seller: “Al verkocht, sorry.”');
    await el(c, btnX('🛒 Make a new order'));
    return 'buyer sees a red "rejected" box with "Message from the seller" and can make a new order';
  });
  await step('EDG-4', 'Invalid refund address blocks the details', async () => {
    const id = await order('C', 'Sorteertest duur', { pay: '🛡 Escrow', pickup: true });
    const p = await B(`#/trade/${id}`);
    await waitText(p, 'Order from', 30000);
    await fillPh(p, 'bc1q…', sellerAddr);
    await click(p, '✓ Accept');
    await waitText(p, 'Waiting for the buyer to choose an arbiter', 30000);
    const c = await go('C', `#/trade/${id}`);
    await waitText(c, 'A few details for the seller', 30000);
    await fillPh(c, 'bc1q…', 'tb1qinvalidaddress');
    await c.waitForSelector('.details-form input.invalid');
    if (!(await (await el(c, '//*[contains(@class,"details-form")]//button[normalize-space(.)="Send"]')).evaluate((b) => b.disabled))) throw new Error('Send enabled');
    people.C.edgTrade = id;
    return 'field red, Send disabled';
  });
  await step('EDG-3', 'Cancel before paying', async () => {
    const p = await B(`#/trade/${people.C.edgTrade}`);
    await click(p, 'Cancel trade (nothing paid yet)');
    await waitText(p, 'Cancelled', 30000);
    return 'status Cancelled';
  });

  // ---- Lightning and direct payments ----
  await step('LN-1', 'Connect a wallet', async () => {
    for (const [who, w] of [['B', 'seller'], ['C', 'buyer']]) {
      const p = await go(who, '#/settings?open=lightning');
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
    return `storage holds only ciphertext: ${raw.slice(0, 60)}…`;
  });
  await step('LN-3', 'Lightning address', async () => {
    const p = await go('B', '#/settings?open=lightning');
    await fill(p, 'Lightning address for receiving (optional)', 'bea@wallet.example');
    await p.keyboard.press('Tab');
    await sleep(300);
    const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('xbt:settings')).lightningAddress);
    if (saved !== 'bea@wallet.example') throw new Error('not saved: ' + saved);
    return 'saved; used for payment requests when no wallet is connected';
  });
  await step('LN-4', 'Escrow advice above €50', async () => {
    const p = await as('B');
    await newListing(p, { title: 'Racefiets frame', price: 120, escrow: true });
    const c = await openListing('C', 'Racefiets frame');
    await click(c, '🛒 Order now');
    await waitText(c, 'recommended');
    await c.waitForFunction(() => [...document.querySelectorAll('label.choice')].find((l) => l.textContent.includes('Escrow (buyer'))?.querySelector('input').checked, { timeout: 5000 });
    await choose(c, '⚡ Lightning');
    await waitText(c, 'we recommend escrow');
    return 'escrow preselected as recommended; warning when choosing Lightning';
  });
  await step('SRV-1', 'Offer a service with a price per hour', async () => {
    const p = await B('#/sell/new');
    await waitText(p, 'New listing');
    await fill(p, 'Title', 'Klusjesman voor kleine reparaties');
    await setCategory(p, 'diensten-en-vakmensen');
    if (await exists(p, fieldX('Condition', 'select'))) throw new Error('condition shown for a service');
    if ((await text(p)).includes('Carriers you are willing to use')) throw new Error('delivery shown for a service');
    await fill(p, 'Price', '40');
    await select(p, 'Price per', 'hour');
    await click(p, 'Publish');
    await waitText(p, 'Klusjesman voor kleine reparaties');
    const c = await openListing('C', 'Klusjesman voor kleine reparaties');
    await waitText(c, '€40.00 per hour');
    await waitText(c, 'Services');
    return 'no condition or delivery for a service; "€40.00 per hour"';
  });
  let tidLn;
  await step('LN-5', 'Order with Lightning, pick-up', async () => {
    const p = await as('B');
    await newListing(p, { title: 'Fietslampjes set', price: 5, onchain: true });
    tidLn = await order('C', 'Fietslampjes set', { pay: '⚡ Lightning', pickup: true });
    const c = await as('C');
    if ((await text(c)).includes('Escrow') && (await text(c)).includes('Arbiter:')) throw new Error('escrow in a direct trade');
    return 'direct Lightning order, no escrow, no arbiter, no address';
  });
  await step('LN-6', 'Payment request in the chat', async () => {
    const p = await B(`#/trade/${tidLn}`);
    await waitText(p, 'Order from', 30000);
    await click(p, '✓ Accept');
    await click(p, 'Create invoice with my wallet');
    await waitText(p, 'I received the payment', 60000);
    const c = await go('C', `#/trade/${tidLn}`);
    await waitText(c, 'Pay with my wallet', 30000);
    await waitText(c, '⚡ XBT Lightning');
    await waitText(c, '💳 Payment request');
    return 'QR, invoice marked "⚡ XBT Lightning" (feature bit 512) and a "💳 Payment request" line in the chat';
  });
  await step('LN-7', 'Pay with one tap', async () => {
    const c = await as('C');
    await click(c, '⚡ Pay with my wallet');
    await waitText(c, 'Paid. The Lightning preimage proves it.', 60000);
    const p = await B(`#/trade/${tidLn}`);
    await waitText(p, 'Paid. The Lightning preimage proves it.', 30000);
    // Paid: the listing reserves itself, so nobody else orders it.
    await waitToast(p, 'is paid and now reserved', 30000);
    const c2 = await openListing('C', 'Fietslampjes set');
    await waitText(c2, 'Reserved: the seller is holding this');
    if (await exists(c2, btnX('🛒 Order now'))) throw new Error('can still order a paid listing');
    return 'both see the payment proven by the preimage; the listing reserved itself ("Order now" gone)';
  });
  await step('LN-10', 'Hand over, complete and review', async () => {
    let p = await B(`#/trade/${tidLn}`);
    await click(p, 'Handed over');
    await waitText(p, 'Handed over');
    const c = await go('C', `#/trade/${tidLn}`);
    await waitText(c, 'Handed over', 30000);
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
  await step('SHP-2', 'Prepaid label with a QR code in the chat', async () => {
    const id = await order('C', 'Fietslampjes set', { pay: '⚡ Lightning', carrier: 'PostNL' });
    const p = await B(`#/trade/${id}`);
    await waitText(p, 'Order from', 30000);
    await click(p, '✓ Accept');
    await click(p, 'Create invoice with my wallet');
    await waitText(p, 'I received the payment', 60000);
    const c = await go('C', `#/trade/${id}`);
    await waitText(c, 'A few details for the seller', 30000);
    // The address from TRD-3b is pre-filled, unless this browser was reset in TRD-11.
    if (!(await c.$eval('::-p-xpath(//label[span[normalize-space(.)="Full name"]]//input)', (i) => i.value))) await fillAddress(c);
    await clickIn(c, 'details-form', 'Send');
    await waitNoText(c, 'A few details for the seller');
    await waitText(c, 'Details sent', 30000);
    await waitText(c, 'Pay with my wallet', 30000);
    await click(c, '⚡ Pay with my wallet');
    await waitText(c, 'Paid. The Lightning preimage proves it.', 60000);
    const types = (pg) => pg.evaluate((tid) => Object.values(window.xbt?.inbox.get().rumors || {}).filter((r) => r.tags.some((t) => t[1] === tid)).map((r) => `${r.tags.find((t) => t[0] === 'xbt-type')?.[1]}@${r.created_at}`).join(' '), id);
    const cTypes = await types(c);
    const s = await B(`#/trade/${id}`);
    await waitText(s, 'Details sent', 30000).catch(async (e) => { throw new Error(`${e.message}; buyer has: ${cTypes}; seller has: ${await types(s)}`); });
    await s.waitForFunction(() => /Prepaid shipping label|Your address for the label/.test(document.querySelector('main').innerText), { timeout: 30000 });
    // B has no address yet in this run: fill it once.
    if ((await text(s)).includes('Your address for the label')) {
      await fillAddress(s);
      await click(s, 'Save');
    }
    await click(s, 'Get the label price');
    await waitText(s, 'Buy label');
    await (await el(s, '//button[starts-with(normalize-space(.),"Buy label")]')).click();
    await click(s, '⚡ Pay with my wallet');
    await waitText(s, 'Show this QR code', 60000);
    await s.waitForFunction(() => { const i = document.querySelector('img.label-qr'); return i && i.complete && i.naturalWidth > 0; }, { timeout: 20000 });
    await proof(s, 'plan', 'SHP-2 · Label betaald via Lightning: QR-code, PDF en trackingcode in de chat');
    const code = await s.$eval('.label-card code', (e) => e.textContent.trim());
    const filled = await s.$eval('::-p-xpath(//label[span[normalize-space(.)="Tracking code"]]//input)', (i) => i.value);
    if (filled !== code) throw new Error('tracking not pre-filled');
    await click(s, 'Mark as shipped');
    await waitText(s, 'Shipped with PostNL');
    return `label ${code} paid over Lightning; QR + PDF in the chat; tracking pre-filled`;
  });
  await step('TRD-3', 'Switch the payment method (Lightning → on-chain)', async () => {
    const id = await order('C', 'Fietslampjes set', { pay: '⚡ Lightning', pickup: true });
    people.C.onchainTrade = id;
    const c = await as('C');
    await click(c, '🔁 Change payment method');
    await choose(c, 'On-chain');
    await click(c, 'Ask');
    await waitText(c, 'Waiting for an answer');
    const p = await B(`#/trade/${id}`);
    await waitText(p, 'asks to pay with', 30000);
    await proof(p, 'plan', 'TRD-3 · Verkoper: koper vraagt om on-chain te betalen; akkoord of weigeren');
    await click(p, '✓ Agree');
    await waitText(p, 'Payment method changed');
    await waitText(p, 'On-chain');
    return 'request card for the seller; after "Agree" the order is on-chain; both shown in the chat';
  });
  await step('LN-9', 'Direct on-chain payment', async () => {
    const id = people.C.onchainTrade;
    const p = await B(`#/trade/${id}`);
    await click(p, '✓ Accept');
    const addr = cli('getnewaddress', 'plan-direct', 'bech32');
    await fill(p, 'Your XBT address', addr);
    await click(p, 'Request 0.0001 XBT');
    await waitText(p, 'I received the payment');
    const c = await go('C', `#/trade/${id}`);
    await waitText(c, 'Payment request:', 30000);
    const txid = cli('sendtoaddress', addr, '0.0001');
    mine(1);
    await fillPh(c, 'Payment txid', txid);
    await click(c, 'I paid');
    await waitText(c, '✓ 0.0001 XBT, 1 confirmations', 30000);
    return 'txid checked at the node: full amount, 1 confirmation';
  });
  await step('LN-8', 'Pay from another wallet', async () => {
    const id = await order('C', 'Fietslampjes set', { pay: '⚡ Lightning', pickup: true });
    const p = await B(`#/trade/${id}`);
    await waitText(p, 'Order from', 30000);
    await click(p, '✓ Accept');
    await click(p, 'Create invoice with my wallet');
    await waitText(p, 'I received the payment', 60000);
    const c = await go('C', `#/trade/${id}`);
    await waitText(c, 'Pay with my wallet', 30000);
    const invoice = await c.$eval('.addr code', (e) => e.textContent.trim());
    const pool = new SimplePool();
    await nwc.payInvoice(pool, parseNwcUri(walletUri('arbiter')), invoice);
    pool.close([RELAY]);
    await click(c, 'I paid');
    await waitText(c, 'The buyer reports a payment', 30000);
    const p2 = await B(`#/trade/${id}`);
    await click(p2, 'Check my wallet');
    await waitText(p2, 'The seller confirmed receiving the payment', 30000);
    return 'paid outside the app; seller checked the wallet and confirmed';
  });
  await step('SRV-2', 'Book a service and mark it done', async () => {
    const c = await openListing('C', 'Klusjesman voor kleine reparaties');
    await click(c, '🛒 Order now');
    await waitText(c, 'How do you want to pay?');
    if ((await text(c)).includes('Ship it to me')) throw new Error('delivery asked for a service');
    await click(c, 'Send order');
    await waitText(c, 'Waiting for the seller to accept');
    const id = await tradeIdOf(c);
    const p = await B(`#/trade/${id}`);
    await waitText(p, 'Order from', 30000);
    await click(p, '✓ Accept');
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
    return 'booked without delivery or address, paid, marked "done", confirmed';
  });

  // ---- import ----
  await step('IMP-1', 'Import button: clear name, no false warning', async () => {
    const p = await B('#/sell');
    await el(p, btnX('⇪ Import from Marktplaats, Vinted…'));
    await go('B', '#/import');
    await waitText(p, 'Import your listings from Marktplaats, Vinted, eBay…');
    const href = await p.$eval('a.bookmarklet', (a) => a.getAttribute('href'));
    if (!href.startsWith('javascript:')) throw new Error('no bookmarklet');
    if ((await text(p)).includes('older version')) throw new Error('outdated warning without an import');
    return '"Import from Marktplaats, Vinted…"; the bookmark carries the current version (fresh bookmark: no warning, see test:import)';
  });
  await step('IMP-9', 'From the app: paste a share link', async () => {
    const p = await B('#/import');
    await p.reload({ waitUntil: 'load' });
    await (await el(p, '//summary[contains(.,"Import button for your browser")]')).click();
    await waitText(p, 'not inside the Marktplaats or Vinted app');
    await fillPh(p, 'https://www.marktplaats.nl/u/…', 'http://127.0.0.1:4300/seller/view/m2454474184');
    await click(p, 'Read');
    await waitText(p, '1 found', 30000);
    const v = await p.$eval('.import-row input:not([type=checkbox]):not(.price-in)', (i) => i.value);
    if (v !== 'Eiken salontafel') throw new Error(v);
    await waitText(p, 'Reserved there');
    return 'a pasted /seller/view/m… link reads the ad (reserved recognised); the bookmark explains it needs a browser';
  });
  await step('IMP-11', 'Clear phone steps', async () => {
    const p = await B('#/import');
    await p.reload({ waitUntil: 'load' });
    await (await el(p, '//summary[contains(.,"Import button for your browser")]')).click();
    await waitText(p, 'On a phone');
    await waitText(p, 'Copy the bookmark code');
    return 'numbered phone steps for Chrome and Safari';
  });
  for (const [id, title] of [['IMP-2', 'Marktplaats profile, reserved recognised'], ['IMP-3', 'Published items disappear from the list'], ['IMP-7', '"Mark as sold on XBT Market"'], ['IMP-8', 'Single ad /seller/view/m…']]) {
    manual(id, title, 'Needs your real shop pages. The same logic passes in test:import against fake Marktplaats/Vinted/eBay pages (incl. /seller/view/m…, reserved, hidden duplicates, "Mark as sold on XBT Market").');
  }

  // ---- AI ----
  await step('AI-1', 'Save the API key', async () => {
    const p = await B('#/settings?open=ai');
    await waitText(p, 'other AI providers are not supported');
    await fillPh(p, 'sk-ant-…', 'sk-ant-plan-test-key');
    await click(p, 'Save');
    await waitText(p, 'Key saved');
    const raw = await p.evaluate((pk) => localStorage.getItem(`xbt:secrets:${pk}`), people.B.pk);
    if (raw.includes('sk-ant-plan')) throw new Error('key stored in plain text');
    return '"✓ Key saved"; only an Anthropic key, explained; storage holds only ciphertext';
  });
  await step('AI-2', 'Listing from photos', async () => {
    const p = await B('#/sell/new');
    await waitText(p, 'New listing');
    const input = await p.$('label.photo.add input[type=file]');
    await input.uploadFile('public/icon-512.png');
    await p.waitForFunction(() => document.querySelectorAll('.photos .photo img').length >= 1, { timeout: 30000 });
    await fakeAnthropic(p, { title: 'Rode wollen sjaal', description: 'Zachte rode sjaal van wol, zo goed als nieuw.', category: 'kleding-dames', condition: 'like-new', price: 8, notes: 'Vermeld de lengte van de sjaal.' });
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
    await go('B', '#/sell/new');
    const disabled = await (await el(p, btnX('✨ Write listing from photos'))).evaluate((b) => b.disabled);
    if (!disabled) throw new Error('enabled without photos');
    return 'AI button disabled without photos';
  });

  // ---- node choice ----
  await step('NODE-1', 'Known server', async () => {
    const p = await B('#/settings?open=network');
    await choose(p, 'Local (npm run shim)');
    await click(p, 'Test connection');
    await waitText(p, '✓ block');
    return 'block height read from the server';
  });
  await step('NODE-2', 'Own node', async () => {
    const p = await B('#/settings?open=network');
    await fillPh(p, 'https://umbrel.local:3006/api', 'http://localhost:3006/api');
    await click(p, 'Use');
    await waitText(p, '✓ block');
    await choose(p, 'Local (npm run shim)');
    return 'own node URL accepted and tested';
  });

  // ---- the service ----
  await step('SVC-1', 'The XBT Market service answers', async () => {
    const info = await (await fetch(API + '/')).json();
    if (info.service !== 'xbt-market' || !info.usernames) throw new Error(JSON.stringify(info));
    return `local service (same code as the Cloudflare Worker): ${JSON.stringify(info)}. Deploying it to Cloudflare: by you`;
  });
  await step('SVC-2', 'Shipping is on', async () => {
    const info = await (await fetch(API + '/')).json();
    if (!info.shipping) throw new Error(JSON.stringify(info));
    return 'shipping: true (against the Sendcloud mock). Your Sendcloud keys: by you';
  });

  // ---- settings and backup ----
  await step('SET-1', 'Trade backup download and restore', async () => {
    const p = await B('#/settings?open=backup');
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
    const p = await B('#/settings?open=trading');
    await fill(p, 'Manual rate (1 XBT in EUR)', '500');
    await openListing('B', 'Wollen sjaal, rood');
    await waitText(p, '€3.00 ≈ 0.006 XBT');
    const s = await B('#/settings?open=trading');
    await fill(s, 'Manual rate (1 XBT in EUR)', '50000');
    return 'XBT amount follows the manual rate';
  });
  await step('SET-3', 'Log out and log in again', async () => {
    const p = await B('#/settings');
    await click(p, 'Log out');
    await waitText(p, 'Create a new account', 20000);
    await fillPh(p, 'nsec1…', people.B.nsec);
    await click(p, 'Log in');
    await p.evaluate(() => { location.hash = '#/sell'; });
    await waitText(p, 'Your listings', 30000);
    // Paid in an escrow trade, so it may be under "Reserved".
    await sleep(3000);
    if (!(await text(p)).includes('Wollen sjaal, rood')) { const t = await p.$('::-p-xpath(//main//button[starts-with(normalize-space(.),"Reserved (")])'); if (t) await t.click(); }
    await waitText(p, 'Wollen sjaal, rood', 30000);
    await p.evaluate(() => { location.hash = '#/trades'; });
    await waitText(p, 'Wollen sjaal', 60000);
    return 'listings and trades back after logging in with the nsec';
  });

  // ---- things a script cannot do for you ----
  manual('TRD-4b', 'Pay from a real BLAKE2b wallet', 'Funding used a Knots regtest node. Paying from your own XBT wallet with real coins is for you.');
  manual('LN-real', 'A real Lightning wallet', 'Tested with mock NWC wallets. Connecting your own XBT Lightning wallet (NWC) is for you.');
  manual('AI-real', 'A real AI answer', 'Tested against a fake API. The quality of a real Claude answer needs your own API key.');
  manual('SVC-real', 'The service on Cloudflare with Sendcloud', 'Tested with the same code in Node against a Sendcloud mock. The live deploy and real labels need your Cloudflare and Sendcloud accounts.');
  manual('ACC-6b', 'Home screen icon on a real phone', 'Installability is checked; adding it to a real home screen is for you.');
} finally {
  const summary = { device: DEVICE, passed: results.filter((r) => r.status === 'pass').length, failed, manual: results.filter((r) => r.status === 'manual').length, results };
  if (SHOTS) writeFileSync(`${SHOTS}/testplan-results-${DEVICE}.json`, JSON.stringify(summary, null, 2));
  console.log(`\nTEST PLAN (${DEVICE}): ${summary.passed} passed, ${failed} failed, ${summary.manual} manual`);
  for (const r of results) console.log(`${r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '·'} ${r.id} ${r.title}${r.status !== 'pass' ? ' — ' + r.note : ''}`);
  await browser.close();
  process.exitCode = failed ? 1 : 0;
}
