// Bookmarklet import test against local fake shop pages. See README "Testing".
import { setupPage, launchBrowser } from './proof.mjs';
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const src = readFileSync(new URL('../../src/generated/bookmarklet.js', import.meta.url), 'utf8');
const BOOKMARKLET = JSON.parse(src.match(/BOOKMARKLET_SOURCE = (".*");/)[1]).replace('__XBT_APP__', (process.env.APP_URL || 'http://127.0.0.1:4173/'));
const d = (process.env.PROFILE_DIR || process.env.HOME + '/snap/firefox/common') + '/xbt-import'; rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true });
// Firefox by default (FIREFOX=…), or Chromium with CHROME=/path/to/chrome.
const browser = await launchBrowser(puppeteer, process.env.CHROME
  ? { browser: 'chrome', executablePath: process.env.CHROME, headless: true, args: ['--no-sandbox'], protocolTimeout: 45000 }
  : { browser: 'firefox', executablePath: process.env.FIREFOX || '/usr/bin/firefox', headless: true, userDataDir: d, protocolTimeout: 45000 });
const sk = generateSecretKey();
const app = await browser.newPage();
await setupPage(app);
await app.goto((process.env.APP_URL || 'http://127.0.0.1:4173/'), { waitUntil: 'load' });
await app.evaluate((p) => {
  localStorage.setItem('xbt:account', JSON.stringify({ pubkey: p.pk, sk: p.sk, backedUp: true }));
  localStorage.setItem('xbt:settings', JSON.stringify({ relays: ['ws://127.0.0.1:7777'], network: 'regtest', lang: 'en', country: 'NL' }));
}, { pk: getPublicKey(sk), sk: Buffer.from(sk).toString('hex') });
await app.close();
let failures = 0;
for (const [url, expect] of [
  ['http://localhost:4300/member/123-fred', ["Levi’s 501 jeans W32", 'Nike hoodie']],
  ['http://localhost:4300/itm/999', ['Coldcard Mk4']],
  ['http://localhost:4300/sch/i.html', ['Raspberry Pi 4 4GB', 'Bitaxe Gamma 601']],
]) {
  const shop = await browser.newPage();
  await shop.goto(url, { waitUntil: 'load' });
  const popup = new Promise((resolve) => browser.once('targetcreated', (t) => resolve(t.page())));
  shop.on('dialog', (d) => { console.log('  dialog:', d.message()); d.dismiss(); });
  await shop.evaluate(BOOKMARKLET + ';0');
  const imp = await popup;
  await sleep(4000);
  const txt = await imp.evaluate(() => document.querySelector('main')?.innerText || '');
  const vals = await imp.evaluate(() => [...document.querySelectorAll('.import-row input:not([type=checkbox]):not(.price-in)')].map((i) => i.value));
  const prices = await imp.evaluate(() => [...document.querySelectorAll('.import-row .price-in')].map((i) => i.value));
  const ok = expect.every((t) => vals.includes(t)) && !vals.includes('Shop on eBay');
  if (!ok) failures++;
  console.log(ok ? 'ok  ' : 'FAIL', url, JSON.stringify(vals), JSON.stringify(prices), txt.split('\n')[1] || '');
  if (url.includes('member')) {
    if (process.env.SHOTS) await imp.screenshot({ path: process.env.SHOTS + '/8-import.png', fullPage: true });
    await imp.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^Publish \d/.test(b.textContent)).click());
    await sleep(3000);
    console.log('after publish:', (await imp.evaluate(() => document.querySelector('main').innerText)).slice(0, 120).replace(/\n/g, ' | '));
  }
  await imp.close();
  await shop.close();
}

