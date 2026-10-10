export const MAX_RECORDING_SECONDS = 6;

// Encode the microphone samples, with a sample-accurate cap even if a mobile
// browser delays its stop timer. WAV also avoids codec differences on replay.
export function encodeRecording(buffer) {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = Math.min(buffer.length, Math.floor(buffer.sampleRate * MAX_RECORDING_SECONDS));
  if (!channels || frames < buffer.sampleRate * 0.1) throw new Error('Recording too short');
  const bytes = new ArrayBuffer(44 + frames * channels * 2);
  const view = new DataView(bytes);
  const text = (offset, value) => [...value].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, 'data');
  view.setUint32(40, frames * channels * 2, true);
  const samples = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, samples[channel][frame] || 0));
      view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true); offset += 2;
    }
  }
  return { blob: new Blob([bytes], { type: 'audio/wav' }), duration: frames / buffer.sampleRate };
}

export function createClipRecorder({ decode, onState, onTick, onComplete, onError,
  mediaDevices = globalThis.navigator?.mediaDevices, Recorder = globalThis.MediaRecorder,
  now = () => performance.now(), schedule = setTimeout, unschedule = clearTimeout }) {
  let session;
  const release = current => {
    unschedule(current.limit); unschedule(current.tick);
    for (const track of current.stream?.getTracks() || []) {
      track.removeEventListener('ended', current.interrupted);
      track.stop();
    }
  };
  const cancel = () => {
    const current = session; session = null;
    if (!current) return;
    release(current);
    if (current.recorder?.state !== 'inactive') { try { current.recorder?.stop(); } catch {} }
  };
  const fail = (current, error) => {
    if (session !== current) return;
    cancel(); onError(error);
  };
  const stop = () => {
    const current = session;
    if (!current || current.stopping || !current.recorder) return;
    current.stopping = true;
    onState('processing');
    try { if (current.recorder.state !== 'inactive') current.recorder.stop(); }
    catch (error) { fail(current, error); }
    finally { release(current); }
  };
  const start = async () => {
    cancel();
    const current = { chunks: [], stopping: false }; session = current;
    if (!mediaDevices?.getUserMedia || !Recorder) {
      fail(current, new DOMException('Microphone recording unavailable', 'NotSupportedError')); return;
    }
    onState('requesting');
    try {
      current.stream = await mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 1 } }, video: false });
      if (session !== current) { release(current); return; }
      const mimeType = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(type => Recorder.isTypeSupported?.(type));
      const recorder = new Recorder(current.stream, mimeType ? { mimeType } : {});
      current.recorder = recorder;
      current.interrupted = () => fail(current, new Error('Microphone interrupted'));
      for (const track of current.stream.getTracks()) track.addEventListener('ended', current.interrupted, { once: true });
      recorder.ondataavailable = event => { if (session === current && event.data.size) current.chunks.push(event.data); };
      recorder.onerror = event => fail(current, event.error || new Error('Recording failed'));
      recorder.onstop = async () => {
        release(current);
        if (session !== current) return;
        onState('processing');
        try {
          const blob = new Blob(current.chunks, { type: recorder.mimeType || current.chunks[0]?.type });
          if (!blob.size) throw new Error('Empty recording');
          const buffer = await decode(await blob.arrayBuffer());
          if (session !== current) return;
          const result = encodeRecording(buffer);
          session = null; onComplete(result);
        } catch (error) { fail(current, error); }
      };
      recorder.start(); current.started = now();
      onState('recording');
      current.limit = schedule(stop, MAX_RECORDING_SECONDS * 1000);
      const tick = () => {
        if (session !== current || current.stopping) return;
        const elapsed = Math.min(MAX_RECORDING_SECONDS, (now() - current.started) / 1000);
        onTick(elapsed);
        if (elapsed >= MAX_RECORDING_SECONDS) stop();
        else current.tick = schedule(tick, 50);
      };
      tick();
    } catch (error) { fail(current, error); }
  };
  return { start, stop, cancel };
}
