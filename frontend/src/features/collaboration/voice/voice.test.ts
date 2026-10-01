/* eslint-disable @typescript-eslint/no-explicit-any -- loose fakes for browser/socket APIs */
import { describe, expect, it, vi } from 'vitest';
import { buildAudioConstraints } from './constraints';
import { diagnose, summarizeAudioStats } from './diagnostics';
import { parseIceServers } from './iceServers';
import { MeshTransport } from './MeshTransport';
import { SpeakingDetector, VoiceActivity } from './SpeakingDetector';
import { describeMediaError, LOCAL_ID, MESSAGES, VoiceSession } from './VoiceSession';
import type { SignalingChannel, TransportEvents, VoicePeerInfo, VoiceTransport } from './types';

// ---------- fakes ----------

class FakeSignaling implements SignalingChannel {
  connected = true;
  id = 'self-socket';
  emitted: Array<[string, unknown]> = [];
  ackResponse: unknown = { ok: true, peers: [] };
  private handlers = new Map<string, Set<(...args: any[]) => void>>();
  emit(event: string, payload?: unknown) {
    this.emitted.push([event, payload]);
  }
  on(event: string, handler: (...args: any[]) => void) {
    (this.handlers.get(event) ?? this.handlers.set(event, new Set()).get(event)!).add(handler);
  }
  off(event: string, handler: (...args: any[]) => void) {
    this.handlers.get(event)?.delete(handler);
  }
  timeout() {
    return {
      emitWithAck: async (event: string, payload?: unknown) => {
        this.emitted.push([event, payload]);
        if (this.ackResponse instanceof Error) throw this.ackResponse;
        return this.ackResponse;
      },
    };
  }
  fire(event: string, payload?: unknown) {
    this.handlers.get(event)?.forEach(h => h(payload));
  }
  listenerCount() {
    return [...this.handlers.values()].reduce((n, s) => n + s.size, 0);
  }
  events(name: string) {
    return this.emitted.filter(([e]) => e === name).map(([, p]) => p);
  }
}

