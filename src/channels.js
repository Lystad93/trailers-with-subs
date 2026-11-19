// An index of the YouTube channels of Norwegian film distributors and cinemas. Their trailers
// already carry Norwegian text in the picture (or Norwegian voices), so they need no subtitle
// work at all. The channels' video lists are fetched now and then and kept on disk; a title is
// then matched against the list locally, without asking YouTube anything.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { env, log } from './env.js';
import { runYtdlp, YT_ID, BOT_CHECK, botCheckHint } from './youtube.js';

export const DEFAULT_CHANNELS = [
  { id: 'UCgich1wPX7rhFYJR8QU3kXg', name: 'United International Pictures Norway' },
  { id: 'UCzdRSOCiNx_0iZFnSHgGqkA', name: 'SF Studios Norge' },
  { id: 'UC2LkYLYBJ83r9_9_WpDHRtw', name: 'Nordisk Film Norge' },
  { id: 'UCdI2m5v0cyCCOs4rhkYsXFA', name: 'Disney Norge' },
  { id: 'UC2XUomCvuSGgmi3cwbuu1GQ', name: '20th Century Studios Norge' },
  { id: 'UCY4czGjXxTgFZi7GWiRyMig', name: 'Warner Bros. Pictures Norway' },
  { id: 'UCwaBrQmJ0iESz4ahPSTQTDg', name: 'WarnerBrosNorge' },
  { id: 'UCn1VeQhdDgTm4kbiVKNrH2g', name: 'Norsk Filmdistribusjon' },
  { id: 'UCXxpx6QxTa4XIvd3JPEoCiw', name: 'Selmer Media' },
  { id: 'UCdMJn-DhV9AtgMIkm2BpQdg', name: 'Arthaus Norge' },
  { id: 'UCmwC_TxY0S8TfY7RYtAtoEg', name: 'Mer Film' },
  { id: 'UCzB8Ol8MEPJhjWXz1EngGIw', name: 'Another World Entertainment Norway' },
  { id: 'UCjQX_J3Jo53HAJGJu4CJy3w', name: 'Fidalgo Films' },
  // Filmweb also re-posts trailers without Norwegian text: only its marked ones count.
  { id: 'UC8C3teVwucjcg7skFUHtPEw', name: 'Filmweb', marked: true },

  // Danish and Swedish distributors: the next best thing when there is no Norwegian trailer.
  { id: 'UC2LzjztyruaONwnZPIGdBAA', name: 'Nordisk Film', lang: 'da' },
  { id: 'UCIleQtx3SRfL_PiiOJxm91g', name: 'Nordisk Film Biografer', lang: 'da' },
  { id: 'UCkAzdVMiwWo5gEI9JrFs04w', name: 'Sony Pictures - Danmark', lang: 'da' },
  { id: 'UCmA9LbNZH5z83D7x8EcAkSQ', name: 'United International Pictures Danmark', lang: 'da' },
  { id: 'UClAtPbYb5D1qvM0D2PabqjQ', name: 'SF Studios Danmark', lang: 'da' },
  { id: 'UCVV8jeodhHpeuTjnU6RU1yA', name: 'Scanbox Entertainment Danmark', lang: 'da' },
  { id: 'UCN6OyiMHPGRsYWTZpCgn5kQ', name: 'Disney Danmark', lang: 'da' },
  { id: 'UCjpxtkXp9sVsltyanvG_z6Q', name: 'Filmsiden Trailers', lang: 'da', marked: true },
  { id: 'UCkllgTNY4dg8qdMfpPlnmyQ', name: 'Nordisk Film Sverige', lang: 'sv' },
  { id: 'UC_4Nc4NeEG-SIaetcgMTtfw', name: 'SF Studios', lang: 'sv' },
  { id: 'UCDjvMCwueVulV2xCUCJvd_g', name: 'Scanbox Entertainment Sverige', lang: 'sv' },
  { id: 'UCQ8eoZdZP4gvGiVkqAh05VA', name: 'Disney Sverige', lang: 'sv' },
  { id: 'UCT8HvLtkRReWyTXQJB7mG9Q', name: 'Noble Entertainment', lang: 'sv' },
  { id: 'UCMwpMKpJZw5g2N_rb_jwEmA', name: 'Njutafilms', lang: 'sv' },
  { id: 'UCIEdXQPXHRMK07SDUfaYjHA', name: 'Folkets Bio', lang: 'sv' },
  { id: 'UCY27XKkuu-TvQWOVHsWr9yA', name: 'Bio.se', lang: 'sv', marked: true },
];

