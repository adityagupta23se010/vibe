# Collaboration room: voice

The whiteboard room (`/teacher|student/whiteboard/:roomCode`) is the collaboration room.
Voice is a second realtime capability inside it, next to drawing, cursors and presence.

```
WhiteboardPage
 ├─ useWhiteboardBoard ─ useWhiteboardSocket ──┐  one authenticated Socket.IO connection
 ├─ useVoiceChat ─ VoiceSession ───────────────┘  (shared; voice reuses the board's room join)
 │                   └─ VoiceTransport ← MeshTransport (WebRTC, one RTCPeerConnection per peer)
 ├─ ParticipantsPanel   one participant list; voice state is merged in by userId
 ├─ VoiceControls       docked bar under the canvas: join/leave, mute, status, who's in voice
 └─ RemoteAudio         one hidden <audio> per remote peer
```

- **Audio never touches the server.** Socket.IO carries only signaling (`voice:join`, `voice:leave`,
  `voice:state`, `voice:offer`, `voice:answer`, `voice:ice-candidate`, `voice:sync`; server emits
  `voice:participants`, `voice:replaced`). Nothing about voice is persisted.
- **Authorization** comes from the board. `backend/src/modules/whiteboard/VoiceSignaling.ts` only accepts
  voice events from a socket that `WhiteboardGateway` has already admitted to a room. The server takes
  identity from the token and only relays signaling between sockets in the same room's voice set.
- **Independence.** The canvas has no voice code. If voice fails, the board keeps working. If the
  socket drops, existing peer connections keep carrying audio. On reconnect the session announces
  itself again and renegotiates, with no page reload.
- **Joining is explicit.** The microphone is requested only when the user clicks *Join voice*.
  Mute disables the track and leaves the peer connections up.
- **Speaking indicators** come from local Web Audio analysis (`SpeakingDetector`). Audio levels are
  never sent anywhere.

## Owner controls and permissions

The board's creator (`session.createdBy`) is the **room owner**. The owner can do everything, and
no room setting or moderation action can be aimed at the owner.

**Persisted** on the session document: each participant's `role` (editor or viewer) and owner
overrides `voice.canJoin` / `voice.canSpeak`, plus the room-wide `boardLocked`, `voicePolicy`
(`enabled`, `joinMuted`, `speakByDefault`) and the `removed` list. **Runtime only**: sockets, voice
membership, mic state, speaking indicators and peer connections.

`backend/src/modules/whiteboard/access.ts → computeAccess(session, userId)` is the only place that
decides what someone may do. The service applies it to every REST and socket operation, including the
live `stroke:live` and `object:preview` relays. Moderation events (`participant:setRole`,
`participant:setVoice`, `participant:remove` / `readmit`, `room:setSettings`, `room:setDefaultRole`,
`voice:muteAll`, `voice:unmuteAll`) re-check ownership against the database on every call and
ignore any role the client claims. After any change, the gateway recomputes each connected member's
access and sends it in `room:state` (each user gets only their own). The UI only mirrors that state:
it never updates permissions locally ahead of the server, and it shows a pending state until the
server confirms.

Voice is a `RoomCapability`. The gateway tells it about access changes and removals, and it enforces
them: it refuses joins, evicts users whose voice was revoked (`voice:revoked`), and ignores an unmute
from someone the owner has muted. In a mesh call the server cannot stop a modified client from
sending audio, so every receiving client also refuses to play audio from a force-muted peer. An SFU
transport would move that enforcement to the server.

| Owner action | Effect |
| --- | --- |
| Make Viewer / Editor | Persisted role; drawing tools enable or disable live |
| Lock whiteboard | Everyone except the owner is read-only; roles are kept for when it's unlocked |
| Mute / Allow to speak | Per-participant `canSpeak`; a forced mute can't be lifted by the participant |
| Disable / Allow voice | Per-participant `canJoin`; revoking drops them from voice but keeps them in the room |
| Mute everyone now | One-off: sets `canSpeak = false` for everyone currently present; the button then becomes **Unmute everyone** |
| Unmute everyone | Lifts every owner-imposed mute (explicit "allowed to speak" overrides are kept). Owner mutes are per participant, so changing the policy switches does **not** lift them |
| Join muted / Only speak when allowed / Allow voice | Standing room policy for who joins voice and how |
| Remove / Allow back | Evicts the user's sockets now and blocks rejoining (REST and socket) until re-admitted |

## Topology and scaling

Mesh works well for the target of 2–6 people. Each participant uploads one audio stream per peer,
so cost grows as N². Larger rooms need an SFU (e.g. mediasoup or LiveKit). To add one, implement
`VoiceTransport` (`start` / `sync` / `close`), so each client publishes once and subscribes to the
SFU's streams. Then swap it into `VoiceSession.createTransport`. The session, hook and UI don't change.

