import { spawn } from 'node:child_process';
import { env, log, logThrottled } from './env.js';
import { Memo } from './memo.js';

export const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const NORWEGIAN = /^(nb|no|nn)(?:[-_]|$)/i;

export function baseArgs() {
  const args = ['--no-warnings', '--no-playlist', '--no-progress'];
  if (env.jsRuntime) args.push('--js-runtimes', env.jsRuntime);
  if (env.cookies) args.push('--cookies', env.cookies);
  return [...args, ...env.ytdlpArgs];
}

export function runYtdlp(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(env.ytdlp, [...baseArgs(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`yt-dlp exited ${code}: ${stderr.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
}

const infoMemo = new Memo({ max: 300 });

// Full video info including Norwegian translations of human-made subtitles
// (yt-dlp only lists those when automatic subtitles are requested).
export function getInfo(videoId) {
  if (!YT_ID.test(videoId)) return Promise.reject(new Error('bad video id'));
  // googlevideo links expire after ~6h; keep well inside that.
  return infoMemo.wrap(videoId, 60 * 60 * 1000, async () => {
    const { stdout } = await runYtdlp(['-J', '--write-subs', '--write-auto-subs', '--', `https://www.youtube.com/watch?v=${videoId}`], {
      timeoutMs: 90000,
    });
    return JSON.parse(stdout);
  });
}

