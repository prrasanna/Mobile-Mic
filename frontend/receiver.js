'use strict';

/**
 * Receiver (Host Laptop).
 * Provides Meeting Host & Join Room flow with QR Code generation,
 * join approval (Accept / Reject), and live WebRTC audio reception.
 */
(() => {
  const $ = (id) => document.getElementById(id);

  const el = {
    // Views
    viewWelcome: $('view-welcome'),
    viewLobby: $('view-lobby'),
    viewConsole: $('view-console'),

    // Top Header
    topSubtitle: $('top-subtitle'),
    hostNetworkBadge: $('host-network-badge'),
    hostNetworkStatus: $('host-network-status'),

    // Landing Model Inputs & Buttons
    inputHostRoomName: $('input-host-room-name'),
    btnLaunchHostRoom: $('btn-launch-host-room'),
    inputJoinDisplayName: $('input-join-display-name'),
    inputJoinMeetingId: $('input-join-meeting-id'),
    btnEnterJoinRoom: $('btn-enter-join-room'),

    // Lobby Screen
    lobbyQrCanvas: $('lobby-qr-canvas'),
    lobbyRoomCode: $('lobby-room-code'),
    btnCopyCode: $('btn-copy-code'),
    btnCopyLink: $('btn-copy-link'),
    lobbyDeviceStatusBadge: $('lobby-device-status-badge'),
    lobbyDeviceStatusText: $('lobby-device-status-text'),
    lobbyEmptyState: $('lobby-empty-state'),
    metaRoomId: $('meta-room-id'),
    btnLeaveLobby: $('btn-leave-lobby'),

    // Slide-in Join Request Modal
    joinRequestToast: $('join-request-toast'),
    requestDeviceDesc: $('request-device-desc'),
    btnAcceptRequest: $('btn-accept-request'),
    btnRejectRequest: $('btn-reject-request'),

    // Console Screen
    consoleDeviceName: $('console-device-name'),
    consoleDeviceSub: $('console-device-sub'),
    consoleDeviceAvatar: $('console-device-avatar'),
    consoleAudioStateBadge: $('console-audio-state-badge'),
    consoleAudioStateText: $('console-audio-state-text'),
    btnShowQrAgain: $('btn-show-qr-again'),
    btnEndSession: $('btn-end-session'),
    hostWaveformCanvas: $('host-waveform-canvas'),
    rxMeter: $('rx-meter'),
    levelDb: $('level-db'),

    // Stats
    statRtt: $('stat-rtt'),
    statLoss: $('stat-loss'),
    statJitter: $('stat-jitter'),
    statBitrate: $('stat-bitrate'),
    statBuffer: $('stat-buffer'),
    connStatus: $('connection-status'),

    // Audio Output Controls
    volume: $('volume'),
    volumeOut: $('volume-out'),
    muteBtn: $('mute-btn'),
    toneBtn: $('tone-btn'),
    unlockBtn: $('unlock-btn'),
    audio: $('remote-audio'),
    error: $('error-message'),
  };

  // State
  let currentRoomId = WM.generateRoomId();
  let currentRoomName = 'Main Hall Audio';
  let hostLanIp = window.location.hostname;
  let hostPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
  let currentJoinUrl = '';
  let pendingDeviceRequest = null;

  // Audio & WebRTC State
  let audioCtx = null;
  let signalling = null;
  let pc = null;
  let currentSid = null;
  let analyser = null;
  let meterSource = null;
  let statsTimer = null;
  let warmupTimer = null;
  let lastStats = null;
  let peerPresent = false;
  let receiving = false;
  let requestTimer = null;

  const queue = WM.serialQueue();

  // ------------------------------------------------------------------- VIEW SWITCHING
  function showView(view) {
    el.viewWelcome.hidden = view !== 'welcome';
    el.viewLobby.hidden = view !== 'lobby';
    el.viewConsole.hidden = view !== 'console';
  }

  function showError(text) {
    if (!text) {
      el.error.hidden = true;
      el.error.textContent = '';
      return;
    }
    el.error.textContent = text;
    el.error.hidden = false;
  }

  // ----------------------------------------------------------- HOST IP DETECTION & QR
  async function fetchHostInfo() {
    try {
      const res = await fetch('/api/info');
      if (res.ok) {
        const data = await res.json();
        if (data.ips && data.ips.length > 0) {
          hostLanIp = data.ips[0];
        }
        if (data.port) {
          hostPort = data.port;
        }
      }
    } catch {
      // Fallback to location.hostname
    }
  }

  function generateJoinUrl() {
    const protocol = window.location.protocol;
    const portStr = hostPort ? `:${hostPort}` : '';
    return `${protocol}//${hostLanIp}${portStr}/?room=${encodeURIComponent(currentRoomId)}&name=${encodeURIComponent(currentRoomName)}`;
  }

  function renderLobbyQr() {
    currentJoinUrl = generateJoinUrl();
    el.lobbyRoomCode.textContent = currentRoomId;
    el.metaRoomId.textContent = currentRoomId;

    if (window.OfflineQRCode && el.lobbyQrCanvas) {
      window.OfflineQRCode.render(el.lobbyQrCanvas, currentJoinUrl, {
        size: 220,
        margin: 2,
        darkColor: '#051F20',
        lightColor: '#ffffff',
      });
    }
  }

  // ----------------------------------------------------------------- AUDIO PIPELINE
  async function ensureAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      try {
        await audioCtx.resume();
      } catch {}
    }
    if (!analyser && audioCtx) {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      setupVisualizers();
    }
  }

  function setupVisualizers() {
    if (!analyser) return;
    let holdUntil = 0;

    WM.createMeter(analyser, el.rxMeter, el.levelDb, (db) => {
      const t = performance.now();
      if (db > -55) holdUntil = t + 600;
      const now = t < holdUntil;
      if (now !== receiving) {
        receiving = now;
        updateLiveIndicator();
      }
    });

    if (el.hostWaveformCanvas) {
      WM.createWaveformVisualizer(analyser, el.hostWaveformCanvas);
    }
  }

  function attachMeter(stream) {
    if (!audioCtx || !analyser) return;
    if (meterSource) {
      try { meterSource.disconnect(); } catch {}
    }
    meterSource = audioCtx.createMediaStreamSource(stream);
    meterSource.connect(analyser);
  }

  function updateLiveIndicator() {
    const connected = pc && pc.connectionState === 'connected';
    if (!connected) {
      el.consoleAudioStateBadge.className = 'status-badge amber';
      el.consoleAudioStateText.textContent = 'CONNECTING...';
      el.consoleDeviceAvatar.className = 'device-avatar';
      return;
    }

    if (receiving) {
      el.consoleAudioStateBadge.className = 'status-badge';
      el.consoleAudioStateText.textContent = 'RECEIVING AUDIO';
      el.consoleDeviceAvatar.className = 'device-avatar live';
    } else {
      el.consoleAudioStateBadge.className = 'status-badge blue';
      el.consoleAudioStateText.textContent = 'STANDBY (SILENT)';
      el.consoleDeviceAvatar.className = 'device-avatar';
    }
  }

  async function playAudio() {
    try {
      await el.audio.play();
      el.unlockBtn.hidden = true;
    } catch {
      el.unlockBtn.hidden = false;
    }
  }

  // ------------------------------------------------------------- WebRTC HANDLING
  function closePc() {
    stopStats();
    clearTimeout(requestTimer);
    requestTimer = null;
    currentSid = null;
    receiving = false;
    if (pc) {
      const old = pc;
      pc = null;
      try { old.close(); } catch {}
    }
    el.audio.srcObject = null;
    el.statRtt.textContent = '-';
    el.statLoss.textContent = '-';
    el.statJitter.textContent = '-';
    el.statBuffer.textContent = '-';
    el.statBitrate.textContent = '-';
    el.connStatus.textContent = 'Disconnected';
    el.connStatus.style.color = 'var(--text-dim)';
    updateLiveIndicator();
  }

  async function handleOffer(msg) {
    closePc();
    await ensureAudioContext();

    const thisPc = new RTCPeerConnection(WM.RTC_CONFIG);
    pc = thisPc;
    currentSid = msg.sid;
    el.connStatus.textContent = 'Connecting...';
    el.connStatus.style.color = 'var(--accent-amber)';

    thisPc.ontrack = (event) => {
      if (pc !== thisPc) return;
      const stream = event.streams[0] || new MediaStream([event.track]);
      el.audio.srcObject = stream;
      playAudio();

      if ('jitterBufferTarget' in event.receiver) {
        try {
          event.receiver.jitterBufferTarget = WM.CONFIG.jitterBufferTargetMs;
        } catch {}
      }
      attachMeter(stream);
    };

    thisPc.onicecandidate = (event) => {
      if (event.candidate) {
        signalling.send({ type: 'ice-candidate', sid: msg.sid, candidate: event.candidate });
      }
    };

    thisPc.onconnectionstatechange = () => {
      if (pc !== thisPc) return;
      const state = thisPc.connectionState;
      if (state === 'connected') {
        clearTimeout(requestTimer);
        requestTimer = null;
        showError('');
        el.connStatus.textContent = 'Connected';
        el.connStatus.style.color = 'var(--accent-green-glow)';
        startStats();
        updateLiveIndicator();
      } else if (state === 'disconnected' || state === 'failed') {
        stopStats();
        el.connStatus.textContent = state;
        el.connStatus.style.color = 'var(--accent-red)';
        updateLiveIndicator();
        clearTimeout(requestTimer);
        requestTimer = setTimeout(() => {
          if (peerPresent && pc === thisPc && thisPc.connectionState !== 'connected') {
            signalling.send({ type: 'request-offer' });
          }
        }, state === 'failed' ? 500 : WM.CONFIG.reconnectDelayMs + 1000);
      }
    };

    try {
      await thisPc.setRemoteDescription({ type: 'offer', sdp: WM.tuneOpus(msg.sdp) });
      const answer = await thisPc.createAnswer();
      await thisPc.setLocalDescription({ type: 'answer', sdp: WM.tuneOpus(answer.sdp) });
      signalling.send({ type: 'answer', sid: msg.sid, sdp: thisPc.localDescription.sdp });
    } catch (err) {
      if (pc !== thisPc) return;
      throw err;
    }
  }

  // ------------------------------------------------------- NETWORK & STREAM STATS
  function startStats() {
    stopStats();
    pollStats();
    warmupTimer = setTimeout(pollStats, 800);
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
        kbps = ((now.bytes - lastStats.bytes) * 8) / (now.t - lastStats.t);
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
    } catch {
      /* closed while polling */
    }
  }

  // ------------------------------------------------------------ SIGNALING HANDLING
  function onSignalingMessage(msg) {
    switch (msg.type) {
      case 'joined':
        peerPresent = msg.peerPresent;
        break;

      case 'peer-joined':
        peerPresent = true;
        break;

      case 'peer-left':
        peerPresent = false;
        closePc();
        el.joinRequestToast.hidden = true;
        pendingDeviceRequest = null;
        el.lobbyDeviceStatusText.textContent = 'Waiting for microphone...';
        el.lobbyDeviceStatusBadge.className = 'status-badge amber';
        break;

      case 'join-request':
        // Mobile scanned QR and wants to join
        pendingDeviceRequest = msg;
        el.requestDeviceDesc.textContent = `${msg.deviceName || 'Mobile Device'} • Local Network`;
        el.joinRequestToast.hidden = false;
        break;

      case 'offer':
        queue(async () => {
          try {
            await handleOffer(msg);
          } catch (err) {
            console.error(err);
            showError('Could not answer device offer: ' + err.message);
          }
        });
        break;

      case 'ice-candidate':
        queue(async () => {
          if (!pc || msg.sid !== currentSid || !pc.remoteDescription) return;
          try {
            await pc.addIceCandidate(msg.candidate);
          } catch (err) {
            console.warn('ICE candidate error:', err);
          }
        });
        break;

      case 'replaced':
        closePc();
        showError('Another receiver page took over. Close other instances and refresh.');
        break;
    }
  }

  function startSignaling() {
    if (signalling && signalling.isAlive()) return;

    signalling = new WM.Signaling('receiver', {
      isConnected: () => !!pc && pc.connectionState === 'connected',
      onClose: () => {
        peerPresent = false;
      },
      onMessage: onSignalingMessage,
    });
    signalling.connect();
  }

  // ------------------------------------------------------------- JOIN APPROVAL / REJECT
  function acceptJoinRequest() {
    if (!pendingDeviceRequest) return;
    el.joinRequestToast.hidden = true;

    // Send approved response to mobile
    signalling.send({
      type: 'join-response',
      approved: true,
      roomId: currentRoomId,
      roomName: currentRoomName,
    });

    const deviceName = pendingDeviceRequest.deviceName || 'Mobile Microphone';
    el.consoleDeviceName.textContent = deviceName;
    el.lobbyDeviceStatusText.textContent = `Connected: ${deviceName}`;
    el.lobbyDeviceStatusBadge.className = 'status-badge';

    // Transition to main console
    showView('console');
    el.topSubtitle.textContent = `ROOM: ${currentRoomId} • ${currentRoomName}`;
    el.hostNetworkStatus.textContent = 'SESSION ACTIVE';
    el.hostNetworkBadge.className = 'status-badge';
  }

  function rejectJoinRequest() {
    if (!pendingDeviceRequest) return;
    el.joinRequestToast.hidden = true;

    // Send rejected response to mobile
    signalling.send({
      type: 'join-response',
      approved: false,
      roomId: currentRoomId,
    });

    pendingDeviceRequest = null;
  }

  // ------------------------------------------------------------- UI INTERACTIONS
  function setupEvents() {
    // Welcome View Model Actions
    if (el.btnLaunchHostRoom) {
      el.btnLaunchHostRoom.addEventListener('click', async () => {
        await ensureAudioContext();
        currentRoomName = (el.inputHostRoomName && el.inputHostRoomName.value.trim()) || 'Main Hall Audio (Host)';
        currentRoomId = WM.generateRoomId();
        showView('lobby');
        el.topSubtitle.textContent = `ROOM: ${currentRoomId} • ${currentRoomName}`;
        el.hostNetworkStatus.textContent = 'WAITING FOR DEVICE';
        el.hostNetworkBadge.className = 'status-badge amber';

        renderLobbyQr();
        startSignaling();
      });
    }

    if (el.btnEnterJoinRoom) {
      el.btnEnterJoinRoom.addEventListener('click', () => {
        const name = (el.inputJoinDisplayName && el.inputJoinDisplayName.value.trim()) || '';
        const room = (el.inputJoinMeetingId && el.inputJoinMeetingId.value.trim().toUpperCase()) || '';
        const params = new URLSearchParams();
        if (room) params.set('room', room);
        if (name) params.set('name', name);
        window.location.href = `/?${params.toString()}`;
      });
    }

    // Lobby View
    el.btnCopyCode.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(currentRoomId);
        el.btnCopyCode.innerHTML = '<svg class="svg-icon sm" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> <span>Copied!</span>';
        setTimeout(() => {
          el.btnCopyCode.innerHTML = '<svg class="svg-icon sm" viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg> <span>Copy Room Code</span>';
        }, 2000);
      } catch {
        prompt('Room Code:', currentRoomId);
      }
    });

    el.btnCopyLink.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(currentJoinUrl);
        el.btnCopyLink.innerHTML = '<svg class="svg-icon sm" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> <span>Copied!</span>';
        setTimeout(() => {
          el.btnCopyLink.innerHTML = '<svg class="svg-icon sm" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> <span>Copy Join Link</span>';
        }, 2000);
      } catch {
        prompt('Join Link:', currentJoinUrl);
      }
    });

    el.btnLeaveLobby.addEventListener('click', () => {
      closePc();
      showView('welcome');
      el.topSubtitle.textContent = 'Offline Meeting Audio System';
      el.hostNetworkStatus.textContent = 'LOCAL NETWORK';
      el.hostNetworkBadge.className = 'status-badge';
    });

    // Join Request Modal
    el.btnAcceptRequest.addEventListener('click', acceptJoinRequest);
    el.btnRejectRequest.addEventListener('click', rejectJoinRequest);

    // Audio Output Controls
    el.volume.addEventListener('input', () => {
      el.audio.volume = el.volume.value / 100;
      el.volumeOut.textContent = el.volume.value + '%';
    });

    el.muteBtn.addEventListener('click', () => {
      el.audio.muted = !el.audio.muted;
      el.muteBtn.innerHTML = el.audio.muted
        ? '<svg class="svg-icon sm" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" x2="1" y1="1" y2="23"/></svg> <span>UNMUTE OUTPUT</span>'
        : '<svg class="svg-icon sm" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg> <span>MUTE OUTPUT</span>';
      el.muteBtn.classList.toggle('btn-danger', el.audio.muted);
    });

    el.toneBtn.addEventListener('click', async () => {
      await ensureAudioContext();
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

    el.unlockBtn.addEventListener('click', playAudio);

    el.btnShowQrAgain.addEventListener('click', () => {
      showView('lobby');
      renderLobbyQr();
    });

    el.btnEndSession.addEventListener('click', () => {
      closePc();
      if (signalling) {
        signalling.send({ type: 'leave-room', roomId: currentRoomId });
      }
      showView('lobby');
      renderLobbyQr();
    });
  }

  // Initialization
  async function init() {
    await fetchHostInfo();
    setupEvents();
    showView('welcome');
  }

  init();
})();
