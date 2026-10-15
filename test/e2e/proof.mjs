// Screenshots as proof of each passed step. With SHOTS=<dir> every call saves
// a JPEG and appends { suite, file, caption, who } to <dir>/manifest.jsonl;
// scripts/proof-report.mjs turns that into one HTML page.
import { appendFileSync } from 'node:fs';

const SHOTS = process.env.SHOTS;
let n = 0;

export async function proof(page, suite, caption, { mobile = false, fullPage = true } = {}) {
  if (!SHOTS) return;
  const file = `${suite}-${String(++n).padStart(2, '0')}${mobile ? '-mobile' : ''}.jpg`;
  if (mobile) await page.setViewport({ width: 390, height: 844 });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `${SHOTS}/${file}`, type: 'jpeg', quality: 70, fullPage });
  if (mobile) await page.setViewport({ width: 1280, height: 900 });
  appendFileSync(`${SHOTS}/manifest.jsonl`, JSON.stringify({ suite, file, caption, who: page.who || '', at: new Date().toISOString() }) + '\n');
}
