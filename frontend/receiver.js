'use strict';

/**
 * Receiver (laptop).
 * Answers the phone's WebRTC offer and plays the incoming audio through the
 * laptop's default output (the 3.5 mm jack that feeds the amplifier).
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    gate: $('gate'),
    startBtn: $('start-btn'),
    tally: $('tally'),
    tallyWord: $('tally-word'),
    tallyHint: $('tally-hint'),
    conn: $('connection-status'),
    sender: $('sender-status'),
    network: $('network-quality'),
    canvas: $('rx-meter'),
    levelDb: $('level-db'),
    volume: $('volume'),
    volumeOut: $('volume-out'),
    mute: $('mute-btn'),
    tone: $('tone-btn'),
    statRtt: $('stat-rtt'),
    statLoss: $('stat-loss'),
    statJitter: $('stat-jitter'),
    statBuffer: $('stat-buffer'),
    statBitrate: $('stat-bitrate'),
    unlock: $('unlock-btn'),
    error: $('error-message'),
    audio: $('remote-audio'),
  };

  let audioCtx = null;
  let signaling = null;
  let pc = null;
  let currentSid = null;
  let analyser = null;
  let meterSource = null;
  let statsTimer = null;
  let warmupTimer = null;
  let lastStats = null;
  let peerPresent = false;
  let requestTimer = null;
  let receiving = false; // audio above the noise floor right now

  const queue = WM.serialQueue();

  // ------------------------------------------------------------------- UI
  function showError(text) {
    el.error.textContent = text;
    el.error.hidden = !text;
  }

  function setConnState(state) {
    el.conn.textContent = state;
    el.conn.className = 'pill ' + state;
    updateTally();
  }

  function setSender(text, level) {
    el.sender.textContent = text;
    el.sender.className = 'value' + (level ? ' ' + level : '');
    updateTally();
  }

  function updateTally() {
    const connected = pc && pc.connectionState === 'connected';
    el.tally.classList.toggle('live', !!connected && receiving);
    if (!peerPresent) {
      el.tallyWord.textContent = 'Waiting';
      el.tallyHint.textContent = 'No phone connected';
    } else if (!connected) {
      el.tallyWord.textContent = 'Connecting';
      el.tallyHint.textContent = 'Phone found, setting up audio';
    } else if (receiving) {
      el.tallyWord.textContent = 'Receiving';
      el.tallyHint.textContent = 'Audio is playing';
    } else {
      el.tallyWord.textContent = 'Ready';
      el.tallyHint.textContent = 'Phone mic is silent';
    }
  }

  // --------------------------------------------------------------- WebRTC
  function closePc() {
    stopStats();
    clearTimeout(requestTimer);
    requestTimer = null;
    currentSid = null;
    receiving = false;
    if (pc) {
      const old = pc;
      pc = null;
      try {
        old.close();
      } catch {
        /* already closed */
      }
    }
    el.audio.srcObject = null;
    el.network.textContent = '-';
    el.network.className = 'value';
    ['statRtt', 'statLoss', 'statJitter', 'statBuffer', 'statBitrate'].forEach((k) => (el[k].textContent = '-'));
  }

  async function playAudio() {
    try {
      await el.audio.play();
      el.unlock.hidden = true;
    } catch {
      el.unlock.hidden = false; // autoplay blocked: needs one click
    }
  }

  // One analyser + one draw loop for the page's lifetime; only the source is swapped per call.
  function setupMeter() {
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024; // analysis only: the <audio> element does the actual playback
    let holdUntil = 0;
    WM.createMeter(analyser, el.canvas, el.levelDb, (db) => {
      const t = performance.now();
      if (db > -55) holdUntil = t + 600; // hold briefly so the status doesn't flicker between words
      const now = t < holdUntil;
      if (now !== receiving) {
        receiving = now;
        updateTally();
      }
    });
  }

  function attachMeter(stream) {
    if (!audioCtx || !analyser) return;
    if (meterSource) meterSource.disconnect();
    meterSource = audioCtx.createMediaStreamSource(stream);
    meterSource.connect(analyser);
  }

  async function handleOffer(msg) {
    closePc();
    const thisPc = new RTCPeerConnection(WM.RTC_CONFIG);
    pc = thisPc;
    currentSid = msg.sid;
    setConnState('new');

    thisPc.ontrack = (event) => {
      if (pc !== thisPc) return;
      const stream = event.streams[0] || new MediaStream([event.track]);
      el.audio.srcObject = stream;
      playAudio();
      // Keep the playout buffer small for low latency (Chrome 114+).
      if ('jitterBufferTarget' in event.receiver) {
        try {
          event.receiver.jitterBufferTarget = WM.CONFIG.jitterBufferTargetMs;
        } catch {
          /* unsupported value */
        }
      }
      attachMeter(stream);
    };

    thisPc.onicecandidate = (event) => {
      if (event.candidate) signaling.send({ type: 'ice-candidate', sid: msg.sid, candidate: event.candidate });
    };

    thisPc.onconnectionstatechange = () => {
      if (pc !== thisPc) return;
      const state = thisPc.connectionState;
      setConnState(state);
      if (state === 'connected') {
        clearTimeout(requestTimer);
        requestTimer = null;
        showError('');
        startStats();
      } else if (state === 'disconnected' || state === 'failed') {
        stopStats();
        // The phone normally re-offers on its own; ask it to if it hasn't.
        clearTimeout(requestTimer);
        requestTimer = setTimeout(() => {
          if (peerPresent && pc === thisPc && thisPc.connectionState !== 'connected') {
            signaling.send({ type: 'request-offer' });
          }
        }, state === 'failed' ? 500 : WM.CONFIG.reconnectDelayMs + 1000);
      }
    };

    try {
      await thisPc.setRemoteDescription({ type: 'offer', sdp: WM.tuneOpus(msg.sdp) });
      const answer = await thisPc.createAnswer();
      await thisPc.setLocalDescription({ type: 'answer', sdp: WM.tuneOpus(answer.sdp) });
      signaling.send({ type: 'answer', sid: msg.sid, sdp: thisPc.localDescription.sdp });
      setConnState('connecting');
    } catch (err) {
      if (pc !== thisPc) return; // superseded or closed while answering: not an error
      throw err;
    }
  }

  // ------------------------------------------------------- network stats
  function startStats() {
    stopStats();
    pollStats(); // baseline sample
    warmupTimer = setTimeout(pollStats, 800); // first rates appear after ~1 s instead of ~4 s
    statsTimer = setInterval(pollStats, WM.CONFIG.statsIntervalMs);
  }

  function stopStats() {
    clearInterval(statsTimer);
    clearTimeout(warmupTimer);
    statsTimer = null;
    warmupTimer = null;
    lastStats = null;
  }

  async function pollStats() {
    const current = pc;
    if (!current) return;
    try {
      const report = await current.getStats();
      let inbound = null;
      let pair = null;
      report.forEach((r) => {
        if (r.type === 'inbound-rtp' && (r.kind || r.mediaType) === 'audio') inbound = r;
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
      });
      if (!inbound) return;

      const now = {
        t: performance.now(),
        received: inbound.packetsReceived || 0,
        lost: inbound.packetsLost || 0,
        bytes: inbound.bytesReceived || 0,
        jbDelay: inbound.jitterBufferDelay || 0,
        jbCount: inbound.jitterBufferEmittedCount || 0,
      };

      let lossPct = null;
      let kbps = null;
      let bufferMs = null;
      if (lastStats) {
        const dRecv = now.received - lastStats.received;
        const dLost = Math.max(0, now.lost - lastStats.lost);
        if (dRecv + dLost > 0) lossPct = (dLost / (dRecv + dLost)) * 100;
        kbps = ((now.bytes - lastStats.bytes) * 8) / (now.t - lastStats.t); // bits per ms == kbit/s
        const dCount = now.jbCount - lastStats.jbCount;
        if (dCount > 0) bufferMs = ((now.jbDelay - lastStats.jbDelay) / dCount) * 1000;
      }
      lastStats = now;

      const rttMs = pair && typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime * 1000 : null;
      const jitterMs = typeof inbound.jitter === 'number' ? inbound.jitter * 1000 : null;

      if (rttMs !== null) el.statRtt.textContent = Math.round(rttMs) + ' ms';
      if (lossPct !== null) el.statLoss.textContent = lossPct.toFixed(1) + '%';
      if (jitterMs !== null) el.statJitter.textContent = jitterMs.toFixed(1) + ' ms';
      if (bufferMs !== null) el.statBuffer.textContent = Math.round(bufferMs) + ' ms';
      if (kbps !== null) el.statBitrate.textContent = kbps.toFixed(0) + ' kbps';

      const q = WM.quality(rttMs, lossPct);
      el.network.textContent = q.text;
      el.network.className = 'value ' + q.level;
    } catch {
      /* connection closed while polling */
    }
  }

  // ------------------------------------------------------------ signaling
  function onSignalingMessage(msg) {
    switch (msg.type) {
      case 'joined':
        peerPresent = msg.peerPresent;
        setSender(peerPresent ? 'Phone online' : 'Waiting for phone', peerPresent ? 'good' : '');
        break;

      case 'peer-joined':
        peerPresent = true;
        setSender('Phone online', 'good');
        break;

      case 'peer-left':
        peerPresent = false;
        closePc();
        setConnState('new');
        setSender('Phone disconnected', 'warn');
        break;

      case 'offer':
        queue(async () => {
          try {
            await handleOffer(msg);
          } catch (err) {
            console.error(err);
            showError('Could not answer the phone: ' + err.message);
          }
        });
        break;

      case 'ice-candidate':
        queue(async () => {
          if (!pc || msg.sid !== currentSid || !pc.remoteDescription) return;
          try {
            await pc.addIceCandidate(msg.candidate);
          } catch (err) {
            console.warn('ICE candidate rejected:', err);
          }
        });
        break;

      case 'replaced':
        closePc();
        setConnState('closed');
        showError('Another receiver page took over. Close the other one, then reload this page.');
        break;
    }
  }

  // --------------------------------------------------------------- output
  function setupControls() {
    el.volume.addEventListener('input', () => {
      el.audio.volume = el.volume.value / 100;
      el.volumeOut.textContent = el.volume.value + '%';
    });

    el.mute.addEventListener('click', () => {
      el.audio.muted = !el.audio.muted;
      el.mute.textContent = el.audio.muted ? 'UNMUTE OUTPUT' : 'MUTE OUTPUT';
      el.mute.classList.toggle('active', el.audio.muted);
      el.mute.setAttribute('aria-pressed', String(el.audio.muted));
    });

    // One second of 440 Hz at low level: check the AUX cable and amplifier without needing the phone.
    el.tone.addEventListener('click', () => {
      if (!audioCtx) return;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const t = audioCtx.currentTime;
      const peak = 0.2 * (el.audio.muted ? 0 : el.audio.volume);
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(peak, t + 0.05);
      gain.gain.setValueAtTime(peak, t + 0.95);
      gain.gain.linearRampToValueAtTime(0, t + 1.0);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 1.05);
    });

    el.unlock.addEventListener('click', playAudio);
  }

  // ----------------------------------------------------------------- start
  async function start() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    el.gate.hidden = true;
    setupMeter();

    signaling = new WM.Signaling('receiver', {
      isConnected: () => !!pc && pc.connectionState === 'connected',
      onClose: () => {
        peerPresent = false;
        setSender('Signaling offline, retrying...', 'warn');
      },
      onMessage: onSignalingMessage,
    });
    signaling.connect();
  }

  el.startBtn.addEventListener('click', start);
  setupControls();
  updateTally();
})();
