// End-to-end test of the video pipeline with local media standing in for YouTube:
// real ffmpeg, real progressive streaming, real remux and range serving.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailers-test-'));
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.LOG_LEVEL = 'warn';
process.env.SECRET = 'test-secret';

const media = await import('../src/media.js');
const { parseProfile } = await import('../src/config.js');

const VIDEO = path.join(tmp, 'video.mp4');
const AUDIO = path.join(tmp, 'audio.m4a');
const BAD_AUDIO = path.join(tmp, 'bad-audio.m4a');

function ff(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
}

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return JSON.parse(r.stdout.toString());
}

// Grey frame of the bottom quarter at time t, as raw bytes.
function bottomFrame(file, t) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'crop=iw:ih/4:0:ih*3/4,scale=320:45,format=gray', '-f', 'rawvideo', '-']);
  return r.stdout;
}

const VTT = ['WEBVTT', '', '00:00:00.500 --> 00:00:04.500', 'Hei på deg, æøå!', ''].join('\n');

const info = {
  id: 'abcdefghijk',
  duration: 5,
  formats: [
    { format_id: 'v1', vcodec: 'avc1.64001f', acodec: 'none', height: 720, fps: 24, protocol: 'https' },
    { format_id: 'a1', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, protocol: 'https', format_note: 'original' },
  ],
  subtitles: { en: [{ ext: 'vtt' }] },
  automatic_captions: { 'no-en': [{ ext: 'vtt' }], no: [{ ext: 'vtt' }] },
};

const subtitleRequests = [];
const deps = {
  getInfo: async () => info,
  // Throttled like a network download, so the first viewer really gets a growing file.
  openSource: (_infoPath, formatId) =>
    spawn('sh', ['-c', `pv -q -L 400k "$0" 2>/dev/null || cat "$0"`, formatId === 'v1' ? VIDEO : AUDIO], { stdio: ['ignore', 'pipe', 'pipe'] }),
  fetchSubtitle: async (_infoPath, key) => {
    subtitleRequests.push(key);
    return VTT;
  },
};

let server;
let base;

test.before(async () => {
  if (!hasFfmpeg) return;
  // A DASH-like fragmented, video-only H.264 file and a separate AAC audio file.
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-pix_fmt', 'yuv420p', '-an', '-movflags', 'frag_keyframe+empty_moov', VIDEO]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:a', 'aac', '-b:a', '128k', '-movflags', 'frag_keyframe+empty_moov', AUDIO]);
  // A plain MP4 with its index at the end cannot be read from a pipe: used to check the job fails.
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=60', '-c:a', 'aac', '-b:a', '256k', BAD_AUDIO]); // too big to buffer
  await media.initMedia();
  server = http.createServer((req, res) => {
    const [, , videoId, profileStr] = new URL(req.url, 'http://x').pathname.split('/');
    media.handlePlay(req, res, videoId, profileStr, parseProfile(profileStr), deps);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

test('soft subtitles: first viewer streams while building, later viewers get a seekable file', { skip: !hasFfmpeg }, async () => {
  const url = `${base}/play/abcdefghijk/sub.1080.h264.soft.a`;
  const first = await get(url);
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'video/mp4');
  assert.equal(first.headers['content-length'], undefined, 'first response is streamed while being made');
  const live = path.join(tmp, 'live.mp4');
  fs.writeFileSync(live, first.body);
  const liveProbe = probe(live);
  assert.deepEqual(liveProbe.streams.map((s) => s.codec_type), ['video', 'audio', 'subtitle']);
  assert.ok(Number(liveProbe.format.duration) > 4.5);

  // Translation of the human-made English subtitles was preferred over auto-captions.
  assert.deepEqual(subtitleRequests, ['no-en']);

  // Wait until the finished file is in the cache.
  const key = media.cacheKey('abcdefghijk', 'sub.1080.h264.soft.a');
  for (let i = 0; i < 100 && !fs.existsSync(media.finalPath(key)); i++) await new Promise((r) => setTimeout(r, 100));
  const final = probe(media.finalPath(key));
  const sub = final.streams.find((s) => s.codec_type === 'subtitle');
  assert.equal(sub.codec_name, 'mov_text');
  assert.equal(sub.tags.language, 'nor');
  assert.equal(sub.disposition.default, 1);
  assert.equal(final.streams.find((s) => s.codec_type === 'video').codec_name, 'h264');

  const ranged = await get(url, { range: 'bytes=100-199' });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.body.length, 100);
  assert.match(ranged.headers['content-range'], /^bytes 100-199\/\d+$/);
  const full = await get(url);
  assert.equal(Number(full.headers['content-length']), fs.statSync(media.finalPath(key)).size);

  const subText = spawnSync('ffmpeg', ['-v', 'error', '-i', media.finalPath(key), '-map', '0:s:0', '-f', 'srt', '-']).stdout.toString();
  assert.match(subText, /Hei på deg, æøå!/);
});

test('burned-in subtitles change the picture where the text is', { skip: !hasFfmpeg }, async () => {
  const url = `${base}/play/abcdefghijk/sub.1080.h264.burn.a`;
  // A seek before the file exists waits for it to be finished.
  const res = await get(url, { range: 'bytes=0-' });
  assert.equal(res.status, 200);
  const key = media.cacheKey('abcdefghijk', 'sub.1080.h264.burn.a');
  for (let i = 0; i < 100 && !fs.existsSync(media.finalPath(key)); i++) await new Promise((r) => setTimeout(r, 100));
  const out = media.finalPath(key);
  const p = probe(out);
  assert.deepEqual(p.streams.map((s) => s.codec_type), ['video', 'audio']);

  const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
  const withText = diff(bottomFrame(out, 2), bottomFrame(VIDEO, 2));
  const withoutText = diff(bottomFrame(out, 4.8), bottomFrame(VIDEO, 4.8));
  assert.ok(withText > withoutText * 3 && withText > 2, `subtitle area should differ (with text ${withText.toFixed(2)}, without ${withoutText.toFixed(2)})`);
});

