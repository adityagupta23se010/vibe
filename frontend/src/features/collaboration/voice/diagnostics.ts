/**
 * Development-only WebRTC diagnostics. Nothing here is shown to LMS users or
 * sent to the server; it is logged to the console and exposed on
 * `window.__vibeVoice` while running `vite dev`.
 */

export type PeerAudioStats = {
  peer: string;
  state: RTCPeerConnectionState;
  codec?: string;
  /** Inbound (what we hear from this peer). */
  packetsReceived?: number;
  packetsLost?: number;
  lossPercent?: number;
  jitterMs?: number;
  /** 0..1, as reported by the browser for the received track. */
  audioLevel?: number;
  /** Samples the jitter buffer had to invent — audible as glitches when it climbs. */
  concealedPercent?: number;
  /** Outbound (what this peer hears from us). */
  packetsSent?: number;
  rttMs?: number;
  candidatePair?: string;
};

// getStats() entries are a loose union of dictionaries that varies by browser.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Stat = Record<string, any> & { id: string; type: string };

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Reduces a getStats() report to the handful of numbers that explain call quality. Pure, for testing. */
export function summarizeAudioStats(peer: string, state: RTCPeerConnectionState, report: Iterable<Stat>): PeerAudioStats {
  const stats = [...report];
  const byId = new Map(stats.map(s => [s.id, s]));
  const summary: PeerAudioStats = { peer, state };

  const inbound = stats.find(s => s.type === 'inbound-rtp' && (s.kind ?? s.mediaType) === 'audio');
  if (inbound) {
    summary.packetsReceived = inbound.packetsReceived;
    summary.packetsLost = inbound.packetsLost;
    const total = (inbound.packetsReceived ?? 0) + Math.max(0, inbound.packetsLost ?? 0);
    if (total > 0) summary.lossPercent = round((100 * Math.max(0, inbound.packetsLost ?? 0)) / total, 2);
    if (typeof inbound.jitter === 'number') summary.jitterMs = round(inbound.jitter * 1000);
    if (typeof inbound.audioLevel === 'number') summary.audioLevel = round(inbound.audioLevel, 3);
    if (inbound.totalSamplesReceived > 0 && typeof inbound.concealedSamples === 'number')
      summary.concealedPercent = round((100 * inbound.concealedSamples) / inbound.totalSamplesReceived, 2);
    const codec = inbound.codecId && byId.get(inbound.codecId);
    if (codec?.mimeType) summary.codec = `${codec.mimeType}${codec.clockRate ? `/${codec.clockRate}` : ''}${codec.channels ? `/${codec.channels}` : ''}`;
  }

  const outbound = stats.find(s => s.type === 'outbound-rtp' && (s.kind ?? s.mediaType) === 'audio');
  if (outbound) {
    summary.packetsSent = outbound.packetsSent;
    if (!summary.codec && outbound.codecId && byId.get(outbound.codecId)?.mimeType) summary.codec = byId.get(outbound.codecId)!.mimeType;
  }

  // RTT from the selected candidate pair (falls back to remote-inbound-rtp).
  const transport = stats.find(s => s.type === 'transport' && s.selectedCandidatePairId);
  const pair = (transport && byId.get(transport.selectedCandidatePairId)) ?? stats.find(s => s.type === 'candidate-pair' && (s.selected || s.nominated) && s.state === 'succeeded');
  if (pair) {
    if (typeof pair.currentRoundTripTime === 'number') summary.rttMs = round(pair.currentRoundTripTime * 1000);
    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    if (local && remote) summary.candidatePair = `${local.candidateType}→${remote.candidateType}`; // "relay" means TURN is in use
  }
  if (summary.rttMs === undefined) {
    const remoteInbound = stats.find(s => s.type === 'remote-inbound-rtp' && (s.kind ?? 'audio') === 'audio');
    if (typeof remoteInbound?.roundTripTime === 'number') summary.rttMs = round(remoteInbound.roundTripTime * 1000);
  }
  return summary;
}

/** Problems worth a console warning while developing — the usual root causes of "noisy" calls. */
export function diagnose(stats: PeerAudioStats[], counts: { peerConnections: number; voicePeers: number; remoteStreams: number }) {
  const issues: string[] = [];
  if (counts.peerConnections > counts.voicePeers) issues.push(`more peer connections (${counts.peerConnections}) than remote voice participants (${counts.voicePeers}) — possible duplicate peers`);
  if (counts.remoteStreams > counts.peerConnections) issues.push(`more remote streams (${counts.remoteStreams}) than peer connections — possible duplicate playback`);
  for (const s of stats) {
    if (s.codec && !/opus/i.test(s.codec)) issues.push(`${s.peer}: negotiated ${s.codec}, expected Opus`);
    if ((s.lossPercent ?? 0) > 3) issues.push(`${s.peer}: ${s.lossPercent}% packet loss`);
    if ((s.jitterMs ?? 0) > 30) issues.push(`${s.peer}: ${s.jitterMs} ms jitter`);
    if ((s.rttMs ?? 0) > 300) issues.push(`${s.peer}: ${s.rttMs} ms round-trip`);
    if ((s.concealedPercent ?? 0) > 5) issues.push(`${s.peer}: ${s.concealedPercent}% concealed audio (glitches)`);
  }
  return issues;
}

export type DiagnosticsSource = {
  connections: () => ReadonlyMap<string, RTCPeerConnection>;
  voicePeers: () => number;
  remoteStreams: () => number;
};

/** Polls getStats() for every peer while voice is active. Only constructed when import.meta.env.DEV. */
export class VoiceDiagnostics {
  private timer?: ReturnType<typeof setInterval>;
  latest: PeerAudioStats[] = [];

  constructor(private readonly source: DiagnosticsSource, private readonly intervalMs = 5000) {}

  start() {
    this.stop();
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
    (globalThis as { __vibeVoice?: unknown }).__vibeVoice = this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async sample() {
    const connections = [...this.source.connections()];
    this.latest = await Promise.all(
      connections.map(async ([peer, pc]) => summarizeAudioStats(peer, pc.connectionState, (await pc.getStats()).values() as Iterable<Stat>)),
    );
    const issues = diagnose(this.latest, { peerConnections: connections.length, voicePeers: this.source.voicePeers(), remoteStreams: this.source.remoteStreams() });
    if (this.latest.length) console.debug('[voice] stats', this.latest);
    issues.forEach(issue => console.warn('[voice]', issue));
    return { stats: this.latest, issues };
  }
}
