export const SATS = 100_000_000;

export function formatCoin(sats, { unit = true, digits = 8 } = {}) {
  if (sats == null || Number.isNaN(sats)) return '–';
  const s = (sats / SATS).toFixed(digits).replace(/\.?0+$/, '') || '0';
  return unit ? `${s} XBT` : s;
}

export function parseCoin(text) {
  const t = String(text).trim().replace(',', '.');
  if (!/^\d+(\.\d{0,8})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  return Number(w) * SATS + Number(f.padEnd(8, '0'));
}

export function formatFiat(amount, currency = 'EUR') {
  if (amount == null || Number.isNaN(amount)) return '–';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
