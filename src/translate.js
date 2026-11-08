// Translates subtitles to Norwegian Bokmål ourselves, with DeepL or a LibreTranslate server.
// YouTube's own translations ("tlang") are rate limited hard for servers; the original-language
// track is an ordinary request.
import { env } from './env.js';

export class TranslateError extends Error {
  constructor(message, transient = false) {
    super(message);
    this.transient = transient;
  }
}

export function translatorName() {
  if (env.deeplKey) return 'DeepL';
  if (env.libreUrl) return 'LibreTranslate';
  return null;
}

const SENTENCE_END = /[.!?…:;"”»)\]]$/;

// Auto-generated captions come in fragments; translating whole sentences reads far better.
export function mergeForTranslation(cues, { maxChars = 90, maxMs = 7000 } = {}) {
  const out = [];
  for (const cue of cues) {
    const text = cue.lines.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const last = out[out.length - 1];
    const joinable =
      last &&
      !SENTENCE_END.test(last.text) &&
      cue.start - last.end < 1500 &&
      cue.end - last.start <= maxMs &&
      last.text.length + 1 + text.length <= maxChars;
    if (joinable) {
      last.text += ` ${text}`;
      last.end = cue.end;
    } else {
      out.push({ start: cue.start, end: cue.end, text });
    }
  }
  return out;
}

// Breaks a subtitle into at most two balanced lines.
export function wrapText(text, width = 42) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= width) return [clean];
  const words = clean.split(' ');
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const score = Math.max(a.length, b.length);
    if (!best || score < best.score) best = { score, lines: [a, b] };
  }
  return best ? best.lines : [clean];
}

async function postJson(url, body, headers, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new TranslateError(`translation request failed: ${err.message}`, true);
  }
  if (!res.ok) {
    const transient = res.status === 429 || res.status >= 500;
    const reason = res.status === 456 ? 'DeepL quota used up for this month' : res.status === 403 ? 'translation key rejected' : `HTTP ${res.status}`;
    throw new TranslateError(`translation failed: ${reason}`, transient);
  }
  return res.json();
}

async function deepl(texts, fetchImpl) {
  const host = env.deeplKey.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const data = await postJson(
    `${host}/v2/translate`,
    { text: texts, target_lang: 'NB', split_sentences: 'nonewlines', preserve_formatting: true },
    { authorization: `DeepL-Auth-Key ${env.deeplKey}` },
    fetchImpl
  );
  return (data.translations || []).map((t) => t.text);
}

async function libre(texts, fetchImpl) {
  const body = { q: texts, source: 'auto', target: 'nb', format: 'text' };
  if (env.libreKey) body.api_key = env.libreKey;
  const data = await postJson(`${env.libreUrl.replace(/\/+$/, '')}/translate`, body, {}, fetchImpl);
  const out = data.translatedText;
  return Array.isArray(out) ? out : [out];
}

export async function translateTexts(texts, fetchImpl = fetch) {
  const engine = env.deeplKey ? deepl : env.libreUrl ? libre : null;
  if (!engine) throw new TranslateError('no translator configured');
  const out = [];
  for (let i = 0; i < texts.length; i += 50) {
    const batch = texts.slice(i, i + 50);
    const translated = await engine(batch, fetchImpl);
    if (translated.length !== batch.length) throw new TranslateError('translator returned the wrong number of lines');
    out.push(...translated);
  }
  return out;
}

// Cues in any language → Norwegian cues, ready for cuesToSrt.
export async function translateCues(cues, fetchImpl = fetch) {
  const merged = mergeForTranslation(cues);
  if (!merged.length) return [];
  const translated = await translateTexts(merged.map((c) => c.text), fetchImpl);
  return merged.map((c, i) => ({ start: c.start, end: c.end, lines: wrapText(translated[i] || c.text) }));
}
