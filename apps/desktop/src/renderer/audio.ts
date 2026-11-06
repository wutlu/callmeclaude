// Call audio: microphone → PCM16 16 kHz frames to the hub; hub's PCM16 24 kHz → speakers.
import { MIC_SAMPLE_RATE, SPEAKER_SAMPLE_RATE } from '@callmeclaude/protocol';
import { floatToPcm16, pcm16ToFloat } from '../shared.ts';

// Collects 40 ms of microphone audio per message (the AudioContext resamples the mic to 16 kHz).
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${MIC_SAMPLE_RATE / 25}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('tap', Tap);
`;

export class CallAudio {
  private mic?: MediaStream;
  private inCtx?: AudioContext;
  private outCtx?: AudioContext;
  private playAt = 0;
  private sources = new Set<AudioBufferSourceNode>();
  muted = false;

  constructor(private send: (pcm: Uint8Array) => void) {}

  async start() {
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.inCtx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await this.inCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this.inCtx.createMediaStreamSource(this.mic);
    const tap = new AudioWorkletNode(this.inCtx, 'tap');
    // Muted still streams (silence): the hub treats a silent socket as a dropped call.
    tap.port.onmessage = (e) => this.send(floatToPcm16(this.muted ? new Float32Array((e.data as Float32Array).length) : e.data));
    src.connect(tap);
    this.outCtx = new AudioContext({ sampleRate: SPEAKER_SAMPLE_RATE });
    this.playAt = 0;
  }

  /** Queue the assistant's audio right after what is already playing. */
  play(data: ArrayBuffer) {
    const ctx = this.outCtx;
    if (!ctx) return;
    const f = pcm16ToFloat(data);
    if (!f.length) return;
    const buf = ctx.createBuffer(1, f.length, SPEAKER_SAMPLE_RATE);
    buf.getChannelData(0).set(f);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.05, this.playAt);
    node.start(at);
    this.playAt = at + buf.duration;
    this.sources.add(node);
    node.onended = () => this.sources.delete(node);
  }

  /** The developer interrupted: drop what has not been heard yet. */
  flush() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
    }
    this.sources.clear();
    this.playAt = 0;
  }

  stop() {
    this.flush();
    this.mic?.getTracks().forEach((t) => t.stop());
    void this.inCtx?.close();
    void this.outCtx?.close();
    this.mic = this.inCtx = this.outCtx = undefined;
  }
}

/** A soft two-tone ring while Claude calls this computer. */
export class Ringer {
  private ctx?: AudioContext;
  private timer?: number;

  start() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    const ring = () => {
      const ctx = this.ctx!;
      for (const [i, f] of [440, 554].entries()) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        const t = ctx.currentTime + i * 0.35;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.15, t + 0.03);
        g.gain.linearRampToValueAtTime(0, t + 0.3);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + 0.32);
      }
    };
    ring();
    this.timer = window.setInterval(ring, 2500);
  }

  stop() {
    clearInterval(this.timer);
    void this.ctx?.close();
    this.ctx = undefined;
  }
}
