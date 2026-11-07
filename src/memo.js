// A small TTL cache with in-flight de-duplication.
export class Memo {
  constructor({ max = 5000 } = {}) {
    this.max = max;
    this.store = new Map();
    this.pending = new Map();
  }

  get(key) {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value, ttlMs) {
    if (this.store.size >= this.max) {
      // Drop the oldest entry (Map keeps insertion order).
      this.store.delete(this.store.keys().next().value);
    }
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }

  // ttl may be a number or a function of the value (so empty results can expire sooner).
  async wrap(key, ttl, work) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    if (this.pending.has(key)) return this.pending.get(key);
    const run = (async () => {
      const value = await work();
      const ttlMs = typeof ttl === 'function' ? ttl(value) : ttl;
      if (ttlMs > 0) this.set(key, value, ttlMs);
      return value;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, run);
    return run;
  }
}
