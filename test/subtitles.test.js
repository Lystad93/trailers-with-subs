import test from 'node:test';
import assert from 'node:assert/strict';
import { vttToSrt, parseVtt } from '../src/subtitles.js';

test('plain translated VTT becomes SRT', () => {
  const vtt = `WEBVTT
Kind: captions
Language: no

00:00:01.000 --> 00:00:03.500 align:start position:0%
Det finnes en profeti

00:00:04.000 --> 00:00:06.000
om en som skal &amp; komme
`;
  const { srt, count } = vttToSrt(vtt);
  assert.equal(count, 2);
  assert.equal(
    srt,
    `1
00:00:01,000 --> 00:00:03,500
Det finnes en profeti

2
00:00:04,000 --> 00:00:06,000
om en som skal & komme
`
  );
});

test('auto-generated rolling captions are not doubled', () => {
  // The shape YouTube uses for auto-generated captions: word timings, a repeated line,
  // and 10ms transition cues.
  const S = ' '; // YouTube puts a single space on "empty" cue lines
  const vtt = [
    'WEBVTT',
    'Kind: captions',
    'Language: en',
    '',
    '00:00:00.160 --> 00:00:02.869 align:start position:0%',
    S,
    'long<00:00:00.480><c> live</c><00:00:00.800><c> the</c><00:00:01.120><c> fighters</c>',
    '',
    '00:00:02.869 --> 00:00:02.879 align:start position:0%',
    'long live the fighters',
    S,
    '',
    '00:00:02.879 --> 00:00:05.000 align:start position:0%',
    'long live the fighters',
    'the<00:00:03.200><c> spice</c><00:00:03.600><c> must</c><00:00:04.000><c> flow</c>',
    '',
    '00:00:05.000 --> 00:00:05.010 align:start position:0%',
    'the spice must flow',
    S,
    '',
  ].join('\n');
  const cues = parseVtt(vtt);
  assert.equal(cues.length, 4);
  const { srt, count } = vttToSrt(vtt);
  assert.equal(count, 2);
  assert.match(srt, /00:00:00,160 --> 00:00:02,869\nlong live the fighters\n/);
  assert.match(srt, /00:00:02,879 --> 00:00:05,000\nthe spice must flow\n/);
  assert.doesNotMatch(srt, /fighters\nthe spice/);
});

test('overlapping cues are trimmed, duplicates merged', () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
A

00:00:03.000 --> 00:00:05.000
B

00:00:05.100 --> 00:00:06.000
B
`;
  const { srt, count } = vttToSrt(vtt);
  assert.equal(count, 2);
  assert.match(srt, /00:00:01,000 --> 00:00:03,000\nA/);
  assert.match(srt, /00:00:03,000 --> 00:00:06,000\nB/);
});

test('empty or garbage input gives no cues', () => {
  assert.equal(vttToSrt('').count, 0);
  assert.equal(vttToSrt('not a subtitle file').count, 0);
});
