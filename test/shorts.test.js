import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailers-shorts-'));
process.env.CACHE_DIR = tmp;
process.env.LOG_LEVEL = 'error';
const { findShorts, noteShort, resetShortsForTests } = await import('../src/shorts.js');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('YouTube says which videos are Shorts; answers are kept', async () => {
  resetShortsForTests();
  const asked = [];
  const fetchImpl = async (url, opts) => {
    const id = String(url).split('/').pop();
    asked.push(id);
    assert.equal(opts.redirect, 'manual');
    if (id === 'slowslowslo') await new Promise((r) => setTimeout(r, 900));
    if (id.startsWith('short')) return { status: 200, headers: new Headers() };
    return { status: 303, headers: new Headers({ location: `https://www.youtube.com/watch?v=${id}` }) };
  };
  const first = await findShorts(['short000001', 'normal00001', 'slowslowslo'], { fetchImpl, budgetMs: 500 });
  assert.deepEqual([...first], [['short000001', true], ['normal00001', false], ['slowslowslo', null]]);
  await new Promise((r) => setTimeout(r, 700));
  const second = await findShorts(['short000001', 'normal00001', 'slowslowslo'], { fetchImpl, budgetMs: 500 });
  assert.equal(second.get('slowslowslo'), false, 'the slow answer arrived in the background');
  assert.equal(asked.length, 3, 'nothing is asked twice');

  // A video that turned out upright when it was played.
  noteShort('played00001');
  assert.equal((await findShorts(['played00001'], { fetchImpl })).get('played00001'), true);
});

test('a consent page or a block is no answer, and stops the asking for a while', async () => {
  resetShortsForTests();
  let asked = 0;
  const fetchImpl = async () => {
    asked++;
    return { status: 302, headers: new Headers({ location: 'https://consent.youtube.com/m?continue=x' }) };
  };
  assert.equal((await findShorts(['aaaaaaaaaaa'], { fetchImpl })).get('aaaaaaaaaaa'), null);
  assert.equal((await findShorts(['bbbbbbbbbbb'], { fetchImpl })).get('bbbbbbbbbbb'), null);
  assert.equal(asked, 1);
});
