import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFormats, pickSubtitle, codecFamily } from '../src/youtube.js';

const v = (id, height, vcodec, extra = {}) => ({ format_id: id, height, vcodec, acodec: 'none', protocol: 'https', fps: 24, ...extra });
const a = (id, acodec, abr, extra = {}) => ({ format_id: id, vcodec: 'none', acodec, abr, protocol: 'https', ...extra });

const info = {
  formats: [
    { format_id: 'sb0', vcodec: 'none', acodec: 'none', protocol: 'mhtml' },
    { format_id: '18', height: 360, vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', protocol: 'https' },
    v('137', 1080, 'avc1.640028', { tbr: 4000 }),
    v('248', 1080, 'vp09.00.40.08', { tbr: 2500 }),
    v('399', 1080, 'av01.0.08M.08', { tbr: 2000 }),
    v('271', 1440, 'vp09.00.50.08'),
    v('313', 2160, 'vp09.00.51.08'),
    v('701', 2160, 'av01.0.12M.10', { dynamic_range: 'HDR10' }),
    v('401', 2160, 'av01.0.12M.08'),
    v('614', 1080, 'avc1.640028', { protocol: 'm3u8_native' }),
    a('140', 'mp4a.40.2', 129, { language: 'en', language_preference: 10, format_note: 'English original, medium' }),
    a('251', 'opus', 140, { language: 'en', language_preference: 10, format_note: 'English original, medium' }),
    a('140-1', 'mp4a.40.2', 129, { language: 'no', language_preference: -1, format_note: 'Norwegian, medium' }),
    a('140-drc', 'mp4a.40.2', 129, { language: 'en', language_preference: 10, format_note: 'English original, medium, DRC' }),
  ],
};

test('codec families', () => {
  assert.equal(codecFamily('avc1.640028'), 'h264');
  assert.equal(codecFamily('vp09.00.51.08'), 'vp9');
  assert.equal(codecFamily('av01.0.12M.08'), 'av1');
});

test('h264 profile picks 1080p H.264 and the original AAC audio', () => {
  const p = pickFormats(info, { maxHeight: 2160, codec: 'h264' });
  assert.equal(p.video.format_id, '137');
  assert.equal(p.audio.format_id, '140');
  assert.equal(p.audioIsAac, true);
});

test('any codec picks 4K SDR VP9', () => {
  const p = pickFormats(info, { maxHeight: 2160, codec: 'any' });
  assert.equal(p.video.format_id, '313');
});

test('max height is respected', () => {
  assert.equal(pickFormats(info, { maxHeight: 1440, codec: 'any' }).video.format_id, '271');
  assert.equal(pickFormats(info, { maxHeight: 1080, codec: 'any' }).video.format_id, '248');
  assert.equal(pickFormats(info, { maxHeight: 1080, codec: 'any', burn: true }).video.format_id, '137');
});

test('when nothing fits under the limit, the smallest video is used', () => {
  assert.equal(pickFormats(info, { maxHeight: 480, codec: 'h264' }).video.format_id, '137');
});

test('Norwegian audio track is chosen for dubbed mode when present', () => {
  const p = pickFormats(info, { maxHeight: 1080, audioLang: /^(no|nb|nn)/ });
  assert.equal(p.audio.format_id, '140-1');
});

test('falls back to combined formats', () => {
  const p = pickFormats({ formats: [info.formats[1]] }, { maxHeight: 1080 });
  assert.equal(p.muxed.format_id, '18');
});

test('nothing playable gives null', () => {
  assert.equal(pickFormats({ formats: [] }), null);
});

const subInfo = (subtitles, automatic) => ({
  subtitles: Object.fromEntries(subtitles.map((k) => [k, [{ ext: 'vtt' }]])),
  automatic_captions: Object.fromEntries(automatic.map((k) => [k, [{ ext: 'vtt' }]])),
});

test('human-made Norwegian subtitles come first', () => {
  assert.deepEqual(pickSubtitle(subInfo(['en', 'nn', 'nb'], ['no', 'no-en'])), { key: 'nb', kind: 'manual' });
  assert.deepEqual(pickSubtitle(subInfo(['no-NO'], [])), { key: 'no-NO', kind: 'manual' });
});

test('then a translation of human-made English subtitles', () => {
  assert.deepEqual(pickSubtitle(subInfo(['de', 'en'], ['no', 'no-de', 'no-en', 'en-orig'])), { key: 'no-en', kind: 'translated' });
});

test('then translated auto-captions', () => {
  assert.deepEqual(pickSubtitle(subInfo(['live_chat'], ['en', 'en-orig', 'no'])), { key: 'no', kind: 'auto' });
});

test('auto=false only accepts human-made Norwegian subtitles', () => {
  assert.equal(pickSubtitle(subInfo(['en'], ['no', 'no-en']), { auto: false }), null);
  assert.equal(pickSubtitle(subInfo([], [])), null);
});