## ICE / TURN

`VITE_WEBRTC_ICE_SERVERS` (frontend env) is a JSON `RTCIceServer[]`. If unset, the default is
Google's public STUN server, which is enough for local development and most home networks.
**Production needs TURN.** Peers behind symmetric NAT or corporate and campus firewalls can't
connect with STUN alone:

```
VITE_WEBRTC_ICE_SERVERS=[{"urls":"stun:turn.example.org:3478"},{"urls":["turn:turn.example.org:3478","turns:turn.example.org:5349"],"username":"…","credential":"…"}]
```

Prefer short-lived TURN credentials (e.g. coturn's `use-auth-secret`) over static ones.

## Audio quality

- **Mic processing** (`voice/constraints.ts`): echo cancellation, noise suppression, auto gain and mono
  (`channelCount: {ideal: 1}`). It only requests constraints the browser reports as supported. These
  built-in processors are what remove fan, keyboard and speaker echo, so no extra audio library is used.
- **No local playback:** the mic only feeds a Web Audio analyser, which is never connected to the
  speakers. Only remote streams are played, one `<audio>` per remote peer (`RemoteAudio`).
- **One connection per peer:** `MeshTransport.create()` replaces any existing connection for that
  peer, a repeated offer reuses it, and each reconnect builds a fresh transport and closes the old
  one. Each peer has one stable `MediaStream`, even if `ontrack` fires again.
- **Codec:** browsers negotiate Opus first with in-band FEC by default, so the SDP isn't touched. The
  dev diagnostics warn if anything else is ever negotiated.
- **Speaking indicator** (`VoiceActivity`): runs entirely in the browser and is never sent anywhere.
  It needs two consecutive loud polls to start, so keyboard clicks don't trigger it. An adaptive noise
  floor stops steady fan noise from triggering it, and it holds for 450 ms between words.
- **Mic unplugged:** the session leaves voice and says "Your microphone was disconnected" instead of
  silently sending nothing.

### Development diagnostics

Under `vite dev` only, while you're in voice, `VoiceDiagnostics` polls `getStats()` every 5 s and
logs, for each peer: codec, packets received and lost (with %), jitter, round-trip time, received
audio level, concealed-samples % (audible glitches) and the ICE route (`relay` means TURN). It warns
on packet loss, high jitter or RTT, a non-Opus codec, and **more connections or streams than voice
participants** (the signature of duplicate audio). The latest sample is at `window.__vibeVoice.latest`.
None of this ships in production builds or reaches the server.

What to suspect when someone reports "noise":

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Hearing yourself back | Acoustic echo: the other person is on speakers at high volume, or two clients share one room or laptop | Use headphones; AEC handles normal speaker use |
| Doubled or phasey voice | Duplicate playback | A diagnostics warning about duplicate peers or streams |
| Robotic or choppy | Packet loss or jitter | `lossPercent`, `jitterMs`, `concealedPercent` |
| Constant hiss or fan | Mic noise beyond what NS removes | Try another mic; check the OS mic boost |
| Distorted when loud | Clipping from OS gain plus AGC | Lower the OS input level |

## Testing locally with two users

1. Start the backend and frontend as usual, and use **headphones** so audio doesn't feed back.
2. Sign in as user A in one Chrome profile, and as user B in another profile or an incognito window.
   Browser storage holds one session, so two tabs in the same profile count as the same user.
3. User A creates a board, clicks **Share**, and user B opens the link. Both should see each other in
   the participants panel and see each other's drawing live.
4. Both click **Join voice** and allow the microphone. Speak; the speaker's avatar gets a green ring
   on the other side. Mute, unmute and leave each update the other user's panel, and both stay on the board.
5. To test reconnection, stop and restart the backend, or toggle DevTools → Network → Offline. The
   board reconnects and voice re-announces itself without a reload.

Audio-quality checklist (two or three people, ideally on separate machines): headphones vs laptop
speakers, two different microphones, a quiet room, a fan running, typing while silent (the speaking
indicator should stay off), join/leave/rejoin and mute/unmute repeatedly, then a network blip. Keep
DevTools open. There should be no `[voice]` warnings, `__vibeVoice.latest` should show exactly one
entry per other participant, and the codec should be Opus.

`getUserMedia` needs a secure context: `localhost` works, but a LAN IP needs https.

Tests: `frontend/src/features/collaboration/voice/voice.test.ts` (session, mesh, helpers) and
`backend/src/modules/whiteboard/tests/VoiceSignaling.test.ts` (real Socket.IO: authorization,
relay rules, lifecycle, cleanup).
