import { resolveTmdb, getTitleData } from './tmdb.js';
import { searchYoutube, SearchSkipped, YT_ID } from './youtube.js';
import { log, logThrottled } from './env.js';
import { findChannelTrailers, indexReady, normalizeTitle } from './channels.js';
import { findShorts } from './shorts.js';

export { normalizeTitle };

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
 * Returns [{ videoId, mode: 'no'|'sub', lang, label, name, short }], in the configured order, Shorts last.
 */
// A Danish or Swedish cinema trailer has Danish or Swedish text in the picture: readable for a
// Norwegian, and used when there is no Norwegian trailer.
const NORDIC = {
  da: { flag: '🇩🇰', label: '🇩🇰 Dansk tekst', plain: '🇩🇰 Dansk kinotrailer' },
  sv: { flag: '🇸🇪', label: '🇸🇪 Svensk tekst', plain: '🇸🇪 Svensk kinotrailer' },
};
const SHORT_HINT = /\b(vertical|shorts?)\b|#shorts/i;

export async function findTrailers(type, id, config, { tmdbKey, fetchImpl, searchBudgetMs = 3500, search = searchDubs, channelTrailers = findChannelTrailers, channelsReady = indexReady, shorts = findShorts } = {}) {
  const key = config.tmdb || tmdbKey;
  const target = await resolveTmdb(type, id, key, fetchImpl);
  if (!target) return [];
  const data = await getTitleData(target.tmdbType, target.tmdbId, key, fetchImpl);
  if (!data) return [];

  const ranked = rankVideos(data.videos);
  const isNo = (v) => NO_LANGS.has(v.iso_639_1);
  const noVideos = config.no ? ranked.filter(isNo).slice(0, config.maxNo) : [];
  const norwegianFilm = NO_LANGS.has(data.originalLanguage);

  const family = data.genres.includes(ANIMATION) || data.genres.includes(FAMILY);
  let partial = false;
  let no = [];
  let neighbours = []; // Danish, else Swedish
  if (config.no && config.kino) {
    // Norwegian distributors' own uploads come first: Norwegian text is already in the picture.
    for (const v of channelTrailers(data, { preferDubbed: family, nordic: config.nordic })) {
      const name = `${v.title} (${v.channel})`;
      if (v.lang && v.lang !== 'no') {
        const n = NORDIC[v.lang];
        if (!norwegianFilm && (!neighbours.length || neighbours[0].lang === v.lang)) neighbours.push({ videoId: v.id, mode: 'no', lang: v.lang, label: v.texted ? n.label : n.plain, name });
        continue;
      }
      const label = v.dubbed ? '🇳🇴 Norsk tale' : norwegianFilm ? '🇳🇴 Norsk trailer' : v.texted ? '🇳🇴 Norsk tekst' : '🇳🇴 Norsk kinotrailer';
      no.push({ videoId: v.id, mode: 'no', lang: 'no', label, name });
    }
    if (!channelsReady()) partial = true; // the channel lists are still being fetched
  }
  for (const v of noVideos) {
    if (!no.some((n) => n.videoId === v.key)) no.push({ videoId: v.key, mode: 'no', lang: 'no', label: noLabel(v.name, data), name: v.name || 'Trailer' });
  }

  // Look for Norwegian dubs on YouTube when neither the channels nor TMDB have a Norwegian trailer.
  const searchWanted =
    config.no &&
    no.length === 0 &&
    !norwegianFilm &&
    (config.search === 'all' || (config.search === 'family' && family));
  if (searchWanted) {
    const job = search(data, config.maxNo).catch((err) => {
      if (err instanceof SearchSkipped) log.debug(`YouTube search skipped for ${id}: ${err.message}`);
      else logThrottled('yt-search-failed', 60000, 'warn', `YouTube search failed for ${id}: ${err.message}`);
      return SKIPPED;
    });
    const job2 = job.then((r) => {
      if (r === SKIPPED) partial = true;
      return r === SKIPPED ? [] : r;
    });
    const results = await Promise.race([job2, new Promise((r) => setTimeout(() => r(null), searchBudgetMs))]);
    if (results === null) partial = true;
    if (results === null) log.debug(`YouTube search for ${id} is still running; it will be cached for next time`);
    for (const r of results || []) {
      if (!no.some((n) => n.videoId === r.id)) no.push({ videoId: r.id, mode: 'no', lang: 'no', label: noLabel(r.title, data), name: r.title });
    }
  }

  let pool = [];
  if (config.sub && !norwegianFilm) {
    const langs = ['en', data.originalLanguage].filter((l, i, a) => l && !NO_LANGS.has(l) && a.indexOf(l) === i);
    pool = ranked.filter((v) => langs.includes(v.iso_639_1));
    if (!pool.length) pool = ranked.filter((v) => !v.iso_639_1);
    // English trailers first, then the ones in the film's own language; best ranked first within each.
    pool.sort((a, b) => langs.indexOf(a.iso_639_1) - langs.indexOf(b.iso_639_1) || ranked.indexOf(a) - ranked.indexOf(b));
    pool = pool
      .filter((v) => !no.some((n) => n.videoId === v.key))
      .map((v) => ({ videoId: v.key, mode: 'sub', label: subLabel(v.iso_639_1 ?? 'null'), name: v.name || 'Trailer' }));
  }

  // Shorts (upright phone videos) are a narrow strip on a TV. They are only used when a group
  // has nothing else, and then they go last. Only the videos that could be listed are checked.
  const candidates = [...no.slice(0, config.maxNo + 2), ...pool.slice(0, config.maxSub + 3)];
  const answers = candidates.length ? await shorts(candidates.map((c) => c.videoId)) : new Map();
  const isShort = (t) => answers.get(t.videoId) === true || (answers.get(t.videoId) !== false && SHORT_HINT.test(t.name));
  if (candidates.some((c) => answers.get(c.videoId) === null)) partial = true; // asked, no answer yet
  const split = (list, max) => {
    const checked = list.filter((t) => answers.has(t.videoId));
    const normal = checked.filter((t) => !isShort(t)).slice(0, max);
    return [normal, normal.length ? [] : checked.filter(isShort).slice(0, 1).map((t) => ({ ...t, short: true, label: `${t.label} · Short` }))];
  };
  const [noNormal, noShorts] = split(no, config.maxNo);
  // Danish or Swedish only when there is no ordinary Norwegian trailer.
  const nordic = noNormal.length ? noNormal : neighbours.slice(0, config.maxNo);
  const [sub, subShorts] = split(pool, config.maxSub);
  const last = [...noShorts, ...subShorts];

  const out = [...(config.first === 'sub' ? [...sub, ...nordic] : [...nordic, ...sub]), ...last];
  // The dub search was skipped or is still running: worth asking again soon.
  if (partial) out.partial = true;
  out.film = `${data.title}${data.year ? ` (${data.year})` : ''}`;
  return out;
}

const SKIPPED = Symbol('search skipped');
