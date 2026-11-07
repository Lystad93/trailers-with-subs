import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { env, log } from './env.js';
import { getInfo, pickFormats, pickSubtitle, runYtdlp, baseArgs } from './youtube.js';
import { vttToSrt } from './subtitles.js';

// ---------------------------------------------------------------------------------------------
// Signing: play URLs are signed so the server cannot be used to fetch arbitrary YouTube videos.

let secret = env.secret;

export async function initMedia() {
  await fsp.mkdir(path.join(env.cacheDir, 'work'), { recursive: true });
  // Unfinished work from a previous run is useless.
  for (const entry of await fsp.readdir(path.join(env.cacheDir, 'work'))) {
    await fsp.rm(path.join(env.cacheDir, 'work', entry), { recursive: true, force: true });
  }
  if (!secret) {
    const file = path.join(env.cacheDir, '.secret');
    try {
      secret = (await fsp.readFile(file, 'utf8')).trim();
    } catch {
      secret = '';
    }
    if (!secret) {
      secret = randomBytes(24).toString('hex');
      await fsp.writeFile(file, secret, { mode: 0o600 });
    }
  }
}

export function sign(videoId, profile) {
  return createHmac('sha256', secret || 'unset').update(`${videoId}/${profile}`).digest('base64url').slice(0, 16);
}

// ---------------------------------------------------------------------------------------------
// Jobs: one per (video, profile). The output is written as fragmented MP4 so it can be streamed
// to the first viewer while it is still being made, then remuxed into a normal, seekable MP4.

const jobs = new Map();
const failures = new Map();
const FAILURE_COOLDOWN_MS = 2 * 60 * 1000;
let running = 0;
const queue = [];

function acquire() {
  if (running < env.maxJobs) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}
function release() {
  const next = queue.shift();
  if (next) next();
  else running--;
}

export const cacheKey = (videoId, profile) => `${videoId}_${profile.replace(/[^A-Za-z0-9]+/g, '-')}`;
export const finalPath = (key) => path.join(env.cacheDir, `${key}.mp4`);

export function getJob(key) {
  return jobs.get(key);
}

export function startJob(videoId, profileStr, profile, deps = {}) {
  const key = cacheKey(videoId, profileStr);
  const existing = jobs.get(key);
  if (existing) return existing;
  const failedAt = failures.get(key);
  if (failedAt && Date.now() - failedAt.at < FAILURE_COOLDOWN_MS) {
    const job = { key, failed: failedAt.error, done: Promise.reject(failedAt.error), partReady: Promise.reject(failedAt.error) };
    job.done.catch(() => {});
    job.partReady.catch(() => {});
    return job;
  }

  const job = { key, videoId, profile, partPath: null, encodeFinished: false, listeners: new Set() };
  let partResolve;
  let partReject;
  job.partReady = new Promise((res, rej) => {
    partResolve = res;
    partReject = rej;
  });
  job.partReady.catch(() => {});
  job.notify = () => {
    for (const fn of job.listeners) fn();
  };

  job.done = (async () => {
    await acquire();
    const workDir = path.join(env.cacheDir, 'work', `${key}-${Date.now()}`);
    try {
      await fsp.mkdir(workDir, { recursive: true });
      const out = await buildVideo(videoId, profile, workDir, {
        ...deps,
        onPart: (p) => {
          job.partPath = p;
          partResolve(p);
        },
        onProgress: () => job.notify(),
        onEncoded: () => {
          job.encodeFinished = true;
          job.notify();
        },
      });
      job.encodeFinished = true;
      job.notify();
      await fsp.rename(out, finalPath(key));
      log.info(`ready: ${key}`);
      return finalPath(key);
    } catch (err) {
      failures.set(key, { at: Date.now(), error: err });
      partReject(err);
      job.failed = err;
      job.encodeFinished = true;
      job.notify();
      log.error(`job ${key} failed: ${err.message}`);
      throw err;
    } finally {
      release();
      jobs.delete(key);
      // Readers of the growing part file keep their open file handle, so removing it is safe.
      fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
      enforceCacheLimit().catch((e) => log.warn(`cache cleanup: ${e.message}`));
    }
  })();
  job.done.catch(() => {});
  jobs.set(key, job);
  return job;
}

function assStyle() {
  // Sizes are relative to libass' 288-line default canvas, so they scale with the video.
  return [
    `FontName=${env.subFont}`,
    `FontSize=${env.subFontSize}`,
    'PrimaryColour=&H00FFFFFF',
    'OutlineColour=&H00000000',
    'BackColour=&H80000000',
    'BorderStyle=1',
    'Outline=1.3',
    'Shadow=0.6',
    'MarginV=22',
  ].join(',');
}

function waitExit(child, name) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} exited ${code ?? signal}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

