// Automatisch aus app.js (WORKLET_CODE) erzeugt – nicht von Hand ändern, sondern: node build.js

class KeyLockProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.size = 1 << 15;
    this.mask = this.size - 1;
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)];
    this.w = 0;
    this.G = 2 * Math.round(sampleRate * 0.03);   // grain ~60 ms
    this.phase = 0;
    this.mix = 0;
  }
  read(ch, pos) {
    const i = Math.floor(pos), f = pos - i, b = this.buf[ch], m = this.mask;
    return b[i & m] * (1 - f) + b[(i + 1) & m] * f;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const iL = inp[0], iR = inp[1] || inp[0];
    const p = params.pitch[0];
    const shifting = Math.abs(p - 1) > 1e-4;
    const target = shifting ? 1 : 0;
    const G = this.G, half = G / 2, step = (1 - p) / G, mask = this.mask;
    const bL = this.buf[0], bR = this.buf[1];
    for (let i = 0; i < oL.length; i++) {
      const w = this.w;
      bL[w] = iL ? iL[i] : 0;
      bR[w] = iR ? iR[i] : 0;
      const d = (w - half) & mask;
      let l = bL[d], r = bR[d];
      if (shifting || this.mix > 0) {
        let sl = 0, sr = 0;
        for (let h = 0; h < 2; h++) {
          let ph = this.phase + h * 0.5;
          if (ph >= 1) ph -= 1;
          const s = Math.sin(Math.PI * ph);
          const win = s * s;
          const pos = w - ph * G + this.size;
          sl += win * this.read(0, pos);
          sr += win * this.read(1, pos);
        }
        if (this.mix !== target) {
          this.mix = target > this.mix ? Math.min(1, this.mix + 1 / 1024) : Math.max(0, this.mix - 1 / 1024);
        }
        l += (sl - l) * this.mix;
        r += (sr - r) * this.mix;
      }
      if (shifting) {
        this.phase += step;
        this.phase -= Math.floor(this.phase);
      }
      oL[i] = l;
      oR[i] = r;
      this.w = (w + 1) & mask;
    }
    return true;
  }
}
registerProcessor('keylock', KeyLockProcessor);

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.L = new Float32Array(8192);
    this.R = new Float32Array(8192);
    this.n = 0;
    this.port.onmessage = e => {
      if (e.data === 'start') { this.n = 0; this.on = true; }
      else if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (!this.n) return;
    this.port.postMessage({ l: this.L.slice(0, this.n), r: this.R.slice(0, this.n) });
    this.n = 0;
  }
  process(inputs) {
    if (!this.on) return true;
    const inp = inputs[0];
    const l = inp[0], r = inp[1] || inp[0];
    for (let i = 0; i < 128; i++) {
      this.L[this.n] = l ? l[i] : 0;
      this.R[this.n] = r ? r[i] : 0;
      this.n++;
    }
    if (this.n >= this.L.length) this.flush();
    return true;
  }
}
registerProcessor('recorder', RecorderProcessor);

// Vinyl-Scratch: spielt den Track an einer Position, die dem Finger folgt –
// vorwärts, rückwärts, Stillstand. Geschwindigkeit (= Tonhöhe) ergibt sich
// aus der Fingerbewegung, wie bei einer Platte unter der Hand.
class ScratchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.l = null; this.r = null; this.len = 0;
    this.p = 0; this.t = 0;                              // Position / Ziel in Samples
    this.k = 1 - Math.exp(-1 / (0.016 * sampleRate));    // Trägheit der Platte ~16 ms
    this.g = 0; this.gt = 0;                             // Ein-/Ausblenden gegen Klicks
    this.hx = [0, 0]; this.hy = [0, 0];                  // Gleichspannungsfilter
    this.port.onmessage = e => {
      const m = e.data;
      if (m.type === 'load') { this.l = m.l; this.r = m.r; this.len = m.l.length; this.gt = 0; this.g = 0; }
      else if (m.type === 'start') { this.p = this.t = m.pos * sampleRate; this.gt = 1; }
      else if (m.type === 'target') { this.t = m.pos * sampleRate; }
      else if (m.type === 'stop') { this.gt = 0; }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0], oL = out[0], oR = out[1] || out[0];
    if (!this.l || (this.gt === 0 && this.g < 1e-4)) { oL.fill(0); oR.fill(0); this.g = 0; return true; }
    const L = this.l, R = this.r, n = this.len, s = 1 / 32768, hx = this.hx, hy = this.hy;
    for (let i = 0; i < oL.length; i++) {
      this.p += (this.t - this.p) * this.k;
      this.g += (this.gt - this.g) * 0.004;
      const p = this.p;
      let a = 0, b = 0;
      if (p >= 0 && p < n - 1) {
        const j = p | 0, f = p - j;
        a = (L[j] + (L[j + 1] - L[j]) * f) * s;
        b = (R[j] + (R[j + 1] - R[j]) * f) * s;
      }
      // Hochpass ~10 Hz: Stillstand der Platte = Stille statt Gleichspannung
      const ya = a - hx[0] + 0.9987 * hy[0]; hx[0] = a; hy[0] = ya;
      const yb = b - hx[1] + 0.9987 * hy[1]; hx[1] = b; hy[1] = yb;
      oL[i] = ya * this.g;
      oR[i] = yb * this.g;
    }
    return true;
  }
}
registerProcessor('scratch', ScratchProcessor);
