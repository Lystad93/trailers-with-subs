import test from 'node:test';
import assert from 'node:assert/strict';
import { findTrailers, isDubCandidate, rankVideos } from '../src/trailers.js';
import { normalizeConfig, encodeConfig, decodeConfig, makeProfile, parseProfile } from '../src/config.js';

const vid = (key, lang, type, name, extra = {}) => ({ key, iso_639_1: lang, site: 'YouTube', type, name, official: true, published_at: '2024-01-01T00:00:00Z', ...extra });

function fakeTmdb(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.pathname);
    const body = routes[url.pathname];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (typeof body === 'function' ? body(url) : body) };
  };
  return { fetchImpl, calls };
}

test('config round trip and defaults', () => {
  const c = normalizeConfig({ subs: 'soft', q: '2160', maxNo: 99, bogus: 1 });
  assert.equal(c.subs, 'soft');
  assert.equal(c.q, 2160);
  assert.equal(c.maxNo, 10);
  assert.deepEqual(decodeConfig(encodeConfig(c)), c);
  assert.deepEqual(decodeConfig(''), normalizeConfig({}));
  assert.equal(decodeConfig('%%%not-base64'), null);
});

test('profiles round trip', () => {
  const c = normalizeConfig({ q: 1440, codec: 'any', subs: 'soft', auto: false });
  assert.equal(makeProfile('sub', c), 'sub.1440.any.soft.m');
  assert.deepEqual(parseProfile('sub.1440.any.soft.m'), { mode: 'sub', q: 1440, codec: 'any', subs: 'soft', auto: false });
  assert.deepEqual(parseProfile(makeProfile('no', c)), { mode: 'no', q: 1440, codec: 'any' });
  assert.equal(parseProfile('sub.999.any.soft.m'), null);
  assert.equal(parseProfile('../etc'), null);
});

test('trailers rank before teasers, official first, newest first', () => {
  const ranked = rankVideos([
    vid('aaaaaaaaaaa', 'en', 'Teaser', 'Teaser'),
    vid('bbbbbbbbbbb', 'en', 'Trailer', 'Trailer 1', { published_at: '2023-01-01' }),
    vid('ccccccccccc', 'en', 'Trailer', 'Final Trailer', { published_at: '2024-05-01' }),
    vid('ddddddddddd', 'en', 'Featurette', 'Making of'),
    vid('eeeeeeeeeee', 'en', 'Trailer', 'Fan', { official: false, published_at: '2025-01-01' }),
    { key: 'fffffffffff', site: 'Vimeo', type: 'Trailer' },
  ]);
  assert.deepEqual(ranked.map((v) => v.key), ['ccccccccccc', 'bbbbbbbbbbb', 'eeeeeeeeeee', 'aaaaaaaaaaa']);
});

test('finds Norwegian dub and English trailers for a movie', async () => {
  const { fetchImpl } = fakeTmdb({
    '/3/find/tt2953050': { movie_results: [{ id: 330457 }], tv_results: [] },
    '/3/movie/330457': {
      title: 'Frozen II',
      original_title: 'Frozen II',
      original_language: 'en',
      release_date: '2019-11-20',
      genres: [{ id: 16 }, { id: 10751 }],
      translations: { translations: [{ iso_639_1: 'no', data: { title: 'Frost 2' } }] },
      videos: {
        results: [
          vid('NOnorsk0001', 'no', 'Trailer', 'Frost 2 | Ny trailer | Norsk tale'),
          vid('ENtrailer01', 'en', 'Trailer', 'Official Trailer 2', { published_at: '2019-06-11' }),
          vid('ENtrailer02', 'en', 'Trailer', 'Official Trailer', { published_at: '2019-02-13' }),
          vid('ENteaser001', 'en', 'Teaser', 'Teaser Trailer'),
        ],
      },
    },
  });
  let searched = 0;
  const search = async (data, limit) => {
    searched++;
    assert.equal(data.norwegianTitle, 'Frost 2');
    assert.equal(limit, 1);
    return [{ id: 'NOsearch001', title: 'FROST 2 - Offisiell trailer - Norsk tale', duration: 120 }];
  };
  const out = await findTrailers('movie', 'tt2953050', normalizeConfig({ tmdb: 'k' }), { fetchImpl, search });
  assert.equal(searched, 1);
  assert.deepEqual(
    out.map((t) => [t.videoId, t.mode, t.label]),
    [
      ['NOnorsk0001', 'no', '🇳🇴 Norsk tale'],
      ['NOsearch001', 'no', '🇳🇴 Norsk tale'],
      ['ENtrailer01', 'sub', '🇬🇧 Engelsk · norsk tekst'],
      ['ENtrailer02', 'sub', '🇬🇧 Engelsk · norsk tekst'],
    ]
  );

  const subFirst = await findTrailers('movie', 'tt2953050', normalizeConfig({ tmdb: 'k', first: 'sub', no: false, maxSub: 1 }), { fetchImpl, search });
  assert.deepEqual(subFirst.map((t) => t.videoId), ['ENtrailer01']);
});