// CHANNELS_EXTRA: more channels, as channel ids (UC…) or @handles, separated by commas.
export function configuredChannels() {
  const extra = String(process.env.CHANNELS_EXTRA || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^UC[\w-]{22}$/.test(s) || /^@[\w.-]{3,}$/.test(s))
    .map((id) => ({ id, name: id }));
  const all = [...DEFAULT_CHANNELS, ...extra];
  return all.filter((c, i) => all.findIndex((o) => o.id === c.id) === i);
}

const channelUrl = (id) => `https://www.youtube.com/${id.startsWith('@') ? id : `channel/${id}`}/videos`;

// ---------------------------------------------------------------------------------------------
// Matching a video title to a film

export function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Norwegian, Danish and Swedish month names.
const MONTHS = 'januar|januari|februar|februari|mars|marts|april|mai|maj|juni|juli|august|augusti|september|oktober|november|desember|december';
// Whole words only; \b does not know that å, ø and æ are letters.
const words = (pattern) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'gu');
const NOISE = [
  words(`(d )?\\d{1,2} (${MONTHS})( (19|20)\\d{2})?`), // 27. november (2026), d. 20. juni
  words('(med|m) (norsk|norske|dansk|danske|svensk|svenska) (tekst|tale|stemmer|undertekster|tekster|text)'),
  words('(norsk|norske|norwegian|dansk|danske|danish|svensk|svenska|swedish) (tekst|tekstet|tale|stemmer|versjon|subtitles|voices|trailer|undertekster|text)'),
  words('på kino( (nå|snart))?'),
  words('i kinoene( nå)?'),
  words('(kommer )?i (biografen|biograferne)( (nu|snart|d))?'),
  words('kommer( snart)?'),
  words('\\d{1,2} \\d{1,2} \\d{2,4}'), // 16.07.20
  words('(swe|se|sv|dk|da|no|nor) subs?'),
  words('(svenskt|engelskt|svensk|engelsk|dansk|norsk) (tal|tale)'),
  words('på bio( (nu|snart))?'),
  words('(kino|biograf)?premiere|biopremiär'),
  words('((offisiell|offisielle|ofisiell|official|officiel|officiell|ny|siste|sidste|sista|final) )*(trailer|teaser|teasertrailer|hovedtrailer)( \\d)?'), // "ny offisiell trailer 2"
  words('hd|4k|uhd|dk'),
];

