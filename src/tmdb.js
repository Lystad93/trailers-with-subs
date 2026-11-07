import { Memo } from './memo.js';

const API = 'https://api.themoviedb.org/3';
const memo = new Memo({ max: 10000 });
const DAY = 24 * 60 * 60 * 1000;

export class TmdbError extends Error {}

export async function tmdbGet(path, params, key, fetchImpl = fetch) {
  if (!key) throw new TmdbError('No TMDB API key configured');
  const url = new URL(API + path);
  const headers = { accept: 'application/json' };
  // A v4 read access token is a JWT; a v3 key is 32 hex characters.
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new TmdbError(`TMDB ${path} → HTTP ${res.status}`);
  return res.json();
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
