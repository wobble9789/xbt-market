// Builds one HTML page from the screenshots the e2e tests take with SHOTS set:
//   node scripts/proof-report.mjs <shots dir> [out.html] [results.json]
// results.json (optional): [{ name, ok, detail }] for suites without screenshots.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

const dir = process.argv[2];
const out = process.argv[3] || `${dir}/report.html`;
const results = process.argv[4] && existsSync(process.argv[4]) ? JSON.parse(readFileSync(process.argv[4], 'utf8')) : [];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const shots = readFileSync(`${dir}/manifest.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((s) => ({ device: 'chrome-desktop', ...s }));
const DEVICES = { 'firefox-desktop': 'Firefox · desktop', 'firefox-phone': 'Firefox · telefoonformaat', 'chrome-desktop': 'Chrome · desktop', 'chrome-phone': 'Chrome · telefoon (Android-emulatie)' };
// Test plan results per device (testplan-results-<device>.json), merged by ID.
const plans = readdirSync(dir).filter((f) => /^testplan-results-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
const planIds = [...new Map(plans.flatMap((p) => p.results.map((r) => [r.id, r.title]))).entries()];
const STATUS = { pass: ['ok', '✓ geslaagd'], fail: ['bad', '✗ mislukt'], manual: ['muted', '· door jou'] };
const SUITES = {
  escrow: 'Kopen met escrow, en een geschil met arbiter (echte Knots-regtest-node)',
  direct: 'Direct betalen: Lightning via gekoppelde wallets, en on-chain (echte node)',
  extras: 'Instellingen, nodekeuze, versleutelde opslag, AI-hulp en escrow-advies',
  plan: 'De handmatige testlijst, stap voor stap',
};
const groups = Object.keys(DEVICES).flatMap((d) => Object.keys(SUITES).map((k) => [d, k])).filter(([d, k]) => shots.some((s) => s.device === d && s.suite === k));
const img = (s) => `data:image/jpeg;base64,${readFileSync(`${dir}/${s.file}`).toString('base64')}`;

const html = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>XBT Market testbewijs</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--text:#1b1c1e;--muted:#6b6f76;--line:#e3e3df;--ok:#1f8a4c;--okbg:#e6f5ec;--bad:#c0392b;--badbg:#fdeceb}
@media (prefers-color-scheme:dark){:root{--bg:#111214;--card:#1b1c1f;--text:#ececec;--muted:#9a9ea6;--line:#2c2e33;--ok:#4cc27f;--okbg:#12301f;--bad:#ef6b5e;--badbg:#3a1714}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px}
h1{font-size:24px;margin:0 0 4px} h2{font-size:19px;margin:32px 0 12px}
.muted{color:var(--muted)} table{border-collapse:collapse;width:100%;background:var(--card);border-radius:10px;overflow:hidden}
td,th{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}
figure{margin:0 0 20px;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
figcaption{padding:10px 14px;border-bottom:1px solid var(--line)} figcaption b{color:var(--ok)}
figure img{display:block;width:100%;height:auto;max-height:900px;object-fit:contain;object-position:top;background:#fff}
figure.mobile img{max-width:390px;margin:0 auto}
figure.phone img{max-width:420px;margin:0 auto}
</style></head><body><main>
<h1>XBT Market: testbewijs</h1>
<p class="muted">${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC · ${shots.length} screenshots, elk gemaakt direct nadat de test die stap had gecontroleerd.</p>
<h2>Uitslag per testsuite</h2>
<table><tr><th>Test</th><th>Uitslag</th><th>Wat het bewijst</th></tr>
${results.map((r) => `<tr><td>${esc(r.name)}</td><td class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓ geslaagd' : '✗ mislukt'}</td><td>${esc(r.detail || '')}</td></tr>`).join('')}
</table>
${plans.length ? `<h2>Handmatige testlijst (testplan.html), automatisch doorlopen</h2>
<p class="muted">${plans.map((p) => `${esc(DEVICES[p.device] || p.device)}: ${p.passed} geslaagd, ${p.failed} mislukt, ${p.manual} door jou`).join(' · ')}</p>
<table><tr><th>ID</th><th>Test</th>${plans.map((p) => `<th>${esc(DEVICES[p.device] || p.device)}</th>`).join('')}<th>Toelichting</th></tr>
${planIds.map(([id, title]) => { const rs = plans.map((p) => p.results.find((r) => r.id === id)); const note = rs.find((r) => r && r.status !== 'pass')?.note || rs.find(Boolean)?.note || ''; return `<tr><td>${esc(id)}</td><td>${esc(title)}</td>${rs.map((r) => `<td class="${r ? STATUS[r.status][0] : 'muted'}">${r ? STATUS[r.status][1] : '–'}</td>`).join('')}<td class="muted">${esc(note)}</td></tr>`; }).join('')}
</table>` : ''}
${groups.map(([d, g]) => `<h2>${esc(DEVICES[d])}: ${esc(SUITES[g])}</h2>${shots.filter((s) => s.device === d && s.suite === g).map((s, i) => `<figure class="${s.file.includes('-mobile') ? 'mobile' : ''} ${s.device.endsWith('phone') ? 'phone' : ''}"><figcaption><b>✓</b> ${i + 1}. ${esc(s.caption)}</figcaption><img loading="lazy" src="${img(s)}" alt="${esc(s.caption)}"></figure>`).join('')}`).join('')}
</main></body></html>`;
writeFileSync(out, html);
console.log(`${out}: ${shots.length} screenshots, ${(html.length / 1e6).toFixed(1)} MB`);