const fakeTrack = () => {
  const listeners = new Map<string, Set<() => void>>();
  return {
    enabled: true,
    stopped: false,
    stop() { this.stopped = true; },
    addEventListener(type: string, fn: () => void) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn); },
    removeEventListener(type: string, fn: () => void) { listeners.get(type)?.delete(fn); },
    /** Simulates the browser ending the track (device unplugged). */
    end() { listeners.get('ended')?.forEach(fn => fn()); },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
};
const fakeStream = () => {
  const track = fakeTrack();
  return { track, getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream & { track: ReturnType<typeof fakeTrack> };
};

class FakeTransport implements VoiceTransport {
  started?: VoicePeerInfo[];
  synced: VoicePeerInfo[][] = [];
  closed = false;
  constructor(public events: TransportEvents) {}
  start(_local: MediaStream, peers: VoicePeerInfo[]) { this.started = peers; }
  sync(peers: VoicePeerInfo[]) { this.synced.push(peers); }
  close() { this.closed = true; }
}

function setup(overrides: { getUserMedia?: (c?: MediaStreamConstraints) => Promise<MediaStream>; supported?: boolean } = {}) {
  const signaling = new FakeSignaling();
  const transports: FakeTransport[] = [];
  const detector = { add: vi.fn(), remove: vi.fn(), dispose: vi.fn(), onChange: undefined as undefined | ((id: string, s: boolean) => void) };
  const stream = fakeStream();
  const session = new VoiceSession(signaling, {
    getUserMedia: overrides.getUserMedia ?? (async () => stream),
    supported: () => overrides.supported ?? true,
    diagnostics: false,
    createTransport: (_s, events) => {
      const t = new FakeTransport(events);
      transports.push(t);
      return t;
    },
    createDetector: cb => {
      detector.onChange = cb;
      return detector;
    },
  });
  return { signaling, session, transports, detector, stream };
}

const peer = (socketId: string, userId: string, muted = false, forced = false): VoicePeerInfo => ({ socketId, userId, name: userId, muted, forced });

// ---------- VoiceSession ----------

describe('VoiceSession', () => {
  it('never touches the microphone until join is called', () => {
    const getUserMedia = vi.fn();
    const { session } = setup({ getUserMedia });
    session.setRoomReady(true);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(session.getSnapshot().status).toBe('idle');
  });

  it('joins: acquires the mic, announces, and starts the transport with existing peers', async () => {
    const { session, signaling, transports, detector } = setup();
    signaling.ackResponse = { ok: true, peers: [peer('s2', 'u2')] };
    session.setRoomReady(true);
    await session.join();
    expect(signaling.events('voice:join')).toHaveLength(1);
    expect(transports[0].started).toEqual([peer('s2', 'u2')]);
    expect(detector.add).toHaveBeenCalledWith(LOCAL_ID, expect.anything());
    expect(session.getSnapshot().status).toBe('connected');
  });

  it('waits for room membership before announcing', async () => {
    const { session, signaling } = setup();
    await session.join();
    expect(signaling.events('voice:join')).toHaveLength(0);
    expect(session.getSnapshot().status).toBe('connecting');
    session.setRoomReady(true);
    await vi.waitFor(() => expect(session.getSnapshot().status).toBe('connected'));
  });

  it('mutes by disabling the track without tearing down the transport', async () => {
    const { session, signaling, transports, stream } = setup();
    session.setRoomReady(true);
    await session.join();
    session.toggleMute();
    expect(stream.track.enabled).toBe(false);
    expect(session.getSnapshot().muted).toBe(true);
    expect(signaling.events('voice:state')).toEqual([{ muted: true }]);
    expect(transports[0].closed).toBe(false);
    session.toggleMute();
    expect(stream.track.enabled).toBe(true);
    expect(signaling.events('voice:state')).toEqual([{ muted: true }, { muted: false }]);
  });

  it('leave stops the mic, closes peers, tells the server, and returns to idle', async () => {
    const { session, signaling, transports, stream } = setup();
    session.setRoomReady(true);
    await session.join();
    session.leave();
    expect(stream.track.stopped).toBe(true);
    expect(transports[0].closed).toBe(true);
    expect(signaling.events('voice:leave')).toHaveLength(1);
    expect(session.getSnapshot().status).toBe('idle');
  });

  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['NotReadableError', 'device-busy'],
    ['NotFoundError', 'no-device'],
  ])('maps %s to a friendly %s error and allows retry', async (name, kind) => {
    let fail = true;
    const { session, signaling } = setup({
      getUserMedia: async () => {
        if (fail) throw Object.assign(new Error('x'), { name });
        return fakeStream();
      },
    });
    session.setRoomReady(true);
    await session.join();
    expect(session.getSnapshot().status).toBe('idle');
    expect(session.getSnapshot().error?.kind).toBe(kind);
    expect(signaling.events('voice:join')).toHaveLength(0);
    fail = false;
    await session.join();
    expect(session.getSnapshot().status).toBe('connected');
    expect(session.getSnapshot().error).toBeUndefined();
  });

  it('reports unsupported browsers without throwing', async () => {
    const { session } = setup({ supported: false });
    await session.join();
    expect(session.getSnapshot().error?.kind).toBe('unsupported');
  });

  it('shows a disconnected state when the server rejects the join', async () => {
    const { session, signaling, stream } = setup();
    signaling.ackResponse = { ok: false };
    session.setRoomReady(true);
    await session.join();
    expect(session.getSnapshot().status).toBe('disconnected');
    expect(stream.track.stopped).toBe(true);
  });

  it('keeps audio alive through a socket drop and re-announces with a fresh transport on reconnect', async () => {
    const { session, signaling, transports } = setup();
    session.setRoomReady(true);
    await session.join();
    session.toggleMute();

    session.setRoomReady(false);
    expect(session.getSnapshot().status).toBe('reconnecting');
    expect(transports[0].closed).toBe(false);

    signaling.emitted = [];
    signaling.id = 'self-socket-2';
    signaling.ackResponse = { ok: true, peers: [peer('s2', 'u2')] };
    session.setRoomReady(true);
    await vi.waitFor(() => expect(session.getSnapshot().status).toBe('connected'));
    expect(transports[0].closed).toBe(true);
    expect(transports[1].started).toEqual([peer('s2', 'u2')]);
    // Mute state survives the reconnect and is re-announced.
    expect(signaling.events('voice:state')).toEqual([{ muted: true }]);
  });

  it('asks for the current voice list whenever room membership becomes ready', () => {
    const { session, signaling } = setup();
    session.setRoomReady(true);
    expect(signaling.events('voice:sync')).toHaveLength(1);
    signaling.fire('voice:participants', [peer('s2', 'u2')]);
    session.setRoomReady(false);
    expect(session.getSnapshot().participants).toEqual([]);
    session.setRoomReady(true);
    expect(signaling.events('voice:sync')).toHaveLength(2);
  });

  it('syncs the transport with the server list, excluding itself', async () => {
    const { session, signaling, transports } = setup();
    session.setRoomReady(true);
    await session.join();
    signaling.fire('voice:participants', [peer('self-socket', 'me'), peer('s2', 'u2', true)]);
    expect(transports[0].synced.at(-1)).toEqual([peer('s2', 'u2', true)]);
    expect(session.getSnapshot().participants).toHaveLength(2);
  });

  it('tracks remote streams and speaking state from the transport and detector', async () => {
    const { session, transports, detector } = setup();
    session.setRoomReady(true);
    await session.join();
    const remote = fakeStream();
    transports[0].events.onRemoteStream('s2', remote);
    expect(session.getSnapshot().remoteStreams.get('s2')).toBe(remote);
    detector.onChange!('s2', true);
    expect(session.getSnapshot().speaking.has('s2')).toBe(true);
    transports[0].events.onPeerState('s2', 'reconnecting');
    expect(session.getSnapshot().status).toBe('reconnecting');
    transports[0].events.onPeerState('s2', 'connected');
    expect(session.getSnapshot().status).toBe('connected');
    transports[0].events.onRemoteStream('s2', null);
    expect(session.getSnapshot().remoteStreams.size).toBe(0);
    expect(detector.remove).toHaveBeenCalledWith('s2');
  });

  it('stops voice when replaced by another tab', async () => {
    const { session, signaling, stream } = setup();
    session.setRoomReady(true);
    await session.join();
    signaling.fire('voice:replaced');
    expect(stream.track.stopped).toBe(true);
    expect(session.getSnapshot().error?.kind).toBe('replaced');
  });

  it('dispose releases the mic and every socket listener', async () => {
    const { session, signaling, stream, detector } = setup();
    session.setRoomReady(true);
    await session.join();
    session.dispose();
    expect(stream.track.stopped).toBe(true);
    expect(signaling.listenerCount()).toBe(0);
    expect(detector.dispose).toHaveBeenCalled();
  });

  it('drops a mic stream that resolves after the user already left', async () => {
    let resolve!: (s: MediaStream) => void;
    const late = fakeStream();
    const { session, signaling } = setup({ getUserMedia: () => new Promise(r => (resolve = r)) });
    session.setRoomReady(true);
    const joining = session.join();
    session.leave();
    resolve(late);
    await joining;
    expect(late.track.stopped).toBe(true);
    expect(signaling.events('voice:join')).toHaveLength(0);
  });
});

