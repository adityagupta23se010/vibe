/**
 * Microphone constraints for voice chat. The browser's built-in processing
 * (acoustic echo cancellation, noise suppression, automatic gain) is what
 * keeps fan/keyboard noise and speaker echo out of the call; mono capture
 * matches what Opus voice uses and avoids stereo upmix artefacts.
 *
 * Only constraints the browser reports as supported are requested, and
 * channelCount is a preference (`ideal`), so no browser fails the request
 * with OverconstrainedError over it.
 */
export function buildAudioConstraints(
  supported: MediaTrackSupportedConstraints = typeof navigator !== 'undefined' && navigator.mediaDevices?.getSupportedConstraints
    ? navigator.mediaDevices.getSupportedConstraints()
    : {},
): MediaStreamConstraints {
  // An empty map means "unknown" (old browser / test env): request everything and let the browser ignore what it lacks.
  const known = Object.keys(supported).length > 0;
  const has = (key: keyof MediaTrackSupportedConstraints) => !known || !!supported[key];
  const audio: MediaTrackConstraints = {};
  if (has('echoCancellation')) audio.echoCancellation = true;
  if (has('noiseSuppression')) audio.noiseSuppression = true;
  if (has('autoGainControl')) audio.autoGainControl = true;
  if (has('channelCount')) audio.channelCount = { ideal: 1 };
  return { audio, video: false };
}
