'use strict';

/**
 * Shared helpers for the transmitter (phone) and receiver (laptop) pages.
 * Loaded as a classic script; everything hangs off the global `WM`.
 * Also loadable from Node (module.exports) so it can be unit-tested.
 */
const WM = (() => {
  const CONFIG = {
    opusBitrate: 32000, // bits/s. Spec range: 16-32 kbps mono voice.
    jitterBufferTargetMs: 50, // receiver playout buffer; lower = less latency, more glitches on bad Wi-Fi
    reconnectDelayMs: 2000, // signaling + WebRTC retry delay
    statsIntervalMs: 2000,
    warnRttMs: 150,
    warnLossPct: 5,
  };

  // LAN only: no STUN/TURN. Host candidates are enough on one subnet.
  const RTC_CONFIG = { iceServers: [] };

  /** WebSocket URL on the same host/port that served the page. */
  function wsUrl() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}/ws`;
  }

  /**
   * Tune the Opus line of an SDP for mono speech at a fixed bitrate with
   * in-band FEC (survives small Wi-Fi losses) and no DTX (no clipped word starts).
   */
  function tuneOpus(sdp, bitrate = CONFIG.opusBitrate) {
    const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
    const lines = sdp.split(eol);
    const rtpmapIdx = lines.findIndex((l) => /^a=rtpmap:\d+ opus\/48000/i.test(l));
    if (rtpmapIdx === -1) return sdp;

    const pt = lines[rtpmapIdx].match(/^a=rtpmap:(\d+)/)[1];
    const prefix = `a=fmtp:${pt} `;
    const fmtpIdx = lines.findIndex((l) => l.startsWith(prefix));

    const params = new Map();
    if (fmtpIdx !== -1) {
      lines[fmtpIdx]
        .slice(prefix.length)
        .split(';')
        .forEach((kv) => {
          const [k, v] = kv.trim().split('=');
          if (k) params.set(k, v);
        });
    }
    const wanted = {
      stereo: '0',
      'sprop-stereo': '0',
      useinbandfec: '1',
      usedtx: '0',
      maxaveragebitrate: String(bitrate),
      maxplaybackrate: '48000',
    };
    Object.entries(wanted).forEach(([k, v]) => params.set(k, v));

    const fmtp = prefix + [...params].map(([k, v]) => (v === undefined ? k : `${k}=${v}`)).join(';');
    if (fmtpIdx !== -1) lines[fmtpIdx] = fmtp;
    else lines.splice(rtpmapIdx + 1, 0, fmtp);
    return lines.join(eol);
  }

  /** Turn RTT (ms) and packet loss (%) into a level + short message. */
  function quality(rttMs, lossPct) {
    const problems = [];
    if (lossPct != null && lossPct >= CONFIG.warnLossPct) problems.push(`packet loss ${lossPct.toFixed(1)}%`);
    if (rttMs != null && rttMs >= CONFIG.warnRttMs) problems.push(`high delay (RTT ${Math.round(rttMs)} ms)`);
    if (!problems.length) return { level: 'good', text: 'Good' };
    const bad = (lossPct != null && lossPct >= 10) || (rttMs != null && rttMs >= 300);
    return { level: bad ? 'bad' : 'warn', text: 'Weak signal: ' + problems.join(', ') };
  }

  /** Run async jobs one after another so signaling messages are handled in order. */
  function serialQueue() {
    let chain = Promise.resolve();
    return (job) => {
      chain = chain.then(job).catch((err) => console.error('[signaling job]', err));
      return chain;
    };
  }

  /**
   * WebSocket signaling client with auto-reconnect (2 s).
   * handlers: onOpen, onClose, onMessage(msg), isConnected() -> bool
   */
  class Signaling {
    constructor(role, handlers) {
      this.role = role;
      this.handlers = handlers || {};
      this.ws = null;
      this.stopped = false; // true after "replaced": don't fight the newer client
      this.timer = null;
    }

    connect() {
      if (this.stopped) return;
      clearTimeout(this.timer);
      const ws = new WebSocket(wsUrl());
      this.ws = ws;

      ws.onopen = () => {
        const connected = !!(this.handlers.isConnected && this.handlers.isConnected());
        this.send({ type: 'join', role: this.role, connected });
        if (this.handlers.onOpen) this.handlers.onOpen();
      };
      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === 'replaced') this.stopped = true;
        if (this.handlers.onMessage) this.handlers.onMessage(msg);
      };
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        if (this.handlers.onClose) this.handlers.onClose();
        if (!this.stopped) this.timer = setTimeout(() => this.connect(), CONFIG.reconnectDelayMs);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      };
    }

    isOpen() {
      return !!this.ws && this.ws.readyState === 1;
    }

    isAlive() {
      return !!this.ws && this.ws.readyState <= 1; // CONNECTING or OPEN
    }

    send(msg) {
      if (!this.isOpen()) return false;
      this.ws.send(JSON.stringify(msg));
      return true;
    }

    /** User pressed "Reconnect": clear the "replaced" flag and reconnect now if needed. */
    resume() {
      this.stopped = false;
      if (!this.isAlive()) this.connect();
    }
  }

  /**
   * Draw a segmented level meter on a canvas from a Web Audio AnalyserNode.
   * Green = normal, yellow = loud, red = near clipping (plus a CLIP flag).
   * Level is RMS in dBFS mapped from -60..0; the peak sample drives clip detection.
   * The label and onLevel(db) are updated ~7x/second with the loudest reading in that window
   * (floor -100 dBFS), so short sounds are not missed.
   */
  function createMeter(analyser, canvas, dbLabel, onLevel) {
    const samples = new Float32Array(analyser.fftSize);
    const ctx = canvas.getContext('2d');
    let shown = 0;
    let clipUntil = 0;
    let lastText = 0;
    let windowMaxDb = -100; // loudest reading since the last label/callback update

    function fitCanvas() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (w && h && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
      }
    }

    function draw(now) {
      requestAnimationFrame(draw); // ~60 fps
      fitCanvas();

      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i];
        sum += v * v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sum / samples.length);
      const db = 20 * Math.log10(Math.max(rms, 1e-5));
      const level = Math.min(1, Math.max(0, (db + 60) / 60));
      shown = Math.max(level, shown * 0.92); // fast attack, smooth release
      if (peak >= 0.99) clipUntil = now + 800;
      if (db > windowMaxDb) windowMaxDb = db;

      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      const seg = Math.max(4, Math.round(H / 7));
      const gap = Math.max(2, Math.round(seg / 3));
      const count = Math.floor(W / (seg + gap));
      const lit = Math.round(shown * count);
      for (let i = 0; i < count; i++) {
        const pos = i / count;
        const color = pos > 0.92 ? '#ff4d4f' : pos > 0.7 ? '#ffc53d' : '#22c55e';
        ctx.fillStyle = i < lit ? color : '#2b353f';
        ctx.fillRect(i * (seg + gap), 0, seg, H);
      }
      if (now < clipUntil) {
        ctx.fillStyle = '#ff4d4f';
        ctx.font = `700 ${Math.round(H * 0.4)}px system-ui, sans-serif`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText('CLIP', W - 10, H / 2);
      }

      if (now - lastText > 150) {
        lastText = now;
        if (dbLabel) dbLabel.textContent = windowMaxDb <= -60 ? 'silent' : Math.round(windowMaxDb) + ' dBFS';
        if (onLevel) onLevel(windowMaxDb);
        windowMaxDb = -100;
      }
    }
    requestAnimationFrame(draw);
  }

  return { CONFIG, RTC_CONFIG, wsUrl, tuneOpus, quality, serialQueue, Signaling, createMeter };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WM;
