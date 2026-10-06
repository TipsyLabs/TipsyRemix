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

// Vinyl-Scratch: spielt den Track an der Position, an der der Finger war –
// vorwärts, rückwärts, Stillstand. Jede Fingerposition kommt mit ihrem
// Zeitpunkt; der Player fährt diese Punkte mit kleinem Versatz als glatte
// Bewegung nach. So klingt es auch dann sauber, wenn der Touchscreen nur
// 60–120 Positionen pro Sekunde und unregelmäßig liefert.
// Der Versatz passt sich dem Gerät an: Er wird gemessen (wie spät kommen die
// Punkte an, wie groß sind die Abstände) – auf dem iPad läuft die Audio-Uhr
// in größeren Schritten als am PC, ein fester Wert war dort zu knapp.
const SCRATCH_DELAY_MIN = 0.015, SCRATCH_DELAY_MAX = 0.12, SCRATCH_DELAY_START = 0.06;
const SCRATCH_COAST = 0.03;   // kommt ein Fingerpunkt doch zu spät: so lange in gleicher Richtung weiterlaufen
class ScratchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.l = null; this.r = null; this.len = 0;
    this.pts = [];                                       // [Zeit (s), Position (Samples)]
    this.vel = 0;                                        // letzte Fingergeschwindigkeit (Samples/s)
    this.p = 0;                                          // gespielte Position (Samples)
    this.ks = 1 - Math.exp(-1 / (0.004 * sampleRate));   // Ecken abrunden (~4 ms)
    this.g = 0; this.gt = 0;                             // Ein-/Ausblenden gegen Klicks
    this.hx = [0, 0]; this.hy = [0, 0];                  // Gleichspannungsfilter
    this.lp = [0, 0, 0, 0];                              // Anti-Aliasing (2 Pole je Kanal)
    this.speed = 0;                                      // Tempo im letzten Block (1 = normal)
    this.delay = SCRATCH_DELAY_START;                    // aktueller Versatz (s)
    this.late = 0; this.gap = 0;                         // gemessene Verspätung / Punktabstand (Spitzenwerte)
    this.fresh = true;                                   // erste Bewegung nach dem Anfassen?
    this.port.onmessage = e => {
      const m = e.data;
      if (m.type === 'load') { this.l = m.l; this.r = m.r; this.len = m.l.length; this.gt = 0; this.g = 0; }
      else if (m.type === 'unload') { this.l = this.r = null; this.len = 0; this.gt = 0; this.g = 0; }
      else if (m.type === 'start') { this.p = m.pos * sampleRate; this.pts = [[m.time, this.p]]; this.vel = 0; this.gt = 1; this.fresh = true; }
      else if (m.type === 'move') {
        for (const [t, pos] of m.pts) {
          const last = this.pts[this.pts.length - 1];
          if (last && t > last[0]) this.gap = Math.max(this.gap, Math.min(0.05, t - last[0]));
          if (!last || t > last[0]) this.pts.push([t, pos * sampleRate]);
          else last[1] = pos * sampleRate;               // gleicher Zeitpunkt: nur Position erneuern
        }
        const newest = m.pts[m.pts.length - 1][0];
        this.late = Math.max(this.late, currentTime - newest);
        const want = this.wantDelay();
        // Beim ersten Ziehen steht die Platte noch → Versatz darf sofort springen
        if (this.fresh) { this.delay = Math.max(want, this.delay); this.fresh = false; }
        else if (want > this.delay + 0.03) this.delay = want;
      }
      else if (m.type === 'stop') { this.gt = 0; }
    };
  }
  wantDelay() {
    return Math.min(SCRATCH_DELAY_MAX, Math.max(SCRATCH_DELAY_MIN, this.late + this.gap + 0.004));
  }
  // Fingerposition zum Zeitpunkt t (linear zwischen zwei Fingerpunkten;
  // fehlt der nächste Punkt noch, kurz mit der letzten Geschwindigkeit weiter)
  targetAt(t) {
    const P = this.pts;
    while (P.length > 1 && P[1][0] <= t) {
      this.vel = (P[1][1] - P[0][1]) / Math.max(1e-4, P[1][0] - P[0][0]);
      P.shift();
    }
    const a = P[0];
    if (t <= a[0]) return a[1];
    if (P.length === 1) return a[1] + this.vel * Math.min(t - a[0], SCRATCH_COAST);
    const b = P[1];
    return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
  }
  process(inputs, outputs) {
    const out = outputs[0], oL = out[0], oR = out[1] || out[0];
    if (!this.l || !this.pts.length || (this.gt === 0 && this.g < 1e-4)) { oL.fill(0); oR.fill(0); this.g = 0; return true; }
    const L = this.l, R = this.r, n = this.len, s = 1 / 32768, hx = this.hx, hy = this.hy, lp = this.lp;
    // Versatz nachführen: wachsen darf er immer, aber langsam (≤ 1,5 % Tempo, beim Scratchen unhörbar);
    // schrumpfen und schnell anpassen nur, solange die Platte (fast) steht.
    // Spitzenwerte vergessen langsam (≈ 4 ms pro Sekunde).
    this.late = Math.max(-0.05, this.late - 0.00001);
    this.gap = Math.max(0, this.gap - 0.00001);
    const diff = this.wantDelay() - this.delay;
    if (this.speed < 0.05) this.delay += Math.max(-0.0005, Math.min(0.0005, diff));
    else if (diff > 0) this.delay += Math.min(0.00004, diff);
    const N = oL.length, t0 = currentTime - this.delay, dt = 1 / sampleRate;
    // Tiefpass passend zur Geschwindigkeit: schnell gescratcht = sonst metallisches Aliasing
    const pStart = this.p;
    const fc = Math.min(20000, Math.max(300, 18000 / Math.max(1, this.speed)));
    const a = 1 - Math.exp(-2 * Math.PI * fc / sampleRate);
    for (let i = 0; i < N; i++) {
      this.p += (this.targetAt(t0 + i * dt) - this.p) * this.ks;
      this.g += (this.gt - this.g) * 0.004;
      const p = this.p;
      let x = 0, y = 0;
      if (p >= 0 && p < n - 1) {
        const j = p | 0, f = p - j;
        x = (L[j] + (L[j + 1] - L[j]) * f) * s;
        y = (R[j] + (R[j + 1] - R[j]) * f) * s;
      }
      lp[0] += (x - lp[0]) * a; lp[1] += (lp[0] - lp[1]) * a;
      lp[2] += (y - lp[2]) * a; lp[3] += (lp[2] - lp[3]) * a;
      x = lp[1]; y = lp[3];
      // Hochpass ~10 Hz: Stillstand der Platte = Stille statt Gleichspannung
      const ya = x - hx[0] + 0.9987 * hy[0]; hx[0] = x; hy[0] = ya;
      const yb = y - hx[1] + 0.9987 * hy[1]; hx[1] = y; hy[1] = yb;
      oL[i] = ya * this.g;
      oR[i] = yb * this.g;
    }
    this.speed = Math.abs(this.p - pStart) / N;
    return true;
  }
}
registerProcessor('scratch', ScratchProcessor);