// ---------- VoiceSession: moderation ----------

describe('VoiceSession moderation', () => {
  it('does not request the microphone when the owner has not allowed voice', async () => {
    const getUserMedia = vi.fn();
    const { session } = setup({ getUserMedia });
    session.setRoomReady(true);
    session.setAccess({ canJoinVoice: false, canSpeak: true });
    await session.join();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ status: 'idle', canJoin: false, error: { kind: 'not-allowed' } });
  });

  it('starts muted when the server says so (room join-muted policy)', async () => {
    const { session, signaling, stream } = setup();
    signaling.ackResponse = { ok: true, peers: [], muted: true, forced: false };
    session.setRoomReady(true);
    await session.join();
    expect(stream.track.enabled).toBe(false);
    expect(session.getSnapshot()).toMatchObject({ muted: true, notice: MESSAGES.joinedMuted });
    session.toggleMute(); // self-unmute is allowed under join-muted
    expect(stream.track.enabled).toBe(true);
  });

  it('force mute: mutes immediately, refuses self-unmute, and lifts when the owner allows', async () => {
    const { session, signaling, stream, transports } = setup();
    session.setRoomReady(true);
    await session.join();

    session.setAccess({ canJoinVoice: true, canSpeak: false });
    expect(stream.track.enabled).toBe(false);
    expect(session.getSnapshot()).toMatchObject({ muted: true, canSpeak: false, notice: MESSAGES.forcedMute });
    expect(transports[0].closed).toBe(false); // still connected, just muted

    signaling.emitted = [];
    session.toggleMute();
    expect(stream.track.enabled).toBe(false);
    expect(signaling.events('voice:state')).toEqual([]);

    session.setAccess({ canJoinVoice: true, canSpeak: true });
    expect(session.getSnapshot()).toMatchObject({ muted: true, notice: MESSAGES.allowedToSpeak }); // never hot-mics
    session.toggleMute();
    expect(stream.track.enabled).toBe(true);
    expect(signaling.events('voice:state')).toEqual([{ muted: false }]);
  });

  it('joins already force-muted when the server reports it', async () => {
    const { session, signaling, stream } = setup();
    signaling.ackResponse = { ok: true, peers: [], muted: true, forced: true };
    session.setRoomReady(true);
    session.setAccess({ canJoinVoice: true, canSpeak: false });
    await session.join();
    expect(stream.track.enabled).toBe(false);
    expect(session.getSnapshot().notice).toBe(MESSAGES.joinedForced);
  });

  it('revocation leaves voice, stops the mic and closes peers, but keeps the room', async () => {
    const { session, signaling, stream, transports } = setup();
    session.setRoomReady(true);
    await session.join();
    signaling.fire('voice:revoked', { message: 'The room owner turned off voice for you.' });
    expect(stream.track.stopped).toBe(true);
    expect(transports[0].closed).toBe(true);
    expect(session.getSnapshot()).toMatchObject({ status: 'idle', error: { kind: 'not-allowed', message: 'The room owner turned off voice for you.' } });
    // The client must not send voice:leave for a server-initiated removal…
    expect(signaling.events('voice:leave')).toHaveLength(0);
    // …and the stale error clears once voice is allowed again.
    session.setAccess({ canJoinVoice: false, canSpeak: true });
    session.setAccess({ canJoinVoice: true, canSpeak: true });
    expect(session.getSnapshot().error).toBeUndefined();
    expect(session.getSnapshot().notice).toBe(MESSAGES.voiceAllowed);
  });

  it('losing voice access via room state also leaves voice', async () => {
    const { session, stream } = setup();
    session.setRoomReady(true);
    await session.join();
    session.setAccess({ canJoinVoice: false, canSpeak: true });
    expect(stream.track.stopped).toBe(true);
    expect(session.getSnapshot().status).toBe('idle');
  });

  it('surfaces a server refusal as a not-allowed error rather than a connection failure', async () => {
    const { session, signaling } = setup();
    signaling.ackResponse = { ok: false, error: 'The room owner has not allowed you to use voice.' };
    session.setRoomReady(true);
    await session.join();
    expect(session.getSnapshot()).toMatchObject({ status: 'idle', error: { kind: 'not-allowed' } });
  });
});

