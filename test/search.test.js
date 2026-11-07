// YouTube search throttling, with a fake yt-dlp standing in for the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailers-search-'));
const fake = path.join(tmp, 'yt-dlp');
const mode = path.join(tmp, 'mode');
fs.writeFileSync(
  fake,
  `#!/bin/sh
if [ "$(cat "${mode}")" = "bot" ]; then
  echo "ERROR: [youtube] abc: Sign in to confirm you’re not a bot. This helps protect our community." >&2
  exit 1
fi
sleep 0.2
echo '{"entries":[{"id":"abcdefghijk","title":"Frost 2 trailer norsk tale","duration":90}]}'
`,
  { mode: 0o755 }
);
fs.writeFileSync(mode, 'ok');
process.env.YTDLP_PATH = fake;
process.env.YTDLP_JS_RUNTIME = '';
process.env.SEARCH_QUEUE_MAX = '2';
process.env.LOG_LEVEL = 'error';

const { searchYoutube, SearchSkipped } = await import('../src/youtube.js');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('only a few searches wait in line; the rest are skipped, not cached', async () => {
  const results = await Promise.allSettled(['a', 'b', 'c', 'd'].map((q) => searchYoutube(q, 1)));
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'rejected', 'rejected']);
  assert.ok(results[2].reason instanceof SearchSkipped);
  assert.equal(results[0].value[0].id, 'abcdefghijk');
  // A skipped search is tried for real next time.
  const again = await searchYoutube('c', 1);
  assert.equal(again[0].id, 'abcdefghijk');
});

test('a bot check pauses all searches', async () => {
  fs.writeFileSync(mode, 'bot');
  await assert.rejects(searchYoutube('e', 1), SearchSkipped);
  fs.writeFileSync(mode, 'ok');
  await assert.rejects(searchYoutube('f', 1), /paused after a bot check/);
});
