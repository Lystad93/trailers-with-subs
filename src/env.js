import path from 'node:path';

function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Splits a shell-like argument string, honouring single and double quotes.
export function splitArgs(input) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(input || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

export const env = {
  port: num(process.env.PORT, 7000),
  // Public URL of this addon (e.g. https://trailers.example.com). Derived from the request when empty.
  baseUrl: (process.env.BASE_URL || '').replace(/\/+$/, ''),
  tmdbKey: process.env.TMDB_API_KEY || '',
  cacheDir: path.resolve(process.env.CACHE_DIR || './data/cache'),
  cacheMaxBytes: num(process.env.CACHE_MAX_GB, 10) * 1024 ** 3,
  maxJobs: Math.max(1, num(process.env.MAX_JOBS, 2)),
  secret: process.env.SECRET || '',
  ytdlp: process.env.YTDLP_PATH || 'yt-dlp',
  ytdlpArgs: splitArgs(process.env.YTDLP_ARGS || ''),
  cookies: process.env.YTDLP_COOKIES || '',
  // yt-dlp needs a JavaScript runtime for YouTube; Node is already here.
  jsRuntime: process.env.YTDLP_JS_RUNTIME ?? 'node',
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  burnPreset: process.env.BURN_PRESET || 'veryfast',
  burnCrf: num(process.env.BURN_CRF, 20),
  burnMaxHeight: num(process.env.BURN_MAX_HEIGHT, 1080),
  maxDuration: num(process.env.MAX_DURATION, 600),
  subFont: process.env.SUB_FONT || 'DejaVu Sans',
  subFontSize: num(process.env.SUB_FONT_SIZE, 18),
  // How long a stream request may wait for the YouTube search fallback (AIOMetadata gives up after 6s).
  searchBudgetMs: num(process.env.SEARCH_BUDGET_MS, 3500),
  // YouTube searches allowed to wait in line; more are skipped (catalog warm-ups ask about hundreds of titles).
  searchQueueMax: num(process.env.SEARCH_QUEUE_MAX, 5),
  // TMDB is shared with AIOMetadata on the same IP, so stay well under its ~50 requests/second.
  tmdbRps: Math.max(1, num(process.env.TMDB_RPS, 20)),
  tmdbConcurrency: Math.max(1, num(process.env.TMDB_CONCURRENCY, 6)),
  logLevel: process.env.LOG_LEVEL || 'info',
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export const log = Object.fromEntries(
  Object.keys(LEVELS).map((level) => [
    level,
    (...args) => {
      if (LEVELS[level] < (LEVELS[env.logLevel] ?? 20)) return;
      const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
      (level === 'error' || level === 'warn' ? console.error : console.log)(line);
    },
  ])
);

// Logs a message at most once per interval per key, with a count of what was held back.
const throttled = new Map();
export function logThrottled(key, intervalMs, level, message) {
  const now = Date.now();
  const entry = throttled.get(key);
  if (entry && now - entry.at < intervalMs) {
    entry.suppressed++;
    return;
  }
  const extra = entry?.suppressed ? ` (${entry.suppressed} similar messages hidden)` : '';
  throttled.set(key, { at: now, suppressed: 0 });
  log[level](message + extra);
}
