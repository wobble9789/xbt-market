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
await browser.close();
console.log(failures ? 'IMPORT FAILED' : 'IMPORT PASSED');
