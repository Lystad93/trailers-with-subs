// Per-user settings travel in the manifest URL as base64url JSON, the usual Stremio addon convention.

export const DEFAULTS = Object.freeze({
  tmdb: '', // TMDB API key (v3) or read access token (v4); falls back to the server's TMDB_API_KEY
  no: true, // list Norwegian trailers (dubbed, or Norwegian release)
  sub: true, // list English/original-language trailers with Norwegian subtitles
  maxNo: 2, // at most this many Norwegian trailers
  maxSub: 2, // at most this many subtitled trailers
  subs: 'burn', // burn (burned into the picture, works in every player) | soft (selectable track, no re-encode)
  auto: true, // allow YouTube's auto-translated / auto-generated Norwegian subtitles
  search: 'family', // off | family | all: search YouTube for Norwegian dubs TMDB does not know
  q: 1080, // max height: 720 | 1080 | 1440 | 2160
  codec: 'h264', // h264 (plays everywhere, max 1080p on YouTube) | any (best VP9/AV1, up to 4K)
  first: 'no', // which group comes first: no | sub
  yt: false, // also list plain YouTube entries (Stremio's YouTube player, no added subtitles)
});

const ENUMS = {
  subs: ['burn', 'soft'],
  search: ['off', 'family', 'all'],
  codec: ['h264', 'any'],
  first: ['no', 'sub'],
};
const QUALITIES = [480, 720, 1080, 1440, 2160];

function bool(v, d) {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return d;
}

function int(v, d, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const q = Number(c.q);
  return {
    tmdb: typeof c.tmdb === 'string' ? c.tmdb.trim().slice(0, 400) : '',
    no: bool(c.no, DEFAULTS.no),
    sub: bool(c.sub, DEFAULTS.sub),
    maxNo: int(c.maxNo, DEFAULTS.maxNo, 0, 10),
    maxSub: int(c.maxSub, DEFAULTS.maxSub, 0, 10),
    subs: ENUMS.subs.includes(c.subs) ? c.subs : DEFAULTS.subs,
    auto: bool(c.auto, DEFAULTS.auto),
    search: ENUMS.search.includes(c.search) ? c.search : DEFAULTS.search,
    q: QUALITIES.includes(q) ? q : DEFAULTS.q,
    codec: ENUMS.codec.includes(c.codec) ? c.codec : DEFAULTS.codec,
    first: ENUMS.first.includes(c.first) ? c.first : DEFAULTS.first,
    yt: bool(c.yt, DEFAULTS.yt),
  };
}

export function encodeConfig(config) {
  const c = normalizeConfig(config);
  // Only keep what differs from the defaults so URLs stay short.
  const diff = Object.fromEntries(Object.entries(c).filter(([k, v]) => v !== DEFAULTS[k]));
  return Buffer.from(JSON.stringify(diff)).toString('base64url');
}

export function decodeConfig(segment) {
  if (!segment) return normalizeConfig({});
  let text = segment;
  try {
    text = decodeURIComponent(segment);
  } catch {
    /* keep as is */
  }
  for (const attempt of [() => JSON.parse(Buffer.from(text, 'base64url').toString('utf8')), () => JSON.parse(text)]) {
    try {
      const parsed = attempt();
      if (parsed && typeof parsed === 'object') return normalizeConfig(parsed);
    } catch {
      /* try next */
    }
  }
  return null;
}

// The part of a config that decides how a video is built. It is baked into the play URL so a
// cached file is reused by everyone who asked for the same thing.
// mode: 'no' (Norwegian trailer, kept as is) | 'sub' (add Norwegian subtitles)
export function makeProfile(mode, config) {
  const c = normalizeConfig(config);
  if (mode === 'no') return `no.${c.q}.${c.codec}`;
  return `sub.${c.q}.${c.codec}.${c.subs}.${c.auto ? 'a' : 'm'}`;
}

const PROFILE_RE = /^(?:no\.(\d{3,4})\.(h264|any)|sub\.(\d{3,4})\.(h264|any)\.(burn|soft)\.([am]))$/;

export function parseProfile(profile) {
  const m = PROFILE_RE.exec(String(profile || ''));
  if (!m) return null;
  if (m[1]) {
    const q = Number(m[1]);
    if (!QUALITIES.includes(q)) return null;
    return { mode: 'no', q, codec: m[2] };
  }
  const q = Number(m[3]);
  if (!QUALITIES.includes(q)) return null;
  return { mode: 'sub', q, codec: m[4], subs: m[5], auto: m[6] === 'a' };
}
