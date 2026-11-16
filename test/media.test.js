// End-to-end test of the video pipeline with local media standing in for YouTube:
// real ffmpeg, real streaming of a file that is still being written, real range serving.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SHORTS_CHECK = '0';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailers-test-'));
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.LOG_LEVEL = process.env.TEST_LOG || 'error';
process.env.SECRET = 'test-secret';

const media = await import('../src/media.js');
const { parseProfile } = await import('../src/config.js');

const VIDEO = path.join(tmp, 'video.mp4');
const AUDIO = path.join(tmp, 'audio.m4a');
const OPUS = path.join(tmp, 'audio.webm');
const BAD_AUDIO = path.join(tmp, 'bad-audio.m4a');
const SLOW = path.join(tmp, 'slow.mjs');

function ff(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
}

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return JSON.parse(r.stdout.toString());
}
const types = (file) => probe(file).streams.map((s) => s.codec_type);
const subtitleText = (file) => spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:s:0', '-f', 'srt', '-']).stdout.toString();

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
    { format_id: 'a1', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, protocol: 'https', format_note: 'original', language: 'en-US' },
  ],
  subtitles: { en: [{ ext: 'vtt' }] },
  automatic_captions: { 'no-en': [{ ext: 'vtt' }], no: [{ ext: 'vtt' }] },
};

const fileOf = (formatId) => (formatId === 'v1' ? VIDEO : formatId === 'a2' ? OPUS : AUDIO);
const subtitleRequests = [];
const deps = {
  getInfo: async () => info,
  openSource: (_infoPath, formatId) => spawn('cat', [fileOf(formatId)], { stdio: ['ignore', 'pipe', 'pipe'] }),
  fetchSubtitle: async (_infoPath, key) => {
    subtitleRequests.push(key);
    return VTT;
  },
  subtitleRetryMs: 50,
};
// A download at 250 kB/s, so the first viewer really gets a file that is still growing.
const slowSource = (_infoPath, formatId) => spawn(process.execPath, [SLOW, fileOf(formatId)], { stdio: ['ignore', 'pipe', 'pipe'] });

test.before(async () => {
  if (!hasFfmpeg) return;
  // A DASH-like fragmented, video-only H.264 file and separate AAC and Opus audio files.
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-pix_fmt', 'yuv420p', '-an', '-movflags', 'frag_keyframe+empty_moov', VIDEO]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:a', 'aac', '-b:a', '128k', '-movflags', 'frag_keyframe+empty_moov', AUDIO]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:a', 'libopus', '-b:a', '96k', '-f', 'webm', OPUS]);
  // A plain MP4 with its index at the end cannot be read from a pipe: used to check the job fails.
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=60', '-c:a', 'aac', '-b:a', '256k', BAD_AUDIO]); // too big to buffer
  fs.writeFileSync(
    SLOW,
    `import fs from 'node:fs';
const data = fs.readFileSync(process.argv[2]);
for (let i = 0; i < data.length; i += 25000) {
  process.stdout.write(data.subarray(i, i + 25000));
  await new Promise((r) => setTimeout(r, 100));
}
`
  );
  await media.initMedia();
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

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

// One request through handlePlay; resolves with the response and the cache key once the job is over.
async function play(videoId, profileStr, extra = {}, headers = {}) {
  const d = { ...deps, ...extra };
  const srv = http.createServer((req, res) => media.handlePlay(req, res, videoId, profileStr, parseProfile(profileStr), d));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const res = await get(`http://127.0.0.1:${srv.address().port}/`, headers);
  srv.close();
  const key = media.cacheKey(videoId, profileStr);
  for (let i = 0; i < 150 && media.getJob(key); i++) await new Promise((r) => setTimeout(r, 100));
  return { res, key, file: media.finalPath(key), marker: media.finalPath(key).replace(/\.mkv$/, '.retry-subs') };
}

const rateLimited = () => {
  throw new Error("yt-dlp exited 1: ERROR: Unable to download video subtitles for 'no-en': HTTP Error 429: Too Many Requests");
};

test('a slow download is streamed to the first viewer while it is written; the file is then seekable', { skip: !hasFfmpeg }, async () => {
  const profile = 'sub.1080.h264.soft.a';
  const { res, file } = await play('abcdefghijk', profile, { openSource: slowSource });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'video/x-matroska');
  assert.equal(res.headers['content-length'], undefined, 'streamed while being made');
  const live = path.join(tmp, 'live.mkv');
  fs.writeFileSync(live, res.body);
  assert.deepEqual(types(live), ['video', 'audio', 'subtitle']);
  assert.match(subtitleText(live), /Hei på deg, æøå!/);

  // YouTube's translation of the human-made English subtitles was preferred over auto-captions.
  assert.deepEqual(subtitleRequests, ['no-en']);

  const final = probe(file);
  const video = final.streams.find((s) => s.codec_type === 'video');
  const audio = final.streams.find((s) => s.codec_type === 'audio');
  const sub = final.streams.find((s) => s.codec_type === 'subtitle');
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.has_b_frames, probe(VIDEO).streams[0].has_b_frames);
  assert.equal(audio.codec_name, 'aac');
  assert.equal(audio.tags.language, 'eng');
  assert.equal(sub.codec_name, 'subrip');
  assert.equal(sub.tags.language, 'nor');
  assert.equal(sub.disposition.default, 1);
  assert.equal(sub.disposition.forced, 0);
  assert.ok(Number(final.format.duration) > 4.5);

  const ranged = await play('abcdefghijk', profile, {}, { range: 'bytes=100-199' });
  assert.equal(ranged.res.status, 206);
  assert.equal(ranged.res.body.length, 100);
  assert.match(ranged.res.headers['content-range'], /^bytes 100-199\/\d+$/);
  const full = await play('abcdefghijk', profile);
  assert.equal(Number(full.res.headers['content-length']), fs.statSync(file).size);
});

