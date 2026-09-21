'use strict';

/**
 * Transmitter (Mobile Phone).
 * Captures microphone upon approval and streams live audio over WebRTC to host laptop.
 */
(() => {
  const $ = (id) => document.getElementById(id);

  const el = {
    // Top Bar
    topRoleSub: $('top-role-sub'),
    mobileTopStatus: $('mobile-top-status'),
    mobileTopStatusText: $('mobile-top-status-text'),

    // View 1: Manual Code Entry
    viewEnterCode: $('view-enter-code'),
    inputManualRoom: $('input-manual-room'),
    inputDeviceNameManual: $('input-device-name-manual'),
    btnSubmitManualCode: $('btn-submit-manual-code'),

    // View 2: Join Preview
    viewJoinPreview: $('view-join-preview'),
    previewRoomTitle: $('preview-room-title'),
    previewRoomName: $('preview-room-name'),
    previewRoomId: $('preview-room-id'),
    inputDeviceName: $('input-device-name'),
    btnJoinRoom: $('btn-join-room'),
    btnCancelJoin: $('btn-cancel-join'),
    micGateError: $('mic-gate-error'),

    // View 3: Waiting Approval
    viewWaitingApproval: $('view-waiting-approval'),
    approvalStatusBadge: $('approval-status-badge'),
    approvalStatusText: $('approval-status-text'),
    waitingRoomId: $('waiting-room-id'),
    btnCancelRequest: $('btn-cancel-request'),

    // View 4: Rejected
    viewRejected: $('view-rejected'),
    btnRetryJoin: $('btn-retry-join'),

    // View 5: Mic Live Console
    viewMicConsole: $('view-mic-console'),
    micLockStatusCard: $('mic-lock-status-card'),
    lockStateAvailable: $('lock-state-available'),
    lockStateSpeaking: $('lock-state-speaking'),
    lockStateLocked: $('lock-state-locked'),
    lockedSpeakerDesc: $('locked-speaker-desc'),
    micCircleBtn: $('mic-circle-btn'),
    micCircleSymbol: $('mic-circle-symbol'),
    micCircleLabel: $('mic-circle-label'),
    micLiveBadge: $('mic-live-badge'),
    micLiveText: $('mic-live-text'),
    pttButton: $('ptt-button'),
    levelMeter: $('level-meter'),
    levelDb: $('level-db'),
    muteBtn: $('mute-btn'),
    btnLeaveRoom: $('btn-leave-room'),
    mobileConnState: $('mobile-conn-state'),
    mobileStatRtt: $('mobile-stat-rtt'),
    wakeNote: $('wake-note'),

    error: $('error-message'),
  };

  // State
  let currentRoomId = '';
  let currentRoomName = 'Meeting Room';
  let currentDeviceName = WM.detectDeviceName();
  let myClientId = 'user_' + Math.random().toString(36).slice(2, 9);

  let stream = null;
  let audioTrack = null;
  let audioCtx = null;
  let pc = null;
  let sid = null;
  let signaling = null;
  let peerPresent = false;
  let reconnectTimer = null;
  let statsTimer = null;
  let wakeLock = null;

  // Mic state & Room Lock
  let latched = false;
  let pttHeld = false;
  let muted = false;
  let hasMicLock = false;
  let currentSpeaker = null;
  let microphoneLocked = false;
  let activeSpeakerName = null;

  const queue = WM.serialQueue();

  // ------------------------------------------------------------------- VIEW SWITCHING
  function showView(view) {
    el.viewEnterCode.hidden = view !== 'enter-code';
    el.viewJoinPreview.hidden = view !== 'preview';
    el.viewWaitingApproval.hidden = view !== 'waiting';
    el.viewRejected.hidden = view !== 'rejected';
    el.viewMicConsole.hidden = view !== 'console';
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

  // ------------------------------------------------------------------- MIC CONTROL
  function updateLockUI() {
    if (hasMicLock) {
      if (el.lockStateSpeaking) el.lockStateSpeaking.hidden = false;
      if (el.lockStateAvailable) el.lockStateAvailable.hidden = true;
      if (el.lockStateLocked) el.lockStateLocked.hidden = true;
      if (el.pttButton) el.pttButton.disabled = false;
    } else if (microphoneLocked) {
      if (el.lockStateSpeaking) el.lockStateSpeaking.hidden = true;
      if (el.lockStateAvailable) el.lockStateAvailable.hidden = true;
      if (el.lockStateLocked) el.lockStateLocked.hidden = false;
      if (el.lockedSpeakerDesc) {
        el.lockedSpeakerDesc.textContent = (activeSpeakerName ? `MIC LOCKED • ${activeSpeakerName} is speaking` : 'MIC LOCKED • Someone is speaking');
      }
      if (el.pttButton) el.pttButton.disabled = true;
    } else {
      if (el.lockStateSpeaking) el.lockStateSpeaking.hidden = true;
      if (el.lockStateAvailable) el.lockStateAvailable.hidden = false;
      if (el.lockStateLocked) el.lockStateLocked.hidden = true;
      if (el.pttButton) el.pttButton.disabled = false;
    }
  }

  function applyMicState() {
    // HARD ENFORCEMENT: Audio track is enabled ONLY if participant holds the mic lock!
    const live = hasMicLock && !muted && (latched || pttHeld);
    if (audioTrack) audioTrack.enabled = live;

    if (live) {
      el.micCircleBtn.className = 'big-mic-btn active transmitting';
      el.micCircleLabel.textContent = 'LIVE';
      el.micLiveBadge.className = 'status-badge live';
      el.micLiveText.textContent = 'TRANSMITTING';
    } else if (!hasMicLock && microphoneLocked) {
      el.micCircleBtn.className = 'big-mic-btn locked';
      el.micCircleLabel.textContent = 'LOCKED';
      el.micLiveBadge.className = 'status-badge amber';
      el.micLiveText.textContent = 'MIC LOCKED';
    } else if (muted) {
      el.micCircleBtn.className = 'big-mic-btn';
      el.micCircleLabel.textContent = 'MUTED';
      el.micLiveBadge.className = 'status-badge amber';
      el.micLiveText.textContent = 'MUTED';
    } else {
      el.micCircleBtn.className = 'big-mic-btn';
      el.micCircleLabel.textContent = 'MIC OFF';
      el.micLiveBadge.className = 'status-badge';
      el.micLiveText.textContent = 'STANDBY';
    }

    el.pttButton.classList.toggle('active', pttHeld && !muted && hasMicLock);
    const muteText = $('mute-btn-text');
    if (muteText) muteText.textContent = muted ? 'UNMUTE' : 'MUTE';
    el.muteBtn.classList.toggle('btn-danger', muted);
    updateLockUI();
  }

  async function initMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('InsecureContext'), { name: 'InsecureContext' });
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }

  function describeMicError(err) {
    switch (err.name) {
      case 'InsecureContext':
        return 'Please access via HTTPS to enable microphone access.';
      case 'NotAllowedError':
        return 'Microphone permission denied. Allow mic access in browser settings.';
      case 'NotFoundError':
        return 'No microphone found on this device.';
      default:
        return 'Microphone error: ' + err.message;
    }
  }

  function setupAudioMeter() {
    if (!audioCtx || !stream) return;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    WM.createMeter(analyser, el.levelMeter, el.levelDb);
  }

  // ------------------------------------------------------------------- WebRTC CALL
  function closePc() {
    stopStats();
    if (pc) {
      const old = pc;
      pc = null;
      try { old.close(); } catch {}
    }
    el.mobileConnState.textContent = 'Disconnected';
    el.mobileConnState.style.color = 'var(--text-dim)';
    el.mobileStatRtt.textContent = '- ms';
  }

  async function limitBitrate(rtpSender) {
    try {
      const params = rtpSender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = WM.CONFIG.opusBitrate;
      await rtpSender.setParameters(params);
    } catch (err) {
      console.warn('Could not limit bitrate:', err);
    }
  }

  async function startCall() {
    if (!stream || !signaling || !signaling.isOpen()) return;
    closePc();

    const thisSid = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
    const thisPc = new RTCPeerConnection(WM.RTC_CONFIG);
    pc = thisPc;
    sid = thisSid;

    el.mobileConnState.textContent = 'Connecting...';
    el.mobileConnState.style.color = 'var(--accent-amber)';

    const transceiver = thisPc.addTransceiver(audioTrack, { direction: 'sendonly', streams: [stream] });

    thisPc.onconnectionstatechange = () => {
      if (pc !== thisPc) return;
      const state = thisPc.connectionState;
      if (state === 'connected') {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        showError('');
        el.mobileConnState.textContent = 'Connected';
        el.mobileConnState.style.color = 'var(--accent-green-glow)';
        startStats();
      } else if (state === 'disconnected') {
        stopStats();
        el.mobileConnState.textContent = 'Reconnecting...';
        el.mobileConnState.style.color = 'var(--accent-amber)';
        scheduleReconnect(WM.CONFIG.reconnectDelayMs);
      } else if (state === 'failed') {
        stopStats();
        el.mobileConnState.textContent = 'Connection Failed';
        el.mobileConnState.style.color = 'var(--accent-red)';
        scheduleReconnect(500);
      }
    };

    thisPc.onicecandidate = (event) => {
      if (event.candidate) {
        signaling.send({ type: 'ice-candidate', sid: thisSid, candidate: event.candidate });
      }
    };

    try {
      const offer = await thisPc.createOffer();
      if (pc !== thisPc) return;
      await thisPc.setLocalDescription({ type: 'offer', sdp: WM.tuneOpus(offer.sdp) });
      signaling.send({ type: 'offer', sid: thisSid, sdp: thisPc.localDescription.sdp });
      limitBitrate(transceiver.sender);
    } catch (err) {
      console.error(err);
      showError('Connection error: ' + err.message);
      scheduleReconnect(WM.CONFIG.reconnectDelayMs);
    }
  }

  function scheduleReconnect(delay) {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (pc && pc.connectionState === 'connected') return;
      if (!peerPresent) return;
      startCall();
    }, delay);
  }

  // ------------------------------------------------------------- STATS POLLING
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
      report.forEach((r) => {
        if (r.type === 'remote-inbound-rtp' && (r.kind || r.mediaType) === 'audio') {
          if (typeof r.roundTripTime === 'number') rtt = r.roundTripTime * 1000;
        }
        if (rtt === null && r.type === 'candidate-pair' && r.nominated && typeof r.currentRoundTripTime === 'number') {
          rtt = r.currentRoundTripTime * 1000;
        }
      });
      if (rtt !== null) {
        el.mobileStatRtt.textContent = Math.round(rtt) + ' ms';
      }
    } catch {
      /* disconnected */
    }
  }

  // ------------------------------------------------------------ SIGNALING
  function onSignalingMessage(msg) {
    switch (msg.type) {
      case 'joined':
        peerPresent = msg.peerPresent;
        // Automatically send join request once socket joins
        signaling.send({
          type: 'join-request',
          roomId: currentRoomId,
          clientId: myClientId,
          deviceName: currentDeviceName,
          displayName: currentDeviceName,
        });
        break;

      case 'peer-joined':
        peerPresent = true;
        break;

      case 'peer-left':
        peerPresent = false;
        closePc();
        break;

      case 'join-response':
        if (msg.targetClientId && msg.targetClientId !== myClientId) return;
        if (msg.approved) {
          // Host Accepted!
          showView('console');
          el.topRoleSub.textContent = `ROOM: ${currentRoomId}`;
          el.mobileTopStatusText.textContent = 'CONNECTED TO HOST';
          el.mobileTopStatus.className = 'status-badge';
          applyMicState();
          requestWakeLock();
          queue(startCall);
        } else {
          // Host Rejected
          showView('rejected');
          closePc();
        }
        break;

      case 'mic_granted':
        if (msg.speakerId === myClientId) {
          hasMicLock = true;
          microphoneLocked = true;
          currentSpeaker = myClientId;
          activeSpeakerName = msg.speakerName || currentDeviceName;
          latched = true;
          applyMicState();
        } else {
          hasMicLock = false;
          latched = false;
          pttHeld = false;
          microphoneLocked = true;
          currentSpeaker = msg.speakerId;
          activeSpeakerName = msg.speakerName;
          applyMicState();
        }
        break;

      case 'mic_denied':
        hasMicLock = false;
        latched = false;
        pttHeld = false;
        microphoneLocked = true;
        currentSpeaker = msg.currentSpeaker;
        activeSpeakerName = msg.speakerName;
        applyMicState();
        showError((activeSpeakerName ? activeSpeakerName : 'Another participant') + ' is currently speaking.');
        setTimeout(() => showError(''), 2500);
        break;

      case 'mic_released':
        hasMicLock = false;
        latched = false;
        pttHeld = false;
        microphoneLocked = false;
        currentSpeaker = null;
        activeSpeakerName = null;
        applyMicState();
        break;

      case 'speaker_disconnected':
        hasMicLock = false;
        latched = false;
        pttHeld = false;
        microphoneLocked = false;
        currentSpeaker = null;
        activeSpeakerName = null;
        applyMicState();
        break;

      case 'room_state':
        microphoneLocked = !!msg.microphoneLocked;
        currentSpeaker = msg.currentSpeaker || null;
        activeSpeakerName = msg.speakerName || null;
        hasMicLock = (currentSpeaker === myClientId);
        if (!hasMicLock) {
          latched = false;
          pttHeld = false;
        }
        applyMicState();
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
            console.warn('ICE rejected:', err);
          }
        });
        break;

      case 'leave-room':
        closePc();
        showView('preview');
        showError('Host ended the session.');
        break;

      case 'replaced':
        closePc();
        showError('Another device connected with the same role.');
        break;
    }
  }

  function connectSignaling() {
    if (signaling && signaling.isAlive()) {
      signaling.send({
        type: 'join-request',
        roomId: currentRoomId,
        clientId: myClientId,
        deviceName: currentDeviceName,
        displayName: currentDeviceName,
      });
      return;
    }

    signaling = new WM.Signaling('sender', {
      isConnected: () => !!pc && pc.connectionState === 'connected',
      getJoinData: () => ({
        roomId: currentRoomId,
        clientId: myClientId,
        displayName: currentDeviceName,
        deviceName: currentDeviceName,
      }),
      onMessage: onSignalingMessage,
      onClose: () => {
        peerPresent = false;
      },
    });
    signaling.connect();
  }

  // ------------------------------------------------------------ WAKE LOCK
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      el.wakeNote.textContent = 'Screen lock stops audio. Keep screen turned on while speaking.';
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
      el.wakeNote.textContent = 'Screen wake lock active.';
    } catch {
      el.wakeNote.textContent = 'Keep screen turned on while speaking.';
    }
  }

  // ------------------------------------------------------------- REQUEST ACCESS FLOW
  async function requestAccess() {
    el.micGateError.hidden = true;
    el.btnJoinRoom.disabled = true;

    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();

    try {
      stream = await initMicrophone();
    } catch (err) {
      el.micGateError.textContent = describeMicError(err);
      el.micGateError.hidden = false;
      el.btnJoinRoom.disabled = false;
      return;
    }

    audioTrack = stream.getAudioTracks()[0];
    audioTrack.enabled = false; // Start muted until user triggers Mic ON / PTT

    if (audioCtx.state === 'suspended') await audioCtx.resume();
    setupAudioMeter();

    // Show waiting screen
    el.waitingRoomId.textContent = currentRoomId;
    showView('waiting');
    el.btnJoinRoom.disabled = false;

    // Connect and send join request to host
    connectSignaling();
  }

  // ------------------------------------------------------------- UI CONTROLS & EVENTS
  function setupEvents() {
    // Manual code entry
    el.btnSubmitManualCode.addEventListener('click', () => {
      const code = el.inputManualRoom.value.trim().toUpperCase();
      if (!code) return;
      currentRoomId = code;
      currentDeviceName = el.inputDeviceNameManual.value.trim() || WM.detectDeviceName();
      el.previewRoomId.textContent = currentRoomId;
      el.previewRoomName.textContent = `Room ${currentRoomId}`;
      el.previewRoomTitle.textContent = `Room ${currentRoomId}`;
      el.inputDeviceName.value = currentDeviceName;
      showView('preview');
    });

    // Join Preview
    el.btnJoinRoom.addEventListener('click', () => {
      currentDeviceName = el.inputDeviceName.value.trim() || WM.detectDeviceName();
      requestAccess();
    });

    el.btnCancelJoin.addEventListener('click', () => {
      showView('enter-code');
    });

    // Waiting Screen
    el.btnCancelRequest.addEventListener('click', () => {
      closePc();
      showView('preview');
    });

    // Rejected Screen
    el.btnRetryJoin.addEventListener('click', () => {
      showView('preview');
    });

    // Circular Mic Button Toggle
    el.micCircleBtn.addEventListener('click', () => {
      if (hasMicLock) {
        // User turns mic OFF
        latched = false;
        hasMicLock = false;
        applyMicState();
        if (signaling) {
          signaling.send({
            type: 'mic_release',
            roomId: currentRoomId,
            clientId: myClientId,
          });
        }
      } else {
        // User turns mic ON
        if (microphoneLocked) {
          showError((activeSpeakerName ? activeSpeakerName : 'Another participant') + ' is currently speaking.');
          setTimeout(() => showError(''), 2500);
          return;
        }
        if (signaling) {
          signaling.send({
            type: 'mic_request',
            roomId: currentRoomId,
            clientId: myClientId,
          });
        }
      }
    });

    // Mute Button Toggle
    el.muteBtn.addEventListener('click', () => {
      muted = !muted;
      applyMicState();
    });

    // Push To Talk Handlers
    const pressPtt = () => {
      if (microphoneLocked && !hasMicLock) {
        showError((activeSpeakerName ? activeSpeakerName : 'Another participant') + ' is currently speaking.');
        setTimeout(() => showError(''), 2500);
        return;
      }
      pttHeld = true;
      if (!hasMicLock) {
        if (signaling) {
          signaling.send({
            type: 'mic_request',
            roomId: currentRoomId,
            clientId: myClientId,
          });
        }
      } else {
        applyMicState();
      }
    };

    const releasePtt = () => {
      if (!pttHeld) return;
      pttHeld = false;
      if (hasMicLock && !latched) {
        hasMicLock = false;
        applyMicState();
        if (signaling) {
          signaling.send({
            type: 'mic_release',
            roomId: currentRoomId,
            clientId: myClientId,
          });
        }
      } else {
        applyMicState();
      }
    };

    el.pttButton.addEventListener('touchstart', (e) => { e.preventDefault(); pressPtt(); }, { passive: false });
    el.pttButton.addEventListener('touchend', (e) => { e.preventDefault(); releasePtt(); }, { passive: false });
    el.pttButton.addEventListener('touchcancel', releasePtt);
    el.pttButton.addEventListener('mousedown', pressPtt);
    el.pttButton.addEventListener('mouseup', releasePtt);
    el.pttButton.addEventListener('mouseleave', releasePtt);
    el.pttButton.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', releasePtt);

    // Leave Room
    el.btnLeaveRoom.addEventListener('click', () => {
      if (hasMicLock && signaling) {
        signaling.send({
          type: 'mic_release',
          roomId: currentRoomId,
          clientId: myClientId,
        });
      }
      closePc();
      latched = false;
      pttHeld = false;
      hasMicLock = false;
      muted = false;
      applyMicState();
      showView('preview');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        releasePtt();
      } else if (audioTrack) {
        requestWakeLock();
      }
    });
  }

  // ------------------------------------------------------------- INITIALIZATION
  function init() {
    setupEvents();
    el.inputDeviceName.value = currentDeviceName;
    el.inputDeviceNameManual.value = currentDeviceName;

    // Check URL query parameters
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    const nameParam = params.get('name');

    if (roomParam) {
      currentRoomId = roomParam.trim().toUpperCase();
      currentRoomName = nameParam ? decodeURIComponent(nameParam) : 'Meeting Room';
      el.previewRoomId.textContent = currentRoomId;
      el.previewRoomName.textContent = currentRoomName;
      el.previewRoomTitle.textContent = currentRoomName;
      showView('preview');
    } else {
      showView('enter-code');
    }
  }

  init();
})();
