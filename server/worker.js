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

export default {
  fetch(request, env) {
    return env.STORE.get(env.STORE.idFromName('main')).fetch(request);
  },
};
