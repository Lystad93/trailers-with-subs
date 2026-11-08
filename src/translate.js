// Translates subtitles to Norwegian Bokmål ourselves, with Gemini or a LibreTranslate server.
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
  if (env.geminiKey) return `Gemini (${env.geminiModel})`;
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
    let detail = '';
    try {
      detail = (await res.json())?.error?.message || '';
    } catch {
      /* no body */
    }
    const reason = res.status === 403 || res.status === 401 ? 'translation key rejected' : `HTTP ${res.status}`;
    throw new TranslateError(`translation failed: ${reason}${detail ? ` (${detail.slice(0, 200)})` : ''}`, transient);
  }
  return res.json();
}

const GEMINI_INSTRUCTIONS = [
  'You translate film and TV trailer subtitles into Norwegian Bokmål (nb).',
  'You get a JSON array of subtitle lines in order. Return a JSON array with exactly the same number of strings,',
  'each the translation of the line at the same position. Never merge, split, drop or reorder lines.',
  'Write natural, idiomatic Bokmål as a professional subtitler would: short, readable, no explanations.',
  'Keep names, titles and brands as they are unless they have an established Norwegian form.',
  'If a line is already Norwegian, or is only a sound or music cue, return it unchanged.',
].join(' ');

async function gemini(texts, fetchImpl, context) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.geminiModel)}:generateContent`;
  const prompt = (context ? `Trailer: ${context}\n` : '') + `Lines (${texts.length}):\n${JSON.stringify(texts)}`;
  const body = {
    systemInstruction: { parts: [{ text: GEMINI_INSTRUCTIONS }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: { type: 'ARRAY', items: { type: 'STRING' } },
    },
  };
  // A model sometimes returns the wrong number of lines: ask once more before giving up.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const data = await postJson(url, body, { 'x-goog-api-key': env.geminiKey }, fetchImpl);
    const candidate = data?.candidates?.[0];
    const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('');
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (Array.isArray(parsed) && parsed.length === texts.length && parsed.every((t) => typeof t === 'string')) return parsed;
    if (attempt === 2) {
      const why = candidate?.finishReason && candidate.finishReason !== 'STOP' ? ` (finish reason ${candidate.finishReason})` : '';
      throw new TranslateError(`Gemini did not return ${texts.length} translated lines${why}`);
    }
  }
  return null;
}

async function libre(texts, fetchImpl) {
  const body = { q: texts, source: 'auto', target: 'nb', format: 'text' };
  if (env.libreKey) body.api_key = env.libreKey;
  const data = await postJson(`${env.libreUrl.replace(/\/+$/, '')}/translate`, body, {}, fetchImpl);
  const out = data.translatedText;
  return Array.isArray(out) ? out : [out];
}

export async function translateTexts(texts, fetchImpl = fetch, context = '') {
  const engine = env.geminiKey ? gemini : env.libreUrl ? libre : null;
  if (!engine) throw new TranslateError('no translator configured');
  // A trailer is a few dozen lines: one request for Gemini keeps the whole context together.
  const size = engine === gemini ? 150 : 50;
  const out = [];
  for (let i = 0; i < texts.length; i += size) {
    const batch = texts.slice(i, i + size);
    const translated = await engine(batch, fetchImpl, context);
    if (translated.length !== batch.length) throw new TranslateError('translator returned the wrong number of lines');
    out.push(...translated);
  }
  return out;
}

// Cues in any language → Norwegian cues, ready for cuesToSrt.
export async function translateCues(cues, fetchImpl = fetch, context = '') {
  const merged = mergeForTranslation(cues);
  if (!merged.length) return [];
  const translated = await translateTexts(merged.map((c) => c.text), fetchImpl, context);
  return merged.map((c, i) => ({ start: c.start, end: c.end, lines: wrapText(translated[i] || c.text) }));
}
