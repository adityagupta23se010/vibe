import { memo, useEffect, useRef } from 'react';

function StreamAudio({ stream, silenced }: { stream: MediaStream; silenced: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    // Autoplay can be blocked until the user interacts; joining voice is a click, so this normally succeeds.
    void el.play().catch(() => undefined);
    return () => {
      el.pause();
      el.srcObject = null;
    };
  }, [stream]);
  // Defense in depth for owner force-mutes: in a mesh call the server cannot
  // stop a tampered client from sending audio, so receivers refuse to play it.
  useEffect(() => {
    if (ref.current) ref.current.muted = silenced;
  }, [silenced]);
  return <audio ref={ref} autoPlay playsInline />;
}

/**
 * One hidden <audio> per remote peer, keyed by socket id so React reuses the
 * element across renders and removes it when the peer leaves. The local
 * microphone is never played back.
 */
export const RemoteAudio = memo(function RemoteAudio({ streams, silenced }: { streams: ReadonlyMap<string, MediaStream>; silenced: ReadonlySet<string> }) {
  return (
    <div hidden aria-hidden>
      {[...streams].map(([socketId, stream]) => (
        <StreamAudio key={socketId} stream={stream} silenced={silenced.has(socketId)} />
      ))}
    </div>
  );
});
