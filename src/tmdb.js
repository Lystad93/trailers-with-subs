import { Memo } from './memo.js';
import { env, logThrottled } from './env.js';

const API = 'https://api.themoviedb.org/3';
const memo = new Memo({ max: 10000 });
const DAY = 24 * 60 * 60 * 1000;

export class TmdbError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// All TMDB requests go through one queue: a few at a time, at a steady rate, and everyone waits
// when TMDB says slow down. Catalog warm-ups ask about hundreds of titles in one go.
export function createLimiter({ concurrency, perSecond }) {
  let active = 0;
  let nextStart = 0;
  let pausedUntil = 0;
  const waiting = [];
  const pump = () => {
    while (active < concurrency && waiting.length) {
      active++;
      waiting.shift()();
    }
  };
  return {
    pause(ms) {
      pausedUntil = Math.max(pausedUntil, Date.now() + ms);
    },
    get queued() {
      return waiting.length;
    },
    async run(fn) {
      await new Promise((resolve) => {
        waiting.push(resolve);
        pump();
      });
      try {
        // Space out request starts and honour a pause.
        for (;;) {
          const now = Date.now();
          const at = Math.max(nextStart, pausedUntil);
          if (at <= now) break;
          await sleep(at - now);
        }
        nextStart = Math.max(Date.now(), nextStart) + 1000 / perSecond;
        return await fn();
      } finally {
        active--;
        pump();
      }
    },
  };
}

export const tmdbLimiter = createLimiter({ concurrency: env.tmdbConcurrency, perSecond: env.tmdbRps });
const MAX_ATTEMPTS = 4;

export async function tmdbGet(path, params, key, fetchImpl = fetch, limiter = tmdbLimiter) {
  if (!key) throw new TmdbError('No TMDB API key configured');
  const url = new URL(API + path);
  const headers = { accept: 'application/json' };
  // A v4 read access token is a JWT; a v3 key is 32 hex characters.
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await limiter.run(() => fetchImpl(url, { headers, signal: AbortSignal.timeout(8000) }));
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new TmdbError(`TMDB ${path}: ${err.message}`);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    if (res.status === 401) throw new TmdbError('TMDB rejected the API key (HTTP 401)');
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
      if (res.status === 429) {
        limiter.pause(waitMs);
        logThrottled('tmdb-429', 60000, 'warn', `TMDB is rate limiting; pausing TMDB requests for ${Math.round(waitMs / 1000)}s (${limiter.queued} waiting)`);
      }
      await sleep(waitMs);
      continue;
    }
    throw new TmdbError(`TMDB ${path} → HTTP ${res.status}`);
  }
}

// Stremio ids: "tt0111161", "tt0944947:1:2" (episode), "tmdb:550" / "tmdb:movie:550".
export function parseStremioId(id) {
  const raw = String(id || '');
  const tt = /^(tt\d+)/.exec(raw);
  if (tt) return { imdb: tt[1] };
  const tm = /^tmdb:(?:(movie|tv|series):)?(\d+)/.exec(raw);
  if (tm) return { tmdb: Number(tm[2]), tmdbType: tm[1] === 'movie' ? 'movie' : tm[1] ? 'tv' : null };
  return null;
}

export async function resolveTmdb(type, id, key, fetchImpl) {
  const parsed = parseStremioId(id);
  if (!parsed) return null;
  const wanted = type === 'movie' ? 'movie' : 'tv';
  if (parsed.tmdb) return { tmdbType: parsed.tmdbType || wanted, tmdbId: parsed.tmdb };
  return memo.wrap(`find:${parsed.imdb}`, (v) => (v ? 30 * DAY : DAY), async () => {
    const found = await tmdbGet(`/find/${parsed.imdb}`, { external_source: 'imdb_id' }, key, fetchImpl);
    if (!found) return null;
    const movie = found.movie_results?.[0];
    const tv = found.tv_results?.[0];
    const order = wanted === 'movie' ? [['movie', movie], ['tv', tv]] : [['tv', tv], ['movie', movie]];
    const hit = order.find(([, r]) => r);
    return hit ? { tmdbType: hit[0], tmdbId: hit[1].id } : null;
  });
}

const VIDEO_LANGS = 'no,nb,nn,en,null';

export async function getTitleData(tmdbType, tmdbId, key, fetchImpl) {
  return memo.wrap(`title:${tmdbType}:${tmdbId}`, 12 * 60 * 60 * 1000, async () => {
    const details = await tmdbGet(
      `/${tmdbType}/${tmdbId}`,
      { language: 'en-US', append_to_response: 'videos,translations', include_video_language: VIDEO_LANGS },
      key,
      fetchImpl
    );
    if (!details) return null;
    let videos = details.videos?.results || [];
    const orig = details.original_language;
    if (orig && !['en', 'no', 'nb', 'nn'].includes(orig)) {
      // Trailers in the film's own language (Korean, French ...) can get Norwegian subtitles too.
      const extra = await tmdbGet(`/${tmdbType}/${tmdbId}/videos`, { include_video_language: orig }, key, fetchImpl).catch(() => null);
      videos = videos.concat(extra?.results || []);
    }
    const translations = details.translations?.translations || [];
    const norwegian = translations.find((t) => ['no', 'nb'].includes(t.iso_639_1));
    const noTitle = norwegian?.data?.title || norwegian?.data?.name || '';
    const date = details.release_date || details.first_air_date || '';
    return {
      tmdbType,
      tmdbId,
      title: details.title || details.name || '',
      originalTitle: details.original_title || details.original_name || '',
      norwegianTitle: noTitle,
      year: date.slice(0, 4),
      originalLanguage: orig || null,
      genres: (details.genres || []).map((g) => g.id),
      videos,
    };
  });
}
