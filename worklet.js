// Automatisch aus app.js (WORKLET_CODE) erzeugt – nicht von Hand ändern, sondern: node build.js

class KeyLockProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  // Ein einziger Lesekopf läuft mit Faktor "pitch" über eine Delay-Line und korrigiert so die
  // Tonhöhe. Weil er dabei langsam vom Schreibkopf wegdriftet, springt er ab und zu zurück
  // (oder vor). Diese Sprünge setzt er nur dorthin, wo im übersprungenen/wiederholten Stück
  // kein Anschlag (Kick, Snare, Hi-Hat) liegt, und an die Stelle, an der die Wellenform am
  // besten passt (Korrelation) – so wird kein Schlag doppelt gespielt oder verschluckt.
  // Kommt ein kräftiger Schlag (Kick/Snare) herein, springt er kurz davor so, dass genau
  // dieser Schlag mit der Soll-Verzögerung herauskommt: die Schläge bleiben auf dem Grid
  // (wichtig für den Sync mit dem anderen Deck), der Sprung liegt im leisen Ende des Beats.
  constructor() {
    super();
    this.N = 1 << 16;                                   // Ringpuffer (≈ 1,4 s)
    this.mask = this.N - 1;
    this.L = new Float32Array(this.N);
    this.R = new Float32Array(this.N);
    this.CH = 64;                                       // Rahmen der Anschlagserkennung
    this.onsets = new Uint8Array(this.N / this.CH);
    this.chMask = this.N / this.CH - 1;
    this.chE = 0;
    this.hist = new Float32Array(8);
    this.histI = 0;
    // Kick/Snare erkennt man am Bass-/Mittenanteil, Hi-Hats haben dort kaum Energie
    this.lpA = 1 - Math.exp(-2 * Math.PI * 400 / sampleRate);
    this.lp = 0;
    this.chLow = 0;
    this.histLow = new Float32Array(8);
    this.prevFlag = 0;
    this.peakLow = 0;                                    // langsam fallende Spitzen der Energie
    this.peakAll = 0;
    this.w = 0;                                         // nächste Schreibposition (absolut)
    this.D0 = Math.round(0.05 * sampleRate);            // Soll-Verzögerung (für alle Decks gleich)
    this.pos = -this.D0;                                // Lesekopf (absolut, gebrochen)
    this.old = null;                                    // ausblendender Lesekopf beim Sprung
    this.xf = 0;
    this.Lc = Math.round(0.008 * sampleRate);           // Überblendung beim Sprung
    this.Wc = Math.round(0.010 * sampleRate);           // Vergleichsfenster für die Korrelation
    this.S = Math.round(0.004 * sampleRate);            // Suchbereich ± um das Sprungziel
    this.margin = this.S + Math.round(0.003 * sampleRate);
    this.protectStrong = Math.round(0.06 * sampleRate);   // nach Kick/Snare: Ausklang schützen
    this.protectWeak = Math.round(0.015 * sampleRate);    // nach Hi-Hat & Co.
    this.ref = new Float32Array(this.Wc);
    this.pending = null;                                // kräftiger Anschlag, auf den ausgerichtet wird
  }
  read(buf, pos) {
    const i = Math.floor(pos), f = pos - i, m = this.mask;
    return buf[i & m] * (1 - f) + buf[(i + 1) & m] * f;
  }
  mono(pos) { return this.read(this.L, pos) + this.read(this.R, pos); }
  // Darf zwischen den absoluten Positionen a und b gesprungen werden? Nicht, wenn dort ein
  // Anschlag liegt oder das Stück noch im Ausklang eines Anschlags kurz davor steckt.
  hasOnset(a, b) {
    const CH = this.CH, cs = Math.floor((a - this.protectStrong) / CH), cw = Math.floor((a - this.protectWeak) / CH);
    const c1 = Math.floor(b / CH);
    for (let c = cs; c <= c1; c++) {
      const f = this.onsets[c & this.chMask];
      if (f === 2 || (f === 1 && c >= cw)) return true;
    }
    return false;
  }
  // Sprung zum Ziel; genaue Stelle per Korrelation mit dem, was der alte Kopf gleich spielt
  splice(target, p) {
    const Wc = this.Wc, ref = this.ref;
    for (let i = 0; i < Wc; i++) ref[i] = this.mono(this.pos + i * p);
    let best = target, bestScore = -Infinity;
    const lim = this.w - Wc * p - 2;                  // nichts lesen, was noch nicht geschrieben ist
    for (let c = target - this.S; c <= target + this.S; c += 2) {
      if (c > lim) break;
      let dot = 0, en = 1e-9;
      for (let i = 0; i < Wc; i += 2) { const v = this.mono(c + i * p); dot += ref[i] * v; en += v * v; }
      const sc = dot / Math.sqrt(en);
      if (sc > bestScore) { bestScore = sc; best = c; }
    }
    this.old = { pos: this.pos };
    this.pos = best;
    this.xf = 0;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const iL = inp[0], iR = inp[1] || inp[0];
    const n = oL.length, p = params.pitch[0], sr = sampleRate;

    // Kräftiger Anschlag im Anmarsch: so springen, dass er genau mit Verzögerung D0 herauskommt
    if (this.pending !== null && !this.old) {
      const q = this.pending;
      this.pending = null;
      // Leseposition r, ab der der Kopf (Faktor p) den Anschlag q nach (D0 - Alter) Samples erreicht
      const target = q - p * (this.D0 - (this.w - q));
      const jump = Math.abs(target - this.pos);
      const safe = target + this.Lc * p + this.margin < q && this.pos < q - this.margin;
      if (jump > 0.0005 * sr && safe &&
          !this.hasOnset(Math.min(this.pos, target) - this.margin, Math.max(this.pos, target) + this.Lc + this.margin)) {
        this.splice(target, p);
      }
    }

    // Sprung nötig/erlaubt? (zu Beginn jedes Blocks, nicht während einer Überblendung)
    if (!this.old) {
      const D = this.w - this.pos;                     // aktuelle Verzögerung in Samples
      const dev = (D - this.D0) / sr;
      const R = Math.min(0.035, 0.006 + 0.2 * Math.abs(1 - p));   // erlaubte Abweichung (s)
      let want = null;
      // erst ab der halben erlaubten Abweichung springen (seltener, dafür passend platziert)
      if (p < 1 - 1e-6) { if (dev > 0.5 * R) want = this.D0 - 0.6 * R * sr; }
      else if (p > 1 + 1e-6) { if (dev < -0.5 * R) want = this.D0 + 0.6 * R * sr; }
      else if (Math.abs(dev) > 0.001) want = this.D0;
      if (want !== null) {
        const target = this.w - want;
        const forced = Math.abs(dev) >= R || D < 2 * this.Wc;
        const a = Math.min(this.pos, target) - this.margin;
        const b = Math.max(this.pos, target) + this.Lc + this.margin;
        if (forced || !this.hasOnset(a, b)) this.splice(target, p);
      }
    }

    const m = this.mask, CH = this.CH;
    for (let i = 0; i < n; i++) {
      // schreiben + Anschläge erkennen (Energie eines 64er-Rahmens gegen die 8 davor)
      const xl = iL ? iL[i] : 0, xr = iR ? iR[i] : 0;
      const wi = this.w & m;
      this.L[wi] = xl;
      this.R[wi] = xr;
      this.chE += xl * xl + xr * xr;
      this.lp += this.lpA * (xl + xr - this.lp);
      this.chLow += this.lp * this.lp;
      this.w++;
      if ((this.w & (CH - 1)) === 0) {
        const e = this.chE / CH, el = this.chLow / CH;
        let avg = 0, avgLow = 0;
        for (let k = 0; k < 8; k++) { avg += this.hist[k]; avgLow += this.histLow[k]; }
        avg /= 8;
        avgLow /= 8;
        // 2 = kräftig (Bass/Mitten springen: Kick, Snare), 1 = leicht (Hi-Hat & Co.)
        this.peakLow = Math.max(el, this.peakLow * 0.9995);
        this.peakAll = Math.max(e, this.peakAll * 0.9995);
        // Schwebungen zwischen Tönen lassen die Energie auch ohne Anschlag pulsieren –
        // deshalb deutlicher Sprung UND eine Mindestlautstärke relativ zu den letzten Spitzen
        const flag = el > 6 * avgLow + 1e-8 && el > 0.1 * this.peakLow ? 2
          : e > 4 * avg + 1e-8 && e > 0.02 * this.peakAll ? 1 : 0;
        this.histLow[this.histI & 7] = el;
        this.chLow = 0;
        this.onsets[((this.w / CH) - 1) & this.chMask] = flag;
        // neuer kräftiger Anschlag (der vorige Rahmen war noch keiner) → darauf ausrichten
        if (flag === 2 && this.prevFlag !== 2) this.pending = this.w - CH;
        this.prevFlag = flag;
        this.hist[this.histI++ & 7] = e;
        this.chE = 0;
      }
      // lesen
      let l = this.read(this.L, this.pos), r = this.read(this.R, this.pos);
      this.pos += p;
      if (this.old) {
        const g = this.xf / this.Lc;
        l = l * g + this.read(this.L, this.old.pos) * (1 - g);
        r = r * g + this.read(this.R, this.old.pos) * (1 - g);
        this.old.pos += p;
        if (++this.xf >= this.Lc) this.old = null;
      }
      oL[i] = l;
      oR[i] = r;
    }
    // Positionen klein halten (Vielfache der Puffergröße abziehen ändert nichts am Inhalt)
    if (this.w > 1e9) {
      const shift = (Math.floor(this.w / this.N) - 1) * this.N;
      this.w -= shift;
      this.pos -= shift;
      if (this.old) this.old.pos -= shift;
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
