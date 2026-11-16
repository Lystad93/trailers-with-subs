import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, log, logThrottled } from './env.js';
import { decodeConfig, encodeConfig, makeProfile, parseProfile, DEFAULTS } from './config.js';
import { findTrailers } from './trailers.js';
import { initMedia, sign, handlePlay } from './media.js';
import { Memo } from './memo.js';
import { YT_ID } from './youtube.js';
import { startChannelIndex, indexStatus } from './channels.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const configureHtml = () => fs.readFileSync(path.join(here, '..', 'public', 'configure.html'), 'utf8');

export function manifest() {
  return {
    id: 'community.trailers-with-subs.no',
    version: pkg.version,
    name: 'Norske trailere',
    description: 'Norwegian dubbed trailers, and English trailers with Norwegian subtitles, in the best quality YouTube has. Made for AIOMetadata’s “trailer addon” setting.',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'tmdb:'],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

function baseUrl(req) {
  if (env.baseUrl) return env.baseUrl;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${env.port}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

function json(res, status, body, maxAge = 0) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
  });
  res.end(JSON.stringify(body));
}

const streamMemo = new Memo({ max: 20000 });
const FLAG = { no: '🇳🇴', da: '🇩🇰', sv: '🇸🇪' };

export async function buildStreams(type, id, config, origin, deps = {}) {
  const trailers = await findTrailers(type, id, config, { tmdbKey: env.tmdbKey, searchBudgetMs: env.searchBudgetMs, ...deps });
  const streams = [];
  if (trailers.partial) streams.partial = true;
  for (const t of trailers) {
    const title = `${t.label} — ${t.name}`;
    const flag = FLAG[t.lang] || '🇳🇴';
    if (t.mode === 'no' && config.ytno) {
      // Nothing is added to a Norwegian trailer, so the player can fetch it from YouTube itself.
      streams.push({ name: `${flag} Trailer`, title, ytId: t.videoId });
      continue;
    }
    const profile = makeProfile(t.mode, config);
    const url = `${origin}/play/${t.videoId}/${profile}/${sign(t.videoId, profile)}.mkv`;
    streams.push({
      name: t.mode === 'no' ? `${flag} Trailer` : '🇳🇴 Tekstet',
      title,
      url,
      behaviorHints: { bingeGroup: `trailers-${t.mode}`, notWebReady: true },
    });
    if (config.yt) streams.push({ name: 'YouTube', title: `${t.label.replace(' · norsk tekst', '')} — ${t.name} (YouTube)`, ytId: t.videoId });
  }
  // What was found, so the log shows which trailers a title was given.
  // One line per title with what was found; the full list at LOG_LEVEL=debug.
  const list = (lang, word) => {
    const found = trailers.filter((t) => t.mode === 'no' && (t.lang || 'no') === lang);
    return found.length ? `${word}: ${found.map((t) => `${t.name}${t.short ? ' (Short)' : ''} [${t.videoId}]`).join('; ')}` : '';
  };
  const subbed = trailers.filter((t) => t.mode === 'sub');
  const nordic = [list('no', 'Norwegian'), list('da', 'Danish'), list('sv', 'Swedish')].filter(Boolean);
  const summary = [
    ...(nordic.length ? nordic : ['no Nordic trailer']),
    `${subbed.length} with translated subtitles${subbed.some((t) => t.short) ? ' (a Short, nothing else exists)' : ''}`,
  ].join(' · ');
  log.info(`${trailers.film || `${type}/${id}`} (${id}): ${trailers.length ? summary : 'no trailers'}`);
  log.debug(streams.map((st, i) => `  ${i + 1}. ${st.title} [${st.ytId ? `YouTube ${st.ytId}` : 'served by the addon'}]`).join('\n'));
  return streams;
}

async function route(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }

  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'health') return json(res, 200, { ok: true, version: pkg.version, channels: indexStatus() });

  // /play/<videoId>/<profile>/<sig>.mkv
  if (parts[0] === 'play' && parts.length === 4) {
    const [, videoId, profileStr, sigFile] = parts;
    const sig = sigFile.replace(/\.(mkv|mp4)$/, ''); // .mp4 links from before 2.0 may still be cached
    const profile = parseProfile(profileStr);
    if (!YT_ID.test(videoId) || !profile || sig !== sign(videoId, profileStr)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Bad or unsigned trailer link');
    }
    return handlePlay(req, res, videoId, profileStr, profile);
  }

  // Optional leading config segment: /<config>/manifest.json, /<config>/stream/...
  let config = decodeConfig('');
  let rest = parts;
  const known = new Set(['manifest.json', 'stream', 'configure']);
  if (parts.length && !known.has(parts[0])) {
    config = decodeConfig(parts[0]);
    if (!config) return json(res, 400, { error: 'Could not read the settings in this URL' });
    rest = parts.slice(1);
  }

  if (rest.length === 0 || rest[0] === 'configure') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    const html = configureHtml()
      .replace('__CONFIG__', JSON.stringify(config).replace(/</g, '\\u003c'))
      .replace('__DEFAULTS__', JSON.stringify(DEFAULTS))
      .replace('__SERVER_HAS_TMDB__', JSON.stringify(Boolean(env.tmdbKey)));
    return res.end(html);
  }

  if (rest[0] === 'manifest.json') return json(res, 200, manifest(), 3600);

  if (rest[0] === 'stream' && rest.length === 3) {
    const type = rest[1];
    const id = decodeURIComponent(rest[2].replace(/\.json$/, ''));
    if (!['movie', 'series'].includes(type)) return json(res, 200, { streams: [] });
    if (!config.tmdb && !env.tmdbKey) return json(res, 200, { streams: [] });
    const origin = baseUrl(req);
    const cacheKey = `${origin}|${encodeConfig(config)}|${type}|${id}`;
    try {
      const streams = await streamMemo.wrap(cacheKey, (v) => (v.partial ? 10 * 60 * 1000 : (v.length ? 6 : 1) * 60 * 60 * 1000), () => buildStreams(type, id, config, origin));
      return json(res, 200, { streams }, streams.length ? 6 * 3600 : 3600);
    } catch (err) {
      // An error status makes AIOMetadata try again later; an empty list would be kept for a day.
      logThrottled('stream-error', 60000, 'warn', `stream ${type}/${id}: ${err.message}`);
      res.setHeader('Retry-After', '60');
      return json(res, 503, { streams: [], error: 'Temporarily unavailable, try again later' });
    }
  }

  json(res, 404, { error: 'Not found' });
}

export function createServer() {
  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log.error(err);
      if (!res.headersSent) json(res, 500, { error: 'Internal error' });
      else res.destroy();
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await initMedia();
  await startChannelIndex();
  createServer().listen(env.port, () => {
    log.info(`Norske trailere v${pkg.version} listening on :${env.port}`);
    log.info(`Configure at ${env.baseUrl || `http://localhost:${env.port}`}/configure`);
    if (!env.tmdbKey) log.warn('TMDB_API_KEY is not set: each user must put a TMDB key in their settings');
  });
}
