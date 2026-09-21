# Wireless Mic — Offline Wireless Meeting Audio System

A private, 100% offline wireless microphone and meeting audio system built with **Node.js, WebSockets, WebRTC, and Web Audio API**.

Turn any smartphone into a crystal-clear wireless microphone over local Wi-Fi. Audio streams directly from the phone's browser to a laptop receiver, which outputs the live sound through its 3.5 mm AUX jack or USB audio interface into an amplifier, PA system, or speakers.

**No internet connection required. No app installation required. Zero external CDN dependencies.**

---

## 🎙 System Overview & Flow

```
Mobile Phone (Transmitter / Speaker)
        │
        ▼  [Local Wi-Fi Network • WebRTC / Opus 32 kbps Mono]
        │
Laptop Host (Receiver Page + Node.js Signaling Server)
        │
        ▼  [3.5 mm AUX Line Out / USB Interface]
        │
Amplifier / Mixer ──▶ Loudspeakers / PA System
```

### Key Workflow:
1. **Host a Meeting (Laptop)**: The laptop launches a private local meeting room (e.g. `MIC-4821`) and generates a dynamic QR code.
2. **Scan & Join (Mobile Phone)**: The phone scans the QR code (or enters the Room ID) and submits a join request.
3. **Host Approval (Laptop)**: The host receives a non-intrusive slide-in notification card with device details and chooses to **Accept** or **Reject**.
4. **Live Microphone (Phone)**: Once approved, the phone activates its microphone with **Live Toggle** and **Push-to-Talk (PTT)** controls.
5. **Audio Reception & Diagnostics (Laptop)**: The host monitors real-time audio waveforms, dBFS input level meters, and WebRTC stream health (RTT latency, packet loss, jitter, bitrate).

---

## 🚀 Quick Start

### Prerequisites
- **Node.js 18+** installed on the host laptop.
- **mkcert** (used once while setting up local HTTPS certificates; needed for browser microphone access).

### 1. Installation & Certificate Generation

```bash
# Clone or navigate into project directory
cd "Mobile Mic"

# Install server dependencies (Express & ws)
npm install

# Generate trusted local HTTPS certificates for your laptop LAN IP
mkcert -install
cd certs
mkcert 192.168.1.10 localhost 127.0.0.1 ::1     # Replace with your laptop's LAN IP
cd ..
```

> **Tip:** Find your laptop's local IP using `ipconfig` (Windows) or `ifconfig` / `ip a` (macOS/Linux).

### 2. Start the Server

```bash
npm start
```

By default, the server starts on port `8443` (configurable with `PORT=8443 npm start`).

```
Wireless Mic is running (offline, LAN only)

  Receiver (open on this laptop):  https://localhost:8443/receiver.html
  Transmitter (open on the phone): https://192.168.1.10:8443/
  Signaling:                       wss://<laptop-ip>:8443/ws
```

### 3. Running a Session

1. **Host (Laptop)**:
   - Open `https://localhost:8443/receiver.html` in Chrome or Edge.
   - Enter your Host/Room Name and click **Launch Meeting Room →**.
   - The lobby displays the meeting QR code and room code (e.g., `MIC-4821`).
2. **Participant (Phone)**:
   - Connect the phone to the **same Wi-Fi network**.
   - Scan the QR code with the phone camera or navigate to `https://<laptop-ip>:8443/`.
   - Enter your name and tap **Join Room**.
3. **Authorize (Laptop)**:
   - Click **✓ ACCEPT** on the slide-in notification card.
4. **Speak (Phone)**:
   - Tap **MIC ON** for continuous speaking, or hold **PUSH TO TALK**.

---

## 🛠 Features

- **100% Offline & Private**: Works completely on local Wi-Fi / hotspot with no internet access, no external trackers, and no third-party STUN/TURN servers.
- **Self-Contained QR Code Generator**: Offline client-side vector/canvas QR engine (`frontend/qrcode.js`).
- **Host Authorization & Room Gate**: Host can accept or reject device join requests before any audio is transmitted.
- **High-Fidelity Opus Speech Tuning**: Tuned mono speech profile at 32 kbps with in-band FEC (Forward Error Correction) and disabled DTX for zero clipping.
- **Low-Latency Playout Buffer**: Configured for 50 ms jitter buffer target on the receiver for ultra-responsive sound.
- **Real-Time Visualizers**:
  - Live animated oscilloscope audio waveform on canvas.
  - Segmented dBFS level meter with clip detection.
- **Push-to-Talk & Latching**: Touch-friendly circular live status button, PTT (hold-to-speak), and dedicated master mute switch.
- **Screen Wake Lock**: Automatically requests browser Screen Wake Lock to prevent the phone from sleeping while speaking.
- **Stream Telemetry**: Live polling of Round Trip Time (RTT), Packet Loss, Jitter, Playout Delay, and Bitrate.
- **Dark Obsidian & Emerald Forest Design System**: Modern, responsive, glassmorphic UI styled with vector SVG icons and high-contrast typography.

