import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MODEL = 'gemini-test';
const { translateTexts, translateCues, mergeForTranslation, wrapText, translatorName, TranslateError } = await import('../src/translate.js');
const { subtitlePlan } = await import('../src/youtube.js');

// A stand-in for Gemini's generateContent endpoint.
function fakeGemini(answer) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const lines = JSON.parse(body.contents[0].parts[0].text.split('\n').slice(-1)[0]);
    calls.push({ url: String(url), headers: opts.headers, body, lines });
    return answer(lines, calls.length);
  };
  return { fetchImpl, calls };
}
const reply = (value) => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] }, finishReason: 'STOP' }] }),
});

test('Gemini gets the lines as JSON and must answer with a JSON array of the same length', async () => {
  assert.equal(translatorName(), 'Gemini (gemini-test)');
  const { fetchImpl, calls } = fakeGemini((lines) => reply(lines.map((l) => `NO:${l}`)));
  const out = await translateTexts(['Hello.', 'Run!'], fetchImpl, 'Dune: Part Two | Official Trailer');
  assert.deepEqual(out, ['NO:Hello.', 'NO:Run!']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  assert.equal(calls[0].headers['x-goog-api-key'], 'test-key');
  assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(calls[0].body.generationConfig.responseSchema, { type: 'ARRAY', items: { type: 'STRING' } });
  assert.match(calls[0].body.systemInstruction.parts[0].text, /Norwegian Bokmål/);
  assert.match(calls[0].body.contents[0].parts[0].text, /^Trailer: Dune: Part Two/);
});

test('a reply with the wrong number of lines is asked again, then given up on', async () => {
  const flaky = fakeGemini((lines, n) => reply(n === 1 ? ['only one'] : lines.map((l) => `NO:${l}`)));
  assert.deepEqual(await translateTexts(['a', 'b'], flaky.fetchImpl), ['NO:a', 'NO:b']);
  assert.equal(flaky.calls.length, 2);

  const broken = fakeGemini(() => reply('not an array'));
  await assert.rejects(translateTexts(['a', 'b'], broken.fetchImpl), /did not return 2 translated lines/);
});

test('rate limits are temporary, a bad key is not', async () => {
  const busy = fakeGemini(() => ({ ok: false, status: 429, json: async () => ({ error: { message: 'Resource has been exhausted' } }) }));
  await assert.rejects(translateTexts(['a'], busy.fetchImpl), (e) => e instanceof TranslateError && e.transient && /exhausted/.test(e.message));
  const bad = fakeGemini(() => ({ ok: false, status: 400, json: async () => ({ error: { message: 'API key not valid' } }) }));
  await assert.rejects(translateTexts(['a'], bad.fetchImpl), (e) => !e.transient && /API key not valid/.test(e.message));
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
  const { fetchImpl } = fakeGemini((lines) => reply(lines.map((t) => (t === 'Hello there.' ? 'Hei der.' : t))));
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