// ---------- audio quality ----------

describe('microphone constraints', () => {
  it('asks for echo cancellation, noise suppression, AGC and mono', () => {
    expect(buildAudioConstraints({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: true })).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } },
      video: false,
    });
  });

  it('only requests what the browser supports', () => {
    expect(buildAudioConstraints({ echoCancellation: true, noiseSuppression: true })).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
  });

  it('is what the session actually passes to getUserMedia, once per join', async () => {
    const stream = fakeStream();
    const getUserMedia = vi.fn(async () => stream);
    const { session, signaling } = setup({ getUserMedia });
    session.setRoomReady(true);
    await session.join();
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ video: false, audio: expect.objectContaining({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }) }));
    // A reconnect renegotiates peers but must not open a second microphone.
    session.setRoomReady(false);
    session.setRoomReady(true);
    await vi.waitFor(() => expect(signaling.events('voice:join')).toHaveLength(2));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe('microphone track lifecycle', () => {
  it('leaves voice with a clear message when the microphone disappears', async () => {
    const { session, signaling, stream, transports } = setup();
    session.setRoomReady(true);
    await session.join();
    stream.track.end();
    expect(stream.track.stopped).toBe(true);
    expect(transports[0].closed).toBe(true);
    expect(signaling.events('voice:leave')).toHaveLength(1);
    expect(session.getSnapshot()).toMatchObject({ status: 'idle', error: { kind: 'device-lost' } });
    expect(stream.track.listenerCount()).toBe(0);
  });

  it('removes the ended-listener on a normal leave', async () => {
    const { session, stream } = setup();
    session.setRoomReady(true);
    await session.join();
    session.leave();
    expect(stream.track.listenerCount()).toBe(0);
  });
});

