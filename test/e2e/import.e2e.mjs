// Bookmarklet import test against local fake shop pages. See README "Testing".
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const src = readFileSync(new URL('../../src/generated/bookmarklet.js', import.meta.url), 'utf8');
const BOOKMARKLET = JSON.parse(src.match(/BOOKMARKLET_SOURCE = (".*");/)[1]).replace('__XBT_APP__', (process.env.APP_URL || 'http://127.0.0.1:4173/'));
const d = (process.env.PROFILE_DIR || process.env.HOME + '/snap/firefox/common') + '/xbt-import'; rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true });
const browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.FIREFOX || '/usr/bin/firefox', headless: true, userDataDir: d, protocolTimeout: 45000 });
const sk = generateSecretKey();
const app = await browser.newPage();
await app.goto((process.env.APP_URL || 'http://127.0.0.1:4173/'), { waitUntil: 'load' });
await app.evaluate((p) => {
  localStorage.setItem('xbt:account', JSON.stringify({ pubkey: p.pk, sk: p.sk, backedUp: true }));
  localStorage.setItem('xbt:settings', JSON.stringify({ relays: ['ws://127.0.0.1:7777'], network: 'regtest', lang: 'nl' }));
}, { pk: getPublicKey(sk), sk: Buffer.from(sk).toString('hex') });
await app.close();
let failures = 0;
for (const [url, expect] of [
  ['http://127.0.0.1:4300/member/123-fred', ["Levi’s 501 jeans W32", 'Nike hoodie']],
  ['http://127.0.0.1:4300/itm/999', ['Coldcard Mk4']],
  ['http://127.0.0.1:4300/sch/i.html', ['Raspberry Pi 4 4GB', 'Bitaxe Gamma 601']],
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
    await imp.evaluate(() => [...document.querySelectorAll('button')].find((b) => /publiceren/.test(b.textContent)).click());
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
  })));
  const summary = await imp.evaluate(() => document.querySelector('.import-summary').innerText.replace(/\n/g, ' '));
  const goneText = await imp.evaluate(() => document.querySelector('.notice.warn')?.innerText.split('\n')[0] || '');
  console.log(`  ${label}: ${summary} ${goneText ? '| ' + goneText : ''}`);
  for (const r of rows) console.log(`    [${r.checked ? 'x' : ' '}] ${r.title} €${r.price} ${r.badge}`);
  return { shop, imp, rows, summary, goneText };
}
await fetch('http://127.0.0.1:4300/__variant?v=1');
let r = await runMp('first import');
const check = (cond, msg) => { if (!cond) { failures++; console.log('FAIL', msg); } };
check(r.rows.length === 5 && r.rows.filter((x) => x.badge.match(/Nieuw/)).length === 5, 'all 5 new');
check(r.rows.find((x) => x.title === 'MP item 5').checked === false, 'price-less item not preselected');
check(r.rows.find((x) => x.title === 'MP item 1').price === '10', 'price parsed');
await r.imp.evaluate(() => [...document.querySelectorAll('button')].find((b) => /publiceren/.test(b.textContent)).click());
await r.imp.waitForFunction(() => /4 staan al/.test(document.querySelector('.import-summary')?.innerText || ''), { timeout: 30000 });
await r.imp.close(); await r.shop.close();

r = await runMp('re-import, nothing changed');
check(/1 nieuw/.test(r.summary) && /4 staan al/.test(r.summary), 'everything recognised on re-import (only the unpriced one is new)');
check(r.rows.every((x) => !x.checked || x.title === 'MP item 5'), 'nothing preselected');
await r.imp.close(); await r.shop.close();

await fetch('http://127.0.0.1:4300/__variant?v=2');
r = await runMp('re-import after changes on Marktplaats');
check(/1 gewijzigd/.test(r.summary), 'price change detected');
check(/MP item 3/.test(r.goneText) && !/MP item [1245]/.test(r.goneText), 'removed listing detected');
await r.imp.close(); await r.shop.close();

await browser.close();
console.log(failures ? 'IMPORT FAILED' : 'IMPORT PASSED');
