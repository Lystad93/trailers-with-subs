import { resolveTmdb, getTitleData } from './tmdb.js';
import { searchYoutube, YT_ID } from './youtube.js';
import { log } from './env.js';

export const NO_LANGS = new Set(['no', 'nb', 'nn']);
const ANIMATION = 16;
const FAMILY = 10751;

const TYPE_RANK = { Trailer: 3, Teaser: 2 };

export function rankVideos(videos) {
  const yt = (videos || []).filter((v) => v && v.site === 'YouTube' && YT_ID.test(v.key || ''));
  const trailers = yt.filter((v) => TYPE_RANK[v.type]);
  const pool = trailers.length ? trailers : yt.filter((v) => !['Bloopers', 'Behind the Scenes', 'Featurette'].includes(v.type));
  return pool.slice().sort(
    (a, b) =>
      (TYPE_RANK[b.type] || 0) - (TYPE_RANK[a.type] || 0) ||
      Number(Boolean(b.official)) - Number(Boolean(a.official)) ||
      String(b.published_at || '').localeCompare(String(a.published_at || '')) ||
      (b.size || 0) - (a.size || 0)
  );
}

export function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const DUB_HINT = /norsk\s*tale|norske\s*stemmer|dubb|norwegian\s*(voices|dub)|norsk\s*versjon|norsk\s*dub/i;
const NORWEGIAN_HINT = /\b(norsk|norske|norwegian|norge|norway)\b/i;
const OTHER_NORDIC = /\b(dansk|danish|svensk|swedish|suomi|finsk|finnish|islandsk|icelandic|swe|dk)\b/i;
const JUNK = /\b(lyric|lyrics|sang|song|music video|musikkvideo|fan ?made|fan trailer|concept|reaction|review|anmeldelse|soundtrack|full movie|hele filmen|clip|klipp)\b/i;
const TRAILERISH = /\b(trailer|teaser|traileren|treiler)\b/i;

export function isDubCandidate(entry, titles) {
  const title = entry.title || '';
  if (!NORWEGIAN_HINT.test(title) || OTHER_NORDIC.test(title) || JUNK.test(title) || !TRAILERISH.test(title)) return false;
  if (entry.duration && entry.duration > 300) return false;
  const norm = normalizeTitle(title);
  return titles.some((t) => {
    const n = normalizeTitle(t);
    return n.length >= 2 && (` ${norm} `).includes(` ${n} `);
  });
}

function noLabel(name, data) {
  const dubbed = DUB_HINT.test(name || '') || data.genres.includes(ANIMATION);
  return dubbed ? '🇳🇴 Norsk tale' : '🇳🇴 Norsk trailer';
}

const FLAGS = { en: '🇬🇧', null: '🌐' };
const LANG_NAMES = { en: 'Engelsk', fr: 'Fransk', de: 'Tysk', es: 'Spansk', it: 'Italiensk', ja: 'Japansk', ko: 'Koreansk', sv: 'Svensk', da: 'Dansk', zh: 'Kinesisk', hi: 'Hindi', pt: 'Portugisisk', ru: 'Russisk', pl: 'Polsk', fi: 'Finsk', nl: 'Nederlandsk', tr: 'Tyrkisk', th: 'Thai', is: 'Islandsk' };

function subLabel(lang) {
  const name = LANG_NAMES[lang] || (lang && lang !== 'null' ? lang.toUpperCase() : 'Original');
  return `${FLAGS[lang] || '🌐'} ${name} · norsk tekst`;
}

async function searchDubs(data, limit) {
  const titles = [...new Set([data.norwegianTitle, data.title, data.originalTitle].filter(Boolean))];
  const main = data.norwegianTitle || data.title;
  const queries = [`${main} ${data.year} trailer norsk tale`.replace(/\s+/g, ' ').trim()];
  const found = [];
  for (const q of queries) {
    const results = await searchYoutube(q, 8);
    for (const r of results) {
      if (found.length >= limit) break;
      if (isDubCandidate(r, titles) && !found.some((f) => f.id === r.id)) found.push(r);
    }
  }
  return found;
}

/**
 * Finds the trailers to offer for a title.
 * Returns [{ videoId, mode: 'no'|'sub', label, name }], in the configured order.
 */
export async function findTrailers(type, id, config, { tmdbKey, fetchImpl, searchBudgetMs = 3500, search = searchDubs } = {}) {
  const key = config.tmdb || tmdbKey;
  const target = await resolveTmdb(type, id, key, fetchImpl);
  if (!target) return [];
  const data = await getTitleData(target.tmdbType, target.tmdbId, key, fetchImpl);
  if (!data) return [];

  const ranked = rankVideos(data.videos);
  const isNo = (v) => NO_LANGS.has(v.iso_639_1);
  const noVideos = config.no ? ranked.filter(isNo).slice(0, config.maxNo) : [];
  const norwegianFilm = NO_LANGS.has(data.originalLanguage);

  const no = noVideos.map((v) => ({ videoId: v.key, mode: 'no', label: noLabel(v.name, data), name: v.name || 'Trailer' }));

  // Look for Norwegian dubs on YouTube when TMDB has none.
  const searchWanted =
    config.no &&
    config.maxNo > no.length &&
    !norwegianFilm &&
    (config.search === 'all' || (config.search === 'family' && (data.genres.includes(ANIMATION) || data.genres.includes(FAMILY))));
  if (searchWanted) {
    const job = search(data, config.maxNo - no.length).catch((err) => {
      log.warn(`YouTube search failed for ${id}: ${err.message}`);
      return [];
    });
    const results = await Promise.race([job, new Promise((r) => setTimeout(() => r(null), searchBudgetMs))]);
    if (results === null) log.info(`YouTube search for ${id} is still running; it will be cached for next time`);
    for (const r of results || []) {
      if (!no.some((n) => n.videoId === r.id)) no.push({ videoId: r.id, mode: 'no', label: noLabel(r.title, data), name: r.title });
    }
  }

  let sub = [];
  if (config.sub && !norwegianFilm) {
    const langs = ['en', data.originalLanguage].filter((l, i, a) => l && !NO_LANGS.has(l) && a.indexOf(l) === i);
    let pool = ranked.filter((v) => langs.includes(v.iso_639_1));
    if (!pool.length) pool = ranked.filter((v) => !v.iso_639_1);
    // Original-language trailers first for non-English films, then English.
    pool.sort((a, b) => langs.indexOf(a.iso_639_1) - langs.indexOf(b.iso_639_1) || ranked.indexOf(a) - ranked.indexOf(b));
    sub = pool
      .filter((v) => !no.some((n) => n.videoId === v.key))
      .slice(0, config.maxSub)
      .map((v) => ({ videoId: v.key, mode: 'sub', label: subLabel(v.iso_639_1 ?? 'null'), name: v.name || 'Trailer' }));
  }

  return config.first === 'sub' ? [...sub, ...no] : [...no, ...sub];
}
