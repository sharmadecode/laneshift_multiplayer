import { PLAYER_MAX_SPEED } from '@hr/shared';

const ENGINE_IDLE = 58; // Hz at standstill
const ENGINE_MAX = 190; // Hz at top speed

/** Procedural engine + crash audio (Web Audio, no assets). */
export class EngineAudio {
  private ctx: AudioContext | null = null;
  private osc1: OscillatorNode | null = null;
  private osc2: OscillatorNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private gain: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private muted = false;
  private lastVol = 0;

  /** Must be called from a user gesture (autoplay policy). */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    this.ctx = ctx;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 520;
    filter.Q.value = 0.9;

    const gain = ctx.createGain();
    gain.gain.value = 0;
    filter.connect(gain);
    gain.connect(ctx.destination);
    this.filter = filter;
    this.gain = gain;

    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    o1.frequency.value = ENGINE_IDLE;
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.value = ENGINE_IDLE * 0.5;
    const g2 = ctx.createGain();
    g2.gain.value = 0.45;
    o1.connect(filter);
    o2.connect(g2);
    g2.connect(filter);
    o1.start();
    o2.start();
    this.osc1 = o1;
    this.osc2 = o2;
    this.setSpeed(0);
  }

  setSpeed(speed: number): void {
    if (!this.ctx || this.muted) return;
    const f = ENGINE_IDLE + (ENGINE_MAX - ENGINE_IDLE) * Math.min(1, speed / PLAYER_MAX_SPEED);
    const t = this.ctx.currentTime;
    this.osc1?.frequency.setTargetAtTime(f, t, 0.06);
    this.osc2?.frequency.setTargetAtTime(f * 0.5 + 2, t, 0.06);
    this.filter?.frequency.setTargetAtTime(380 + f * 3.4, t, 0.06);
    this.setVol(0.05 + 0.05 * Math.min(1, speed / PLAYER_MAX_SPEED));
  }

  crash(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (!this.noiseBuf) {
      const len = Math.floor(ctx.sampleRate * 0.5);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      }
      this.noiseBuf = buf;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 850;
    const g = ctx.createGain();
    src.connect(f);
    f.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.55, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    src.start();
    src.stop(ctx.currentTime + 0.55);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.setVol(m ? 0 : this.lastVol);
  }

  suspend(): void {
    this.setVol(0);
  }

  resume(): void {
    if (this.muted) return;
    this.setVol(this.lastVol);
  }

  private setVol(v: number): void {
    this.lastVol = v;
    if (this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    }
  }
}