// Stream types that actually hold packets. A fragmented MP4 declares every track up front, so
// a track whose input failed is listed but empty.
function streamTypes(file) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_type,nb_read_packets', '-of', 'csv=p=0', file];
    const p = spawn(env.ffprobe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}`));
      const types = out
        .split('\n')
        .map((line) => line.trim().split(','))
        .filter(([type, packets]) => type && Number(packets) > 0)
        .map(([type]) => type);
      resolve(types);
    });
  });
}

// Spawns yt-dlp writing one format to stdout, using the info already fetched.
function defaultOpenSource(infoPath, formatId) {
  return spawn(env.ytdlp, [...baseArgs(), '--quiet', '--load-info-json', infoPath, '-f', formatId, '-o', '-'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function defaultFetchSubtitle(infoPath, subKey, workDir) {
  await runYtdlp(
    ['--load-info-json', infoPath, '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', subKey, '--sub-format', 'vtt', '-o', path.join(workDir, 'sub.%(ext)s')],
    { timeoutMs: 60000 }
  );
  const file = (await fsp.readdir(workDir)).find((f) => f.startsWith('sub.') && f.endsWith('.vtt'));
  return file ? fsp.readFile(path.join(workDir, file), 'utf8') : null;
}

export async function buildVideo(videoId, profile, workDir, deps = {}) {
  const loadInfo = deps.getInfo || getInfo;
  const openSource = deps.openSource || defaultOpenSource;
  const fetchSubtitle = deps.fetchSubtitle || defaultFetchSubtitle;

  const info = await loadInfo(videoId);
  if (info.duration && info.duration > env.maxDuration) throw new Error(`video is ${info.duration}s, longer than MAX_DURATION`);
  const infoPath = path.join(workDir, 'info.json');
  await fsp.writeFile(infoPath, JSON.stringify(info));

  const withSubs = profile.mode === 'sub';
  let burn = withSubs && profile.subs === 'burn';
  const maxHeight = burn ? Math.min(profile.q, env.burnMaxHeight) : profile.q;
  const picked = pickFormats(info, {
    maxHeight,
    codec: profile.codec,
    burn,
    audioLang: profile.mode === 'no' ? /^(no|nb|nn)/ : null,
  });
  if (!picked) throw new Error('no playable formats');

  let srtPath = null;
  if (withSubs) {
    const choice = pickSubtitle(info, { auto: profile.auto });
    if (choice) {
      try {
        const vtt = await fetchSubtitle(infoPath, choice.key, workDir);
        const { srt, count } = vttToSrt(vtt || '');
        if (count > 0) {
          srtPath = path.join(workDir, 'sub.srt');
          await fsp.writeFile(srtPath, srt);
          log.info(`${videoId}: Norwegian subtitles "${choice.key}" (${choice.kind}, ${count} lines)`);
        }
      } catch (err) {
        log.warn(`${videoId}: subtitles "${choice.key}" failed: ${err.message}`);
      }
    }
    if (!srtPath) log.warn(`${videoId}: no Norwegian subtitles found, playing without`);
  }
  if (!srtPath) burn = false;

  const sources = picked.muxed ? [picked.muxed] : [picked.video, picked.audio];
  log.info(
    `${videoId}: building ${profile.mode}${srtPath ? (burn ? '+burned subs' : '+soft subs') : ''} from ${sources.map((f) => `${f.format_id}(${f.height ? f.height + 'p ' : ''}${f.vcodec !== 'none' ? f.vcodec : f.acodec})`).join(' + ')}`
  );

  const procs = sources.map((f) => openSource(infoPath, f.format_id));
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  args.push('-i', 'pipe:3');
  if (!picked.muxed) args.push('-i', 'pipe:4');
  const softSubs = srtPath && !burn;
  const subInput = picked.muxed ? 1 : 2;
  if (softSubs) args.push('-i', 'sub.srt');
  args.push('-map', '0:v:0', '-map', picked.muxed ? '0:a:0?' : '1:a:0');
  if (softSubs) args.push('-map', `${subInput}:s:0`);

  if (burn) {
    args.push(
      '-vf', `subtitles=sub.srt:force_style='${assStyle()}'`,
      '-c:v', 'libx264', '-preset', env.burnPreset, '-crf', String(env.burnCrf),
      '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-force_key_frames', 'expr:gte(t,n_forced*2)'
    );
  } else {
    args.push('-c:v', 'copy');
  }
  if (picked.audioIsAac) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', '192k');
  if (softSubs) {
    args.push('-c:s', 'mov_text', '-metadata:s:s:0', 'language=nor', '-metadata:s:s:0', 'title=Norsk', '-disposition:s:0', 'default+forced');
  }
  const partPath = path.join(workDir, 'part.mp4');
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', partPath);

  const ff = spawn(env.ffmpeg, args, { cwd: workDir, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const exits = [waitExit(ff, 'ffmpeg'), ...procs.map((p, i) => waitExit(p, `yt-dlp(${sources[i].format_id})`))];
  procs.forEach((p, i) => {
    const sink = ff.stdio[3 + i];
    sink.on('error', () => {}); // EPIPE when ffmpeg stops early
    p.stdout.pipe(sink);
  });
  const killAll = () => {
    for (const p of [ff, ...procs]) if (p.exitCode === null) p.kill('SIGKILL');
  };

  // Tell readers as soon as the file has its header; after that, on every growth.
  let announced = false;
  const watcher = setInterval(async () => {
    try {
      const st = await fsp.stat(partPath);
      if (!announced && st.size > 0) {
        announced = true;
        deps.onPart?.(partPath);
      }
      deps.onProgress?.();
    } catch {
      /* not created yet */
    }
  }, 200);

  try {
    await Promise.all(
      exits.map((p) =>
        p.catch((err) => {
          killAll();
          throw err;
        })
      )
    );
  } finally {
    clearInterval(watcher);
  }
  if (!announced) deps.onPart?.(partPath);
  // ffmpeg can drop an input it fails to read and still exit 0; a trailer without sound is a failure.
  const types = await streamTypes(partPath);
  if (!types.includes('video') || !types.includes('audio')) throw new Error(`output is missing a track (has: ${types.join(', ') || 'nothing'})`);
  deps.onEncoded?.();

  // Remux into a regular MP4 with the index up front, so every player can seek in it.
  const outPath = path.join(workDir, 'final.mp4');
  const remux = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', partPath, '-map', '0', '-c', 'copy'];
  if (softSubs) remux.push('-disposition:s:0', 'default+forced');
  remux.push('-movflags', '+faststart', '-f', 'mp4', outPath);
  await waitExit(spawn(env.ffmpeg, remux, { stdio: ['ignore', 'ignore', 'pipe'] }), 'ffmpeg remux');
  return outPath;
}

// ---------------------------------------------------------------------------------------------
// Disk cache

export async function enforceCacheLimit() {
  const entries = [];
  for (const name of await fsp.readdir(env.cacheDir)) {
    if (!name.endsWith('.mp4')) continue;
    const p = path.join(env.cacheDir, name);
    const st = await fsp.stat(p).catch(() => null);
    if (st) entries.push({ p, size: st.size, used: Math.max(st.atimeMs, st.mtimeMs) });
  }
  let total = entries.reduce((s, e) => s + e.size, 0);
  entries.sort((a, b) => a.used - b.used);
  for (const e of entries) {
    if (total <= env.cacheMaxBytes) break;
    await fsp.rm(e.p, { force: true });
    total -= e.size;
    log.info(`cache: evicted ${path.basename(e.p)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Serving

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  let start;
  let end;
  if (m[1] === '' && m[2] === '') return null;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

export async function serveFile(req, res, file) {
  const st = await fsp.stat(file);
  const now = new Date();
  fsp.utimes(file, now, st.mtime).catch(() => {}); // remember it was used, for the cache limit
  const range = req.headers.range ? parseRange(req.headers.range, st.size) : null;
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` });
    return res.end();
  }
  if (range) {
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`, 'Content-Length': range.end - range.start + 1 });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
  }
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, range ? { start: range.start, end: range.end } : {});
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// Streams the part file while ffmpeg is still writing it.
export async function serveGrowing(req, res, job) {
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none' });
  if (req.method === 'HEAD') return res.end();
  const fh = await fsp.open(job.partPath, 'r');
  let closed = false;
  let unblock = null;
  res.on('close', () => {
    closed = true;
    unblock?.();
  });
  res.on('drain', () => unblock?.());
  const buf = Buffer.alloc(256 * 1024);
  let pos = 0;
  let wake = null;
  const listener = () => wake?.();
  job.listeners.add(listener);
  try {
    while (!closed) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead > 0) {
        pos += bytesRead;
        if (!res.write(Buffer.from(buf.subarray(0, bytesRead))) && !closed) {
          await new Promise((r) => (unblock = r));
          unblock = null;
        }
        continue;
      }
      if (job.encodeFinished) {
        // One last read in case the final bytes landed after the previous one.
        const tail = await fh.read(buf, 0, buf.length, pos);
        if (tail.bytesRead > 0) {
          pos += tail.bytesRead;
          res.write(Buffer.from(buf.subarray(0, tail.bytesRead)));
          continue;
        }
        break;
      }
      await new Promise((r) => {
        wake = r;
        setTimeout(r, 500);
      });
      wake = null;
    }
  } finally {
    job.listeners.delete(listener);
    await fh.close().catch(() => {});
  }
  if (job.failed) res.destroy();
  else res.end();
}

export async function handlePlay(req, res, videoId, profileStr, profile, deps) {
  const key = cacheKey(videoId, profileStr);
  const file = finalPath(key);
  if (fs.existsSync(file)) return serveFile(req, res, file);

  const job = startJob(videoId, profileStr, profile, deps);
  const range = req.headers.range ? /^bytes=(\d+)-/.exec(req.headers.range) : null;
  const fromStart = !range || Number(range[1]) === 0;
  try {
    if (fromStart) {
      // First viewer: start playing while the file is being made.
      await job.partReady;
      if (!job.encodeFinished || !fs.existsSync(file)) {
        if (job.partPath && fs.existsSync(job.partPath)) return await serveGrowing(req, res, job);
      }
    }
    // A seek into a file that is not finished yet: wait for it.
    await job.done;
    return serveFile(req, res, file);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Could not prepare trailer: ${err.message}`);
    } else {
      res.destroy();
    }
  }
}