test('Norwegian trailers are copied without subtitles', { skip: !hasFfmpeg }, async () => {
  const before = subtitleRequests.length;
  const res = await get(`${base}/play/abcdefghijk/no.1080.h264`);
  assert.equal(res.status, 200);
  const file = path.join(tmp, 'no.mp4');
  fs.writeFileSync(file, res.body);
  assert.deepEqual(probe(file).streams.map((s) => s.codec_type), ['video', 'audio']);
  assert.equal(subtitleRequests.length, before);
});

test('a failing source gives 502, not a hang', { skip: !hasFfmpeg }, async () => {
  const badDeps = { ...deps, getInfo: async () => ({ ...info, formats: [] }) };
  const srv = http.createServer((req, res) => media.handlePlay(req, res, 'zzzzzzzzzzz', 'no.720.h264', parseProfile('no.720.h264'), badDeps));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const res = await get(`http://127.0.0.1:${srv.address().port}/`);
  srv.close();
  assert.equal(res.status, 502);
});

test('a job that loses its audio fails instead of caching a silent trailer', { skip: !hasFfmpeg }, async () => {
  const badDeps = { ...deps, openSource: (_p, id) => spawn('cat', [id === 'v1' ? VIDEO : BAD_AUDIO], { stdio: ['ignore', 'pipe', 'pipe'] }) };
  const profileStr = 'sub.720.h264.burn.a';
  const job = media.startJob('yyyyyyyyyyy', profileStr, parseProfile(profileStr), badDeps);
  await assert.rejects(job.done, /missing a track \(has: video\)/);
  assert.equal(fs.existsSync(media.finalPath(media.cacheKey('yyyyyyyyyyy', profileStr))), false);
});

test('signatures depend on video and profile', () => {
  assert.equal(media.sign('abcdefghijk', 'no.1080.h264'), media.sign('abcdefghijk', 'no.1080.h264'));
  assert.notEqual(media.sign('abcdefghijk', 'no.1080.h264'), media.sign('abcdefghijk', 'no.720.h264'));
});

// Plays a trailer through handlePlay with the given subtitle fetcher and waits for the cache.
async function playOnce(videoId, profileStr, fetchSubtitle) {
  const d = { ...deps, fetchSubtitle, subtitleRetryMs: 50 };
  const srv = http.createServer((req, res) => media.handlePlay(req, res, videoId, profileStr, parseProfile(profileStr), d));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const res = await get(`http://127.0.0.1:${srv.address().port}/`);
  srv.close();
  const key = media.cacheKey(videoId, profileStr);
  for (let i = 0; i < 100 && (media.getJob(key) || !fs.existsSync(media.finalPath(key))); i++) await new Promise((r) => setTimeout(r, 100));
  return { res, key };
}

const subTypes = (file) => probe(file).streams.map((s) => s.codec_type);
const rateLimited = () => {
  throw new Error("yt-dlp exited 1: ERROR: Unable to download video subtitles for 'no-en': HTTP Error 429: Too Many Requests");
};

test('a 429 on subtitles is retried, then the next Norwegian track is tried', { skip: !hasFfmpeg }, async () => {
  const tried = [];
  const { key } = await playOnce('rrrrrrrrrrr', 'sub.720.h264.soft.a', async (_p, k) => {
    tried.push(k);
    if (k === 'no-en') rateLimited();
    return VTT;
  });
  assert.deepEqual(tried, ['no-en', 'no-en', 'no']);
  assert.deepEqual(subTypes(media.finalPath(key)), ['video', 'audio', 'subtitle']);
});

test('when YouTube keeps refusing subtitles, the trailer plays without and is rebuilt later', { skip: !hasFfmpeg }, async () => {
  const profileStr = 'sub.480.h264.soft.a';
  const { res, key } = await playOnce('ttttttttttt', profileStr, async () => rateLimited());
  assert.equal(res.status, 200, res.body.toString());
  const file = media.finalPath(key);
  assert.deepEqual(subTypes(file), ['video', 'audio']);
  const marker = file.replace(/\.mp4$/, '.retry-subs');
  assert.ok(fs.existsSync(marker));

  // Within 30 minutes the cached file is served as is.
  let asked = 0;
  await playOnce('ttttttttttt', profileStr, async () => {
    asked++;
    return VTT;
  });
  assert.equal(asked, 0);

  // After that, the next viewer triggers a rebuild that now gets the subtitles.
  fs.writeFileSync(marker, String(Date.now() - 31 * 60 * 1000));
  const before = fs.statSync(file).mtimeMs;
  await playOnce('ttttttttttt', profileStr, async () => VTT);
  for (let i = 0; i < 100 && fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fs.statSync(file).mtimeMs > before);
  assert.deepEqual(subTypes(file), ['video', 'audio', 'subtitle']);
  assert.equal(fs.existsSync(marker), false);
});

test('a subtitle problem that is not temporary is final', { skip: !hasFfmpeg }, async () => {
  const { key } = await playOnce('uuuuuuuuuuu', 'sub.720.h264.soft.a', async () => {
    throw new Error('yt-dlp exited 1: ERROR: no such subtitle');
  });
  assert.equal(fs.existsSync(media.finalPath(key).replace(/\.mp4$/, '.retry-subs')), false);
});
