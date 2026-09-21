'use strict';

/**
 * Signaling relay.
 *
 * Two roles exist: "sender" (the phone) and "receiver" (the laptop page that
 * plays audio). Messages from one role are forwarded only to the other role,
 * so an SDP offer from the phone always reaches the laptop and never loops
 * back to the phone.
 *
 * Only one sender and one receiver are active at a time. A newer client of the
 * same role replaces the older one (the older one is told with "replaced" and
 * must NOT auto-reconnect).
 *
 * The class only needs socket-like objects with { readyState, send(), close() },
 * which keeps it unit-testable without the `ws` package.
 */

const OPEN = 1; // WebSocket.OPEN
const ROLES = new Set(['sender', 'receiver']);

// Message types that are allowed to be relayed between peers.
const RELAYED = new Set(['offer', 'answer', 'ice-candidate', 'request-offer']);

const other = (role) => (role === 'sender' ? 'receiver' : 'sender');

class Relay {
  constructor(log = () => {}) {
    this.peers = { sender: null, receiver: null };
    this.log = log;
  }

  _send(ws, msg) {
    if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(msg));
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

    if (!ws.role || !RELAYED.has(msg.type)) return;
    this._send(this.peers[other(ws.role)], msg);
  }

  _join(ws, msg) {
    if (ws.role || !ROLES.has(msg.role)) return;
    const role = msg.role;

    const previous = this.peers[role];
    if (previous && previous !== ws) {
      this.log(`${role} replaced by a newer client`);
      this._send(previous, { type: 'replaced' });
      previous.role = null; // so its close handler doesn't clear the new peer
      previous.close(4000, 'replaced');
    }

    ws.role = role;
    this.peers[role] = ws;
    this.log(`${role} joined`);

    const peer = this.peers[other(role)];
    this._send(ws, { type: 'joined', role, peerPresent: !!peer });
    // `connected` lets the other side skip a rebuild if a live call is already running.
    this._send(peer, { type: 'peer-joined', role, connected: !!msg.connected });
  }

  /** Call when a socket closes. */
  leave(ws) {
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

module.exports = { Relay, RELAYED, ROLES };
