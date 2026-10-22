// Minimal Esplora client (mempool.guide serves the BLAKE2b chain with a full
// Esplora API). Every call goes straight from the browser; nothing is proxied.

export class Esplora {
  constructor(base) { this.base = base.replace(/\/+$/, ''); }

  async get(path, type = 'json') {
    const r = await fetch(this.base + path);
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text().catch(() => '')}`.trim());
    return type === 'json' ? r.json() : r.text();
  }

  tipHeight() { return this.get('/blocks/tip/height', 'text').then(Number); }

  // [{ txid, vout, value, status: { confirmed, block_height } }]
  utxos(address) { return this.get(`/address/${address}/utxo`); }

  addressTxs(address) { return this.get(`/address/${address}/txs`); }

  tx(txid) { return this.get(`/tx/${txid}`); }

  txStatus(txid) { return this.get(`/tx/${txid}/status`); }

  async feeRate(target = 'halfHourFee') {
    try {
      const f = await this.get('/v1/fees/recommended');
      return Math.max(1, f[target] ?? f.halfHourFee ?? 1);
    } catch {
      return 2; // some servers send a doubled CORS header that browsers refuse
    }
  }

  // Esplora takes the raw hex as a text/plain body, so no CORS preflight.
  async broadcast(hex) {
    const r = await fetch(this.base + '/tx', { method: 'POST', body: hex });
    const text = await r.text();
    if (!r.ok) throw new Error(text || `broadcast failed (${r.status})`);
    return text.trim();
  }
}

// Escrow funding as seen by the chain: confirmed and unconfirmed totals.
export async function escrowFunding(esplora, address, minConf) {
  const [utxos, tip] = await Promise.all([esplora.utxos(address), esplora.tipHeight()]);
  const conf = (u) => (u.status?.confirmed ? tip - u.status.block_height + 1 : 0);
  const list = utxos
    .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmations: conf(u), blockTime: u.status?.block_time || null }))
    .sort((a, b) => (a.txid === b.txid ? a.vout - b.vout : a.txid < b.txid ? -1 : 1));
  const confirmed = list.filter((u) => u.confirmations >= minConf);
  return {
    utxos: list,
    confirmedUtxos: confirmed,
    total: list.reduce((s, u) => s + u.value, 0),
    confirmedTotal: confirmed.reduce((s, u) => s + u.value, 0),
    tip,
  };
}