export const BOT_CHECK = /confirm you(?:'|’)re not a bot|Sign in to confirm/i;

export function botCheckHint(source) {
  logThrottled(
    'yt-bot-check',
    10 * 60 * 1000,
    'warn',
    `YouTube is asking this server to "confirm you're not a bot" (${source}). Datacenter IPs get this often: ` +
      'route yt-dlp through a proxy (e.g. YTDLP_ARGS=--proxy http://warp:1080) or give it cookies (YTDLP_COOKIES=/data/cookies.txt).'
  );
}

export class SearchSkipped extends Error {}

// Searches run one at a time with a gap between them, so catalog warm-ups do not get the
// server flagged as a bot. Past a short queue they are skipped (and not cached), and after a
// bot check they stop for a while.
let searchChain = Promise.resolve();
let searchQueued = 0;
let searchPausedUntil = 0;
const SEARCH_GAP_MS = 1500;
const BOT_PAUSE_MS = 30 * 60 * 1000;
const searchMemo = new Memo({ max: 5000 });

export function searchYoutube(query, count = 8) {
  return searchMemo.wrap(`${count}:${query}`, (v) => (v.length ? 7 : 2) * 24 * 60 * 60 * 1000, () => {
    if (Date.now() < searchPausedUntil) return Promise.reject(new SearchSkipped('YouTube searches are paused after a bot check'));
    if (searchQueued >= env.searchQueueMax) return Promise.reject(new SearchSkipped('too many YouTube searches waiting'));
    searchQueued++;
    const run = searchChain.then(async () => {
      try {
        if (Date.now() < searchPausedUntil) throw new SearchSkipped('YouTube searches are paused after a bot check');
        const { stdout } = await runYtdlp(['--flat-playlist', '-J', '--', `ytsearch${count}:${query}`], { timeoutMs: 30000 });
        const data = JSON.parse(stdout);
        return (data.entries || [])
          .filter((e) => e && YT_ID.test(e.id || ''))
          .map((e) => ({ id: e.id, title: e.title || '', duration: e.duration ?? null, channel: e.channel || e.uploader || '' }));
      } catch (err) {
        if (BOT_CHECK.test(err.message)) {
          searchPausedUntil = Date.now() + BOT_PAUSE_MS;
          botCheckHint('search; searches paused for 30 minutes');
          throw new SearchSkipped('YouTube bot check');
        }
        throw err;
      } finally {
        searchQueued--;
        await new Promise((r) => setTimeout(r, SEARCH_GAP_MS));
      }
    });
    searchChain = run.catch(() => {});
    return run;
  });
}

export function codecFamily(vcodec) {
  const v = String(vcodec || '').toLowerCase();
  if (v.startsWith('avc1') || v.startsWith('h264')) return 'h264';
  if (v.startsWith('vp09') || v.startsWith('vp9')) return 'vp9';
  if (v.startsWith('av01')) return 'av1';
  if (v.startsWith('hev1') || v.startsWith('hvc1') || v.startsWith('h265')) return 'h265';
  return 'other';
}

const hasVideo = (f) => f.vcodec && f.vcodec !== 'none';
const hasAudio = (f) => f.acodec && f.acodec !== 'none';
const plainHttp = (f) => !f.protocol || f.protocol === 'https' || f.protocol === 'http';
const isAac = (f) => String(f.acodec || '').startsWith('mp4a');

/**
 * Picks the best video and audio formats for the profile.
 * - codec 'h264': H.264 only (falls back to anything if a video has no H.264)
 * - codec 'any':  best resolution, VP9 > AV1 > H.264 at equal resolution
 * - burn: the picture is re-encoded, so prefer what decodes fast (AV1 last)
 * - audioLang: preferred audio language (YouTube multi-language audio), else the original track
 */
export function pickFormats(info, { maxHeight = 1080, codec = 'h264', burn = false, audioLang = null } = {}) {
  const formats = Array.isArray(info?.formats) ? info.formats.filter((f) => f && f.format_id && plainHttp(f)) : [];
  const inLimit = (f) => (f.height || 0) <= maxHeight;

  let videos = formats.filter((f) => hasVideo(f) && !hasAudio(f) && f.height && inLimit(f));
  if (codec === 'h264') {
    const h264 = videos.filter((f) => codecFamily(f.vcodec) === 'h264');
    if (h264.length) videos = h264;
  }
  const codecRank = burn ? { h264: 3, vp9: 2, av1: 1 } : codec === 'any' ? { vp9: 3, av1: 2, h264: 1 } : { h264: 3, vp9: 2, av1: 1 };
  const sdr = (f) => (!f.dynamic_range || f.dynamic_range === 'SDR' ? 1 : 0);
  videos.sort(
    (a, b) =>
      b.height - a.height ||
      (b.fps || 0) - (a.fps || 0) ||
      sdr(b) - sdr(a) ||
      (codecRank[codecFamily(b.vcodec)] || 0) - (codecRank[codecFamily(a.vcodec)] || 0) ||
      (b.tbr || 0) - (a.tbr || 0)
  );

  const audios = formats.filter((f) => hasAudio(f) && !hasVideo(f));
  const lang = (f) => String(f.language || '').toLowerCase();
  const wantsLang = (f) => (audioLang ? (audioLang instanceof RegExp ? audioLang.test(lang(f)) : lang(f) === audioLang) : false);
  const original = (f) => (/original/i.test(f.format_note || '') ? 1 : 0);
  const drc = (f) => (/drc/i.test(`${f.format_id} ${f.format_note || ''}`) ? 1 : 0);
  audios.sort(
    (a, b) =>
      Number(wantsLang(b)) - Number(wantsLang(a)) ||
      original(b) - original(a) ||
      (b.language_preference ?? -1) - (a.language_preference ?? -1) ||
      drc(a) - drc(b) ||
      Number(isAac(b)) - Number(isAac(a)) ||
      (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0)
  );

  const video = videos[0];
  const audio = audios[0];
  if (video && audio) {
    return { video, audio, height: video.height, vcodec: codecFamily(video.vcodec), audioIsAac: isAac(audio) };
  }

  // Some videos (or a throttled client) only offer combined formats.
  const muxed = formats
    .filter((f) => hasVideo(f) && hasAudio(f))
    .sort((a, b) => Number(inLimit(b)) - Number(inLimit(a)) || (inLimit(a) ? (b.height || 0) - (a.height || 0) : (a.height || 0) - (b.height || 0)));
  if (muxed[0]) {
    return { muxed: muxed[0], height: muxed[0].height, vcodec: codecFamily(muxed[0].vcodec), audioIsAac: isAac(muxed[0]) };
  }
  return null;
}

/**
 * Chooses the Norwegian subtitle track, best first:
 * 1. Norwegian subtitles a person made (nb / no / nn)
 * 2. YouTube's translation of human-made subtitles, e.g. "no-en" (English → Norwegian)
 * 3. YouTube's translation of the auto-generated captions ("no")
 */
export function pickSubtitle(info, { auto = true } = {}) {
  const manual = Object.keys(info?.subtitles || {}).filter((k) => k !== 'live_chat');
  const automatic = Object.keys(info?.automatic_captions || {});
  const rankNo = (k) => (/^nb/i.test(k) ? 0 : /^no/i.test(k) ? 1 : 2); // Bokmål before Nynorsk

  const own = manual.filter((k) => NORWEGIAN.test(k)).sort((a, b) => rankNo(a) - rankNo(b));
  if (own.length) return { key: own[0], kind: 'manual' };
  if (!auto) return null;

  // "no-en", "nb-en-US": translations of a manual track. Prefer one made from English.
  const translated = automatic
    .filter((k) => /^(no|nb)-/i.test(k) && !/-orig$/i.test(k))
    .filter((k) => manual.includes(k.replace(/^(no|nb)-/i, '')))
    .sort((a, b) => Number(/^(no|nb)-en/i.test(b)) - Number(/^(no|nb)-en/i.test(a)) || rankNo(a) - rankNo(b));
  if (translated.length) return { key: translated[0], kind: 'translated' };

  const asr = ['no', 'nb'].find((k) => automatic.includes(k));
  if (asr) return { key: asr, kind: 'auto' };
  // The video's own language is Norwegian (auto-generated captions, not a translation).
  const orig = ['no-orig', 'nb-orig'].find((k) => automatic.includes(k));
  if (orig) return { key: orig, kind: 'auto' };
  return null;
}
