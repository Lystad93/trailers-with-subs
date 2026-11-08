import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DEEPL_API_KEY = 'test-key:fx';
const { translateTexts, translateCues, mergeForTranslation, wrapText, TranslateError } = await import('../src/translate.js');
const { subtitlePlan } = await import('../src/youtube.js');

function fakeDeepl(handler) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), headers: opts.headers, body });
    return handler(body);
  };
  return { fetchImpl, calls };
}
const ok = (data) => ({ ok: true, status: 200, json: async () => data });

test('DeepL is called the way its API expects, in batches of 50', async () => {
  const { fetchImpl, calls } = fakeDeepl((body) => ok({ translations: body.text.map((t) => ({ text: `NO:${t}` })) }));
  const texts = Array.from({ length: 120 }, (_, i) => `line ${i}`);
  const out = await translateTexts(texts, fetchImpl);
  assert.equal(out.length, 120);
  assert.equal(out[119], 'NO:line 119');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(calls[0].headers.authorization, 'DeepL-Auth-Key test-key:fx');
  assert.equal(calls[0].body.target_lang, 'NB');
  assert.equal(calls[0].body.text.length, 50);
});

test('quota and rate limits are reported as such', async () => {
  const quota = fakeDeepl(() => ({ ok: false, status: 456, json: async () => ({}) }));
  await assert.rejects(translateTexts(['a'], quota.fetchImpl), (e) => e instanceof TranslateError && !e.transient && /quota/.test(e.message));
  const busy = fakeDeepl(() => ({ ok: false, status: 429, json: async () => ({}) }));
  await assert.rejects(translateTexts(['a'], busy.fetchImpl), (e) => e.transient === true);
});

test('auto-caption fragments are merged into sentences before translating', () => {
  const cue = (start, end, text) => ({ start, end, lines: [text] });
  const merged = mergeForTranslation([
    cue(0, 1000, 'in a world'),
    cue(1000, 2000, 'where nothing is'),
    cue(2000, 3000, 'what it seems.'),
    cue(3500, 5000, 'One man'),
    cue(9000, 10000, 'stands alone'),
  ]);
  assert.deepEqual(merged.map((c) => [c.start, c.end, c.text]), [
    [0, 3000, 'in a world where nothing is what it seems.'],
    [3500, 5000, 'One man'],
    [9000, 10000, 'stands alone'],
  ]);
});

test('long lines are split into two balanced lines', () => {
  assert.deepEqual(wrapText('Kort linje'), ['Kort linje']);
  const lines = wrapText('I en verden der ingenting er som det ser ut, står én mann alene mot alle');
  assert.equal(lines.length, 2);
  assert.ok(Math.abs(lines[0].length - lines[1].length) < 12);
});

test('translateCues keeps the timing of the merged cues', async () => {
  const { fetchImpl } = fakeDeepl((body) => ok({ translations: body.text.map((t) => ({ text: t === 'Hello there.' ? 'Hei der.' : t })) }));
  const cues = await translateCues([{ start: 500, end: 1500, lines: ['Hello', 'there.'] }], fetchImpl);
  assert.deepEqual(cues, [{ start: 500, end: 1500, lines: ['Hei der.'] }]);
});

test('with a translator, YouTube translations come last', () => {
  const info = {
    subtitles: { 'en-US': [{}], de: [{}], live_chat: [{}] },
    automatic_captions: { 'en-orig': [{}], no: [{}], 'no-en-US': [{}], 'no-de': [{}] },
  };
  assert.deepEqual(subtitlePlan(info, { translate: true }).map((c) => `${c.key}${c.translate ? '*' : ''}`), ['en-US*', 'de*', 'en-orig*', 'no-en-US', 'no-de', 'no']);
  assert.deepEqual(subtitlePlan(info, { translate: false }).map((c) => c.key), ['no-en-US', 'no-de', 'no']);
  assert.deepEqual(subtitlePlan({ ...info, subtitles: { ...info.subtitles, nb: [{}] } }, { translate: true })[0], { key: 'nb', kind: 'manual' });
  assert.deepEqual(subtitlePlan(info, { translate: true, auto: false }), []);
});
