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
  { id: 'UC8C3teVwucjcg7skFUHtPEw', name: 'Filmweb' },
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

const MONTHS = 'januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember';
// Whole words only; \b does not know that å, ø and æ are letters.
const words = (pattern) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'gu');
const NOISE = [
  words(`\\d{1,2} (${MONTHS})( (19|20)\\d{2})?`), // 27. november (2026)
  words('(med|m) (norsk|norske) (tekst|tale|stemmer)'),
  words('(norsk|norske|norwegian) (tekst|tekstet|tale|stemmer|versjon|subtitles|voices|trailer)'),
  words('på kino( (nå|snart))?'),
  words('i kinoene( nå)?'),
  words('(kino)?premiere'),
  words('((offisiell|offisielle|ofisiell|official|ny|siste|final) )*(trailer|teaser|teasertrailer|hovedtrailer)( \\d)?'), // "ny offisiell trailer 2"
  words('hd|4k|uhd'),
];

// What is left of a video title once the trailer wording is gone: the film's name.
export function filmNameOf(videoTitle) {
  let s = normalizeTitle(String(videoTitle || '').replace(/\((19|20)\d{2}\)/g, ' '));
  for (const re of NOISE) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

const TRAILER = /\b(trailer|teaser|teasertrailer|hovedtrailer)\b/i;
const DUBBED = /norsk\s*tale|norske\s*stemmer|dubb/i;
const TEXTED = /norsk\s*tekst|tekstet/i;
const NOT_A_TRAILER = /\b(featurette|bak kulissene|behind the scenes|intervju|interview|klipp|clip|musikkvideo|lyric|premierefest|reaction)\b/i;

/** Does this channel video show a trailer for a film with one of these names? */
export function matchesFilm(videoTitle, names) {
  const title = String(videoTitle || '');
  if (!TRAILER.test(title) || NOT_A_TRAILER.test(title)) return false;
  const wanted = names.map((n) => filmNameOf(n) || normalizeTitle(n)).filter((n) => n.length >= 2);
  if (!wanted.length) return false;
  // Either the whole title is the name plus trailer wording, or its first part is ("Name | …").
  const whole = filmNameOf(title);
  const head = filmNameOf(title.split(/\s[|–—-]\s|\s*\|\s*/)[0]);
  return wanted.some((n) => n === whole || n === head);
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
export function refreshChannels({ gapMs = 5000, list = listChannel } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    await loadIndex();
    let added = 0;
    let failed = 0;
    for (const channel of configuredChannels()) {
      const known = index.channels[channel.id];
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
    log.info(`Norwegian channels: ${status.videos} videos from ${status.channels} channels (${added} new${failed ? `, ${failed} channels failed` : ''})`);
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
  if (status.videos) log.info(`Norwegian channels: ${status.videos} videos from ${status.channels} channels on file`);
  const run = () => refreshChannels().catch((err) => log.warn(`channel refresh: ${err.message}`));
  const age = status.refreshed ? Date.now() - Date.parse(status.refreshed) : Infinity;
  const every = env.channelRefreshHours * 60 * 60 * 1000;
  setTimeout(run, age > every ? 5000 : every - age).unref();
  setInterval(run, every).unref();
}

export const indexReady = () => indexStatus().videos > 0;


/**
 * Trailers for a film from the Norwegian channels, best first.
 * data: { title, originalTitle, norwegianTitle, date, tmdbType, genres }
 */
export function findChannelTrailers(data, { preferDubbed = false } = {}) {
  const names = [...new Set([data.norwegianTitle, data.title, data.originalTitle].filter(Boolean))];
  const released = data.date ? Date.parse(data.date) : NaN;
  const found = [];
  for (const channel of Object.values(index.channels)) {
    for (const v of channel.videos) {
      if (v.duration && (v.duration < 25 || v.duration > 330)) continue; // ten-second spots, full films
      if (!matchesFilm(v.title, names)) continue;
      // Keep remakes and same-named films apart: a trailer comes out around its film.
      if (v.ts && !Number.isNaN(released)) {
        const at = v.ts * 1000;
        if (data.tmdbType === 'movie' ? at < released - 2 * 365 * DAY || at > released + 2 * 365 * DAY : at < released - 2 * 365 * DAY) continue;
      }
      if (found.some((f) => f.id === v.id)) continue;
      found.push({ ...v, channel: channel.name, dubbed: DUBBED.test(v.title), texted: TEXTED.test(v.title), teaser: /teaser/i.test(v.title) });
    }
  }
  return found.sort(
    (a, b) =>
      Number(a.teaser) - Number(b.teaser) ||
      (preferDubbed ? Number(b.dubbed) - Number(a.dubbed) : Number(a.dubbed) - Number(b.dubbed)) ||
      (b.ts || 0) - (a.ts || 0)
  );
}
