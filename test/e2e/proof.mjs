// Shared by the e2e tests: the device to emulate and screenshots as proof.
//
// MOBILE=1 runs a test as a phone: 390×844 screen, touch, and a phone user
// agent (Chromium also gets isMobile; Firefox gets the screen size and touch
// where it supports them).
//
// With SHOTS=<dir> every proof() call saves a JPEG after a verified step and
// appends { device, suite, file, caption, who } to <dir>/manifest.jsonl;
// scripts/proof-report.mjs turns that into one HTML page.
import { appendFileSync } from 'node:fs';

const SHOTS = process.env.SHOTS;
export const MOBILE = !!process.env.MOBILE;
export const DEVICE = `${process.env.CHROME ? 'chrome' : 'firefox'}-${MOBILE ? 'phone' : 'desktop'}`;
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

export async function setupPage(page) {
  if (!MOBILE) return page.setViewport(DESKTOP);
  await page.setUserAgent(PHONE_UA).catch(() => {});
  await page.setViewport(PHONE).catch(() => page.setViewport({ width: PHONE.width, height: PHONE.height }));
}

let n = 0;
export async function proof(page, suite, caption, { mobile = false, fullPage = true } = {}) {
  if (!SHOTS) return;
  if (mobile && MOBILE) return; // the whole run is already on a phone
  const file = `${DEVICE}-${suite}-${String(++n).padStart(2, '0')}${mobile ? '-mobile' : ''}.jpg`;
  if (mobile) await page.setViewport({ width: 390, height: 844 });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `${SHOTS}/${file}`, type: 'jpeg', quality: 70, fullPage });
  if (mobile) await setupPage(page);
  appendFileSync(`${SHOTS}/manifest.jsonl`, JSON.stringify({ device: DEVICE, suite, file, caption, who: page.who || '', at: new Date().toISOString() }) + '\n');
}
