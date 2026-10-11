// Public trade reviews as NIP-32 labels (kind 1985), namespace xbt-market/review.
// A review names the trade id and the payout txid. A trade counts as "verified"
// when both parties reviewed it with the same txid.

import { query, signAndPublish, tag } from './pool.js';

export const REVIEW_NS = 'xbt-market/review';

export function publishReview({ about, tradeId, txid, rating, text, role }) {
  return signAndPublish({
    kind: 1985,
    tags: [
      ['L', REVIEW_NS], ['l', rating >= 3 ? 'positive' : 'negative', REVIEW_NS], ['p', about],
      ['xbt-trade', tradeId], ['rating', String(rating)], ['role', role], ...(txid ? [['txid', txid]] : []),
    ],
    content: text || '',
  });
}

const parseReview = (e) => ({
  id: e.id, from: e.pubkey, about: tag(e, 'p'), tradeId: tag(e, 'xbt-trade'), txid: tag(e, 'txid'),
  rating: Math.min(5, Math.max(1, Number(tag(e, 'rating')) || 3)), role: tag(e, 'role'), text: e.content, at: e.created_at,
});

const cache = new Map();

export async function reviewsAbout(pubkey, { fresh = false } = {}) {
  if (!fresh && cache.has(pubkey)) return cache.get(pubkey);
  const p = (async () => {
    const [about, by] = await Promise.all([
      query({ kinds: [1985], '#L': [REVIEW_NS], '#p': [pubkey] }),
      query({ kinds: [1985], '#L': [REVIEW_NS], authors: [pubkey] }),
    ]);
    const received = dedupe(about.map(parseReview).filter((r) => r.tradeId && r.from !== pubkey));
    const given = dedupe(by.map(parseReview).filter((r) => r.tradeId));
    for (const r of received) {
      r.verified = !!r.txid && given.some((g) => g.tradeId === r.tradeId && g.about === r.from && g.txid === r.txid);
    }
    const verified = received.filter((r) => r.verified);
    return {
      reviews: received.sort((a, b) => b.at - a.at),
      count: received.length,
      verifiedTrades: verified.length,
      avg: received.length ? received.reduce((s, r) => s + r.rating, 0) / received.length : null,
      negative: received.filter((r) => r.rating < 3).length,
    };
  })();
  cache.set(pubkey, p);
  p.catch(() => cache.delete(pubkey));
  return p;
}

// One review per (author, trade): keep the newest.
function dedupe(list) {
  const m = new Map();
  for (const r of list) {
    const k = r.from + r.tradeId;
    if (!m.has(k) || m.get(k).at < r.at) m.set(k, r);
  }
  return [...m.values()];
}

export function tradeLimitFor(verifiedTrades, limits) {
  let max = 0;
  for (const l of limits) if (verifiedTrades >= l.minTrades) max = l.maxSats;
  return max;
}