describe('VoiceActivity (speaking indicator)', () => {
  const run = (levels: number[], start = 0) => {
    const vad = new VoiceActivity();
    const states: boolean[] = [];
    levels.forEach((level, i) => { vad.update(level, start + i * 100); states.push(vad.speaking); });
    return { vad, states };
  };

  it('ignores single-poll transients such as keyboard clicks', () => {
    const { states } = run([0.002, 0.2, 0.002, 0.002, 0.25, 0.003, 0.002]);
    expect(states.some(Boolean)).toBe(false);
  });

  it('detects sustained speech and holds briefly between words', () => {
    const { states } = run([0.002, 0.1, 0.12, 0.11, 0.002, 0.002, 0.002, 0.002, 0.002, 0.002]);
    expect(states.slice(0, 2)).toEqual([false, false]);
    expect(states[2]).toBe(true); // onset after two loud polls
    expect(states[5]).toBe(true); // release hold
    expect(states.at(-1)).toBe(false);
  });

  it('adapts to steady background noise (fan) within ~1.5 s but still hears speech over it', () => {
    // Fan noise jitters ±20% around its level, like real broadband noise.
    const fan = Array.from({ length: 40 }, (_, i) => 0.06 * (1 + 0.2 * Math.sin(i * 1.7)));
    const { vad, states } = run(fan);
    expect(states.slice(16).some(Boolean)).toBe(false); // quiet again after the 15-poll window
    vad.update(0.3, 10_000);
    vad.update(0.3, 10_100);
    expect(vad.speaking).toBe(true);
  });

  it('keeps detecting continuous syllabic speech (gaps keep the floor low)', () => {
    // A quiet room, then 3 s of 220 ms syllables with 120 ms gaps, sampled every 100 ms.
    const quiet = Array.from({ length: 15 }, () => 0.001);
    const speech = Array.from({ length: 30 }, (_, i) => ((i * 100) % 340 < 220 ? 0.08 : 0.001));
    const { states } = run([...quiet, ...speech]);
    expect(states.slice(15 + 2).every(Boolean)).toBe(true); // on from the second loud poll, never drops between syllables
  });
});

