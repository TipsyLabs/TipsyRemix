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
