// Automatisch aus app.js (WORKLET_CODE) erzeugt – nicht von Hand ändern, sondern: node build.js

class KeyLockProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  // Ein einziger Lesekopf läuft mit Faktor "pitch" über eine Delay-Line und korrigiert so die
  // Tonhöhe. Weil er dabei vom Schreibkopf wegdriftet, springt er laufend in kleinen Schritten
  // (meist 3–8 ms) zurück bzw. vor – aber nur in Lücken ohne Anschlag (Anschläge werden in drei
  // Bändern ~50 ms vorher erkannt) und an der Stelle, an der die Wellenform am besten passt.
  // Kleine Sprünge passen auch in dichte Musik; ein großer Sprung pro Beat erwischte dort
  // fast immer einen Anschlag, der dann doppelt kam. Vor jedem Kick/Snare richtet er sich
  // so aus, dass der Schlag genau mit der festen Verzögerung D0 herauskommt (gut für Sync).
  constructor() {
    super();
    const sr = sampleRate;
    this.N = 1 << 16;                                   // Ringpuffer (≈ 1,4 s)
    this.mask = this.N - 1;
    this.L = new Float32Array(this.N);
    this.R = new Float32Array(this.N);
    this.M = new Float32Array(this.N);                  // Mono-Summe für die Korrelation
    this.CH = 64;                                       // Rahmen der Anschlagserkennung
    this.onsets = new Uint8Array(this.N / this.CH);     // 0 nichts, 1 leicht, 2 kräftig
    this.lowLvl = new Uint8Array(this.N / this.CH);     // Bass-Lautstärke je Rahmen (0–255 relativ zur Spitze)
    this.chMask = this.N / this.CH - 1;
    // drei Bänder: Bass (< 300 Hz), Gesamt, Höhen (> 3 kHz)
    this.aLo = 1 - Math.exp(-2 * Math.PI * 300 / sr);
    this.aHi = 1 - Math.exp(-2 * Math.PI * 3000 / sr);
    this.lo = 0; this.lp3k = 0;
    this.eLo = 0; this.eAll = 0; this.eHi = 0;
    this.hLo = new Float32Array(8); this.hAll = new Float32Array(8); this.hHi = new Float32Array(8);
    this.hI = 0;
    this.pkLo = 0; this.pkAll = 0; this.pkHi = 0;
    this.prevStrong = false;
    this.w = 0;                                         // nächste Schreibposition (absolut)
    this.D0 = Math.round(0.05 * sr);                    // Soll-Verzögerung (für alle Decks gleich)
    this.pos = -this.D0;                                // Lesekopf (absolut, gebrochen)
    this.old = null;                                    // ausblendender Lesekopf beim Sprung
    this.xf = 0;
    this.Lc = Math.round(0.006 * sr);                   // Überblendung beim Sprung
    this.Wc = Math.round(0.008 * sr);                   // Vergleichsfenster für die Korrelation
    this.S = Math.round(0.003 * sr);                    // Suchbereich ± um das Sprungziel
    // im lauten Bass (Kick-Körper, Basslinie) muss die Phase einer ganzen Schwingung passen:
    this.Sbig = Math.round(0.010 * sr);
    this.WcBig = Math.round(0.016 * sr);
    this.lowQuiet = 0.2 * 255;                          // darunter gilt der Bass als leise
    this.margin = this.S + Math.round(0.002 * sr);
    // nur den Anschlag selbst schützen: bei so kleinen Sprüngen ist ein wiederholtes Stück
    // aus dem Ausklang unhörbar, ein langer Schutz ließe in dichter Musik keine Lücken übrig
    this.protectStrong = Math.round(0.015 * sr);
    this.protectWeak = Math.round(0.006 * sr);
    this.soft = 0.0025 * sr;                            // ab dieser Abweichung nachführen
    this.step = 0.003 * sr;                             // so weit über die Mitte hinaus springen
    this.pending = null;                                // kräftiger Anschlag, auf den ausgerichtet wird
    this.ref = new Float32Array(this.WcBig);
    this.offs = new Int32Array(this.WcBig);
  }
  read(buf, pos) {
    const i = Math.floor(pos), f = pos - i, m = this.mask;
    return buf[i & m] * (1 - f) + buf[(i + 1) & m] * f;
  }
  // Darf zwischen den absoluten Positionen a und b gesprungen werden?
  // strongOnly: leichte Anschläge (Hi-Hats) ignorieren – zweite Wahl, bevor ein Sprung erzwungen wird
  hasOnset(a, b, strongOnly) {
    const CH = this.CH, cs = Math.floor((a - this.protectStrong) / CH), cw = Math.floor((a - this.protectWeak) / CH);
    const c1 = Math.floor(b / CH);
    for (let c = cs; c <= c1; c++) {
      const f = this.onsets[c & this.chMask];
      if (f === 2 || (f === 1 && c >= cw && !strongOnly)) return true;
    }
    return false;
  }
  // ist der Bass zwischen a und b leise? (dann reicht ein kleiner Sprung ohne Phasen-Suche)
  bassQuiet(a, b) {
    const c0 = Math.floor(a / this.CH), c1 = Math.floor(b / this.CH);
    for (let c = c0; c <= c1; c++) if (this.lowLvl[c & this.chMask] > this.lowQuiet) return false;
    return true;
  }
  regionFree(target, strongOnly) {
    return !this.hasOnset(Math.min(this.pos, target) - this.margin, Math.max(this.pos, target) + this.Lc + this.margin, strongOnly);
  }
  // Sprung zum Ziel; genaue Stelle per Korrelation mit dem, was der alte Kopf gleich spielt
  splice(target, p, wide) {
    const Wc = wide ? this.WcBig : this.Wc, S = wide ? this.Sbig : this.S;
    const ref = this.ref, offs = this.offs, M = this.M, m = this.mask;
    const p0 = Math.round(this.pos);
    for (let i = 0; i < Wc; i += 2) { offs[i] = Math.round(i * p); ref[i] = M[(p0 + offs[i]) & m]; }
    const lim = this.w - Math.ceil(Wc * p) - 2;        // nichts lesen, was noch nicht geschrieben ist
    const t0 = Math.round(target);
    const score = (c, step) => {
      let dot = 0, en = 1e-9;
      for (let i = 0; i < Wc; i += step) { const v = M[(c + offs[i]) & m]; dot += ref[i] * v; en += v * v; }
      return dot / Math.sqrt(en);
    };
    // grob (jede 4. Stelle, jedes 4. Sample), dann fein um den besten Treffer – spart Rechenzeit
    const cs = wide ? 4 : 2;
    let best = t0, bestScore = -Infinity;
    for (let c = t0 - S; c <= t0 + S && c <= lim; c += cs) {
      const sc = score(c, 4);
      if (sc > bestScore) { bestScore = sc; best = c; }
    }
    const coarse = best;
    bestScore = -Infinity;
    for (let c = coarse - cs; c <= coarse + cs && c <= lim; c++) {
      const sc = score(c, 2);
      if (sc > bestScore) { bestScore = sc; best = c; }
    }
    this.old = { pos: this.pos };
    this.pos = best + (this.pos - p0);                  // Nachkommaanteil behalten
    this.xf = 0;
  }
  detect(sample) {
    // Rahmen abgeschlossen: Energie je Band gegen die 8 Rahmen davor und gegen die letzten Spitzen
    const CH = this.CH;
    const eLo = this.eLo / CH, eAll = this.eAll / CH, eHi = this.eHi / CH;
    let aLo = 0, aAll = 0, aHi = 0;
    for (let k = 0; k < 8; k++) { aLo += this.hLo[k]; aAll += this.hAll[k]; aHi += this.hHi[k]; }
    aLo /= 8; aAll /= 8; aHi /= 8;
    this.pkLo = Math.max(eLo, this.pkLo * 0.9995);
    this.pkAll = Math.max(eAll, this.pkAll * 0.9995);
    this.pkHi = Math.max(eHi, this.pkHi * 0.9995);
    const strong = eLo > 5 * aLo + 1e-9 && eLo > 0.1 * this.pkLo;
    // (Schwebungen zwischen Tönen lassen die Energie auch ohne Anschlag pulsieren –
    //  deshalb deutliche Sprünge und Mindestlautstärke relativ zu den letzten Spitzen)
    const weak = strong
      || (eAll > 4 * aAll + 1e-9 && eAll > 0.02 * this.pkAll)
      || (eHi > 4 * aHi + 1e-9 && eHi > 0.05 * this.pkHi);
    const ci = ((this.w / CH) - 1) & this.chMask;
    this.onsets[ci] = strong ? 2 : weak ? 1 : 0;
    this.lowLvl[ci] = Math.min(255, Math.round(255 * eLo / (this.pkLo + 1e-12)));
    if (strong && !this.prevStrong) this.pending = this.w - CH;   // neuer Kick/Snare → darauf ausrichten
    this.prevStrong = strong;
    const j = this.hI++ & 7;
    this.hLo[j] = eLo; this.hAll[j] = eAll; this.hHi[j] = eHi;
    this.eLo = this.eAll = this.eHi = 0;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const iL = inp[0], iR = inp[1] || inp[0];
    const n = oL.length, p = params.pitch[0], sr = sampleRate;

    if (!this.old) {
      const D = this.w - this.pos;                     // aktuelle Verzögerung in Samples
      const dev = D - this.D0;
      let done = false;
      // 1) Kick/Snare im Anmarsch: so springen, dass genau dieser Schlag mit D0 herauskommt
      if (this.pending !== null) {
        const q = this.pending;
        this.pending = null;
        const target = q - p * (this.D0 - (this.w - q));
        const safe = target + this.Lc * p + this.margin < q && this.pos < q - this.margin;
        if (Math.abs(target - this.pos) > 0.0005 * sr && safe && this.regionFree(target)) {
          this.splice(target, p, !this.bassQuiet(Math.min(this.pos, target), Math.max(this.pos, target) + this.Wc));
          done = true;
        }
      }
      // 2) laufend in kleinen Schritten nachführen, wenn die Lücke frei ist
      if (!done) {
        const R = Math.min(0.04, 0.008 + 0.3 * Math.abs(1 - p)) * sr;   // spätestens hier wird gesprungen
        let want = null;
        if (dev > this.soft && p <= 1) want = this.D0 - this.step;
        else if (dev < -this.soft && p >= 1) want = this.D0 + this.step;
        else if (Math.abs(dev) > this.soft) want = this.D0;            // Tempo wurde umgestellt
        if (want !== null) {
          const target = this.w - want;
          const forced = Math.abs(dev) >= R || D < 2 * this.WcBig;
          const relaxed = Math.abs(dev) >= 0.4 * R;          // lange nichts gefunden: Hi-Hats/Bass in Kauf nehmen
          const quiet = this.bassQuiet(Math.min(this.pos, target), Math.max(this.pos, target) + this.Wc);
          // 1. Wahl: freie Lücke mit leisem Bass → kleiner Sprung
          // 2. Wahl: nur kräftige Anschläge meiden → Sprung mit Phasen-Suche über eine Bass-Schwingung
          if (!relaxed && !forced) { if (quiet && this.regionFree(target)) this.splice(target, p, false); }
          else if (forced || this.regionFree(target, true)) this.splice(target, p, !quiet);
        }
      }
    }

    const m = this.mask, CH = this.CH, aLo = this.aLo, aHi = this.aHi;
    for (let i = 0; i < n; i++) {
      const xl = iL ? iL[i] : 0, xr = iR ? iR[i] : 0, x = xl + xr;
      const wi = this.w & m;
      this.L[wi] = xl;
      this.R[wi] = xr;
      this.M[wi] = x;
      this.lo += aLo * (x - this.lo);
      this.lp3k += aHi * (x - this.lp3k);
      const hi = x - this.lp3k;
      this.eLo += this.lo * this.lo;
      this.eAll += x * x;
      this.eHi += hi * hi;
      this.w++;
      if ((this.w & (CH - 1)) === 0) this.detect();

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
      if (this.pending !== null) this.pending -= shift;
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
