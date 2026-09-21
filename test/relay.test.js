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

test('multi-participant room tracking and atomic microphone lock', () => {
  const r = new Relay();
  const laptop = fakeSocket();
  const phoneA = fakeSocket();
  const phoneB = fakeSocket();
  const roomId = 'MIC-9999';

  // 1. Laptop hosts Room
  r.handle(laptop, JSON.stringify({
    type: 'join',
    role: 'receiver',
    roomId,
    clientId: 'host_1',
    displayName: 'Host Laptop',
    deviceName: 'Laptop (Host)',
  }));

  assert.strictEqual(r.rooms.get(roomId).participants.size, 1);

  // 2. Phone A joins Room
  r.handle(phoneA, JSON.stringify({
    type: 'join',
    role: 'sender',
    roomId,
    clientId: 'phone_a',
    displayName: 'Android Phone',
    deviceName: 'Android',
  }));

  // 3. Phone B joins Room
  r.handle(phoneB, JSON.stringify({
    type: 'join',
    role: 'sender',
    roomId,
    clientId: 'phone_b',
    displayName: 'iPhone 15',
    deviceName: 'iPhone',
  }));

  // Both phones must remain connected without replacing each other
  assert.strictEqual(r.rooms.get(roomId).senders.size, 2);
  assert.strictEqual(r.rooms.get(roomId).participants.size, 3); // Host + Phone A + Phone B

  const lastRoomState = laptop.sent.filter((m) => m.type === 'room_state').at(-1);
  assert.strictEqual(lastRoomState.participants.length, 3);
  assert.strictEqual(lastRoomState.currentSpeaker, null);
  assert.strictEqual(lastRoomState.microphoneLocked, false);

  // 4. Phone A requests microphone
  r.handle(phoneA, JSON.stringify({ type: 'mic_request', roomId, clientId: 'phone_a' }));
  const phoneAGrant = phoneA.sent.filter((m) => m.type === 'mic_granted').at(-1);
  assert.ok(phoneAGrant, 'Phone A must receive mic_granted');
  assert.strictEqual(phoneAGrant.speakerId, 'phone_a');
  assert.strictEqual(r.rooms.get(roomId).microphoneLocked, true);
  assert.strictEqual(r.rooms.get(roomId).currentSpeaker, 'phone_a');

  // 5. Phone B requests microphone while Phone A is speaking -> DENIED!
  r.handle(phoneB, JSON.stringify({ type: 'mic_request', roomId, clientId: 'phone_b' }));
  const phoneBDeny = phoneB.sent.filter((m) => m.type === 'mic_denied').at(-1);
  assert.ok(phoneBDeny, 'Phone B must receive mic_denied');
  assert.strictEqual(phoneBDeny.currentSpeaker, 'phone_a');

  // 6. Phone A releases microphone
  r.handle(phoneA, JSON.stringify({ type: 'mic_release', roomId, clientId: 'phone_a' }));
  assert.strictEqual(r.rooms.get(roomId).microphoneLocked, false);
  assert.strictEqual(r.rooms.get(roomId).currentSpeaker, null);

  const phoneBReleased = phoneB.sent.filter((m) => m.type === 'mic_released').at(-1);
  assert.ok(phoneBReleased, 'Phone B must receive mic_released notification');

  // 7. Phone B can now request and win the lock
  r.handle(phoneB, JSON.stringify({ type: 'mic_request', roomId, clientId: 'phone_b' }));
  const phoneBGrant = phoneB.sent.filter((m) => m.type === 'mic_granted').at(-1);
  assert.ok(phoneBGrant, 'Phone B must now receive mic_granted');
  assert.strictEqual(r.rooms.get(roomId).currentSpeaker, 'phone_b');

  // 8. Phone B disconnects while speaking -> auto-release lock & update participants
  r.leave(phoneB);
  assert.strictEqual(r.rooms.get(roomId).microphoneLocked, false);
  assert.strictEqual(r.rooms.get(roomId).currentSpeaker, null);
  assert.strictEqual(r.rooms.get(roomId).senders.size, 1);
  assert.strictEqual(r.rooms.get(roomId).participants.size, 2); // Host + Phone A

  const speakerDisconn = phoneA.sent.filter((m) => m.type === 'speaker_disconnected').at(-1);
  assert.ok(speakerDisconn, 'Phone A must receive speaker_disconnected');
  assert.strictEqual(speakerDisconn.participantId, 'phone_b');
});


