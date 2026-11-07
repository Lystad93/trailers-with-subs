import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL = 'error';
const { createLimiter, tmdbGet, TmdbError } = await import('../src/tmdb.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const response = (status, body = {}, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});

test('limiter keeps to its concurrency and rate', async () => {
  const limiter = createLimiter({ concurrency: 2, perSecond: 50 });
  let active = 0;
  let peak = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: 10 }, () =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(30);
        active--;
      })
    )
  );
  assert.equal(peak, 2);
  // 10 starts at 50/s need at least ~180ms.
  assert.ok(Date.now() - t0 >= 170, `took ${Date.now() - t0}ms`);
});

test('a 429 pauses everyone, then the request is retried', async () => {
  const limiter = createLimiter({ concurrency: 4, perSecond: 1000 });
  let calls = 0;
  const fetchImpl = async () => (++calls === 1 ? response(429, {}, { 'retry-after': '0.2' }) : response(200, { ok: true }));
  const t0 = Date.now();
  const [a, b] = await Promise.all([tmdbGet('/a', {}, 'key', fetchImpl, limiter), sleep(20).then(() => tmdbGet('/b', {}, 'key', fetchImpl, limiter))]);
  assert.deepEqual(a, { ok: true });
  assert.deepEqual(b, { ok: true });
  assert.equal(calls, 3);
  // The second request was held back by the pause too.
  assert.ok(Date.now() - t0 >= 190, `took ${Date.now() - t0}ms`);
});

test('gives up after repeated failures, and does not retry a bad key', async () => {
  const limiter = createLimiter({ concurrency: 4, perSecond: 1000 });
  let calls = 0;
  const failing = async () => {
    calls++;
    return response(503, {}, { 'retry-after': '0.01' });
  };
  await assert.rejects(tmdbGet('/x', {}, 'key', failing, limiter), TmdbError);
  assert.equal(calls, 4);

  calls = 0;
  const unauthorized = async () => {
    calls++;
    return response(401);
  };
  await assert.rejects(tmdbGet('/x', {}, 'key', unauthorized, limiter), /401/);
  assert.equal(calls, 1);
});