---

## 📁 Project Structure

```
Mobile Mic/
├── certs/                      # Local mkcert HTTPS certificates (*.pem)
├── frontend/
│   ├── app.js                  # Mobile transmitter logic (Microphone capture, PTT, WebRTC offer)
│   ├── common.js               # Shared utilities (Opus tuning, quality metrics, meter, waveforms)
│   ├── index.html              # Mobile participant & room join page
│   ├── qrcode.js               # Standalone, offline pure-JS QR code generator
│   ├── receiver.html           # Host meeting dashboard & audio console
│   ├── receiver.js             # Laptop receiver logic (WebRTC answer, audio playback, stats, approval)
│   └── style.css               # Obsidian & Emerald Forest design system
├── server/
│   ├── relay.js                # WebSocket signaling & room handshake relay
│   └── server.js               # HTTPS static file server + WebSocket server + /api/info
├── test/
│   ├── common.test.js          # Unit tests for Opus SDP tuning and audio helpers
│   └── relay.test.js           # Unit tests for WebSocket signaling relay & message types
├── package.json
└── README.md
```

---

## 📊 Controls & Interfaces

### Mobile Transmitter (`index.html`)

| Control | Function |
|---|---|
| **Circular Mic Button** | Toggle latching microphone state (**LIVE** / **MIC OFF** / **MUTED**). |
| **PUSH TO TALK** | Hold to broadcast audio; release to return to silent standby. |
| **MUTE** | Master mute kill switch to override microphone output instantly. |
| **LEAVE ROOM** | Disconnect from the current session and return to room selection. |

### Laptop Receiver (`receiver.html`)

| Section | Description |
|---|---|
| **Lobby & QR Code** | Displays dynamic QR code with real LAN join URL, Room ID, and copy buttons. |
| **Join Approval Card** | Slide-in notification with device OS/name and **Accept / Reject** actions. |
| **Waveform Visualizer** | Real-time audio oscilloscope rendering incoming voice frequencies. |
| **Stream Health Cards** | Displays live latency (ms), packet loss (%), jitter (ms), and bitrate (kbps). |
| **Output Volume & Tone** | Volume slider (0–100%), output mute switch, and 440 Hz diagnostic test tone. |

---

## 🧪 Automated Tests

The repository includes a comprehensive unit test suite covering signaling relay behavior, room handshake message routing, SDP Opus tuning, and quality evaluation:

```bash
npm test
```

```
TAP version 13
ok 1 - tuneOpus merges parameters into the existing Opus fmtp line
ok 2 - tuneOpus adds an fmtp line when none exists
ok 3 - tuneOpus leaves SDP without Opus untouched and keeps LF line endings
ok 4 - quality flags loss and delay
ok 5 - serialQueue runs jobs in order even when they are async
ok 6 - serialQueue keeps going after a job throws
ok 7 - generateRoomId produces standard room pattern MIC-XXXX
ok 8 - detectDeviceName returns default or recognized device string
ok 9 - offer from sender reaches only the receiver
ok 10 - answer and ICE flow back to the sender
ok 11 - join reports whether the other side is already present
ok 12 - peer-left is sent when a client disconnects
ok 13 - a newer client of the same role replaces the older one
ok 14 - ignores junk, unknown types, unjoined sockets and bad roles
ok 15 - does not throw when the peer socket is not open
ok 16 - join-request and join-response are relayed between sender and receiver
# tests 16
# pass 16
# fail 0
```

---

## 🔧 Troubleshooting

| Issue | Cause & Solution |
|---|---|
| **Phone cannot open page** | Ensure both phone and laptop are on the same Wi-Fi. Check Windows Firewall / OS firewall to allow Node.js on Private networks. Always use `https://`. |
| **Microphone blocked / `InsecureContext`** | Web browsers require HTTPS for microphone permissions. Access via `https://` with trusted mkcert certificates. |
| **Connection stuck on `connecting` or `failed`** | Wi-Fi router may have **AP/Client Isolation** enabled (common on guest Wi-Fi). Connect to a standard private Wi-Fi network or a phone mobile hotspot. |
| **No audio heard on laptop** | Browsers require user interaction before autoplaying audio. Click anywhere on the receiver page or tap **Click to Enable Laptop Sound**. Check the volume slider and amplifier AUX connection. |
| **High audio latency (> 150 ms)** | Congested Wi-Fi network. Switch to a 5 GHz Wi-Fi band or use a dedicated mobile hotspot for ultra-low latency. |
| **Acoustic feedback squeal** | Mobile phone is too close to the output speakers. Increase the physical distance between the microphone and speakers. |

---

## ⚠️ Safety Note

Always route the laptop's audio output through an amplifier, active powered speaker, or audio mixer. **Never connect a passive speaker directly to a laptop 3.5 mm headphone jack.**

---

## 📄 License

MIT License. Free for personal, academic, and commercial use.
