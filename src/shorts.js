import fsp from 'node:fs/promises';
import path from 'node:path';
import { env, log, logThrottled } from './env.js';
import { createLimiter } from './tmdb.js';

// Which YouTube videos are Shorts (upright, made for phones). TMDB lists them among a film's
// trailers, and on a TV they are a narrow strip, usually without captions.
//
// youtube.com/shorts/<id> answers 200 for a Short and redirects to /watch for any other video.
// The answer never changes, so it is kept on disk.

const file = () => path.join(env.cacheDir, 'shorts.json');
const known = new Map(); // id → true | false
const pending = new Map(); // id → Promise<true | false | null>
const limiter = createLimiter({ concurrency: 4, perSecond: 8 });
let loaded = null;
let saveTimer = null;
let pausedUntil = 0;

function load() {
  loaded ||= fsp
    .readFile(file(), 'utf8')
    .then((text) => {
      for (const [id, short] of Object.entries(JSON.parse(text))) if (!known.has(id)) known.set(id, Boolean(short));
    })
    .catch(() => {});
  return loaded;
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      // Oldest answers go first when the list gets long.
      const entries = [...known].slice(-50000).map(([id, short]) => [id, short ? 1 : 0]);
      await fsp.mkdir(env.cacheDir, { recursive: true });
      await fsp.writeFile(`${file()}.tmp`, JSON.stringify(Object.fromEntries(entries)));
      await fsp.rename(`${file()}.tmp`, file());
    } catch (err) {
      log.warn(`could not save the list of Shorts: ${err.message}`);
    }
  }, 5000);
  saveTimer.unref?.();
}

export function noteShort(id, short = true) {
  if (known.get(id) === short) return;
  known.set(id, short);
  save();
}

async function ask(id, fetchImpl) {
  if (Date.now() < pausedUntil) return null;
  try {
    const res = await limiter.run(() =>
      fetchImpl(`https://www.youtube.com/shorts/${id}`, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { cookie: 'SOCS=CAI', 'accept-language': 'en' },
        signal: AbortSignal.timeout(5000),
      })
    );
    if (res.status === 200) return true;
    const to = res.headers?.get?.('location') || '';
    if (res.status >= 300 && res.status < 400 && /\/watch\?/.test(to)) return false;
    // A consent page, a rate limit, a block: no answer. Stop asking for a while.
    pausedUntil = Date.now() + 10 * 60 * 1000;
    logThrottled('shorts-check', 60 * 60 * 1000, 'warn', `YouTube did not say whether ${id} is a Short (HTTP ${res.status}${to ? ` → ${to.slice(0, 60)}` : ''}); not asking for 10 minutes. Shorts are still recognised once they have been played.`);
    return null;
  } catch (err) {
    log.debug(`Shorts check for ${id} failed: ${err.message}`);
    return null;
  }
}

function check(id, fetchImpl) {
  let task = pending.get(id);
  if (!task) {
    task = ask(id, fetchImpl)
      .then((short) => {
        if (short !== null) noteShort(id, short);
        return short;
      })
      .finally(() => pending.delete(id));
    pending.set(id, task);
  }
  return task;
}

/**
 * Says which of these videos are Shorts: Map id → true | false | null (not known yet).
 * Waits at most budgetMs; checks that take longer finish in the background for next time.
 */
export async function findShorts(ids, { budgetMs = 2000, fetchImpl = fetch } = {}) {
  await load();
  // Switched off: only what playing a video has shown (undefined = not asked).
  if (process.env.SHORTS_CHECK === '0' && fetchImpl === fetch) return new Map(ids.map((id) => [id, known.get(id)]));
  const out = new Map(ids.map((id) => [id, known.has(id) ? known.get(id) : null]));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    const all = Promise.all(unknown.map((id) => check(id, fetchImpl).then((short) => out.set(id, short))));
    let timer;
    await Promise.race([all, new Promise((r) => (timer = setTimeout(r, budgetMs)))]);
    clearTimeout(timer);
  }
  return out;
}

export function resetShortsForTests() {
  known.clear();
  pending.clear();
  pausedUntil = 0;
  loaded = Promise.resolve();
}