describe('development diagnostics', () => {
  const report = [
    { id: 'T', type: 'transport', selectedCandidatePairId: 'CP' },
    { id: 'CP', type: 'candidate-pair', currentRoundTripTime: 0.042, localCandidateId: 'L', remoteCandidateId: 'R', state: 'succeeded' },
    { id: 'L', type: 'local-candidate', candidateType: 'host' },
    { id: 'R', type: 'remote-candidate', candidateType: 'srflx' },
    { id: 'C', type: 'codec', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    { id: 'IN', type: 'inbound-rtp', kind: 'audio', codecId: 'C', packetsReceived: 980, packetsLost: 20, jitter: 0.0123, audioLevel: 0.0421, totalSamplesReceived: 100000, concealedSamples: 500 },
    { id: 'OUT', type: 'outbound-rtp', kind: 'audio', codecId: 'C', packetsSent: 1000 },
  ];

  it('summarizes loss, jitter, RTT, level, codec and route', () => {
    expect(summarizeAudioStats('s2', 'connected', report)).toEqual({
      peer: 's2', state: 'connected', codec: 'audio/opus/48000/2',
      packetsReceived: 980, packetsLost: 20, lossPercent: 2, jitterMs: 12.3, audioLevel: 0.042, concealedPercent: 0.5,
      packetsSent: 1000, rttMs: 42, candidatePair: 'host→srflx',
    });
  });

  it('flags duplicate peers/streams, non-Opus codecs and bad networks', () => {
    const issues = diagnose(
      [{ peer: 'a', state: 'connected', codec: 'audio/PCMU', lossPercent: 8, jitterMs: 60, rttMs: 500 }],
      { peerConnections: 3, voicePeers: 2, remoteStreams: 4 },
    );
    expect(issues.join('\n')).toMatch(/duplicate peers/);
    expect(issues.join('\n')).toMatch(/duplicate playback/);
    expect(issues.join('\n')).toMatch(/expected Opus/);
    expect(issues.join('\n')).toMatch(/packet loss/);
    expect(issues.join('\n')).toMatch(/jitter/);
    expect(diagnose([{ peer: 'b', state: 'connected', codec: 'audio/opus', lossPercent: 0.1, jitterMs: 5, rttMs: 40 }], { peerConnections: 1, voicePeers: 1, remoteStreams: 1 })).toEqual([]);
  });
});

// ---------- MeshTransport ----------

class FakePC {
  static instances: FakePC[] = [];
  localDescription: any = null;
  remoteDescription: any = null;
  signalingState = 'stable';
  connectionState = 'new';
  added: any[] = [];
  candidates: any[] = [];
  closed = false;
  onicecandidate: any = null;
  ontrack: any = null;
  onconnectionstatechange: any = null;
  constructor(public config: RTCConfiguration) { FakePC.instances.push(this); }
  addTrack(track: any) { this.added.push(track); }
  async createOffer(opts?: any) { return { type: 'offer', sdp: `offer${opts?.iceRestart ? '-restart' : ''}` }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(d: any) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription(d: any) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; }
  async addIceCandidate(c: any) { this.candidates.push(c); }
  close() { this.closed = true; }
  setState(state: string) { this.connectionState = state; this.onconnectionstatechange?.(); }
}

function mesh() {
  FakePC.instances = [];
  const signaling = new FakeSignaling();
  const events = { onRemoteStream: vi.fn(), onPeerState: vi.fn() };
  const transport = new MeshTransport(signaling, [{ urls: 'stun:x' }], events, FakePC as unknown as typeof RTCPeerConnection);
  return { signaling, events, transport };
}
const flush = () => new Promise(r => setTimeout(r, 0));

describe('MeshTransport', () => {
  it('offers to every existing peer with the configured ICE servers', async () => {
    const { signaling, transport } = mesh();
    transport.start(fakeStream(), [peer('a', 'ua'), peer('b', 'ub')]);
    await flush();
    expect(FakePC.instances).toHaveLength(2);
    expect(FakePC.instances[0].config.iceServers).toEqual([{ urls: 'stun:x' }]);
    expect(FakePC.instances[0].added).toHaveLength(1);
    expect(signaling.events('voice:offer')).toEqual([
      { to: 'a', sdp: { type: 'offer', sdp: 'offer' } },
      { to: 'b', sdp: { type: 'offer', sdp: 'offer' } },
    ]);
  });

  it('answers incoming offers and buffers early ICE candidates', async () => {
    const { signaling, transport } = mesh();
    transport.start(fakeStream(), []);
    signaling.fire('voice:offer', { from: 'n', sdp: { type: 'offer', sdp: 'o' } });
    await flush();
    expect(signaling.events('voice:answer')).toEqual([{ to: 'n', sdp: { type: 'answer', sdp: 'answer' } }]);
    signaling.fire('voice:ice-candidate', { from: 'n', candidate: { candidate: 'c1' } });
    await flush();
    expect(FakePC.instances[0].candidates).toEqual([{ candidate: 'c1' }]);
  });

  it('applies answers and flushes queued candidates', async () => {
    const { signaling, transport } = mesh();
    transport.start(fakeStream(), [peer('a', 'ua')]);
    await flush();
    signaling.fire('voice:ice-candidate', { from: 'a', candidate: { candidate: 'early' } });
    await flush();
    expect(FakePC.instances[0].candidates).toEqual([]);
    signaling.fire('voice:answer', { from: 'a', sdp: { type: 'answer', sdp: 'ans' } });
    await flush();
    expect(FakePC.instances[0].remoteDescription).toEqual({ type: 'answer', sdp: 'ans' });
    expect(FakePC.instances[0].candidates).toEqual([{ candidate: 'early' }]);
  });

  it('restarts ICE as the initiator when a connection fails', async () => {
    const { signaling, transport, events } = mesh();
    transport.start(fakeStream(), [peer('a', 'ua')]);
    await flush();
    FakePC.instances[0].setState('failed');
    await flush();
    expect(events.onPeerState).toHaveBeenCalledWith('a', 'failed');
    expect(signaling.events('voice:offer').at(-1)).toEqual({ to: 'a', sdp: { type: 'offer', sdp: 'offer-restart' } });
    expect(FakePC.instances).toHaveLength(1); // same connection, renegotiated
  });

  it('keeps exactly one connection per peer under repeated offers', async () => {
    const { signaling, transport } = mesh();
    transport.start(fakeStream(), []);
    signaling.fire('voice:offer', { from: 'n', sdp: { type: 'offer', sdp: 'o1' } });
    await flush();
    signaling.fire('voice:offer', { from: 'n', sdp: { type: 'offer', sdp: 'o2' } }); // e.g. an ICE restart / repeated event
    await flush();
    expect(FakePC.instances).toHaveLength(1);
    expect(transport.peerCount()).toBe(1);
    expect(FakePC.instances[0].remoteDescription).toEqual({ type: 'offer', sdp: 'o2' });
  });

  it('replaces (never duplicates) a connection when a peer is offered to twice', async () => {
    const { transport } = mesh();
    transport.start(fakeStream(), [peer('a', 'ua'), peer('a', 'ua')]);
    await flush();
    expect(transport.peerCount()).toBe(1);
    expect(FakePC.instances.filter(pc => !pc.closed)).toHaveLength(1);
  });

  it('reports one stable remote stream per peer even if ontrack fires again', async () => {
    const { transport, events } = mesh();
    transport.start(fakeStream(), [peer('a', 'ua')]);
    await flush();
    const remote = { getTracks: () => [track], addTrack: vi.fn() } as any;
    const track = { kind: 'audio' };
    FakePC.instances[0].ontrack({ streams: [remote], track });
    FakePC.instances[0].ontrack({ streams: [remote], track });
    expect(events.onRemoteStream.mock.calls.filter(([, s]) => s)).toEqual([['a', remote]]);
    expect(transport.connections().get('a')).toBe(FakePC.instances[0]);
  });

  it('sync drops peers that left; close releases everything and unsubscribes', async () => {
    const { signaling, transport, events } = mesh();
    transport.start(fakeStream(), [peer('a', 'ua'), peer('b', 'ub')]);
    await flush();
    transport.sync([peer('b', 'ub')]);
    expect(FakePC.instances[0].closed).toBe(true);
    expect(events.onRemoteStream).toHaveBeenCalledWith('a', null);
    expect(transport.peerCount()).toBe(1);
    transport.close();
    expect(FakePC.instances[1].closed).toBe(true);
    expect(signaling.listenerCount()).toBe(0);
  });
});

// ---------- helpers ----------

describe('voice helpers', () => {
  it('parses ICE servers from env with a safe default', () => {
    expect(parseIceServers(undefined)).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
    expect(parseIceServers('[{"urls":"turn:t","username":"u","credential":"p"}]')).toEqual([{ urls: 'turn:t', username: 'u', credential: 'p' }]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseIceServers('not json')).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
    expect(parseIceServers('[{"nope":1}]')).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  it('computes RMS for speaking detection', () => {
    expect(SpeakingDetector.rms([])).toBe(0);
    expect(SpeakingDetector.rms([0.5, -0.5])).toBeCloseTo(0.5);
  });

  it('falls back to a generic message for unknown media errors', () => {
    expect(describeMediaError(new Error('?')).kind).toBe('failed');
  });
});
