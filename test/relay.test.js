'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Relay } = require('../server/relay');

function fakeSocket() {
  return {
    readyState: 1,
    role: null,
    sent: [],
    closed: null,
    send(data) { this.sent.push(JSON.parse(data)); },
    close(code, reason) { this.closed = { code, reason }; this.readyState = 3; },
  };
}
const join = (relay, ws, role, extra = {}) => relay.handle(ws, JSON.stringify({ type: 'join', role, ...extra }));

test('offer from sender reaches only the receiver', () => {
  const r = new Relay();
  const phone = fakeSocket();
  const laptop = fakeSocket();
  join(r, phone, 'sender');
  join(r, laptop, 'receiver');
  r.handle(phone, JSON.stringify({ type: 'offer', sid: 'a', sdp: 'x' }));
  assert.deepStrictEqual(laptop.sent.at(-1), { type: 'offer', sid: 'a', sdp: 'x' });
  assert.ok(!phone.sent.some((m) => m.type === 'offer'), 'phone must not get its own offer back');
});

test('answer and ICE flow back to the sender', () => {
  const r = new Relay();
  const phone = fakeSocket();
  const laptop = fakeSocket();
  join(r, phone, 'sender');
  join(r, laptop, 'receiver');
  r.handle(laptop, JSON.stringify({ type: 'answer', sid: 'a', sdp: 'y' }));
  r.handle(laptop, JSON.stringify({ type: 'ice-candidate', sid: 'a', candidate: { candidate: 'c' } }));
  assert.deepStrictEqual(phone.sent.slice(-2).map((m) => m.type), ['answer', 'ice-candidate']);
});

test('join reports whether the other side is already present', () => {
  const r = new Relay();
  const phone = fakeSocket();
  const laptop = fakeSocket();
  join(r, phone, 'sender');
  assert.deepStrictEqual(phone.sent[0], { type: 'joined', role: 'sender', peerPresent: false });
  join(r, laptop, 'receiver', { connected: true });
  assert.deepStrictEqual(laptop.sent[0], { type: 'joined', role: 'receiver', peerPresent: true });
  assert.deepStrictEqual(phone.sent[1], { type: 'peer-joined', role: 'receiver', connected: true });
});

test('peer-left is sent when a client disconnects', () => {
  const r = new Relay();
  const phone = fakeSocket();
  const laptop = fakeSocket();
  join(r, phone, 'sender');
  join(r, laptop, 'receiver');
  r.leave(phone);
  assert.deepStrictEqual(laptop.sent.at(-1), { type: 'peer-left', role: 'sender' });
  assert.strictEqual(r.peers.sender, null);
});

test('a newer client of the same role replaces the older one', () => {
  const r = new Relay();
  const first = fakeSocket();
  const second = fakeSocket();
  const laptop = fakeSocket();
  join(r, laptop, 'receiver');
  join(r, first, 'sender');
  join(r, second, 'sender');
  assert.deepStrictEqual(first.sent.at(-1), { type: 'replaced' });
  assert.strictEqual(first.closed.code, 4000);
  assert.strictEqual(r.peers.sender, second);
  // the old socket closing must not evict the new one
  r.leave(first);
  assert.strictEqual(r.peers.sender, second);
});

test('ignores junk, unknown types, unjoined sockets and bad roles', () => {
  const r = new Relay();
  const phone = fakeSocket();
  const laptop = fakeSocket();
  join(r, laptop, 'receiver');
  r.handle(phone, 'not json');
  r.handle(phone, JSON.stringify({ type: 'offer', sdp: 'x' })); // never joined
  join(r, phone, 'admin'); // invalid role
  join(r, phone, 'sender');
  r.handle(phone, JSON.stringify({ type: 'eval', code: '1' })); // not in the relay whitelist
  assert.ok(!laptop.sent.some((m) => m.type === 'offer' || m.type === 'eval'));
});

test('does not throw when the peer socket is not open', () => {
  const r = new Relay();
  const phone = fakeSocket();
  const laptop = fakeSocket();
  join(r, phone, 'sender');
  join(r, laptop, 'receiver');
  laptop.readyState = 3;
  assert.doesNotThrow(() => r.handle(phone, JSON.stringify({ type: 'offer', sid: 'a', sdp: 'x' })));
});

test('join-request and join-response are relayed between sender and receiver', () => {
  const r = new Relay();
  const phone = fakeSocket();
  const laptop = fakeSocket();
  join(r, phone, 'sender');
  join(r, laptop, 'receiver');

  // Phone requests to join meeting room
  r.handle(phone, JSON.stringify({ type: 'join-request', roomId: 'MIC-4821', deviceName: 'Android Phone' }));
  assert.deepStrictEqual(laptop.sent.at(-1), {
    type: 'join-request',
    roomId: 'MIC-4821',
    deviceName: 'Android Phone',
  });

  // Laptop approves join request
  r.handle(laptop, JSON.stringify({ type: 'join-response', approved: true, roomId: 'MIC-4821' }));
  assert.deepStrictEqual(phone.sent.at(-1), {
    type: 'join-response',
    approved: true,
    roomId: 'MIC-4821',
  });
});

