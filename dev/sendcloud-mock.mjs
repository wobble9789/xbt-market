// A pretend Sendcloud (API v3) for development and tests: shipping options with
// prices, announcing a shipment, a label PDF and a QR code, and pick-up points.
// Also a pretend Resend, for the bug report e-mails.
//   node dev/sendcloud-mock.mjs [port]   (default 3011)
// Point the service at it: SENDCLOUD_BASE=http://127.0.0.1:3011/api/v3
//   SENDCLOUD_POINTS_BASE=http://127.0.0.1:3011/points SENDCLOUD_PUBLIC_KEY=x SENDCLOUD_SECRET_KEY=y
import http from 'node:http';
import qrcode from 'qrcode-generator';

const port = Number(process.argv[2] || 3011);
const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
// [code, carrier, name, base price, per kg, labelless, service point, domestic only]
const OPTIONS = [
  ['postnl:standard', 'postnl', 'PostNL Standard', 4.95, 0.4, true, false, false],
  ['dhl:parcel', 'dhl', 'DHL Parcel', 5.45, 0.35, true, false, false],
  ['dpd:home', 'dpd', 'DPD Home', 6.1, 0.3, false, false, false],
  ['mondial_relay:service_point_qr', 'mondial_relay', 'Mondial Relay Point Relais', 3.6, 0.25, true, true, false],
  ['inpost:locker', 'inpost', 'InPost Locker', 3.9, 0.2, true, true, false],
  ['budbee:home', 'budbee', 'Budbee Home', 4.5, 0.2, false, false, true],
  ['gls_eu:business', 'gls_eu', 'GLS', 6.9, 0.3, false, false, false],
];
const SIZES = { 2: 'S', 5: 'M', 10: 'L', 20: 'XL' };
const shipments = new Map();
const emails = [];
const issues = [];
let nextId = 1000;

const pdf = (text) => Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 298 420]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length ${text.length + 40}>>stream\nBT /F1 14 Tf 20 380 Td (${text}) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF`);

function qrPng(text) {
  // An SVG is enough for the browser test; served as image/svg+xml.
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return Buffer.from(q.createSvgTag({ cellSize: 6, margin: 2 }));
}

const send = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let body = '';
  for await (const c of req) body += c;
  const data = body ? JSON.parse(body) : {};
  // A pretend Resend (e-mail) for bug reports: RESEND_BASE=http://127.0.0.1:3011/resend
  if (url.pathname === '/resend/emails' && req.method === 'POST') {
    const mail = data;
    emails.push({ to: mail.to, subject: mail.subject, html: mail.html, attachments: (mail.attachments || []).map((a) => ({ filename: a.filename, bytes: Buffer.from(a.content, 'base64').length })) });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'mail' + emails.length }));
  }
  if (url.pathname === '/resend/emails' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify(emails));
  }
  // A pretend GitHub issues API: GITHUB_API=http://127.0.0.1:3011/github
  if (/^\/github\/repos\/[^/]+\/[^/]+\/issues$/.test(url.pathname) && req.method === 'POST') {
    issues.push({ repo: url.pathname.split('/').slice(3, 5).join('/'), title: data.title, body: data.body, labels: data.labels, auth: req.headers.authorization });
    res.writeHead(201, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ number: issues.length, html_url: `https://github.com/${url.pathname.split('/').slice(3, 5).join('/')}/issues/${issues.length}` }));
  }
  if (url.pathname === '/github/issues' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify(issues));
  }
  if (!req.headers.authorization?.startsWith('Basic ')) return send(res, 401, { errors: [{ detail: 'Unauthorized' }] });
  const p = url.pathname;
  if (p === '/api/v3/shipping-options' && req.method === 'POST') {
    const kg = Number(data.parcels?.[0]?.weight?.value || 2);
    const intl = data.from_country_code !== data.to_country_code;
    const reach = EU.includes(data.to_country_code) ? 1 : data.to_country_code === 'GB' || data.to_country_code === 'CH' || data.to_country_code === 'NO' ? 1.8 : 3.2;
    const list = OPTIONS.filter((o) => !(o[7] && intl)).map(([code, carrier, name, base, perKg, labelless, point]) => ({
      code, name, carrier: { code: carrier, name: name.split(' ')[0] },
      functionalities: { labelless, last_mile: point ? 'service_point' : 'home_delivery' },
      quotes: [{ price: { total: { value: ((base + perKg * kg) * (intl ? 1.6 : 1) * (intl ? reach : 1)).toFixed(2), currency: 'EUR' } } }],
    }));
    return send(res, 200, { data: list, size: SIZES[kg] });
  }
  if (p === '/api/v3/shipments/announce' && req.method === 'POST') {
    const opt = OPTIONS.find((o) => o[0] === data.ship_with?.properties?.shipping_option_code);
    if (!opt) return send(res, 400, { errors: [{ detail: 'Unknown shipping option' }] });
    for (const [k, a] of [['from', data.from_address], ['to', data.to_address]]) if (!a?.name || !a?.postal_code || !a?.country_code) return send(res, 400, { errors: [{ detail: `${k}_address incomplete` }] });
    if (opt[6] && !data.to_service_point?.id) return send(res, 400, { errors: [{ detail: 'to_service_point required' }] });
    const existing = [...shipments.values()].find((s) => s.external_reference_id === data.external_reference_id);
    if (existing) return send(res, 409, { errors: [{ detail: 'Duplicate external_reference_id' }] });
    const id = nextId++;
    const tracking = `3S${opt[1].toUpperCase().slice(0, 4)}${id}NL`;
    const base = `http://${req.headers.host}/api/v3`;
    const s = { id, external_reference_id: data.external_reference_id, opt, to: data.to_address, from: data.from_address, tracking };
    shipments.set(id, s);
    console.log(`  label ${tracking} ${opt[2]}: ${data.from_address.city} -> ${data.to_address.city}`);
    return send(res, 200, { data: { id: `sh-${id}`, parcels: [{ id, tracking_number: tracking, tracking_url: `https://tracking.example/${tracking}`, status: { code: 'ANNOUNCED' },
      documents: [{ type: 'label', link: `${base}/parcels/${id}/documents/label` }, ...(opt[5] ? [{ type: 'qr', link: `${base}/parcels/${id}/documents/qr` }] : [])] }] } });
  }
  let m;
  if ((m = p.match(/^\/api\/v3\/parcels\/(\d+)\/documents\/(label|qr)$/))) {
    const s = shipments.get(Number(m[1]));
    if (!s) return send(res, 404, { errors: [{ detail: 'Not found' }] });
    return m[2] === 'qr' ? send(res, 200, qrPng(`SENDCLOUD-QR-${s.tracking}`), 'image/svg+xml') : send(res, 200, pdf(`${s.opt[2]} ${s.tracking} to ${s.to.name}, ${s.to.city}`), 'application/pdf');
  }
  if (p === '/points/service-points') {
    const c = url.searchParams.get('carrier');
    return send(res, 200, [1, 2, 3].map((i) => ({ id: 9000 + i, name: `${c} point ${i}`, street: 'Hoofdstraat', house_number: String(i * 10), postal_code: url.searchParams.get('address') || '1000AA', city: 'Teststad', carrier: c, distance: i * 300 })));
  }
  send(res, 404, { errors: [{ detail: 'Not found: ' + p }] });
}).listen(port, '127.0.0.1', () => console.log(`Sendcloud mock on http://127.0.0.1:${port}/api/v3`));