test('a download that finishes at once gives the first viewer the finished, seekable file', { skip: !hasFfmpeg }, async () => {
  const { res, file } = await play('fastfastfas', 'sub.1080.h264.soft.a');
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers['content-length']), fs.statSync(file).size);
  assert.equal(res.headers['accept-ranges'], 'bytes');
});

test('video and audio are copied whatever the codec', { skip: !hasFfmpeg }, async () => {
  const opusInfo = { ...info, formats: [info.formats[0], { format_id: 'a2', vcodec: 'none', acodec: 'opus', abr: 96, protocol: 'https' }] };
  const { file } = await play('opusopusopu', 'no.1080.any', { getInfo: async () => opusInfo });
  const p = probe(file);
  assert.deepEqual(p.streams.map((s) => s.codec_name), ['h264', 'opus']);
  // A trailer listed as Norwegian is tagged as such, for players that go by the audio language.
  assert.equal(p.streams[1].tags.language, 'nor');
});

test('burned-in subtitles change the picture where the text is', { skip: !hasFfmpeg }, async () => {
  // A seek before the file exists waits for it to be finished.
  const { res, file } = await play('abcdefghijk', 'sub.1080.h264.burn.a', {}, { range: 'bytes=0-' });
  assert.equal(res.status, 200);
  assert.deepEqual(types(file), ['video', 'audio']);

  const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
  const withText = diff(bottomFrame(file, 2), bottomFrame(VIDEO, 2));
  const withoutText = diff(bottomFrame(file, 4.8), bottomFrame(VIDEO, 4.8));
  assert.ok(withText > withoutText * 3 && withText > 2, `subtitle area should differ (with text ${withText.toFixed(2)}, without ${withoutText.toFixed(2)})`);
});

test('Norwegian trailers are copied without asking for subtitles', { skip: !hasFfmpeg }, async () => {
  const before = subtitleRequests.length;
  const { res, file } = await play('abcdefghijk', 'no.1080.h264');
  assert.equal(res.status, 200);
  assert.deepEqual(types(file), ['video', 'audio']);
  assert.equal(subtitleRequests.length, before);
});

test('a failing source gives 502, not a hang', { skip: !hasFfmpeg }, async () => {
  const { res } = await play('zzzzzzzzzzz', 'no.720.h264', { getInfo: async () => ({ ...info, formats: [] }) });
  assert.equal(res.status, 502);
});

test('a job that loses its audio fails instead of caching a silent trailer', { skip: !hasFfmpeg }, async () => {
  const badDeps = { ...deps, openSource: (_p, id) => spawn('cat', [id === 'v1' ? VIDEO : BAD_AUDIO], { stdio: ['ignore', 'pipe', 'pipe'] }) };
  const profileStr = 'sub.720.h264.burn.a';
  const job = media.startJob('yyyyyyyyyyy', profileStr, parseProfile(profileStr), badDeps);
  await assert.rejects(job.done, /missing a track \(has: video\)/);
  assert.equal(fs.existsSync(media.finalPath(media.cacheKey('yyyyyyyyyyy', profileStr))), false);
});

