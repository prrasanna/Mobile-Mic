'use strict';

/**
 * Signaling relay with Multi-Participant Room State Tracking &
 * Authoritative First-Come-First-Serve Microphone Lock Arbitration.
 */

const OPEN = 1; // WebSocket.OPEN
const ROLES = new Set(['sender', 'receiver']);

// Message types allowed to be relayed or handled
const RELAYED = new Set([
  'offer', 'answer', 'ice-candidate', 'request-offer',
  'join-request', 'join-response', 'leave-room', 'kick',
  'mic_request', 'mic_release', 'room_state_request'
]);

const other = (role) => (role === 'sender' ? 'receiver' : 'sender');

class Room {
  constructor(id) {
    this.id = id;
    this.receiver = null; // Host laptop socket
    this.senders = new Map(); // clientId -> socket
    this.participants = new Map(); // clientId -> Participant info
    this.currentSpeaker = null; // clientId of participant who holds the mic lock
    this.microphoneLocked = false;
  }

  getParticipantList() {
    return Array.from(this.participants.values());
  }

  getSpeakerName() {
    if (!this.currentSpeaker) return null;
    const p = this.participants.get(this.currentSpeaker);
    return p ? (p.name || p.deviceName) : null;
  }
}

class Relay {
  constructor(log = () => {}) {
    this.peers = { sender: null, receiver: null };
    this.rooms = new Map(); // roomId -> Room
    this.log = log;
  }

