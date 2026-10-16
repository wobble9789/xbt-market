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
  // On a phone every proof point is also a layout check: nothing may be wider
  // than the screen (that makes the page zoom out or scroll sideways).
  if (MOBILE) {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (over > 1) throw new Error(`page is ${over}px wider than the phone screen (${caption})`);
  }
  if (!SHOTS) return;
  if (mobile && MOBILE) return; // the whole run is already on a phone
  const file = `${DEVICE}-${suite}-${String(++n).padStart(2, '0')}${mobile ? '-mobile' : ''}.jpg`;
  if (mobile) await page.setViewport({ width: 390, height: 844 });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `${SHOTS}/${file}`, type: 'jpeg', quality: 70, fullPage });
  if (mobile) await setupPage(page);
  appendFileSync(`${SHOTS}/manifest.jsonl`, JSON.stringify({ device: DEVICE, suite, file, caption, who: page.who || '', at: new Date().toISOString() }) + '\n');
}

// Scroll an element to the middle of the screen and wait until it stops
// moving (late images, reputation lines), so a tap lands where a person's would.
export async function settle(el) {
  await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  let prev = null;
  for (let i = 0; i < 20; i++) {
    const box = await el.boundingBox();
    if (box && prev && box.x === prev.x && box.y === prev.y && box.height === prev.height) return;
    prev = box;
    await new Promise((r) => setTimeout(r, 120));
  }
}

// A fake api.anthropic.com inside the page (works in every browser, unlike
// request interception): the app's next AI call gets `draft` back as Claude's
// answer, and the request is kept in window.__aiCalls for checks.
export function fakeAnthropic(page, draft) {
  return page.evaluate((draft) => {
    window.__aiCalls = [];
    const real = window.__realFetch || window.fetch;
    window.__realFetch = real;
    window.fetch = async (input, init = {}) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (!url.startsWith('https://api.anthropic.com/')) return real(input, init);
      const req = input instanceof Request ? input : null;
      const text = init.body != null ? init.body : await req.clone().text();
      const headers = Object.fromEntries(new Headers(init.headers || req?.headers || {}));
      window.__aiCalls.push({ url, headers, body: JSON.parse(text) });
      return new Response(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify(draft) }], usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  }, draft);
}
