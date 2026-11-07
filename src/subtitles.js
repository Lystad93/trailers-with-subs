// Turns YouTube WebVTT (manual, translated or auto-generated) into clean SRT.
// Auto-generated tracks carry word-timing tags and "rolling" cues that repeat the previous line;
// burned in as they are, every line would show twice.

function parseTimestamp(ts) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(ts.trim());
  if (!m) return null;
  const [, h = '0', min, s, ms] = m;
  return ((Number(h) * 60 + Number(min)) * 60 + Number(s)) * 1000 + Number(ms.padEnd(3, '0'));
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lrm;': '', '&rlm;': '' };

function cleanText(text) {
  return text
    .replace(/<[^>]*>/g, '') // <c>, <i>, <00:00:01.000>, <v Speaker> ...
    .replace(/&(?:amp|lt|gt|nbsp|quot|#39|apos|lrm|rlm);/g, (e) => ENTITIES[e])
    .replace(/​/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function parseVtt(vtt) {
  const cues = [];
  const blocks = String(vtt || '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx === -1) continue; // WEBVTT header, STYLE, NOTE, REGION ...
    const [startRaw, rest] = lines[idx].split('-->');
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp((rest || '').trim().split(/\s+/)[0] || '');
    if (start === null || end === null) continue;
    const text = lines
      .slice(idx + 1)
      .map(cleanText)
      .filter(Boolean);
    cues.push({ start, end, lines: text });
  }
  return cues;
}

export function cleanCues(cues) {
  const out = [];
  let prevLines = [];
  for (const cue of cues) {
    if (cue.end - cue.start < 100) {
      // The 10ms "transition" cues of auto-generated tracks.
      continue;
    }
    let lines = cue.lines.slice();
    // Rolling captions: the first line(s) repeat what the previous cue ended with.
    while (lines.length > 1 && prevLines.length && lines[0] === prevLines[prevLines.length - 1]) {
      lines.shift();
    }
    if (!lines.length) continue;
    const last = out[out.length - 1];
    if (last && last.lines.join('\n') === lines.join('\n') && cue.start - last.end < 500) {
      last.end = Math.max(last.end, cue.end);
      continue;
    }
    if (last && cue.start < last.end) last.end = cue.start; // no stacked subtitles
    out.push({ start: cue.start, end: cue.end, lines });
    prevLines = cue.lines;
  }
  return out.filter((c) => c.end > c.start);
}

function srtTime(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function cuesToSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.lines.join('\n')}\n`).join('\n');
}

export function vttToSrt(vtt) {
  const cues = cleanCues(parseVtt(vtt));
  return { srt: cuesToSrt(cues), count: cues.length };
}