// Marktplaats profile: first import, re-import (all recognised), then changes.
async function runMp(label) {
  const shop = await browser.newPage();
  await shop.goto('http://127.0.0.1:4300/u/test-seller/123456/', { waitUntil: 'load' });
  const popup = new Promise((resolve) => browser.once('targetcreated', (t) => resolve(t.page())));
  shop.on('dialog', (d) => { console.log('  dialog:', d.message()); d.dismiss(); });
  await shop.evaluate(BOOKMARKLET + ';0');
  const imp = await popup;
  await imp.waitForSelector('.import-summary', { timeout: 20000 });
  await sleep(500);
  const rows = await imp.evaluate(() => [...document.querySelectorAll('.import-row')].map((r) => ({
    title: r.querySelector('input:not([type=checkbox]):not(.price-in)').value,
    price: r.querySelector('.price-in').value,
    checked: r.querySelector('input[type=checkbox]').checked,
    badge: r.querySelector('.badge')?.textContent,
    photos: Number(r.querySelector('.photos-count')?.textContent.replace(/\D/g, '') || 0),
  })));
  const summary = await imp.evaluate(() => document.querySelector('.import-summary').innerText.replace(/\n/g, ' '));
  const notices = await imp.evaluate(() => [...document.querySelectorAll('.notice')].map((n) => n.innerText).join(' | '));
  console.log(`  ${label}: ${summary} ${notices ? '| ' + notices : ''}`);
  for (const r of rows) console.log(`    [${r.checked ? 'x' : ' '}] ${r.title} €${r.price} ${r.badge} 📷${r.photos}`);
  return { shop, imp, rows, summary, notices };
}
await fetch('http://127.0.0.1:4300/__variant?v=1');
let r = await runMp('first import');
const check = (cond, msg) => { if (!cond) { failures++; console.log('FAIL', msg); } };
check(r.rows.length === 5 && r.rows.filter((x) => x.badge.match(/New/)).length === 5, 'all 5 new');
check(r.rows.find((x) => x.title === 'MP item 5').checked === false, 'price-less item not preselected');
check(r.rows.find((x) => x.title === 'MP item 1').price === '10', 'price parsed');
check(r.rows.find((x) => x.title === 'MP item 4').price === '40', 'MIN_BID price parsed');
check(r.rows.every((x) => x.photos === 3), 'all 3 photos of every ad, read from the ad pages (the profile shows only one)');
await r.imp.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^Publish \d/.test(b.textContent)).click());
await r.imp.waitForFunction(() => /4 already on XBT Market/.test(document.querySelector('.import-summary')?.innerText || ''), { timeout: 30000 });
await r.imp.close(); await r.shop.close();

r = await runMp('re-import, nothing changed');
check(/1 new/.test(r.summary) && /4 already on XBT Market/.test(r.summary), 'everything recognised on re-import (only the unpriced one is new)');
check(r.rows.length === 1, 'items already on XBT Market are hidden from the list');
check(r.rows.every((x) => !x.checked || x.title === 'MP item 5'), 'nothing preselected');
await r.imp.close(); await r.shop.close();

await fetch('http://127.0.0.1:4300/__variant?v=2');
r = await runMp('re-import after changes on Marktplaats');
check(/1 changed/.test(r.summary), 'price change detected');
check(!/no longer on that profile/.test(r.notices) && !(await r.imp.evaluate(() => [...document.querySelectorAll('button')].some((b) => /Mark as sold/.test(b.textContent)))), 'no "no longer on that profile" notice or button (removed: confusing)');
await r.imp.close(); await r.shop.close();

// On a phone the bookmark opens no pop-up: XBT Market opens in the same tab,
// with the listings compressed in the address, after a note on the shop page.
{
  const shop = await browser.newPage();
  await shop.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36');
  await shop.goto('http://127.0.0.1:4300/u/test-seller/123456/', { waitUntil: 'load' });
  let popups = 0;
  const count = () => { popups++; };
  browser.on('targetcreated', count);
  shop.on('dialog', (d) => { console.log('  dialog:', d.message()); d.dismiss(); });
  // The note can be gone again within moments, when the page navigates.
  let noteShown = false;
  await shop.exposeFunction('xbtNoteSeen', () => { noteShown = true; });
  await shop.evaluate(() => new MutationObserver(() => { if (/XBT Market: (reading|\d+ listings found)/.test(document.getElementById('xbt-import-note')?.textContent || '')) window.xbtNoteSeen(); }).observe(document.body, { childList: true, subtree: true, characterData: true }));
  const nav = shop.waitForNavigation({ timeout: 60000 }).catch(() => null);
  await shop.evaluate(BOOKMARKLET + ';0');
  await nav;
  await shop.waitForSelector('.import-row', { timeout: 30000 }).catch(() => {});
  browser.off('targetcreated', count);
  const url = shop.url();
  const rows = await shop.evaluate(() => document.querySelectorAll('.import-row').length);
  check(noteShown, 'phone: a note on the shop page while reading');
  check(url.startsWith((process.env.APP_URL || 'http://127.0.0.1:4173/')) && url.includes('#/import'), `phone: XBT Market opened in the same tab (${url.slice(0, 80)})`);
  check(popups === 0, 'phone: no pop-up');
  check(rows >= 1, `phone: the listings arrived (${rows} rows)`);
  console.log(popups === 0 && rows >= 1 ? 'ok   phone bookmark: same tab, compressed listings' : 'FAIL phone bookmark');
  await shop.close();
}

