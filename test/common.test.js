'use strict';
const test = require('node:test');
const assert = require('node:assert');
const WM = require('../frontend/common.js');

const SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=rtpmap:9 G722/8000',
  '',
].join('\r\n');

test('tuneOpus merges parameters into the existing Opus fmtp line', () => {
  const out = WM.tuneOpus(SDP, 24000);
  const line = out.split('\r\n').find((l) => l.startsWith('a=fmtp:111'));
  assert.match(line, /minptime=10/);
  assert.match(line, /useinbandfec=1/);
  assert.match(line, /usedtx=0/);
  assert.match(line, /stereo=0/);
  assert.match(line, /maxaveragebitrate=24000/);
  assert.strictEqual(out.split('\r\n').filter((l) => l.startsWith('a=fmtp:111')).length, 1);
});

test('tuneOpus adds an fmtp line when none exists', () => {
  const noFmtp = SDP.replace('a=fmtp:111 minptime=10;useinbandfec=1\r\n', '');
  const lines = WM.tuneOpus(noFmtp).split('\r\n');
  const i = lines.findIndex((l) => l.startsWith('a=rtpmap:111'));
  assert.match(lines[i + 1], /^a=fmtp:111 .*maxaveragebitrate=32000/);
});

test('tuneOpus leaves SDP without Opus untouched and keeps LF line endings', () => {
  const plain = 'v=0\nm=audio 9 RTP/AVP 8\na=rtpmap:8 PCMA/8000\n';
  assert.strictEqual(WM.tuneOpus(plain), plain);
  const lf = SDP.replace(/\r\n/g, '\n');
  assert.ok(!WM.tuneOpus(lf).includes('\r'));
});

test('quality flags loss and delay', () => {
  assert.strictEqual(WM.quality(10, 0).level, 'good');
  assert.strictEqual(WM.quality(200, 0).level, 'warn');
  assert.strictEqual(WM.quality(10, 6).level, 'warn');
  assert.strictEqual(WM.quality(400, 0).level, 'bad');
  assert.strictEqual(WM.quality(10, 12).level, 'bad');
  assert.strictEqual(WM.quality(null, null).level, 'good');
});

test('serialQueue runs jobs in order even when they are async', async () => {
  const q = WM.serialQueue();
  const order = [];
  q(async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1); });
  q(async () => { order.push(2); });
  await q(async () => { order.push(3); });
  assert.deepStrictEqual(order, [1, 2, 3]);
});

test('serialQueue keeps going after a job throws', async () => {
  const q = WM.serialQueue();
  const orig = console.error;
  console.error = () => {};
  let ran = false;
  q(async () => { throw new Error('boom'); });
  await q(async () => { ran = true; });
  console.error = orig;
  assert.ok(ran);
});
