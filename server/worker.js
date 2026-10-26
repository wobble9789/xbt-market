// Cloudflare Workers entry. All requests go to one Durable Object, which runs
// them one at a time: that keeps usernames unique without a database, and its
// storage needs no setup (no KV namespace or database to create).
import { handle } from './service.js';

export class Store {
  constructor(state, env) { this.storage = state.storage; this.env = env; }
  fetch(request) {
    const s = this.storage;
    const store = {
      get: (k) => s.get(k),
      put: (k, v) => s.put(k, v),
      delete: (k) => s.delete(k),
      list: (o) => s.list(o),
    };
    return handle(request, this.env, store);
  }
}

const main = (env) => env.STORE.get(env.STORE.idFromName('main'));

export default {
  fetch(request, env) {
    // Internal jobs only run from the cron trigger below.
    if (new URL(request.url).pathname.startsWith('/internal/')) return new Response('Not found', { status: 404 });
    return main(env).fetch(request);
  },
  // Every 10 minutes: push notifications for saved searches with new listings.
  scheduled(event, env, ctx) {
    ctx.waitUntil(main(env).fetch(new Request('https://service.internal/internal/push-run', { method: 'POST' })));
  },
};