test('live-action films do not search YouTube by default; a slow search does not block', async () => {
  const { fetchImpl } = fakeTmdb({
    '/3/find/tt15239678': { movie_results: [{ id: 693134 }] },
    '/3/movie/693134': { title: 'Dune: Part Two', original_language: 'en', genres: [{ id: 878 }], videos: { results: [vid('Way9Dexny3w', 'en', 'Trailer', 'Official Trailer 3')] } },
  });
  let searched = false;
  const search = async () => {
    searched = true;
    return [];
  };
  const out = await findTrailers('movie', 'tt15239678', normalizeConfig({ tmdb: 'k2' }), { fetchImpl, search });
  assert.equal(searched, false);
  assert.deepEqual(out.map((t) => t.videoId), ['Way9Dexny3w']);

  const slow = () => new Promise((r) => setTimeout(() => r([{ id: 'zzzzzzzzzzz', title: 'Dune 2 trailer norsk' }]), 500));
  const t0 = Date.now();
  const out2 = await findTrailers('movie', 'tt15239678', normalizeConfig({ tmdb: 'k2', search: 'all' }), { fetchImpl, search: slow, searchBudgetMs: 50 });
  assert.ok(Date.now() - t0 < 400);
  assert.deepEqual(out2.map((t) => t.videoId), ['Way9Dexny3w']);
});

test('non-English films get original-language trailers subtitled; Norwegian films are left alone', async () => {
  const { fetchImpl } = fakeTmdb({
    '/3/find/tt6751668': { movie_results: [{ id: 496243 }] },
    '/3/movie/496243': { title: 'Parasite', original_language: 'ko', genres: [{ id: 35 }], videos: { results: [vid('ENparasite1', 'en', 'Trailer', 'Official Trailer')] } },
    '/3/movie/496243/videos': { results: [vid('KOparasite1', 'ko', 'Trailer', '기생충 예고편')] },
    '/3/find/tt8115900': { movie_results: [{ id: 1 }] },
    '/3/movie/1': { title: 'The Worst Person in the World', original_language: 'no', genres: [{ id: 18 }], videos: { results: [vid('NOverdens01', 'no', 'Trailer', 'Verdens verste menneske - trailer')] } },
  });
  const ko = await findTrailers('movie', 'tt6751668', normalizeConfig({ tmdb: 'k3' }), { fetchImpl });
  assert.deepEqual(ko.map((t) => [t.videoId, t.label]), [
    ['ENparasite1', '🇬🇧 Engelsk · norsk tekst'],
    ['KOparasite1', '🌐 Koreansk · norsk tekst'],
  ]);
  const no = await findTrailers('movie', 'tt8115900', normalizeConfig({ tmdb: 'k3' }), { fetchImpl });
  assert.deepEqual(no.map((t) => [t.videoId, t.mode, t.label]), [['NOverdens01', 'no', '🇳🇴 Norsk trailer']]);
});

test('series resolve through tv_results', async () => {
  const { fetchImpl, calls } = fakeTmdb({
    '/3/find/tt0903747': { movie_results: [], tv_results: [{ id: 1396 }] },
    '/3/tv/1396': { name: 'Breaking Bad', original_language: 'en', genres: [{ id: 18 }], videos: { results: [vid('HhesaQXLuRY', 'en', 'Trailer', 'Season 1 Trailer')] } },
  });
  const out = await findTrailers('series', 'tt0903747:1:1', normalizeConfig({ tmdb: 'k4' }), { fetchImpl });
  assert.deepEqual(out.map((t) => t.videoId), ['HhesaQXLuRY']);
  assert.ok(calls.includes('/3/tv/1396'));
});

test('a skipped dub search marks the answer as partial', async () => {
  const { SearchSkipped } = await import('../src/youtube.js');
  const { fetchImpl } = fakeTmdb({
    '/3/find/tt0000042': { movie_results: [{ id: 42 }] },
    '/3/movie/42': { title: 'Toy', original_language: 'en', genres: [{ id: 16 }], videos: { results: [vid('ENtoy000001', 'en', 'Trailer', 'Trailer')] } },
  });
  const skipped = async () => {
    throw new SearchSkipped('too many YouTube searches waiting');
  };
  const out = await findTrailers('movie', 'tt0000042', normalizeConfig({ tmdb: 'k5' }), { fetchImpl, search: skipped });
  assert.deepEqual(out.map((t) => t.videoId), ['ENtoy000001']);
  assert.equal(out.partial, true);

  const done = await findTrailers('movie', 'tt0000042', normalizeConfig({ tmdb: 'k5' }), { fetchImpl, search: async () => [] });
  assert.equal(done.partial, undefined);
});

test('YouTube search results are filtered to real Norwegian trailers of the title', () => {
  const titles = ['Frost 2', 'Frozen II'];
  assert.equal(isDubCandidate({ title: 'Frost 2 | Offisiell trailer | Norsk tale', duration: 90 }, titles), true);
  assert.equal(isDubCandidate({ title: 'FROZEN II - Norwegian trailer', duration: 90 }, titles), true);
  assert.equal(isDubCandidate({ title: 'Frost 2 | Officiel trailer | Dansk tale', duration: 90 }, titles), false);
  assert.equal(isDubCandidate({ title: 'Frost 2 - Livet går sin gang (norsk) lyric video', duration: 200 }, titles), false);
  assert.equal(isDubCandidate({ title: 'Frost 2 trailer norsk', duration: 3600 }, titles), false);
  assert.equal(isDubCandidate({ title: 'Frostbite trailer norsk', duration: 90 }, titles), false);
  assert.equal(isDubCandidate({ title: 'Frost 2 norsk tale', duration: 90 }, titles), false); // not a trailer
});
