# Wireless Mic (offline WebRTC)

Use an Android phone as a wireless microphone. Audio travels over your local Wi-Fi to a laptop, which plays it out of its 3.5 mm jack into an amplifier and speaker. No internet is needed at any point: no STUN/TURN, no CDNs, no web fonts.

```
Android phone (transmitter page)
   |  Wi-Fi, WebRTC/Opus (SRTP over UDP)
Wi-Fi router (no internet needed)
   |  Wi-Fi
Laptop (server + receiver page)
   |  3.5 mm AUX cable
Amplifier -> speaker
```

## Quick start

You need Node.js 18+ and [mkcert](https://github.com/FiloSottile/mkcert) on the laptop (install both while you still have internet; afterwards everything runs offline).

```bash
npm install                       # once, while online

# Create a certificate for the laptop's LAN IP (find it with ipconfig / ip a)
mkcert -install
cd certs
mkcert 192.168.1.10 localhost 127.0.0.1 ::1     # use YOUR laptop IP
cd ..

npm start
```

mkcert names the files after the hostnames (for example `192.168.1.10+3.pem` and `192.168.1.10+3-key.pem`). The server finds the pair in `certs/` by itself, so the exact name doesn't matter. If the laptop's IP changes, generate a new certificate for the new IP. Give the laptop a fixed address (DHCP reservation in the router) to avoid this.

1. **Laptop:** open `https://localhost:8443/receiver.html` and click **Start receiving**.
2. **Phone (Chrome):** open `https://<laptop-ip>:8443/`. The first time, choose *Advanced -> Proceed* on the certificate warning. Tap **Start** and allow the microphone.
3. Wait for both pages to show **connected**, then use **Play test tone** on the laptop to check the AUX cable and amplifier.
4. On the phone, hold **PUSH TO TALK** or switch **MIC ON**.

The server prints the exact URLs when it starts.

### Optional: remove the certificate warning
Copy the mkcert root CA next to your certificates and install it on the phone once:

```bash
cp "$(mkcert -CAROOT)/rootCA.pem" certs/
```
Open `https://<laptop-ip>:8443/rootCA.pem` on the phone, then Android *Settings -> Security -> Encryption & credentials -> Install a certificate -> CA certificate*. Never share `rootCA-key.pem`.

## Controls (phone)

| Control | What it does |
|---|---|
| **PUSH TO TALK** | Live only while held (touch or mouse). Releasing never cuts a mic that is switched on. |
| **MIC ON / OFF** | Latched on/off. Green = on, red = off. Instant: it only toggles `track.enabled`, no renegotiation. |
| **MUTE** | Master kill switch. Overrides both of the above until you tap Unmute. |
| **Reconnect** | Rebuilds the WebRTC call (and the signaling socket if needed). |

The tally at the top shows what the audience hears: **Standby**, **Live** or **Muted**. Connection states shown are `new`, `connecting`, `connected`, `disconnected`, `failed`, `closed`. `disconnected` and `failed` reconnect automatically after about 2 s. The phone and laptop both show RTT and packet loss and warn above 150 ms RTT or 5% loss.

## How it works

- `server/server.js`: HTTPS static server plus a WebSocket at `/ws`.
- `server/relay.js`: signaling logic. Clients join as `sender` (phone) or `receiver` (laptop). Messages go only to the other role, so an offer can never loop back to its author. One sender and one receiver are active; a newer client of the same role replaces the older one.
- The **phone always creates the offer**; the laptop answers. When the laptop page loads, the phone (re)starts the call. If the laptop reloads or the phone rejoins, the call rebuilds itself.
- Each call has an id (`sid`), so late ICE candidates from an old call are ignored.
- Audio is Opus mono, 32 kbps with in-band FEC and no DTX (set in the SDP and via `maxBitrate`). The laptop keeps a small playout buffer (`jitterBufferTarget`, 50 ms) for low latency.
- ICE uses `iceServers: []`. On one subnet the direct host-to-host path is all that is needed.

Tunables (bitrate, jitter buffer, warning thresholds) are in `WM.CONFIG` at the top of `frontend/common.js`.

## Tests

```bash
npm test
```
Unit tests cover the signaling relay and the SDP/quality helpers. The full path was also verified in headless Chromium with a fake microphone: connect, MIC/PTT/MUTE behavior, audio actually arriving, receiver reload, phone rejoin, manual reconnect, and HTTPS/WSS.

## Troubleshooting

| Problem | Cause / fix |
|---|---|
| Phone can't open the page | Laptop firewall. On Windows allow **Node.js** on *Private* networks. Also make sure both devices are on the same Wi-Fi and the URL starts with `https://`. |
| `navigator.mediaDevices` is undefined / "not secure" | The page was opened with `http://` or without accepting the certificate. Use `https://<laptop-ip>:8443/`. |
| Stays `connecting`, then `failed` | **AP/client isolation** is on (often on guest Wi-Fi). Turn it off or use the main network. Check the laptop firewall allows Chrome. |
| Connected but silent | Press **Play test tone** on the laptop. If silent, fix the OS output device / cable. If the tone works, check MIC ON/PTT, MUTE, and the phone's input meter. |
| No sound after the laptop page loads | Browsers need a click first. Click **Start receiving** (or **Click to enable sound**). |
| Audio stops when the phone screen locks | A web page can't record in the background. The page requests a screen wake lock; also set Android screen timeout to a long value. A native app is the real fix (see below). |
| Delay above ~200 ms | Weak Wi-Fi. Move closer, prefer 5 GHz, and lower `jitterBufferTargetMs` only if the network is clean. |
| Feedback squeal | Speaker is too close to the phone. Keep the phone away from the speaker, or lower the amplifier gain. |
| Certificate error after IP change | Re-run `mkcert` for the new IP and restart the server. |

**Safety:** always go through an amplifier. Never connect a passive speaker directly to the laptop's headphone jack.

## Ideas for later
Raspberry Pi receiver (ALSA/PulseAudio out), native Android app with a foreground service, several phones with a mixer, recording, per-device output selection.