  _send(ws, msg) {
    if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(msg));
  }

  _broadcast(room, msg, excludeWs = null) {
    if (!room) return;
    const raw = JSON.stringify(msg);
    if (room.receiver && room.receiver !== excludeWs && room.receiver.readyState === OPEN) {
      room.receiver.send(raw);
    }
    for (const ws of room.senders.values()) {
      if (ws !== excludeWs && ws.readyState === OPEN) {
        ws.send(raw);
      }
    }
  }

  _broadcastRoomState(room) {
    if (!room) return;
    this._broadcast(room, {
      type: 'room_state',
      roomId: room.id,
      participants: room.getParticipantList(),
      currentSpeaker: room.currentSpeaker,
      speakerName: room.getSpeakerName(),
      microphoneLocked: room.microphoneLocked,
    });
  }

  _getOrCreateRoom(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Room(roomId));
    }
    return this.rooms.get(roomId);
  }

  /** Handle one raw message from a socket. */
  handle(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') return this._join(ws, msg);

    // Mic Lock Operations
    if (msg.type === 'mic_request') return this._handleMicRequest(ws, msg);
    if (msg.type === 'mic_release') return this._handleMicRelease(ws, msg);
    if (msg.type === 'room_state_request') return this._handleRoomStateRequest(ws, msg);

    if (!ws.role || !RELAYED.has(msg.type)) return;

    // Room-aware message forwarding
    if (ws.roomId && this.rooms.has(ws.roomId)) {
      const room = this.rooms.get(ws.roomId);
      if (ws.role === 'sender') {
        // Forward from mobile sender to host receiver
        if (room.receiver) {
          const payload = { ...msg, clientId: ws.clientId };
          this._send(room.receiver, payload);
        }
      } else if (ws.role === 'receiver') {
        // Forward from host receiver to target sender or all senders
        if (msg.targetClientId || msg.clientId) {
          const targetId = msg.targetClientId || msg.clientId;
          const targetWs = room.senders.get(targetId);
          if (targetWs) this._send(targetWs, msg);
        } else {
          for (const senderWs of room.senders.values()) {
            this._send(senderWs, msg);
          }
        }
      }
      return;
    }

    // Legacy fallback (1:1 sender/receiver)
    this._send(this.peers[other(ws.role)], msg);
  }

  _join(ws, msg) {
    if (ws.role || !ROLES.has(msg.role)) return;
    const role = msg.role;

    // Check if room-based join
    if (msg.roomId) {
      const room = this._getOrCreateRoom(msg.roomId);
      ws.role = role;
      ws.roomId = msg.roomId;
      ws.clientId = msg.clientId || msg.id || (role === 'receiver' ? 'host' : 'user_' + Math.random().toString(36).slice(2, 9));
      ws.displayName = msg.displayName || msg.name || (role === 'receiver' ? 'Host Laptop' : 'Participant');
      ws.deviceName = msg.deviceName || (role === 'receiver' ? 'Laptop (Host)' : 'Mobile Device');

      if (role === 'receiver') {
        if (room.receiver && room.receiver !== ws) {
          this.log(`Host replaced by newer instance in room ${msg.roomId}`);
          this._send(room.receiver, { type: 'replaced' });
          room.receiver.role = null;
          room.receiver.close(4000, 'replaced');
        }
        room.receiver = ws;
        this.peers['receiver'] = ws;

        // Register Host as participant
        room.participants.set(ws.clientId, {
          id: ws.clientId,
          name: ws.displayName,
          deviceName: ws.deviceName,
          role: 'receiver',
          isHost: true,
          status: 'Connected',
          isSpeaking: false,
        });
      } else {
        // Sender (Phone)
        room.senders.set(ws.clientId, ws);
        this.peers['sender'] = ws;

        // Register Phone participant
        room.participants.set(ws.clientId, {
          id: ws.clientId,
          name: ws.displayName,
          deviceName: ws.deviceName,
          role: 'sender',
          isHost: false,
          status: 'Connected',
          isSpeaking: false,
        });

        // Notify room of new participant
        this._broadcast(room, {
          type: 'user_joined',
          participant: room.participants.get(ws.clientId),
        }, ws);
      }

      this.log(`${role} (${ws.displayName || ws.clientId}) joined room ${msg.roomId}`);

      // Notify joining socket
      this._send(ws, {
        type: 'joined',
        role,
        clientId: ws.clientId,
        roomId: room.id,
        peerPresent: !!room.receiver && room.senders.size > 0,
      });

      // Broadcast full room state to all in room
      this._broadcastRoomState(room);
      return;
    }

    // ------------------------------------------------ Legacy 1:1 join flow
    const previous = this.peers[role];
    if (previous && previous !== ws) {
      this.log(`${role} replaced by a newer client`);
      this._send(previous, { type: 'replaced' });
      previous.role = null;
      previous.close(4000, 'replaced');
    }

    ws.role = role;
    this.peers[role] = ws;
    this.log(`${role} joined`);

    const peer = this.peers[other(role)];
    this._send(ws, { type: 'joined', role, peerPresent: !!peer });
    this._send(peer, { type: 'peer-joined', role, connected: !!msg.connected });
  }

  _handleMicRequest(ws, msg) {
    const roomId = ws.roomId || msg.roomId;
    if (!roomId || !this.rooms.has(roomId)) {
      this._send(ws, { type: 'mic_denied', reason: 'Room not found' });
      return;
    }

    const room = this.rooms.get(roomId);
    const clientId = ws.clientId || msg.clientId;

    // ATOMIC FIRST-COME-FIRST-SERVE CHECK:
    // If nobody holds the lock OR this client already holds it, grant permission!
    if (!room.microphoneLocked || room.currentSpeaker === clientId) {
      room.microphoneLocked = true;
      room.currentSpeaker = clientId;

      // Update participant isSpeaking flag
      const p = room.participants.get(clientId);
      if (p) p.isSpeaking = true;

      const speakerName = p ? (p.name || p.deviceName) : (ws.displayName || ws.deviceName || 'Speaker');

      this.log(`Mic lock GRANTED to ${clientId} (${speakerName}) in room ${room.id}`);

      // Respond directly to the winner
      this._send(ws, {
        type: 'mic_granted',
        roomId: room.id,
        speakerId: clientId,
        speakerName,
      });

      // Broadcast updated room state to all participants
      this._broadcastRoomState(room);
    } else {
      // Room is locked by another participant!
      const currentSpeakerName = room.getSpeakerName();
      this.log(`Mic lock DENIED to ${clientId} in room ${room.id} (locked by ${room.currentSpeaker})`);

      this._send(ws, {
        type: 'mic_denied',
        roomId: room.id,
        currentSpeaker: room.currentSpeaker,
        speakerName: currentSpeakerName,
      });
    }
  }

  _handleMicRelease(ws, msg) {
    const roomId = ws.roomId || msg.roomId;
    if (!roomId || !this.rooms.has(roomId)) return;

    const room = this.rooms.get(roomId);
    const clientId = ws.clientId || msg.clientId;

    // Only current speaker can release the lock
    if (room.currentSpeaker === clientId) {
      const prevSpeaker = room.currentSpeaker;
      room.currentSpeaker = null;
      room.microphoneLocked = false;

      const p = room.participants.get(clientId);
      if (p) p.isSpeaking = false;

      this.log(`Mic lock RELEASED by ${clientId} in room ${room.id}`);

      this._broadcast(room, {
        type: 'mic_released',
        previousSpeaker: prevSpeaker,
      });

      this._broadcastRoomState(room);
    }
  }

  _handleRoomStateRequest(ws, msg) {
    const roomId = ws.roomId || msg.roomId;
    if (!roomId || !this.rooms.has(roomId)) return;
    const room = this.rooms.get(roomId);
    this._send(ws, {
      type: 'room_state',
      roomId: room.id,
      participants: room.getParticipantList(),
      currentSpeaker: room.currentSpeaker,
      speakerName: room.getSpeakerName(),
      microphoneLocked: room.microphoneLocked,
    });
  }

  /** Call when a socket closes. */
  leave(ws) {
    if (ws.roomId && this.rooms.has(ws.roomId)) {
      const room = this.rooms.get(ws.roomId);
      const clientId = ws.clientId;

      if (ws.role === 'sender') {
        room.senders.delete(clientId);
        room.participants.delete(clientId);

        this.log(`Sender ${clientId} left room ${room.id}`);

        // If disconnected client was currently speaking, auto-release the mic lock!
        if (room.currentSpeaker === clientId) {
          room.currentSpeaker = null;
          room.microphoneLocked = false;

          this.log(`Current speaker ${clientId} disconnected; auto-releasing lock`);

          this._broadcast(room, {
            type: 'speaker_disconnected',
            participantId: clientId,
          });

          this._broadcast(room, {
            type: 'mic_released',
            previousSpeaker: clientId,
          });
        }

        // Broadcast user disconnect to room
        this._broadcast(room, {
          type: 'user_left',
          participantId: clientId,
        });

        this._broadcast(room, {
          type: 'user_disconnected',
          participantId: clientId,
        });

        this._broadcastRoomState(room);

        if (this.peers['sender'] === ws) {
          this.peers['sender'] = room.senders.size > 0 ? room.senders.values().next().value : null;
        }
      } else if (ws.role === 'receiver') {
        if (room.receiver === ws) {
          room.receiver = null;
          room.participants.delete(clientId);
          this.log(`Host receiver left room ${room.id}`);
          this._broadcast(room, { type: 'peer-left', role: 'receiver' });
          this._broadcastRoomState(room);
          this.peers['receiver'] = null;
        }
      }

      // If room is completely empty, clean it up
      if (!room.receiver && room.senders.size === 0) {
        this.rooms.delete(room.id);
        this.log(`Room ${room.id} cleaned up`);
      }

      ws.role = null;
      ws.roomId = null;
      ws.clientId = null;
      return;
    }

    // Legacy leave
    if (!ws.role) return;
    const role = ws.role;
    if (this.peers[role] === ws) {
      this.peers[role] = null;
      this.log(`${role} left`);
      this._send(this.peers[other(role)], { type: 'peer-left', role });
    }
    ws.role = null;
  }
}

module.exports = { Relay, RELAYED, ROLES, Room };

