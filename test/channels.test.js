import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailers-channels-'));
process.env.CACHE_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.env.CHANNELS_EXTRA = '@MinKino, UCaaaaaaaaaaaaaaaaaaaaaa, nonsense';

const { filmNameOf, matchesFilm, findChannelTrailers, refreshChannels, setIndexForTests, configuredChannels, indexStatus, DEFAULT_CHANNELS } = await import('../src/channels.js');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Titles as the Norwegian distributors' channels write them.
test('the film name is what is left when the trailer wording is gone', () => {
  const cases = {
    'CoComelon: Filmen | Offisiell trailer (norsk tale)': 'cocomelon filmen',
    'Angry Birds 3 | Ofisiell trailer 2': 'angry birds 3',
    'Street Fighter | Ny ofisiell trailer': 'street fighter',
    'Men in Black: International – Offisiell trailer (norsk tekst)': 'men in black international',
    'Operasjon Argo - Trailer med norsk tekst': 'operasjon argo',
    'trailer YOUR NAME.': 'your name',
    'NOAH - Offisiell trailer m/norsk tekst': 'noah',
    'Trango - Trailer - Premiere 10. oktober 2025': 'trango',
    'Wicked | Ny trailer | På kino nå': 'wicked',
    'Frost 2 | Offisiell trailer | På kino 25. desember': 'frost 2',
    'Blade Runner 2049 - Offisiell trailer': 'blade runner 2049',
  };
  for (const [title, name] of Object.entries(cases)) assert.equal(filmNameOf(title), name, title);
});

test('only real trailers of exactly that film match', () => {
  assert.ok(matchesFilm('Frost 2 | Offisiell trailer | På kino 25. desember', ['Frozen II', 'Frost 2']));
  assert.ok(matchesFilm('UNO (2004) - theatrical trailer', ['Uno']));
  assert.ok(matchesFilm('Affeksjonsverdi | Trailer | Mer Film', ['Sentimental Value', 'Affeksjonsverdi']));
  assert.equal(matchesFilm('Frost 2 | Offisiell trailer', ['Frost', 'Frozen']), false, 'a sequel is another film');
  assert.equal(matchesFilm('Street Fighter | På kino 16. oktober', ['Street Fighter']), false, 'a short spot, not a trailer');
  assert.equal(matchesFilm('Ebenezer | Johnny Depp er Ebenezer Featurette', ['Ebenezer']), false);
  assert.equal(matchesFilm('Wicked: For Good | Offisiell trailer', ['Wicked']), false);
  assert.equal(matchesFilm('Offisiell trailer', ['Trailer']), false);
});

const ts = (date) => Date.parse(date) / 1000;
const video = (id, title, date, duration = 120) => ({ id, title, duration, ts: ts(date) });

test('channel trailers are found, dated and ranked', () => {
  setIndexForTests({
    channels: {
      a: {
        name: 'Disney Norge',
        videos: [
          video('aaaaaaaaaa1', 'Vaiana 2 | Offisiell trailer | Norsk tale', '2024-08-10'),
          video('aaaaaaaaaa2', 'Vaiana 2 | Offisiell trailer | Norsk tekst', '2024-08-10'),
          video('aaaaaaaaaa3', 'Vaiana 2 | Teaser trailer', '2024-05-29'),
          video('aaaaaaaaaa4', 'Vaiana 2 | Offisiell trailer', '2024-09-01', 12),
          video('aaaaaaaaaa5', 'Løvenes Konge | Offisiell trailer', '2019-04-10'),
        ],
      },
      b: { name: 'Filmweb', videos: [video('aaaaaaaaaa2', 'Vaiana 2 - Trailer (norsk tekst)', '2024-08-11')] },
    },
  });
  const vaiana = { title: 'Moana 2', originalTitle: 'Moana 2', norwegianTitle: 'Vaiana 2', date: '2024-11-27', tmdbType: 'movie' };
  assert.deepEqual(findChannelTrailers(vaiana).map((v) => v.id), ['aaaaaaaaaa2', 'aaaaaaaaaa1', 'aaaaaaaaaa3']);
  const family = findChannelTrailers(vaiana, { preferDubbed: true });
  assert.deepEqual(family.map((v) => v.id), ['aaaaaaaaaa1', 'aaaaaaaaaa2', 'aaaaaaaaaa3']);
  assert.equal(family[0].dubbed, true);
  assert.equal(family[0].channel, 'Disney Norge');
  assert.equal(family[1].texted, true);

  // The 2019 remake's trailer is not offered for the 1994 film.
  const lion = (date) => ({ title: 'The Lion King', originalTitle: 'The Lion King', norwegianTitle: 'Løvenes konge', date, tmdbType: 'movie' });
  assert.equal(findChannelTrailers(lion('2019-07-12')).length, 1);
  assert.equal(findChannelTrailers(lion('1994-06-24')).length, 0);
});

test('channel lists are fetched, merged with what is on file, and saved', async () => {
  setIndexForTests({ channels: {} });
  assert.deepEqual(configuredChannels().slice(DEFAULT_CHANNELS.length).map((c) => c.id), ['@MinKino', 'UCaaaaaaaaaaaaaaaaaaaaaa']);
  const asked = [];
  let round = 1;
  const list = async (channel, count) => {
    asked.push(count);
    if (channel.id === '@MinKino') throw new Error('HTTP Error 404: Not Found');
    return { name: channel.name, videos: round === 1 ? [video('bbbbbbbbbb1', 'En film | Trailer', '2025-01-01')] : [video('bbbbbbbbbb2', 'En annen film | Trailer', '2026-01-01')] };
  };
  const first = await refreshChannels({ gapMs: 0, list });
  assert.equal(first.channels, DEFAULT_CHANNELS.length + 1);
  assert.equal(first.videos, DEFAULT_CHANNELS.length + 1);
  assert.ok(asked.every((n) => n === 1500), 'the whole list the first time');

  round = 2;
  asked.length = 0;
  const second = await refreshChannels({ gapMs: 0, list });
  assert.equal(second.videos, 2 * (DEFAULT_CHANNELS.length + 1), 'older videos are kept');
  // The channel that failed the first time is fetched in full; the others only get their newest.
  assert.equal(asked.filter((n) => n === 60).length, DEFAULT_CHANNELS.length + 1);

  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'channels.json'), 'utf8'));
  assert.equal(Object.keys(saved.channels).length, DEFAULT_CHANNELS.length + 1);
  assert.equal(indexStatus().videos, second.videos);
});