// An old (v1) bookmark still imports, without a warning.
{
  const imp = await browser.newPage();
  await imp.goto((process.env.APP_URL || 'http://127.0.0.1:4173/') + '#/import', { waitUntil: 'load' });
  await sleep(1500);
  await imp.evaluate(() => window.postMessage({ type: 'xbt-import', payload: { v: 1, source: 'www.marktplaats.nl', at: 1, page: 'x', items: [{ title: 'ITW', price: 1, url: 'https://www.marktplaats.nl/u/itw/1/' }] } }, '*'));
  await sleep(2500);
  // No warning any more (it confused people importing from several sites); the old bookmark just works.
  const text = await imp.evaluate(() => document.body.innerText);
  const ok = !/older version/.test(text);
  check(ok, 'an old bookmark still imports, without a warning');
  console.log(ok ? 'ok   old bookmark imports without a warning' : 'FAIL old bookmark');
  await imp.close();
}

// A single reserved ad from the seller's own view (/seller/view/m…), with the
// bookmark: found, marked reserved, not preselected, and no outdated warning.
{
  const shop = await browser.newPage();
  await shop.goto('http://127.0.0.1:4300/seller/view/m2454474184', { waitUntil: 'load' });
  const popup = new Promise((resolve) => browser.once('targetcreated', (t) => resolve(t.page())));
  shop.on('dialog', (d) => { console.log('  dialog:', d.message()); d.dismiss(); });
  await shop.evaluate(BOOKMARKLET + ';0');
  const imp = await popup;
  await imp.waitForSelector('.import-row', { timeout: 20000 });
  const row = await imp.evaluate(() => ({ title: document.querySelector('.import-row input:not([type=checkbox]):not(.price-in)').value, checked: document.querySelector('.import-row input[type=checkbox]').checked, text: document.querySelector('main').innerText }));
  check(row.title === 'Eiken salontafel', 'single ad from /seller/view/ found');
  check(/Reserved there/.test(row.text) && !row.checked, 'reserved ad recognised and not preselected');
  check(!/older version/.test(row.text), 'a fresh bookmark gives no outdated warning');
  console.log(row.title === 'Eiken salontafel' ? 'ok   single reserved ad via the bookmark' : 'FAIL single ad', JSON.stringify(row.title));
  await imp.close(); await shop.close();
}

// The same ad by pasting its link (the XBT Market service reads the page), as a phone user would.
if (process.env.API) {
  const imp = await browser.newPage();
  await setupPage(imp);
  await imp.goto((process.env.APP_URL || 'http://127.0.0.1:4173/') + '#/import', { waitUntil: 'load' });
  const input = await imp.waitForSelector('input[inputmode=url]', { timeout: 15000 });
  await input.type('http://127.0.0.1:4300/seller/view/m2454474184');
  await imp.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Read').click());
  await imp.waitForSelector('.import-row', { timeout: 20000 }).catch(() => {});
  const title = await imp.evaluate(() => document.querySelector('.import-row input:not([type=checkbox]):not(.price-in)')?.value || document.querySelector('main').innerText.slice(0, 300));
  check(title === 'Eiken salontafel', 'import by pasted link');
  console.log(title === 'Eiken salontafel' ? 'ok   import by pasted link' : 'FAIL import by pasted link: ' + title);
  if (process.env.SHOTS) await imp.screenshot({ path: process.env.SHOTS + '/import-link.png', fullPage: true });
  await imp.close();
}

await browser.close();
console.log(failures ? 'IMPORT FAILED' : 'IMPORT PASSED');
