const POLL_MS = 100;

/**
 * Voice-activity decision for one audio source, fed one RMS level per poll.
 *
 * - Adaptive noise floor: steady background noise (fans, hum) raises the
 *   floor, so it stops counting as speech after a moment.
 * - Onset: the level must stay above threshold for ONSET_POLLS consecutive
 *   polls, so short transients (keyboard clicks, a tapped desk) are ignored.
 * - Release: speech must stay quiet for RELEASE_MS before the indicator
 *   turns off, so it doesn't flicker between words.
 */
export class VoiceActivity {
  static readonly MIN_THRESHOLD = 0.015; // RMS — never call anything quieter than this speech
  static readonly FLOOR_RATIO = 2.5; // speech must be this many times louder than the noise floor
  static readonly ONSET_POLLS = 2;
  static readonly RELEASE_MS = 450;

  speaking = false;
  private floor = VoiceActivity.MIN_THRESHOLD / VoiceActivity.FLOOR_RATIO;
  private loudPolls = 0;
  private quietSince = 0;

  /** Returns true when the speaking state changed. */
  update(level: number, now: number): boolean {
    // Floor drops quickly to quiet levels and creeps up slowly under sustained noise
    // (speech is bursty, so it barely moves the floor).
    this.floor = level < this.floor ? this.floor + (level - this.floor) * 0.3 : this.floor + (level - this.floor) * 0.01;
    const threshold = Math.max(VoiceActivity.MIN_THRESHOLD, this.floor * VoiceActivity.FLOOR_RATIO);
    const loud = level > threshold;
    this.loudPolls = loud ? this.loudPolls + 1 : 0;
    if (loud) this.quietSince = now;

    const next = this.speaking
      ? loud || now - this.quietSince < VoiceActivity.RELEASE_MS
      : this.loudPolls >= VoiceActivity.ONSET_POLLS;
    if (next === this.speaking) return false;
    this.speaking = next;
    return true;
  }
}

type Source = { node: MediaStreamAudioSourceNode; analyser: AnalyserNode; buffer: Float32Array<ArrayBuffer>; vad: VoiceActivity };

/**
 * Client-side voice-activity detection via the Web Audio API. Levels are never
 * sent anywhere; only on/off transitions reach `onChange`, so React re-renders
 * a few times per utterance rather than on every audio frame.
 */
export class SpeakingDetector {
  private ctx: AudioContext | null = null;
  private sources = new Map<string, Source>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly onChange: (id: string, speaking: boolean) => void) {}

  static rms(samples: ArrayLike<number>) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return samples.length ? Math.sqrt(sum / samples.length) : 0;
  }

  add(id: string, stream: MediaStream) {
    this.remove(id);
    const AudioCtx = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx || !stream.getAudioTracks().length) return;
    this.ctx ??= new AudioCtx();
    void this.ctx.resume?.().catch(() => undefined);
    const node = this.ctx.createMediaStreamSource(stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    // Analysis only — deliberately never connected to ctx.destination, so
    // the local mic is never played back and remote audio is never doubled.
    node.connect(analyser);
    this.sources.set(id, { node, analyser, buffer: new Float32Array(analyser.fftSize), vad: new VoiceActivity() });
    this.timer ??= setInterval(() => this.poll(), POLL_MS);
  }

  remove(id: string) {
    const source = this.sources.get(id);
    if (!source) return;
    source.node.disconnect();
    this.sources.delete(id);
    if (source.vad.speaking) this.onChange(id, false);
    if (!this.sources.size) this.stopTimer();
  }

  dispose() {
    for (const id of [...this.sources.keys()]) this.remove(id);
    this.stopTimer();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  private stopTimer() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private poll() {
    const now = Date.now();
    for (const [id, source] of this.sources) {
      source.analyser.getFloatTimeDomainData(source.buffer);
      if (source.vad.update(SpeakingDetector.rms(source.buffer), now)) this.onChange(id, source.vad.speaking);
    }
  }
}