// What is left of a video title once the trailer wording is gone: the film's name.
export function filmNameOf(videoTitle) {
  let s = normalizeTitle(String(videoTitle || '').replace(/\((19|20)\d{2}\)/g, ' '));
  for (const re of NOISE) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

const TRAILER = /\b(trailer|teaser|teasertrailer|hovedtrailer)\b/i;
const DUBBED = /norsk\s*tale|norske\s*stemmer|dubb|dansk\s*tale|svenskt?\s*tal\b|svenska\s*röster/i;
const TEXTED = /norsk\s*tekst|(?<!u)tekstet|undertekster|svensk\s*text|\b(swe|se|dk|da)\s*subs?\b/i;
const UNTEXTED = /utekstet|uten\s+tekst/i;
const NOT_A_TRAILER = /\b(featurette|bak kulissene|behind the scenes|intervju|interview|klipp|clip|musikkvideo|lyric|premierefest|reaction)\b/i;

// The film names a channel video can stand for: the whole title without the trailer wording, and
// its first part ("Name | …"). None when it is not a trailer.
function videoNames(videoTitle) {
  const title = String(videoTitle || '');
  if (!TRAILER.test(title) || NOT_A_TRAILER.test(title)) return [];
  const whole = filmNameOf(title);
  const head = filmNameOf(title.split(/\s[|–—-]\s|\s*\|\s*/)[0]);
  return [...new Set([whole, head])].filter(Boolean);
}

const wantedNames = (names) => [...new Set(names.map((n) => filmNameOf(n) || normalizeTitle(n)).filter((n) => n.length >= 2))];

/** Does this channel video show a trailer for a film with one of these names? */
export function matchesFilm(videoTitle, names) {
  const wanted = wantedNames(names);
  return wanted.length > 0 && videoNames(videoTitle).some((n) => wanted.includes(n));
}

// ---------------------------------------------------------------------------------------------
// The index

const DAY = 24 * 60 * 60 * 1000;
let index = { channels: {} };
let loaded = false;
const indexFile = () => path.join(env.cacheDir, 'channels.json');

export function setIndexForTests(next) {
  index = next;
  loaded = true;
  byName = null;
}

// film name → [{ channelId, video }]. Working out a video's name takes a dozen regular
// expressions; doing that for every listed video on every request kept the server busy for
// seconds during AIOMetadata's catalog warm-ups. It is done once, when the lists change.
let byName = null;

function nameIndex() {
  if (byName) return byName;
  byName = new Map();
  for (const [channelId, channel] of Object.entries(index.channels)) {
    for (const video of channel.videos) {
      for (const name of videoNames(video.title)) {
        let list = byName.get(name);
        if (!list) byName.set(name, (list = []));
        list.push({ channelId, video });
      }
    }
  }
  return byName;
}

export function indexStatus() {
  const channels = Object.values(index.channels);
  return {
    channels: channels.length,
    videos: channels.reduce((n, c) => n + c.videos.length, 0),
    refreshed: channels.length ? new Date(Math.max(...channels.map((c) => c.fetchedAt || 0))).toISOString() : null,
  };
}

async function loadIndex() {
  if (loaded) return;
  loaded = true;
  try {
    const data = JSON.parse(await fsp.readFile(indexFile(), 'utf8'));
    if (data && typeof data.channels === 'object') index = data;
    byName = null;
  } catch {
    /* first run */
  }
}

async function saveIndex() {
  const tmp = `${indexFile()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(index));
  await fsp.rename(tmp, indexFile());
}

// One channel's newest videos. A long list can be cut short by YouTube; what was listed is kept.
async function listChannel(channel, count) {
  const { stdout } = await runYtdlp(
    ['--flat-playlist', '--playlist-end', String(count), '-J', '--extractor-args', 'youtubetab:approximate_date', '--', channelUrl(channel.id)],
    { timeoutMs: 180000, allowPartial: true }
  );
  const data = JSON.parse(stdout);
  return {
    name: data?.channel || channel.name,
    videos: (data?.entries || [])
      .filter((e) => e && YT_ID.test(e.id || '') && e.title)
      .map((e) => ({ id: e.id, title: e.title, duration: e.duration ?? null, ts: e.timestamp ?? null })),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let refreshing = null;

/** Fetches every channel's list: all of it the first time, only the newest videos after that. */
export function refreshChannels({ gapMs = 5000, list = listChannel, onlyMissing = false } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    await loadIndex();
    let added = 0;
    let failed = 0;
    for (const channel of configuredChannels()) {
      const known = index.channels[channel.id];
      if (onlyMissing && known?.videos.length) continue;
      try {
        // The whole list the first time and once a week (channels remove old videos); in between
        // only the newest.
        const deep = !known?.videos.length || Date.now() - (known.deepAt || 0) > 7 * DAY;
        const fresh = await list(channel, deep ? env.channelDepth : env.channelRecent);
        const had = known?.videos || [];
        const seen = new Set(fresh.videos.map((v) => v.id));
        added += fresh.videos.filter((v) => !had.some((o) => o.id === v.id)).length;
        // A full list replaces the old one, unless YouTube cut it short.
        const complete = deep && fresh.videos.length >= had.length * 0.8;
        const videos = complete ? fresh.videos : [...fresh.videos, ...had.filter((v) => !seen.has(v.id))];
        index.channels[channel.id] = { name: fresh.name, fetchedAt: Date.now(), deepAt: complete ? Date.now() : known?.deepAt || 0, videos };
        byName = null;
        await saveIndex();
      } catch (err) {
        failed++;
        if (BOT_CHECK.test(err.message)) {
          botCheckHint('listing a channel');
          break;
        }
        log.warn(`channel ${channel.name}: ${err.message.split('\n')[0]}`);
      }
      await sleep(gapMs);
    }
    const status = indexStatus();
    log.info(`Nordic cinema channels: ${status.videos} videos from ${status.channels} channels (${added} new${onlyMissing ? ' from newly added channels' : ''}${failed ? `, ${failed} channels failed` : ''})`);
    return status;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Loads the saved index and keeps it fresh in the background. */
export async function startChannelIndex() {
  await loadIndex();
  const status = indexStatus();
  if (status.videos) log.info(`Nordic cinema channels: ${status.videos} videos from ${status.channels} channels on file`);
  nameIndex();
  const run = () => refreshChannels().catch((err) => log.warn(`channel refresh: ${err.message}`));
  const age = status.refreshed ? Date.now() - Date.parse(status.refreshed) : Infinity;
  const every = env.channelRefreshHours * 60 * 60 * 1000;
  // Channels added since the list was saved are listed right away, not at the next refresh.
  const missing = configuredChannels().filter((c) => !index.channels[c.id]?.videos.length);
  if (age > every) setTimeout(run, 5000).unref();
  else {
    if (missing.length) {
      log.info(`Listing ${missing.length} channels that are not on file yet: ${missing.map((c) => c.name).join(', ')}`);
      setTimeout(() => refreshChannels({ onlyMissing: true }).catch((err) => log.warn(`channel refresh: ${err.message}`)), 5000).unref();
    }
    setTimeout(run, every - age).unref();
  }
  setInterval(run, every).unref();
}

export const indexReady = () => indexStatus().videos > 0;


/**
 * Trailers for a film from the Norwegian channels, best first.
 * data: { title, originalTitle, norwegianTitle, date, tmdbType, genres }
 */
const LANG_ORDER = { no: 0, da: 1, sv: 2 };

export function findChannelTrailers(data, { preferDubbed = false, nordic = true } = {}) {
  const names = [...new Set([data.norwegianTitle, data.danishTitle, data.swedishTitle, data.title, data.originalTitle].filter(Boolean))];
  const released = data.date ? Date.parse(data.date) : NaN;
  const found = [];
  const configured = new Map(configuredChannels().flatMap((c) => [[c.id, c], [c.name, c]]));
  const hits = wantedNames(names).flatMap((n) => nameIndex().get(n) || []);
  for (const { channelId: id, video: v } of hits) {
    const channel = index.channels[id];
    if (!channel) continue;
    const setup = configured.get(id) || configured.get(channel.name) || {};
    const lang = setup.lang || 'no';
    if (lang !== 'no' && !nordic) continue;
    if (v.duration && (v.duration < 25 || v.duration > 330)) continue; // ten-second spots, full films
    if (UNTEXTED.test(v.title)) continue;
    const dubbed = DUBBED.test(v.title);
    if (dubbed && lang !== 'no') continue; // Danish or Swedish voices are no help
    if (setup.marked && !dubbed && !TEXTED.test(v.title)) continue;
    if (data.tmdbType !== 'movie' && /på kino|i kinoene|kinopremiere|i biografen|på bio|biopremiär/i.test(v.title)) continue; // a cinema film, not the series
    if (v.ts && !Number.isNaN(released)) {
      const at = v.ts * 1000;
      // A film's trailer comes out within a year and a half of it, either side (festival films
      // reach the Nordics late). For a series only its launch counts: a later cinema film often
      // shares the name.
      const [before, after] = data.tmdbType === 'movie' ? [550, 550] : [365, 365];
      if (at < released - before * DAY || at > released + after * DAY) continue;
    }
    if (found.some((f) => f.id === v.id)) continue;
    found.push({ ...v, channel: channel.name, lang, dubbed, texted: TEXTED.test(v.title), teaser: /teaser/i.test(v.title) });
  }
  // Norwegian first, then Danish, then Swedish; within a language trailers before teasers.
  return found.sort(
    (a, b) =>
      LANG_ORDER[a.lang] - LANG_ORDER[b.lang] ||
      Number(a.teaser) - Number(b.teaser) ||
      (preferDubbed ? Number(b.dubbed) - Number(a.dubbed) : Number(a.dubbed) - Number(b.dubbed)) ||
      (b.ts || 0) - (a.ts || 0)
  );
}
