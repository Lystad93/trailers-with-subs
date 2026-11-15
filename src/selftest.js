// Builds one trailer from the command line and says what happened and how long each step took:
//   node src/selftest.js <YouTube id or link> [burn]
// In Docker: docker exec trailers-with-subs node src/selftest.js <id>
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from './env.js';
import { buildVideo, initMedia } from './media.js';
import { translatorName } from './translate.js';

const arg = process.argv[2] || '';
const videoId = /(?:v=|youtu\.be\/|^)([A-Za-z0-9_-]{11})(?:[&?].*)?$/.exec(arg)?.[1];
if (!videoId) {
  console.error('Usage: node src/selftest.js <YouTube id or link> [burn]');
  process.exit(2);
}
const profile = { mode: 'sub', q: 1080, codec: 'h264', subs: process.argv[3] === 'burn' ? 'burn' : 'soft', auto: true };

await initMedia();
const workDir = await fsp.mkdtemp(path.join(env.cacheDir, 'work', 'selftest-'));
console.log(`Translator: ${translatorName() || 'none (set GEMINI_API_KEY); YouTube\'s own translation is used'}`);
console.log(`yt-dlp arguments: ${env.ytdlpArgs.join(' ') || '(none)'}${env.cookies ? ` + cookies ${env.cookies}` : ''}`);
let failed = false;
try {
  const { outPath, retrySubs } = await buildVideo(videoId, profile, workDir);
  const probe = spawnSync(env.ffprobe, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,height:stream_tags=language', '-of', 'json', outPath]);
  const data = JSON.parse(probe.stdout.toString() || '{}');
  const streams = (data.streams || []).map((s) => `${s.codec_type} ${s.codec_name}${s.height ? ` ${s.height}p` : ''}${s.tags?.language ? ` [${s.tags.language}]` : ''}`);
  console.log(`\nResult: ${streams.join(', ')}; ${Math.round(Number(data.format?.duration || 0))}s, ${(Number(data.format?.size || 0) / 1e6).toFixed(1)} MB`);
  const hasSubs = profile.subs === 'burn' ? !retrySubs : streams.some((s) => s.startsWith('subtitle'));
  console.log(hasSubs && !retrySubs ? 'OK: the trailer has Norwegian subtitles.' : 'The trailer was built WITHOUT subtitles: see the warnings above.');
  failed = !hasSubs || retrySubs;
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  failed = true;
} finally {
  await fsp.rm(workDir, { recursive: true, force: true });
}
// A slow subtitle task may still be running in the background; don't wait for it.
process.exit(failed ? 1 : 0);