test('a download YouTube refuses with 403 is tried once more with new links', { skip: !hasFfmpeg }, async () => {
  let opened = 0;
  const openSource = (_p, id) => {
    opened++;
    // The first video download is refused; everything after it works.
    if (opened === 1) return spawn('sh', ['-c', 'echo "ERROR: unable to download video data: HTTP Error 403: Forbidden" >&2; exit 1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return spawn('cat', [fileOf(id)], { stdio: ['ignore', 'pipe', 'pipe'] });
  };
  const profileStr = 'no.1080.h264';
  const job = media.startJob('rrrrrrrrrrr', profileStr, parseProfile(profileStr), { ...deps, openSource });
  const file = await job.done;
  assert.deepEqual(types(file).sort(), ['audio', 'video']);
  assert.equal(opened, 4);
});

test('signatures depend on video and profile', () => {
  assert.equal(media.sign('abcdefghijk', 'no.1080.h264'), media.sign('abcdefghijk', 'no.1080.h264'));
  assert.notEqual(media.sign('abcdefghijk', 'no.1080.h264'), media.sign('abcdefghijk', 'no.720.h264'));
});

test('a 429 on subtitles is retried, then the next Norwegian track is tried', { skip: !hasFfmpeg }, async () => {
  const tried = [];
  const { file } = await play('rrrrrrrrrrr', 'sub.720.h264.soft.a', {
    fetchSubtitle: async (_p, k) => {
      tried.push(k);
      if (k === 'no-en') rateLimited();
      return VTT;
    },
  });
  assert.deepEqual(tried, ['no-en', 'no-en', 'no']);
  assert.deepEqual(types(file), ['video', 'audio', 'subtitle']);
});

test('slow subtitles do not hold up the trailer; the next play has them', { skip: !hasFfmpeg }, async () => {
  const profile = 'sub.720.h264.soft.a';
  let asked = 0;
  const slowSubs = async () => {
    asked++;
    await new Promise((r) => setTimeout(r, 1500));
    return VTT;
  };
  const t0 = Date.now();
  const first = await play('slowsubs001', profile, { fetchSubtitle: slowSubs, subWaitMs: 300 });
  assert.equal(first.res.status, 200);
  assert.ok(Date.now() - t0 < 1400, `the trailer did not wait for the subtitles (${Date.now() - t0}ms)`);
  assert.deepEqual(types(first.file), ['video', 'audio']);
  assert.ok(fs.existsSync(first.marker));

  // The subtitles are finished in the background and kept.
  const cached = path.join(process.env.CACHE_DIR, 'subs', 'slowsubs001.a.srt');
  for (let i = 0; i < 50 && !fs.existsSync(cached); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(fs.readFileSync(cached, 'utf8'), /Hei på deg/);

  // The next play rebuilds the trailer with them, without asking YouTube for subtitles again.
  const second = await play('slowsubs001', profile, { fetchSubtitle: slowSubs, subWaitMs: 300 });
  assert.deepEqual(types(second.file), ['video', 'audio', 'subtitle']);
  assert.equal(fs.existsSync(second.marker), false);
  assert.equal(asked, 1);
});

test('when YouTube keeps refusing subtitles, the trailer plays without and is rebuilt later', { skip: !hasFfmpeg }, async () => {
  const profile = 'sub.480.h264.soft.a';
  const { res, file, marker } = await play('ttttttttttt', profile, { fetchSubtitle: async () => rateLimited() });
  assert.equal(res.status, 200, res.body.toString());
  assert.deepEqual(types(file), ['video', 'audio']);
  assert.ok(fs.existsSync(marker));

  // Within 30 minutes the cached file is served as is.
  let asked = 0;
  const working = async () => {
    asked++;
    return VTT;
  };
  await play('ttttttttttt', profile, { fetchSubtitle: working });
  assert.equal(asked, 0);

  // After that, the next viewer triggers a rebuild that now gets the subtitles.
  fs.writeFileSync(marker, String(Date.now() - 31 * 60 * 1000));
  await play('ttttttttttt', profile, { fetchSubtitle: working });
  assert.deepEqual(types(file), ['video', 'audio', 'subtitle']);
  assert.equal(fs.existsSync(marker), false);
});

test('a subtitle problem that is not temporary is final', { skip: !hasFfmpeg }, async () => {
  const { file, marker } = await play('uuuuuuuuuuu', 'sub.720.h264.soft.a', {
    fetchSubtitle: async () => {
      throw new Error('yt-dlp exited 1: ERROR: no such subtitle');
    },
  });
  assert.deepEqual(types(file), ['video', 'audio']);
  assert.equal(fs.existsSync(marker), false);
});

test('with a translator, the English track is translated and YouTube translations are not touched', { skip: !hasFfmpeg }, async () => {
  const tried = [];
  const translated = [];
  const extra = {
    fetchSubtitle: async (_p, k) => {
      tried.push(k);
      if (k.startsWith('no')) rateLimited();
      return ['WEBVTT', '', '00:00:00.500 --> 00:00:04.000', 'Hello there.', ''].join('\n');
    },
    translateCues: async (cues) => {
      translated.push(...cues.map((c) => c.lines.join(' ')));
      return cues.map((c) => ({ ...c, lines: ['Hei der.'] }));
    },
  };
  const { file } = await play('vvvvvvvvvvv', 'sub.720.h264.soft.a', extra);
  assert.deepEqual(tried, ['en']);
  assert.deepEqual(translated, ['Hello there.']);
  assert.match(subtitleText(file), /Hei der\./);

  // Another profile of the same video reuses the subtitles without asking again.
  await play('vvvvvvvvvvv', 'sub.720.h264.burn.a', extra);
  assert.deepEqual(tried, ['en']);
});

test('files from before 2.0 are cleared at start-up', { skip: !hasFfmpeg }, async () => {
  const old = path.join(process.env.CACHE_DIR, 'oldoldoldol_sub-1080-h264-burn-a.mp4');
  fs.writeFileSync(old, 'x');
  await media.initMedia();
  assert.equal(fs.existsSync(old), false);
});
