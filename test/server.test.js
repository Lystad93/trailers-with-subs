import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailers-server-'));
process.env.CACHE_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.env.TMDB_API_KEY = 'server-key';
process.env.SEARCH_BUDGET_MS = '50';

const { createServer } = await import('../src/server.js');
const { initMedia } = await import('../src/media.js');
const { encodeConfig } = await import('../src/config.js');

// TMDB stand-in; everything else goes to the real fetch (our own server).
const realFetch = globalThis.fetch;
const tmdbCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = new URL(url);
  if (u.hostname !== 'api.themoviedb.org') return realFetch(url, opts);
  tmdbCalls.push(u);
  const routes = {
    '/3/find/tt1160419': { movie_results: [{ id: 438631 }] },
    '/3/movie/438631': {
      title: 'Dune',
      original_language: 'en',
      genres: [{ id: 878 }],
      videos: {
        results: [
          { key: 'n9xhJrPXop4', site: 'YouTube', type: 'Trailer', iso_639_1: 'en', name: 'Official Main Trailer', official: true, published_at: '2021-07-22' },
          { key: 'NOduneNO001', site: 'YouTube', type: 'Trailer', iso_639_1: 'no', name: 'DUNE - Offisiell trailer (norsk tekst)', official: true, published_at: '2021-07-22' },
        ],
      },
    },
  };
  const body = routes[u.pathname];
  return { ok: Boolean(body), status: body ? 200 : 404, json: async () => body };
};

let base;
let server;
test.before(async () => {
  await initMedia();
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// The same checks AIOMetadata's trailer projection applies to each stream.
function aioToStream(raw) {
  const title = typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim() : typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Trailer';
  if (typeof raw?.ytId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(raw.ytId)) return { title, ytId: raw.ytId };
  if (typeof raw?.url === 'string' && /^https?:\/\//i.test(raw.url)) return { title, url: raw.url };
  return null;
}

test('manifest advertises a stream resource for movies and series', async () => {
  for (const p of ['/manifest.json', `/${encodeConfig({ subs: 'soft' })}/manifest.json`]) {
    const m = await (await fetch(base + p)).json();
    assert.ok(m.resources.includes('stream'));
    assert.deepEqual(m.types, ['movie', 'series']);
    assert.ok(m.idPrefixes.includes('tt'));
  }
});

test('stream response is what AIOMetadata expects, and links play', async () => {
  const res = await fetch(`${base}/stream/movie/tt1160419.json`);
  assert.equal(res.status, 200);
  const { streams } = await res.json();
  const parsed = streams.map(aioToStream);
  assert.equal(parsed.length, 2);
  assert.ok(parsed.every(Boolean));
  assert.equal(parsed[0].title, '🇳🇴 Norsk trailer — DUNE - Offisiell trailer (norsk tekst)');
  assert.match(parsed[0].url, /\/play\/NOduneNO001\/no\.1080\.h264\/[\w-]{16}\.mp4$/);
  assert.equal(parsed[1].title, '🇬🇧 Engelsk · norsk tekst — Official Main Trailer');
  assert.match(parsed[1].url, /\/play\/n9xhJrPXop4\/sub\.1080\.h264\.burn\.a\/[\w-]{16}\.mp4$/);
  assert.ok(tmdbCalls.every((u) => u.searchParams.get('api_key') === 'server-key'));

  // Tampering with the profile breaks the signature.
  const forged = parsed[1].url.replace('sub.1080.h264.burn.a', 'sub.2160.any.burn.a');
  assert.equal((await fetch(forged)).status, 403);
});

test('settings in the URL change the result', async () => {
  const cfg = encodeConfig({ first: 'sub', yt: true, subs: 'soft', q: 2160, codec: 'any', tmdb: 'user-key' });
  const { streams } = await (await fetch(`${base}/${cfg}/stream/movie/tt1160419.json`)).json();
  assert.equal(streams.length, 4);
  assert.match(streams[0].url, /sub\.2160\.any\.soft\.a/);
  assert.equal(streams[1].ytId, 'n9xhJrPXop4');
  assert.match(streams[2].url, /no\.2160\.any/);
  // TMDB answers are shared between users, so no second lookup was needed.
  assert.equal(tmdbCalls.filter((u) => u.searchParams.get('api_key') === 'user-key').length, 0);
});

test('unknown titles and bad input give empty lists, not errors', async () => {
  assert.deepEqual(await (await fetch(`${base}/stream/movie/tt0000001.json`)).json(), { streams: [] });
  assert.deepEqual(await (await fetch(`${base}/stream/channel/tt1160419.json`)).json(), { streams: [] });
  assert.equal((await fetch(`${base}/!!!/manifest.json`)).status, 400);
  assert.equal((await fetch(`${base}/play/short/no.1080.h264/x.mp4`)).status, 403);
});

test('configure page renders with the settings filled in', async () => {
  const cfg = encodeConfig({ subs: 'soft' });
  const html = await (await fetch(`${base}/${cfg}/configure`)).text();
  assert.match(html, /Norske trailere/);
  assert.match(html, /const CONFIG = \{[^<]*"subs":"soft"/);
  assert.doesNotMatch(html, /__CONFIG__|__DEFAULTS__|__SERVER_HAS_TMDB__/);
});
