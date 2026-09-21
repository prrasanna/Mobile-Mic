'use strict';

/**
 * Transmitter (phone).
 * Captures the microphone and sends it to the laptop over WebRTC.
 * The phone is always the WebRTC "offerer"; the laptop page answers.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    gate: $('gate'),
    gateError: $('gate-error'),
    startBtn: $('start-btn'),
    tally: $('tally'),
    tallyWord: $('tally-word'),
    tallyHint: $('tally-hint'),
    conn: $('connection-status'),
    receiver: $('receiver-status'),
    network: $('network-quality'),
    permission: $('mic-permission'),
    micToggle: $('mic-toggle'),
    ptt: $('ptt-button'),
    mute: $('mute-btn'),
    reconnect: $('reconnect-btn'),
    canvas: $('level-meter'),
    levelDb: $('level-db'),
    error: $('error-message'),
    wakeNote: $('wake-note'),
  };

  let stream = null;
  let audioTrack = null;
  let audioCtx = null;
  let pc = null;
  let sid = null; // id of the current call; stale ICE/answers are ignored
  let signaling = null;
  let peerPresent = false;
  let reconnectTimer = null;
  let statsTimer = null;
  let wakeLock = null;

  // Mic state. The track is live only when: not muted AND (latched ON OR PTT held).
  let latched = false;
  let pttHeld = false;
  let muted = false;

  // ------------------------------------------------------------------- UI
  function showError(text) {
    el.error.textContent = text;
    el.error.hidden = !text;
  }

  function setConnState(state) {
    el.conn.textContent = state;
    el.conn.className = 'pill ' + state;
  }

  function setReceiver(text, level) {
    el.receiver.textContent = text;
    el.receiver.className = 'value' + (level ? ' ' + level : '');
  }

  function applyMicState() {
    const live = !muted && (latched || pttHeld);
    if (audioTrack) audioTrack.enabled = live;

    el.micToggle.textContent = latched ? 'MIC ON' : 'MIC OFF';
    el.micToggle.classList.toggle('btn-on', latched);
    el.micToggle.classList.toggle('btn-off', !latched);
    el.micToggle.setAttribute('aria-pressed', String(latched));

    el.ptt.classList.toggle('active', pttHeld && !muted);

    el.mute.textContent = muted ? 'UNMUTE' : 'MUTE';
    el.mute.classList.toggle('active', muted);
    el.mute.setAttribute('aria-pressed', String(muted));

    el.tally.classList.toggle('live', live);
    el.tally.classList.toggle('muted', muted);
    el.tallyWord.textContent = live ? 'Live' : muted ? 'Muted' : 'Standby';
    el.tallyHint.textContent = live
      ? pttHeld
        ? 'Push to talk'
        : 'Mic is on'
      : muted
        ? 'Tap Unmute to talk'
        : 'Mic is off';
  }

  // ----------------------------------------------------------- microphone
  async function initMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }

  function describeMicError(err) {
    switch (err.name) {
      case 'InsecureContext':
        return 'This page is not secure, so the browser blocks the microphone. Open it with https:// (not http://).';
      case 'NotAllowedError':
        return 'Microphone permission was denied. Tap the lock icon in the address bar, set Microphone to Allow, then tap Start again.';
      case 'NotFoundError':
        return 'No microphone was found on this device.';
      case 'NotReadableError':
        return 'The microphone is being used by another app. Close it and tap Start again.';
      default:
        return 'Microphone error: ' + err.message;
    }
  }

  // --------------------------------------------------------- level meter
  function setupAudioMeter() {
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser); // deliberately NOT connected to speakers: no local echo
    WM.createMeter(analyser, el.canvas, el.levelDb);
  }

  // ------------------------------------------------------------- WebRTC
  function closePc() {
    stopStats();
    if (pc) {
      const old = pc;
      pc = null; // handlers check `pc !== thisPc`, so the old one goes quiet
      try {
        old.close();
      } catch {
        /* already closed */
      }
    }
  }

  async function limitBitrate(rtpSender) {
    try {
      const params = rtpSender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = WM.CONFIG.opusBitrate;
      await rtpSender.setParameters(params);
    } catch (err) {
      console.warn('Could not set max bitrate:', err);
    }
  }

  async function startCall() {
    if (!stream || !signaling || !signaling.isOpen()) return; // retried when signaling (re)connects
    closePc();

    const thisSid = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
    const thisPc = new RTCPeerConnection(WM.RTC_CONFIG);
    pc = thisPc;
    sid = thisSid;
    setConnState('new');

    const transceiver = thisPc.addTransceiver(audioTrack, { direction: 'sendonly', streams: [stream] });

    thisPc.onconnectionstatechange = () => {
      if (pc !== thisPc) return;
      const state = thisPc.connectionState;
      setConnState(state);
      if (state === 'connected') {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        showError('');
        startStats();
      } else if (state === 'disconnected') {
        stopStats();
        scheduleReconnect(WM.CONFIG.reconnectDelayMs); // may recover by itself; checked before rebuilding
      } else if (state === 'failed') {
        stopStats();
        scheduleReconnect(500);
      }
    };

    thisPc.onicecandidate = (event) => {
      if (event.candidate) signaling.send({ type: 'ice-candidate', sid: thisSid, candidate: event.candidate });
    };

    try {
      const offer = await thisPc.createOffer();
      if (pc !== thisPc) return;
      await thisPc.setLocalDescription({ type: 'offer', sdp: WM.tuneOpus(offer.sdp) });
      signaling.send({ type: 'offer', sid: thisSid, sdp: thisPc.localDescription.sdp });
      limitBitrate(transceiver.sender);
      setConnState('connecting');
    } catch (err) {
      console.error(err);
      showError('Could not start the connection: ' + err.message);
      scheduleReconnect(WM.CONFIG.reconnectDelayMs);
    }
  }

  function scheduleReconnect(delay) {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (pc && pc.connectionState === 'connected') return; // recovered by itself
      if (!peerPresent) return; // nothing to connect to; will start when the laptop joins
      startCall();
    }, delay);
  }

  // ------------------------------------------------------- network stats
  function startStats() {
    stopStats();
    pollStats();
    statsTimer = setInterval(pollStats, WM.CONFIG.statsIntervalMs);
  }

  function stopStats() {
    clearInterval(statsTimer);
    statsTimer = null;
  }

  async function pollStats() {
    const current = pc;
    if (!current) return;
    try {
      const report = await current.getStats();
      let rtt = null;
      let loss = null;
      report.forEach((r) => {
        if (r.type === 'remote-inbound-rtp' && (r.kind || r.mediaType) === 'audio') {
          if (typeof r.roundTripTime === 'number') rtt = r.roundTripTime * 1000;
          if (typeof r.fractionLost === 'number') loss = r.fractionLost * 100;
        }
        if (rtt === null && r.type === 'candidate-pair' && r.nominated && typeof r.currentRoundTripTime === 'number') {
          rtt = r.currentRoundTripTime * 1000;
        }
      });
      const q = WM.quality(rtt, loss);
      const parts = [];
      if (rtt !== null) parts.push(Math.round(rtt) + ' ms');
      if (loss !== null) parts.push(loss.toFixed(1) + '% loss');
      el.network.textContent = q.level === 'good' ? parts.join(', ') || 'Good' : q.text;
      el.network.className = 'value ' + q.level;
    } catch {
      /* connection closed while polling */
    }
  }

  // ------------------------------------------------------------ signaling
  const queue = WM.serialQueue();

  function onSignalingMessage(msg) {
    switch (msg.type) {
      case 'joined':
        peerPresent = msg.peerPresent;
        setReceiver(peerPresent ? 'Laptop online' : 'Waiting for laptop', peerPresent ? 'good' : '');
        // After a signaling blip, keep a healthy call running; otherwise (re)start it.
        if (peerPresent && !(pc && pc.connectionState === 'connected')) queue(startCall);
        break;

      case 'peer-joined':
        peerPresent = true;
        setReceiver('Laptop online', 'good');
        // The laptop page just (re)loaded, unless it says its call is still up.
        if (!(pc && pc.connectionState === 'connected' && msg.connected)) queue(startCall);
        break;

      case 'peer-left':
        peerPresent = false;
        setReceiver('Laptop left, waiting', 'warn');
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        closePc();
        setConnState('new');
        break;

      case 'request-offer':
        if (!(pc && pc.connectionState === 'connected')) queue(startCall);
        break;

      case 'answer':
        queue(async () => {
          if (!pc || msg.sid !== sid || pc.signalingState !== 'have-local-offer') return;
          await pc.setRemoteDescription({ type: 'answer', sdp: WM.tuneOpus(msg.sdp) });
        });
        break;

      case 'ice-candidate':
        queue(async () => {
          if (!pc || msg.sid !== sid || !pc.remoteDescription) return;
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
        setReceiver('-', '');
        showError('Another phone is now connected as the microphone. Tap Reconnect to take over again.');
        break;
    }
  }

  function connectSignaling() {
    signaling = new WM.Signaling('sender', {
      isConnected: () => !!pc && pc.connectionState === 'connected',
      onOpen: () => {},
      onClose: () => {
        peerPresent = false;
        setReceiver('Signaling offline, retrying...', 'warn');
      },
      onMessage: onSignalingMessage,
    });
    signaling.connect();
  }

  // ------------------------------------------------------------ wake lock
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      el.wakeNote.textContent = 'This browser cannot keep the screen on. Turn off screen timeout in Android settings while using the mic.';
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
      el.wakeNote.textContent = 'Screen is kept on. Locking the phone stops the microphone.';
    } catch {
      el.wakeNote.textContent = 'Could not keep the screen on. Turn off screen timeout in Android settings while using the mic.';
    }
  }

  // -------------------------------------------------------------- controls
  function setupControls() {
    el.micToggle.addEventListener('click', () => {
      latched = !latched;
      applyMicState();
    });

    el.mute.addEventListener('click', () => {
      muted = !muted;
      applyMicState();
    });

    el.reconnect.addEventListener('click', () => {
      showError('');
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      signaling.resume(); // reconnects the socket if needed; 'joined' then starts the call
      if (signaling.isOpen()) {
        if (peerPresent) startCall();
        else setReceiver('Waiting for laptop', '');
      }
    });

    // Push-to-talk: touch for the phone, mouse for testing on a desktop.
    const press = () => {
      pttHeld = true;
      applyMicState();
    };
    const release = () => {
      if (!pttHeld) return;
      pttHeld = false;
      applyMicState();
    };
    el.ptt.addEventListener('touchstart', (e) => { e.preventDefault(); press(); }, { passive: false });
    el.ptt.addEventListener('touchend', (e) => { e.preventDefault(); release(); }, { passive: false });
    el.ptt.addEventListener('touchcancel', release);
    el.ptt.addEventListener('mousedown', press);
    el.ptt.addEventListener('mouseup', release);
    el.ptt.addEventListener('mouseleave', release);
    el.ptt.addEventListener('contextmenu', (e) => e.preventDefault()); // long-press menu on Android
    window.addEventListener('blur', release);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        release(); // never leave PTT stuck on if the screen turns off
      } else if (audioTrack) {
        requestWakeLock();
        if (signaling && !signaling.isAlive()) signaling.connect();
      }
    });
  }

  // ----------------------------------------------------------------- start
  async function start() {
    el.gateError.hidden = true;
    el.startBtn.disabled = true;

    // Create the AudioContext inside the tap so the browser lets it run.
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();

    try {
      stream = await initMicrophone();
    } catch (err) {
      el.permission.textContent = err.name === 'NotAllowedError' ? 'Denied' : 'Unavailable';
      el.permission.className = 'value bad';
      el.gateError.textContent = describeMicError(err);
      el.gateError.hidden = false;
      el.startBtn.disabled = false;
      return;
    }

    el.permission.textContent = 'Granted';
    el.permission.className = 'value good';
    audioTrack = stream.getAudioTracks()[0];
    audioTrack.enabled = false; // start silent; the user decides when to go live
    audioTrack.addEventListener('ended', () => {
      showError('The microphone stopped (another app took it, or the screen locked). Tap Start again after reloading this page.');
    });

    if (audioCtx.state === 'suspended') await audioCtx.resume();
    setupAudioMeter();
    applyMicState();
    requestWakeLock();
    connectSignaling();
    el.gate.hidden = true;
  }

  el.startBtn.addEventListener('click', start);
  setupControls();
  applyMicState();
})();
