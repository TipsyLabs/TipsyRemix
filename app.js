'use strict';

/* =========================================================
   TipsyRemix – 2-Deck DJ im Browser (Web Audio API)
   ========================================================= */

const AC = window.AudioContext || window.webkitAudioContext;
// Hardware-Samplerate nutzen (iPad: 48 kHz) – MP3 kann 44,1 und 48 kHz
const ctx = new AC({ latencyHint: 'interactive' });
// iOS: als Musik-Wiedergabe abspielen (auch bei Stummschalter)
try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) { /* egal */ }

const RES = 150;                        // Wellenform-Buckets pro Sekunde
const TEMPO_RANGES = [0.08, 0.16, 0.5];
const HOTCUE_COLORS = ['#ff4d6d', '#ffd23f', '#3ddc97', '#b388ff'];
const LOOP_BEATS = [1, 2, 4, 8, 16];
const EQ_LOW_X = 250;                   // Trennfrequenz Bass/Mitten (Hz)
const EQ_HIGH_X = 2500;                 // Trennfrequenz Mitten/Höhen (Hz)
const ECHO_MAX_DELAY = 8;               // s (1 Takt bei 30 BPM)
const ECHO_FEEDBACK = 0.5;              // jede Wiederholung -6 dB
const ECHO_WET = 0.9;
const ECHO_LEN_MIN = 1;                 // Ausklingzeit (s), einstellbar per Fader
const ECHO_LEN_MAX = 5;
const ECHO_LEN_DEFAULT = 3;
const COLOR_STEPS = 32;
const WAVE_COLORS = Array.from({ length: COLOR_STEPS }, (_, i) => {
  const low = i / (COLOR_STEPS - 1);    // 0 = Höhen (cyan), 1 = Bass (orange)
  return `hsl(${Math.round(190 - low * 172)}, 92%, ${Math.round(60 - low * 6)}%)`;
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Skalierung der ganzen Konsole (siehe „Ein Bildschirm“ am Ende); Canvas in voller Schärfe rendern
let uiScale = 1;
// Wellenform-Modus: 'smudge' (Scrub/Pitch-Bend) oder 'vinyl' (Scratch) – pro Gerät gemerkt
let waveMode = 'smudge';
try { if (localStorage.getItem('tipsyremix.waveMode') === 'vinyl') waveMode = 'vinyl'; } catch (_) { /* egal */ }
const canvasDpr = () => (window.devicePixelRatio || 1) * Math.max(1, uiScale);
const mod = (a, n) => ((a % n) + n) % n;
const dbToGain = db => Math.pow(10, db / 20);
// EQ-Knopf: ganz links = 0 (Kill), Mitte = 0 dB, ganz rechts = +6 dB
const eqGain = v => (v <= -0.99 ? 0 : v < 0 ? (1 + v) * (1 + v) : dbToGain(v * 6));
// Filter-Knopf: links Low-Pass 20 kHz → 20 Hz, rechts High-Pass 20 Hz → 20 kHz,
// auf den letzten 15 % wird zusätzlich ausgeblendet → am Anschlag komplett stumm
const filterFreq = v => (v < 0 ? 20000 * Math.pow(0.001, -v) : 20 * Math.pow(1000, v));
const filterMuteGain = v => clamp((1 - Math.abs(v)) / 0.15, 0, 1);

function fmtTime(s) {
  const t = Math.floor(Math.max(0, s) * 10);
  const m = Math.floor(t / 600);
  const sec = Math.floor(t / 10) % 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec}.${t % 10}`;
}

function setText(el, s) {
  if (el._t !== s) { el.textContent = s; el._t = s; }
}

/* ---------------- Master-Bus ---------------- */

const master = ctx.createGain();
master.gain.value = 0.8;
const limiter = ctx.createDynamicsCompressor();
limiter.threshold.value = -1.5;
limiter.knee.value = 0;
limiter.ratio.value = 20;
limiter.attack.value = 0.003;
limiter.release.value = 0.12;
const masterAnalyser = ctx.createAnalyser();
masterAnalyser.fftSize = 1024;
const recDest = ctx.createMediaStreamDestination();
master.connect(limiter);
limiter.connect(masterAnalyser);
masterAnalyser.connect(ctx.destination);
limiter.connect(recDest);

/* ---------------- AudioWorklets: Key Lock + MP3-Aufnahme ----------------
   Key Lock: Die Quelle läuft mit geändertem Tempo (und damit geänderter Tonhöhe);
   dieser Prozessor verschiebt die Tonhöhe um 1/Tempo zurück. Zwei
   überblendete Leseköpfe auf einer Delay-Line (Granular-Pitch-Shift).
   Ohne Pitch-Änderung läuft das Signal über eine gleich lange reine
   Verzögerung, damit beide Decks immer dieselbe Latenz haben (Sync!).
   Recorder: sammelt das Master-Signal als PCM und schickt es in Blöcken
   an die Seite, wo es live zu MP3 kodiert wird. */

const WORKLET_CODE = `
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
// Zeitpunkt; der Player fährt diese Punkte mit 25 ms Versatz als glatte
// Bewegung nach. So klingt es auch dann sauber, wenn der Touchscreen nur
// 60–120 Positionen pro Sekunde und unregelmäßig liefert.
const SCRATCH_DELAY = 0.025;
const SCRATCH_COAST = 0.03;   // kommt ein Fingerpunkt zu spät: so lange in gleicher Richtung weiterlaufen
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
    this.port.onmessage = e => {
      const m = e.data;
      if (m.type === 'load') { this.l = m.l; this.r = m.r; this.len = m.l.length; this.gt = 0; this.g = 0; }
      else if (m.type === 'start') { this.p = m.pos * sampleRate; this.pts = [[m.time, this.p]]; this.vel = 0; this.gt = 1; }
      else if (m.type === 'move') {
        for (const [t, pos] of m.pts) {
          const last = this.pts[this.pts.length - 1];
          if (!last || t > last[0]) this.pts.push([t, pos * sampleRate]);
          else last[1] = pos * sampleRate;               // gleicher Zeitpunkt: nur Position erneuern
        }
      }
      else if (m.type === 'stop') { this.gt = 0; }
    };
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
    const N = oL.length, t0 = currentTime - SCRATCH_DELAY, dt = 1 / sampleRate;
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
`;

let recNode = null;

// Auf file:// blockiert Chrome Blob-URLs für Worklets, data:-URLs gehen aber.
async function loadWorklets() {
  if (!ctx.audioWorklet) throw new Error('AudioWorklet nicht verfügbar');
  const urls = [
    // gehostet (z. B. auf claude.ai): eigene Datei neben der Seite
    ...(location.protocol.startsWith('http') ? ['worklet.js'] : []),
    'data:text/javascript;charset=utf-8,' + encodeURIComponent(WORKLET_CODE),
    URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'text/javascript' })),
  ];
  let lastErr;
  for (const url of urls) {
    try { await ctx.audioWorklet.addModule(url); return; } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

async function setupWorklets(decks) {
  try {
    await loadWorklets();
  } catch (err) {
    console.warn('AudioWorklets nicht verfügbar:', err);
    for (const d of decks) d.el.keylock.title = 'Key Lock wird von diesem Browser nicht unterstützt';
    return;
  }
  for (const d of decks) {
    d.keyLock = true;   // standardmäßig an
    d.el.keylock.classList.add('on');
    d.el.keylock.disabled = false;
    d.attachKeyLock(new AudioWorkletNode(ctx, 'keylock', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    }));
    try {
      d.attachScratch(new AudioWorkletNode(ctx, 'scratch', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      }));
    } catch (err) {
      console.warn('Vinyl-Scratch nicht verfügbar:', err);
    }
  }
  recNode = new AudioWorkletNode(ctx, 'recorder', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    channelCount: 2, channelCountMode: 'explicit',
  });
  const silent = ctx.createGain();
  silent.gain.value = 0;
  limiter.connect(recNode);
  recNode.connect(silent);
  silent.connect(ctx.destination);   // damit der Recorder sicher mitläuft
  document.body.dataset.worklets = 'ok';
}

// Safari gibt Audio erst nach einer Berührung frei – bei jeder Geste nachhaken
const unlockAudio = () => { if (ctx.state !== 'running') ctx.resume(); };
for (const ev of ['pointerdown', 'touchend', 'click', 'keydown']) {
  document.addEventListener(ev, unlockAudio, { passive: true, capture: true });
}
// iPad: Pinch-Zoom der ganzen Seite verhindern (Pinch auf der Wellenform zoomt die Wellenform)
document.addEventListener('gesturestart', e => e.preventDefault());

/* ---------------- Analyse: Wellenform + BPM ---------------- */

function analyze(buffer) {
  const sr = buffer.sampleRate, len = buffer.length;
  const c0 = buffer.getChannelData(0);
  const c1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : c0;
  const n = Math.ceil(len * RES / sr);
  const amp = new Float32Array(n);
  const lowQ = new Uint8Array(n);
  const lowE = new Float32Array(n);
  const a = 1 - Math.exp(-2 * Math.PI * 200 / sr);   // Einpol-Tiefpass ~200 Hz
  const spb = sr / RES;
  let y = 0, total = 0, maxAmp = 0;

  for (let b = 0; b < n; b++) {
    const s0 = Math.floor(b * spb), s1 = Math.min(len, Math.floor((b + 1) * spb));
    let mx = 0, sx = 0, sy = 0;
    for (let i = s0; i < s1; i++) {
      const x = (c0[i] + c1[i]) * 0.5;
      y += a * (x - y);
      const ax = x < 0 ? -x : x;
      if (ax > mx) mx = ax;
      sx += x * x;
      sy += y * y;
    }
    amp[b] = mx;
    const ratio = sx > 0 ? Math.sqrt(sy / sx) : 0;
    lowQ[b] = Math.round(clamp((ratio - 0.1) / 0.8, 0, 1) * (COLOR_STEPS - 1));
    lowE[b] = sy;
    total += sx;
    if (mx > maxAmp) maxAmp = mx;
  }
  if (maxAmp > 0) for (let b = 0; b < n; b++) amp[b] /= maxAmp;

  const rms = Math.sqrt(total / Math.max(1, len));
  const { bpm, firstBeat } = detectBpm(lowE, RES);
  return { amp, lowQ, rms, bpm, firstBeat };
}

function detectBpm(lowE, fr) {
  const n = lowE.length;
  if (n < fr * 10) return { bpm: null, firstBeat: 0 };

  // Onset-Hüllkurve aus der Bass-Energie
  const on = new Float32Array(n);
  let prev = Math.sqrt(lowE[0]);
  for (let i = 1; i < n; i++) {
    const v = Math.sqrt(lowE[i]);
    const d = v - prev;
    on[i] = d > 0 ? d : 0;
    prev = v;
  }

  // Grob: Autokorrelation über max. 60 s aus der Mitte des Tracks
  const segLen = Math.min(n, Math.floor(fr * 60));
  const s0 = Math.floor((n - segLen) / 2);
  let mean = 0;
  for (let i = 0; i < segLen; i++) mean += on[s0 + i];
  mean /= segLen;
  const seg = new Float32Array(segLen);
  for (let i = 0; i < segLen; i++) seg[i] = on[s0 + i] - mean;

  const maxLag = Math.min(segLen - 2, Math.ceil(4 * 60 * fr / 70) + 2);
  const ac = new Float32Array(maxLag + 2);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0, m = segLen - lag; i < m; i++) s += seg[i] * seg[i + lag];
    ac[lag] = s / (segLen - lag);
  }
  const acAt = x => {
    const i = Math.floor(x);
    if (i + 1 > maxLag) return 0;
    const f = x - i;
    return ac[i] * (1 - f) + ac[i + 1] * f;
  };

  let best = 0, bestScore = -Infinity;
  for (let bpm = 70; bpm <= 185; bpm += 0.25) {
    const lag = 60 * fr / bpm;
    let s = 0;
    for (let k = 1; k <= 4; k++) s += acAt(lag * k);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 0.6, 2));
    s = s > 0 ? s * prior : s / prior;
    if (s > bestScore) { bestScore = s; best = bpm; }
  }
  if (!(bestScore > 0)) return { bpm: null, firstBeat: 0 };

  // Fein: Kamm über den ganzen Track liefert Tempo + Phase (Beatgrid)
  const sm = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) sm[i] = on[i] + 0.5 * (on[i - 1] + on[i + 1]);
  const comb = bpm => {
    const P = 60 * fr / bpm;
    let bestS = -1, bestPh = 0;
    for (let ph = 0; ph < P; ph++) {
      let s = 0, c = 0;
      for (let t = ph; t < n - 1; t += P) { s += sm[Math.round(t)]; c++; }
      s /= Math.max(1, c);
      if (s > bestS) { bestS = s; bestPh = ph; }
    }
    return { s: bestS, ph: bestPh };
  };

  let fine = best, fineRes = comb(best);
  for (let bpm = best - 0.5; bpm <= best + 0.5; bpm += 0.02) {
    const r = comb(bpm);
    if (r.s > fineRes.s) { fineRes = r; fine = bpm; }
  }
  const rounded = Math.round(fine);
  if (Math.abs(fine - rounded) < 0.06) { fine = rounded; fineRes = comb(fine); }
  return { bpm: Math.round(fine * 100) / 100, firstBeat: fineRes.ph / fr };
}

/* ---------------- UI-Bausteine: Knob & Fader ----------------
   Funktionieren gleich mit Maus, Stift und Finger (Pointer Events).
   Doppeltipp/Doppelklick setzt zurück. */

const KNOB_DRAG_PX = 220;   // so viele Pixel Wischweg = ganzer Regelweg

// Erkennt einen Doppeltipp: zwei kurze Taps ohne Ziehen, nah beieinander
function doubleTapDetector(onDoubleTap) {
  let last = 0, lx = 0, ly = 0;
  return (e, moved) => {
    const now = performance.now();
    if (moved) { last = 0; return; }
    if (now - last < 350 && Math.hypot(e.clientX - lx, e.clientY - ly) < 40) {
      last = 0;
      onDoubleTap();
    } else {
      last = now; lx = e.clientX; ly = e.clientY;
    }
  };
}

function createKnob({ label, min = -1, max = 1, value = 0, def = value, bipolar = false, format = v => v.toFixed(2), onInput }) {
  const el = document.createElement('div');
  el.className = 'knob';
  el.innerHTML = `<div class="knob-wrap"><div class="knob-ring"></div><div class="knob-dial"></div></div>
    <div class="knob-label"><span class="knob-name">${label}</span><span class="knob-value"></span></div>`;
  const wrap = el.querySelector('.knob-wrap');
  const ring = el.querySelector('.knob-ring');
  const dial = el.querySelector('.knob-dial');
  const valEl = el.querySelector('.knob-value');
  let v = value;

  const render = () => {
    const t = (v - min) / (max - min);
    const ang = -135 + t * 270;
    dial.style.transform = `rotate(${ang}deg)`;
    let s, l;
    if (bipolar) { if (ang >= 0) { s = 0; l = ang; } else { s = 360 + ang; l = -ang; } }
    else { s = 225; l = t * 270; }
    ring.style.background =
      `conic-gradient(from ${s}deg, var(--accent) 0deg ${l}deg, transparent ${l}deg 360deg),` +
      `conic-gradient(from 225deg, var(--track) 0deg 270deg, transparent 270deg 360deg)`;
    valEl.textContent = format(v);
    el.classList.toggle('changed', v !== def);
  };
  const set = (nv, emit = true) => {
    nv = clamp(nv, min, max);
    if (bipolar && Math.abs(nv - def) < (max - min) * 0.015) nv = def;
    v = nv;
    render();
    if (emit && onInput) onInput(v);
  };
  const tap = doubleTapDetector(() => set(def));

  // Ziehen nach rechts dreht nach rechts, nach links dreht nach links –
  // proportional zum Weg. Mit Maus/Stift zählt zusätzlich hoch/runter.
  wrap.addEventListener('pointerdown', e => {
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY, startV = v;
    const useY = e.pointerType !== 'touch';
    let moved = false;
    el.classList.add('active');
    const move = ev => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      const d = dx - (useY ? dy : 0);
      set(startV + d / KNOB_DRAG_PX * (max - min) * (ev.shiftKey ? 0.2 : 1));
    };
    const up = ev => {
      wrap.removeEventListener('pointermove', move);
      wrap.removeEventListener('pointerup', up);
      wrap.removeEventListener('pointercancel', up);
      el.classList.remove('active');
      if (ev.type === 'pointerup') tap(ev, moved);
    };
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerup', up);
    wrap.addEventListener('pointercancel', up);
  });
  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    set(v - Math.sign(e.deltaY) * (max - min) / 50);
  }, { passive: false });

  el.setValue = (nv, emit = false) => set(nv, emit);
  el.getValue = () => v;
  render();
  return el;
}

function createFader({ orient = 'v', min = 0, max = 1, value = 0, def = value, center = false, onInput, onCut }) {
  const el = document.createElement('div');
  el.className = `fader ${orient}`;
  el.innerHTML = `<div class="fader-rail">${center ? '<div class="fader-center"></div>' : ''}<div class="fader-thumb"></div></div>`;
  const rail = el.querySelector('.fader-rail');
  const thumb = el.querySelector('.fader-thumb');
  const vertical = orient === 'v';
  let v = value;

  const render = () => {
    const p = (v - min) / (max - min);
    if (vertical) thumb.style.top = (1 - p) * 100 + '%';
    else thumb.style.left = p * 100 + '%';
  };
  const set = (nv, emit = true) => {
    nv = clamp(nv, min, max);
    if (center && Math.abs(nv - def) < (max - min) * 0.01) nv = def;
    v = nv;
    render();
    if (emit && onInput) onInput(v);
  };
  const fromEvent = e => {
    const r = rail.getBoundingClientRect();
    const p = vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    return min + clamp(p, 0, 1) * (max - min);
  };
  const tap = doubleTapDetector(() => set(def));

  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    // Finger auf der Schiene unterhalb des Griffs: Kanal stumm, solange er liegt
    if (onCut && vertical && !thumb.contains(e.target) && e.clientY > thumb.getBoundingClientRect().bottom) {
      const id = e.pointerId;
      el.classList.add('cut');
      onCut(true);
      const end = ev => {
        if (ev.pointerId !== id) return;
        el.removeEventListener('pointerup', end);
        el.removeEventListener('pointercancel', end);
        el.classList.remove('cut');
        onCut(false);
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      return;
    }
    const r = rail.getBoundingClientRect();
    const size = vertical ? r.height : r.width;
    const sx = e.clientX, sy = e.clientY;
    // Maus: Klick auf die Schiene springt dorthin. Finger: immer relativ,
    // damit ein versehentliches Antippen nichts verstellt.
    if (e.pointerType === 'mouse' && !thumb.contains(e.target)) set(fromEvent(e));
    const base = v;
    let moved = false;
    el.classList.add('active');
    const move = ev => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true;
      let d = ((vertical ? ev.clientY - sy : ev.clientX - sx)) / size * (max - min);
      if (vertical) d = -d;
      if (ev.shiftKey) d *= 0.2;
      set(base + d);
    };
    const up = ev => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.classList.remove('active');
      if (ev.type === 'pointerup') tap(ev, moved);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });

  el.setValue = (nv, emit = false) => set(nv, emit);
  el.getValue = () => v;
  render();
  return el;
}

function createMeter(orient) {
  const el = document.createElement('div');
  el.className = `meter ${orient}`;
  el.innerHTML = '<div class="meter-cover"></div>';
  return el;
}

/* ---------------- Deck ---------------- */

const DECK_TEMPLATE = id => `
  <div class="deck-head">
    <div class="deck-letter">${id}</div>
    <div class="track-info">
      <div class="title" data-el="title">Kein Track geladen</div>
      <div class="meta"><span data-el="time">0:00.0</span><span class="sep">/</span><span data-el="remain">-0:00.0</span></div>
    </div>
    <div class="bpm-box">
      <div class="bpm" data-el="bpm">---.-</div>
      <div class="bpm-tools">
        <button class="btn tiny" data-el="half" title="BPM halbieren">½</button>
        <button class="btn tiny" data-el="double" title="BPM verdoppeln">×2</button>
      </div>
    </div>
    <label class="btn load">Laden<input type="file" accept="audio/*,.mp3,.m4a,.wav,.aac,.flac" data-el="file" hidden></label>
  </div>
  <div class="wave-zoom" data-el="zoomWrap">
    <canvas data-el="zoom"></canvas>
    <div class="hint" data-el="hint">Tippe auf „Laden“<br><small>oder zieh einen Song hierher · MP3, M4A, WAV</small></div>
  </div>
  <div class="wave-overview"><canvas data-el="overview"></canvas></div>
  <div class="deck-controls">
    <div class="left-col">
      <div class="transport">
        <button class="btn big cue" data-el="cue">CUE</button>
        <button class="btn big play" data-el="play">▶</button>
      </div>
      <div class="group">
        <div class="group-label">Hot Cues <span class="group-hint">lange drücken = löschen</span></div>
        <div class="hotcues" data-el="hotcues"></div>
      </div>
      <div class="group">
        <div class="group-label">Loop · Beats</div>
        <div class="loops" data-el="loops"></div>
      </div>
      <div class="group">
        <div class="group-label">Echo Out · 1 Takt <span class="echo-len-val" data-el="echoLenVal"></span></div>
        <div class="echo-row">
          <button class="btn echo" data-el="echo" title="Deck stoppt, der letzte Takt hallt aus. Nochmal drücken = Echo abbrechen.">ECHO OUT</button>
          <div class="echo-len" data-el="echoLenSlot" title="Ausklingzeit des Echos"></div>
        </div>
      </div>
    </div>
    <div class="tempo-col">
      <button class="btn sync" data-el="sync" title="Tempo (und Beat) an das andere Deck angleichen">SYNC</button>
      <div class="tempo-readout" data-el="tempoVal">+0.00%</div>
      <div class="tempo-slot" data-el="tempoSlot"></div>
      <div class="pair">
        <button class="btn small" data-el="nudgeDown" title="Kurz bremsen">−</button>
        <button class="btn small" data-el="nudgeUp" title="Kurz schieben">+</button>
      </div>
      <div class="pair">
        <button class="btn small" data-el="range" title="Pitch-Bereich">±8%</button>
        <button class="btn small keylock" data-el="keylock" disabled title="Key Lock: Tonhöhe bleibt gleich, wenn das Tempo geändert wird">KEY</button>
      </div>
    </div>
  </div>`;

class Deck {
  constructor(id, root) {
    this.id = id;
    this.root = root;
    this.other = null;

    // Signalkette: Quelle → Norm → Gain → EQ → Filter → Kanalfader → Crossfader → Master
    this.input = ctx.createGain();      // hier hängt die Quelle dran (ggf. über Key Lock)
    this.keyLockNode = null;
    this.norm = ctx.createGain();
    this.trim = ctx.createGain();
    this.input.connect(this.norm);

    // 3-Band-Isolator (Linkwitz-Riley 24 dB/Okt.): jedes Band lässt sich komplett killen
    const bq = (type, f) => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = Math.SQRT1_2;
      return n;
    };
    const lr4 = (type, f) => { const a = bq(type, f), b = bq(type, f); a.connect(b); return [a, b]; };
    const [lowIn, lowOut] = lr4('lowpass', EQ_LOW_X);
    const [restIn, restOut] = lr4('highpass', EQ_LOW_X);
    const [midIn, midOut] = lr4('lowpass', EQ_HIGH_X);
    const [highIn, highOut] = lr4('highpass', EQ_HIGH_X);
    const lowPhase = bq('allpass', EQ_HIGH_X);   // Phasenausgleich, damit die Summe flach bleibt
    this.bands = { low: ctx.createGain(), mid: ctx.createGain(), high: ctx.createGain() };
    this.trim.connect(lowIn);
    this.trim.connect(restIn);
    lowOut.connect(lowPhase);
    lowPhase.connect(this.bands.low);
    restOut.connect(midIn);
    restOut.connect(highIn);
    midOut.connect(this.bands.mid);
    highOut.connect(this.bands.high);

    // Filter: zwei Biquads in Reihe (24 dB/Okt.) + Stummschaltung an den Anschlägen
    this.filters = [ctx.createBiquadFilter(), ctx.createBiquadFilter()];
    for (const f of this.filters) {
      f.type = 'lowpass';
      f.frequency.value = ctx.sampleRate / 2;
      f.Q.value = 0;
    }
    this.filters[0].connect(this.filters[1]);
    this.filterMute = ctx.createGain();
    this.filters[1].connect(this.filterMute);
    this.fader = ctx.createGain();
    // Mute: Finger auf der Fader-Schiene unterhalb des Griffs (Cut, solange gedrückt)
    this.cut = ctx.createGain();
    this.fader.connect(this.cut);

    // Echo Out: Die Delay-Line nimmt ständig den letzten Takt auf (Wet stumm).
    // Beim Auslösen wird die Aufnahme geschlossen, Wet + Feedback geöffnet.
    this.echoActive = false;
    this.echoTimer = null;
    this.echoLength = ECHO_LEN_DEFAULT;
    this.echoSend = ctx.createGain();
    this.echoDelay = ctx.createDelay(ECHO_MAX_DELAY);
    this.echoHp = ctx.createBiquadFilter();
    this.echoHp.type = 'highpass';
    this.echoHp.frequency.value = 150;
    this.echoLp = ctx.createBiquadFilter();
    this.echoLp.type = 'lowpass';
    this.echoLp.frequency.value = 7000;
    this.echoFb = ctx.createGain();
    this.echoFb.gain.value = 0;
    this.echoWet = ctx.createGain();
    this.echoWet.gain.value = 0;
    this.cut.connect(this.echoSend);
    this.echoSend.connect(this.echoDelay);
    this.echoDelay.connect(this.echoHp);
    this.echoHp.connect(this.echoLp);
    this.echoLp.connect(this.echoFb);
    this.echoFb.connect(this.echoDelay);
    this.echoLp.connect(this.echoWet);

    this.xf = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.meterBuf = new Float32Array(this.analyser.fftSize);
    this.meterLevel = 0;

    this.norm.connect(this.trim);
    for (const b of Object.values(this.bands)) b.connect(this.filters[0]);
    this.filterMute.connect(this.fader);
    this.cut.connect(this.xf);
    this.cut.connect(this.analyser);
    this.echoWet.connect(this.xf);
    this.echoWet.connect(this.analyser);
    this.xf.connect(master);

    // Wiedergabe-Zustand
    this.buffer = null;
    this.wave = null;
    this.source = null;
    this.playing = false;
    this.offset = 0;
    this.startTime = 0;
    this.tempoRange = TEMPO_RANGES[0];
    this.tempoVal = 0;
    this.rate = 1;
    this.nudge = 1;
    this.cuePoint = 0;
    this.cuePreview = false;
    this.hotcues = [null, null, null, null];
    this.loop = null;
    this.bpm = null;
    this.firstBeat = 0;
    this.syncArmed = false;
    this.keyLock = false;
    this.scratchNode = null;
    this.scratching = false;
    this.scratchWasPlaying = false;
    this.zoomSpan = 6;
    this.updateEchoTime();

    this.buildUI();
  }

  get duration() { return this.buffer ? this.buffer.duration : 0; }
  get effRate() { return this.rate * this.nudge; }

  get position() {
    if (!this.playing) return this.offset;
    let p = this.offset + (ctx.currentTime - this.startTime) * this.effRate;
    if (this.loop && p >= this.loop.end) {
      p = this.loop.start + mod(p - this.loop.start, this.loop.end - this.loop.start);
    }
    return Math.min(p, this.duration);
  }

  rebase() {
    this.offset = this.position;
    this.startTime = ctx.currentTime;
  }

  /* ---- Transport ---- */

  startSource() {
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.effRate;
    if (this.loop) {
      src.loopStart = this.loop.start;
      src.loopEnd = this.loop.end;
      src.loop = true;
    }
    src.connect(this.input);
    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      this.playing = false;
      this.offset = this.duration;
    };
    src.start(0, this.offset);
    this.source = src;
    this.startTime = ctx.currentTime;
  }

  stopSource() {
    if (!this.source) return;
    this.source.onended = null;
    try { this.source.stop(); } catch (_) { /* schon gestoppt */ }
    this.source.disconnect();
    this.source = null;
  }

  play() {
    if (!this.buffer || this.playing) return;
    if (ctx.state !== 'running') ctx.resume();
    if (this.offset >= this.duration - 0.01) this.offset = 0;
    this.startSource();
    this.playing = true;
    if (this.syncArmed && this.other && this.other.playing) this.alignPhase(this.other);
    this.syncArmed = false;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.position;
    this.playing = false;
    this.stopSource();
  }

  togglePlay() {
    if (this.cuePreview) { this.cuePreview = false; return; }  // Cue-Vorschau in Play übernehmen
    // Während die Hand auf der Platte liegt: Motor an/aus – läuft nach dem Loslassen weiter
    if (this.scratching) { this.scratchWasPlaying = !this.scratchWasPlaying; return; }
    this.playing ? this.pause() : this.play();
  }

  seek(t, keepLoop = false) {
    if (!this.buffer) return;
    t = clamp(t, 0, this.duration - 0.001);
    if (this.loop && !keepLoop && (t < this.loop.start || t >= this.loop.end)) {
      this.loop = null;
      this.updateLoopButtons();
    }
    if (this.playing) {
      this.stopSource();
      this.offset = t;
      this.startSource();
    } else {
      this.offset = t;
    }
  }

  cueDown() {
    if (!this.buffer) return;
    if (this.playing) {
      this.pause();
      this.seek(this.cuePoint);
    } else if (Math.abs(this.position - this.cuePoint) < 0.02) {
      this.cuePreview = true;   // gedrückt halten = vorhören
      this.play();
    } else {
      this.cuePoint = this.position;
    }
  }

  cueUp() {
    if (!this.cuePreview) return;
    this.cuePreview = false;
    this.pause();
    this.seek(this.cuePoint);
  }

  hotcue(i) {
    if (!this.buffer) return;
    if (this.hotcues[i] == null) {
      this.hotcues[i] = this.position;
      this.updateHotcueButtons();
    } else {
      this.seek(this.hotcues[i]);
    }
  }

  deleteHotcue(i) {
    this.hotcues[i] = null;
    this.updateHotcueButtons();
  }

  /* ---- Tempo ---- */

  applyRate() {
    if (this.source) this.source.playbackRate.setValueAtTime(this.effRate, ctx.currentTime);
    if (this.keyLockNode) {
      this.keyLockNode.parameters.get('pitch')
        .setValueAtTime(this.keyLock ? 1 / this.effRate : 1, ctx.currentTime);
    }
    if (this.nudge === 1) this.updateEchoTime();
  }

  attachKeyLock(node) {
    this.keyLockNode = node;
    this.input.disconnect();
    this.input.connect(node);
    node.connect(this.norm);
    this.applyRate();
  }

  toggleKeyLock() {
    if (!this.keyLockNode) return;
    this.keyLock = !this.keyLock;
    this.el.keylock.classList.toggle('on', this.keyLock);
    this.applyRate();
  }

  setTempo(v) {
    if (this.playing) this.rebase();
    this.tempoVal = clamp(v, -1, 1);
    this.rate = 1 + this.tempoVal * this.tempoRange;
    this.applyRate();
  }

  setNudge(n) {
    if (this.playing) this.rebase();
    this.nudge = n;
    this.applyRate();
  }

  setTempoRange(range) {
    this.tempoRange = range;
    setText(this.el.range, `±${Math.round(range * 100)}%`);
    const tv = (this.rate - 1) / range;
    if (Math.abs(tv) > 1) this.setTempo(clamp(tv, -1, 1));
    else this.tempoVal = tv;
    this.tempoFader.setValue(this.tempoVal);
  }

  cycleRange() {
    const i = TEMPO_RANGES.indexOf(this.tempoRange);
    this.setTempoRange(TEMPO_RANGES[(i + 1) % TEMPO_RANGES.length]);
  }

  sync(other) {
    if (!this.bpm || !other || !other.bpm || !other.buffer) return;
    const r = other.bpm * other.rate / this.bpm;
    let range = this.tempoRange;
    for (const cand of TEMPO_RANGES) {
      if (cand >= range && Math.abs(r - 1) <= cand) { range = cand; break; }
      range = cand;
    }
    if (range !== this.tempoRange) this.setTempoRange(range);
    this.setTempo((r - 1) / this.tempoRange);
    this.tempoFader.setValue(this.tempoVal);
    if (this.playing && other.playing) this.alignPhase(other);
    else this.syncArmed = true;
  }

  alignPhase(other) {
    if (!this.bpm || !other.bpm) return;
    const myBeat = 60 / this.bpm;
    const otBeat = 60 / other.bpm;
    const pos = this.position;
    const fo = mod((other.position - other.firstBeat) / otBeat, 1);
    const fm = mod((pos - this.firstBeat) / myBeat, 1);
    let d = fo - fm;
    if (d > 0.5) d -= 1;
    if (d < -0.5) d += 1;
    this.seek(pos + d * myBeat, true);
  }

  /* ---- Loops ---- */

  toggleLoop(beats) {
    if (!this.buffer || !this.bpm) return;
    if (this.loop && this.loop.beats === beats) { this.clearLoop(); return; }
    if (this.playing) this.rebase();
    const bl = 60 / this.bpm;
    let start;
    if (this.loop) start = this.loop.start;   // Größe ändern, Startpunkt behalten
    else start = Math.max(0, this.firstBeat + Math.floor((this.position - this.firstBeat) / bl + 0.001) * bl);
    const end = Math.min(start + beats * bl, this.duration);
    this.loop = { start, end, beats };
    if (this.source) {
      this.source.loop = false;
      this.source.loopStart = start;
      this.source.loopEnd = end;
      this.source.loop = true;
    }
    this.updateLoopButtons();
  }

  clearLoop() {
    if (!this.loop) return;
    if (this.playing) this.rebase();
    this.loop = null;
    if (this.source) this.source.loop = false;
    this.updateLoopButtons();
  }

  setBpm(bpm) {
    this.clearLoop();
    this.bpm = bpm ? clamp(Math.round(bpm * 100) / 100, 40, 300) : null;
    this.updateLoopButtons();
    this.updateEchoTime();
  }

  /* ---- Mixer-Parameter ---- */

  setTrim(v) { this.trim.gain.setTargetAtTime(dbToGain(v * 12), ctx.currentTime, 0.01); }
  setFader(v) { this.fader.gain.setTargetAtTime(v * v, ctx.currentTime, 0.01); }
  setCut(on) { this.cut.gain.setTargetAtTime(on ? 0 : 1, ctx.currentTime, 0.002); }

  /* ---- Vinyl-Scratch ---- */

  attachScratch(node) {
    this.scratchNode = node;
    node.connect(this.norm);   // am Key Lock vorbei: beim Scratchen soll die Tonhöhe mitgehen
    if (this.buffer) this.sendScratchData();
  }

  // Track als 16-Bit-Kopie an den Scratch-Player geben (halber Speicher, reicht fürs Scratchen)
  sendScratchData() {
    if (!this.scratchNode || !this.buffer) return;
    const toI16 = ch => {
      const f = this.buffer.getChannelData(ch), o = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) {
        const s = f[i];
        o[i] = s <= -1 ? -32768 : s >= 1 ? 32767 : s * 32767;
      }
      return o;
    };
    const l = toI16(0);
    const r = this.buffer.numberOfChannels > 1 ? toI16(1) : l;
    this.scratchNode.port.postMessage({ type: 'load', l, r }, r === l ? [l.buffer] : [l.buffer, r.buffer]);
  }

  startScratch() {
    if (this.scratching) return;
    this.scratchWasPlaying = this.playing;
    this.cuePreview = false;
    this.pause();
    this.scratching = true;
    // Uhr-Abgleich: Zeitstempel der Touch-Events (performance.now) → Audio-Zeit
    this.scratchClock = ctx.currentTime - performance.now() / 1000;
    this.scratchLastEvent = performance.now();
    this.scratchNode.port.postMessage({ type: 'start', pos: this.offset, time: ctx.currentTime });
  }

  // samples: [[Zeitstempel (ms, performance.now), Position (s)], …] – jede Fingerposition mit ihrer Zeit
  scratchTo(samples) {
    if (!this.scratching || !samples.length) return;
    const now = performance.now();
    const pts = samples.map(([ts, pos]) => {
      // ältere Browser liefern Event-Zeit in einer anderen Uhr → dann "jetzt" nehmen
      if (!(Math.abs(ts - now) < 1000)) ts = now;
      this.offset = clamp(pos, 0, this.duration - 0.001);
      return [ts / 1000 + this.scratchClock, this.offset];
    });
    this.scratchLastEvent = samples[samples.length - 1][0];
    this.scratchNode.port.postMessage({ type: 'move', pts });
  }

  // Liegt der Finger still, kommen keine Events – dann regelmäßig "steht" melden
  scratchHeartbeat() {
    if (!this.scratching) return;
    const now = performance.now();
    if (now - this.scratchLastEvent > 40) this.scratchTo([[now, this.offset]]);
  }

  endScratch() {
    if (!this.scratching) return;
    this.scratchNode.port.postMessage({ type: 'stop' });
    this.scratching = false;
    if (this.scratchWasPlaying) this.play();
  }

  setEq(band, v) {
    this.bands[band].gain.setTargetAtTime(eqGain(v), ctx.currentTime, 0.01);
  }

  setFilter(v) {
    const now = ctx.currentTime, nyq = ctx.sampleRate / 2;
    const off = Math.abs(v) < 0.02;
    const type = off || v < 0 ? 'lowpass' : 'highpass';
    const freq = off ? nyq : Math.min(nyq, filterFreq(v));
    this.filters.forEach((f, i) => {
      f.type = type;
      f.frequency.setTargetAtTime(freq, now, 0.01);
      f.Q.setTargetAtTime(off || i === 0 ? 0 : 4, now, 0.01);   // Resonanz nur auf der 2. Stufe
    });
    this.filterMute.gain.setTargetAtTime(filterMuteGain(v), now, 0.01);
  }

  /* ---- Echo Out ---- */

  barSeconds() {
    return 240 / ((this.bpm || 128) * this.rate);
  }

  updateEchoTime() {
    if (this.echoActive) return;   // während des Ausklingens nicht verstellen
    this.echoDelay.delayTime.setValueAtTime(clamp(this.barSeconds(), 0.05, ECHO_MAX_DELAY), ctx.currentTime);
  }

  echoOut() {
    if (this.echoActive) { this.stopEcho(true); return; }
    if (!this.buffer) return;
    const now = ctx.currentTime, len = this.echoLength;
    const wet = this.echoWet.gain, fb = this.echoFb.gain;
    this.echoActive = true;
    this.echoSend.gain.setTargetAtTime(0, now, 0.005);
    fb.cancelScheduledValues(now);
    fb.setTargetAtTime(ECHO_FEEDBACK, now, 0.005);
    // Wet kurz einblenden, dann über die eingestellte Länge bis zur Stille ausblenden
    wet.cancelScheduledValues(now);
    wet.setValueAtTime(wet.value, now);
    wet.linearRampToValueAtTime(ECHO_WET, now + 0.01);
    // (1-x)²-Kurve: bleibt länger hörbar als eine Exponentialkurve und endet exakt bei 0
    const curve = new Float32Array(64);
    for (let i = 0; i < curve.length; i++) curve[i] = ECHO_WET * Math.pow(1 - i / (curve.length - 1), 2);
    wet.setValueCurveAtTime(curve, now + 0.011, len - 0.011);
    this.pause();
    this.echoBtn.classList.add('on');
    clearTimeout(this.echoTimer);
    this.echoTimer = setTimeout(() => this.stopEcho(false), len * 1000);
  }

  stopEcho(fast) {
    if (!this.echoActive) return;
    clearTimeout(this.echoTimer);
    const now = ctx.currentTime, tc = fast ? 0.05 : 0.3;
    for (const p of [this.echoFb.gain, this.echoWet.gain]) {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.setTargetAtTime(0, now, tc);
    }
    this.echoActive = false;
    this.echoBtn.classList.remove('on');
    // erst nach dem Ausblenden wieder mitschneiden
    this.echoTimer = setTimeout(() => {
      if (this.echoActive) return;
      this.echoSend.gain.setTargetAtTime(1, ctx.currentTime, 0.005);
      this.updateEchoTime();
    }, tc * 5000);
  }

  /* ---- Laden ---- */

  async load(file) {
    this.pause();
    setText(this.el.title, `Lade „${file.name}“ …`);
    this.el.hint.style.display = 'none';
    try {
      const data = await file.arrayBuffer();
      const buf = await ctx.decodeAudioData(data);
      setText(this.el.title, 'Analysiere Beat …');
      await new Promise(r => setTimeout(r, 30));
      const w = analyze(buf);

      this.stopSource();
      this.buffer = buf;
      this.wave = w;
      this.offset = 0;
      this.cuePoint = 0;
      this.hotcues = [null, null, null, null];
      this.loop = null;
      this.syncArmed = false;
      this.bpm = w.bpm;
      this.firstBeat = w.firstBeat;
      this.updateEchoTime();
      // Lautheit angleichen (Ziel ca. -14 dBFS RMS)
      const rmsDb = 20 * Math.log10(w.rms + 1e-9);
      this.norm.gain.value = dbToGain(clamp(-14 - rmsDb, -12, 6));
      this.scratching = false;
      this.sendScratchData();

      setText(this.el.title, file.name.replace(/\.[^.]+$/, ''));
      this.el.title.title = file.name;
      this.renderOverviewCache();
      this.updateHotcueButtons();
      this.updateLoopButtons();
    } catch (err) {
      console.error(err);
      setText(this.el.title, 'Fehler: Datei konnte nicht gelesen werden');
      if (!this.buffer) this.el.hint.style.display = '';
    }
  }

  /* ---- UI ---- */

  buildUI() {
    this.root.innerHTML = DECK_TEMPLATE(this.id);
    const el = this.el = {};
    this.root.querySelectorAll('[data-el]').forEach(n => { el[n.dataset.el] = n; });

    el.file.addEventListener('change', () => {
      const f = el.file.files[0];
      if (f) this.load(f);
      el.file.value = '';
    });
    this.root.addEventListener('dragover', e => { e.preventDefault(); this.root.classList.add('dragover'); });
    this.root.addEventListener('dragleave', e => {
      if (!this.root.contains(e.relatedTarget)) this.root.classList.remove('dragover');
    });
    this.root.addEventListener('drop', e => {
      e.preventDefault();
      this.root.classList.remove('dragover');
      const f = [...e.dataTransfer.files].find(x => x.type.startsWith('audio/') || /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|webm)$/i.test(x.name));
      if (f) this.load(f);
    });

    el.play.addEventListener('click', () => this.togglePlay());
    el.cue.addEventListener('pointerdown', e => { e.preventDefault(); this.cueDown(); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) el.cue.addEventListener(ev, () => this.cueUp());

    this.hotcueBtns = HOTCUE_COLORS.map((col, i) => {
      const b = document.createElement('button');
      b.className = 'btn hotcue';
      b.textContent = i + 1;
      b.style.setProperty('--hc', col);
      b.title = 'Tippen: setzen/springen · Lange drücken oder Rechtsklick: löschen';
      // Lange drücken (0,6 s) löscht – funktioniert mit Finger und Maus
      let pressTimer = null, longPressed = false;
      const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
      b.addEventListener('pointerdown', () => {
        longPressed = false;
        cancelPress();
        if (this.hotcues[i] == null) return;
        pressTimer = setTimeout(() => {
          longPressed = true;
          this.deleteHotcue(i);
          b.classList.add('deleted');
          setTimeout(() => b.classList.remove('deleted'), 400);
        }, 600);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, cancelPress);
      b.addEventListener('click', e => {
        if (longPressed) { longPressed = false; return; }
        e.shiftKey ? this.deleteHotcue(i) : this.hotcue(i);
      });
      b.addEventListener('contextmenu', e => { e.preventDefault(); if (e.pointerType !== 'touch') this.deleteHotcue(i); });
      el.hotcues.append(b);
      return b;
    });

    this.loopBtns = LOOP_BEATS.map(beats => {
      const b = document.createElement('button');
      b.className = 'btn loop';
      b.textContent = beats;
      b.addEventListener('click', () => this.toggleLoop(beats));
      el.loops.append(b);
      return b;
    });

    this.tempoFader = createFader({
      orient: 'v', min: -1, max: 1, value: 0, def: 0, center: true,
      onInput: v => { this.syncArmed = false; this.setTempo(v); },
    });
    el.tempoSlot.append(this.tempoFader);
    el.sync.addEventListener('click', () => this.sync(this.other));
    el.range.addEventListener('click', () => this.cycleRange());
    el.keylock.addEventListener('click', () => this.toggleKeyLock());

    this.echoBtn = el.echo;
    el.echo.addEventListener('click', () => this.echoOut());
    const showEchoLen = v => setText(el.echoLenVal, v.toFixed(1) + ' s');
    el.echoLenSlot.append(createFader({
      orient: 'h', min: ECHO_LEN_MIN, max: ECHO_LEN_MAX, value: this.echoLength, def: ECHO_LEN_DEFAULT,
      onInput: v => { this.echoLength = v; showEchoLen(v); },
    }));
    showEchoLen(this.echoLength);
    el.half.addEventListener('click', () => this.bpm && this.setBpm(this.bpm / 2));
    el.double.addEventListener('click', () => this.bpm && this.setBpm(this.bpm * 2));

    const bindNudge = (btn, n) => {
      btn.addEventListener('pointerdown', e => { e.preventDefault(); this.setNudge(n); });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
        btn.addEventListener(ev, () => { if (this.nudge === n) this.setNudge(1); });
      }
    };
    bindNudge(el.nudgeDown, 0.96);
    bindNudge(el.nudgeUp, 1.04);

    // Wellenform, 1 Finger:
    //   SMUDGE – pausiert scrubben / läuft Pitch-Bend (Jogwheel)
    //   VINYL  – Hand auf der Platte: Track folgt dem Finger (Scratch), loslassen = weiter
    // 2 Finger auseinander/zusammen = Zoom
    const z = el.zoom;
    const touches = new Map();
    let drag = null, pinch = null;
    const pinchDist = () => {
      const [a, b] = [...touches.values()];
      return Math.max(10, Math.abs(a.x - b.x));
    };
    const endDrag = () => {
      if (drag && drag.vinyl) this.endScratch();
      else if (drag && drag.wasPlaying) this.setNudge(1);
      drag = null;
    };
    z.addEventListener('pointerdown', e => {
      if (!this.buffer) return;
      e.preventDefault();
      z.setPointerCapture(e.pointerId);
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        endDrag();
        pinch = { dist: pinchDist(), span: this.zoomSpan };
      } else if (touches.size === 1) {
        if (waveMode === 'vinyl' && this.scratchNode) {
          this.startScratch();
          drag = { vinyl: true, startX: e.clientX, startPos: this.offset };
        } else {
          drag = { startX: e.clientX, lastX: e.clientX, wasPlaying: this.playing };
        }
      }
    });
    z.addEventListener('pointermove', e => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size >= 2) {
        this.zoomSpan = clamp(pinch.span * pinch.dist / pinchDist(), 1.5, 40);
      } else if (drag && drag.vinyl) {
        // Finger nach rechts zieht die Platte zurück, nach links schiebt sie vor.
        // Alle Zwischenpositionen seit dem letzten Event mitnehmen (wo der Browser sie liefert).
        const secPerPx = this.zoomSpan / this.zoomW / uiScale;
        const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
        this.scratchTo(evs.map(ev => [ev.timeStamp, drag.startPos - (ev.clientX - drag.startX) * secPerPx]));
      } else if (drag) {
        if (drag.wasPlaying) {
          this.setNudge(1 - clamp((e.clientX - drag.startX) / 300, -0.3, 0.3));
        } else {
          const secPerPx = this.zoomSpan / this.zoomW / uiScale;   // Fingerweg in Bildschirm-Pixeln
          this.seek(this.position - (e.clientX - drag.lastX) * secPerPx, true);
        }
        drag.lastX = e.clientX;
      }
    });
    const release = e => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
      if (touches.size === 0) endDrag();
    };
    z.addEventListener('pointerup', release);
    z.addEventListener('pointercancel', release);
    z.addEventListener('wheel', e => {
      e.preventDefault();
      this.zoomSpan = clamp(this.zoomSpan * (e.deltaY > 0 ? 1.15 : 1 / 1.15), 1.5, 40);
    }, { passive: false });

    const ov = el.overview;
    ov.addEventListener('pointerdown', e => {
      if (!this.buffer) return;
      ov.setPointerCapture(e.pointerId);
      const toTime = ev => {
        const r = ov.getBoundingClientRect();
        return clamp((ev.clientX - r.left) / r.width, 0, 1) * this.duration;
      };
      this.seek(toTime(e));
      const move = ev => { if (!this.playing) this.seek(toTime(ev)); };
      const up = ev => {
        if (this.playing && Math.abs(toTime(ev) - this.position) > 0.3) this.seek(toTime(ev));
        ov.removeEventListener('pointermove', move);
        ov.removeEventListener('pointerup', up);
        ov.removeEventListener('pointercancel', up);
      };
      ov.addEventListener('pointermove', move);
      ov.addEventListener('pointerup', up);
      ov.addEventListener('pointercancel', up);
    });

    this.zoomW = 1; this.zoomH = 1; this.ovW = 1; this.ovH = 1;
    new ResizeObserver(() => this.resize()).observe(el.zoomWrap);
    new ResizeObserver(() => this.resize()).observe(ov);
    this.updateLoopButtons();
  }

  resize() {
    const dpr = canvasDpr();
    const fit = canvas => {
      const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const c = canvas.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      return [c, w, h];
    };
    [this.zc, this.zoomW, this.zoomH] = fit(this.el.zoom);
    [this.oc, this.ovW, this.ovH] = fit(this.el.overview);
    this.renderOverviewCache();
  }

  renderOverviewCache() {
    if (!this.wave || !this.oc) { this.ovCache = null; return; }
    const dpr = canvasDpr();
    const W = this.ovW, H = this.ovH;
    const off = document.createElement('canvas');
    off.width = Math.round(W * dpr);
    off.height = Math.round(H * dpr);
    const c = off.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { amp, lowQ } = this.wave;
    const n = amp.length, mid = H / 2;
    for (let x = 0; x < W; x++) {
      const b0 = Math.floor(x / W * n), b1 = Math.max(b0 + 1, Math.floor((x + 1) / W * n));
      let mx = 0, lq = 0;
      for (let b = b0; b < b1 && b < n; b++) { if (amp[b] > mx) mx = amp[b]; lq += lowQ[b]; }
      c.fillStyle = WAVE_COLORS[Math.round(lq / (b1 - b0))] || WAVE_COLORS[0];
      const h = Math.max(0.5, mx * mid * 0.92);
      c.fillRect(x, mid - h, 1, h * 2);
    }
    this.ovCache = off;
  }

  drawZoom() {
    const c = this.zc;
    if (!c) return;
    const W = this.zoomW, H = this.zoomH, mid = H / 2;
    c.fillStyle = '#07090d';
    c.fillRect(0, 0, W, H);
    if (!this.wave) return;

    const pos = this.position;
    const span = this.zoomSpan;
    const t0 = pos - span / 2;
    const spp = span / W;
    const xOf = t => (t - t0) / spp;

    if (this.loop) {
      c.fillStyle = 'rgba(61, 220, 151, 0.16)';
      c.fillRect(xOf(this.loop.start), 0, xOf(this.loop.end) - xOf(this.loop.start), H);
    }

    // Beatgrid
    if (this.bpm) {
      const bl = 60 / this.bpm;
      let k = Math.ceil((t0 - this.firstBeat) / bl);
      for (let t = this.firstBeat + k * bl; t < t0 + span; t += bl, k++) {
        if (t < 0) continue;
        const bar = mod(k, 4) === 0;
        c.fillStyle = bar ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.10)';
        c.fillRect(Math.round(xOf(t)), 0, 1, H);
        if (bar) c.fillRect(Math.round(xOf(t)) - 2, 0, 5, 3);
      }
    }

    const { amp, lowQ } = this.wave;
    const n = amp.length;
    for (let x = 0; x < W; x++) {
      const t = t0 + x * spp;
      let b0 = Math.floor(t * RES);
      const b1 = Math.floor((t + spp) * RES);
      if (b1 < 0 || b0 >= n) continue;
      if (b0 < 0) b0 = 0;
      let mx = amp[b0];
      for (let b = b0 + 1; b <= b1 && b < n; b++) if (amp[b] > mx) mx = amp[b];
      c.globalAlpha = x < W / 2 ? 0.55 : 1;
      c.fillStyle = WAVE_COLORS[lowQ[b0]];
      const h = Math.max(0.5, mx * mid * 0.92);
      c.fillRect(x, mid - h, 1, h * 2);
    }
    c.globalAlpha = 1;

    // Cue + Hot Cues
    const marker = (t, color, label) => {
      const x = xOf(t);
      if (x < -10 || x > W + 10) return;
      c.fillStyle = color;
      c.fillRect(Math.round(x), 0, 2, H);
      c.beginPath();
      c.moveTo(x - 6, 0); c.lineTo(x + 8, 0); c.lineTo(x + 1, 9);
      c.fill();
      if (label) {
        c.font = 'bold 10px system-ui';
        c.fillText(label, x + 5, H - 5);
      }
    };
    marker(this.cuePoint, '#ffd23f', '');
    this.hotcues.forEach((t, i) => { if (t != null) marker(t, HOTCUE_COLORS[i], String(i + 1)); });

    // Abspielkopf
    c.fillStyle = '#fff';
    c.fillRect(Math.round(W / 2) - 1, 0, 2, H);
  }

  drawOverview() {
    const c = this.oc;
    if (!c) return;
    const W = this.ovW, H = this.ovH;
    c.fillStyle = '#07090d';
    c.fillRect(0, 0, W, H);
    if (!this.wave) return;
    if (this.ovCache) c.drawImage(this.ovCache, 0, 0, W, H);
    const d = this.duration;
    const xOf = t => t / d * W;
    const px = xOf(this.position);
    c.fillStyle = 'rgba(0,0,0,0.5)';
    c.fillRect(0, 0, px, H);
    if (this.loop) {
      c.fillStyle = 'rgba(61, 220, 151, 0.35)';
      c.fillRect(xOf(this.loop.start), 0, Math.max(2, xOf(this.loop.end) - xOf(this.loop.start)), H);
    }
    c.fillStyle = '#ffd23f';
    c.fillRect(xOf(this.cuePoint), 0, 1, H);
    this.hotcues.forEach((t, i) => {
      if (t == null) return;
      c.fillStyle = HOTCUE_COLORS[i];
      c.fillRect(xOf(t) - 1, 0, 3, 6);
    });
    c.fillStyle = '#fff';
    c.fillRect(px - 1, 0, 2, H);
  }

  updateHotcueButtons() {
    this.hotcueBtns.forEach((b, i) => b.classList.toggle('set', this.hotcues[i] != null));
  }

  updateLoopButtons() {
    this.loopBtns.forEach((b, i) => {
      b.disabled = !this.bpm;
      b.classList.toggle('on', !!this.loop && this.loop.beats === LOOP_BEATS[i]);
    });
  }

  render() {
    this.scratchHeartbeat();
    this.drawZoom();
    this.drawOverview();
    const el = this.el;
    const pos = this.position;
    setText(el.time, fmtTime(pos));
    setText(el.remain, '-' + fmtTime(this.duration - pos));
    setText(el.bpm, this.bpm ? (this.bpm * this.rate).toFixed(1) : '---.-');
    const pct = (this.rate - 1) * 100;
    setText(el.tempoVal, (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%');
    const running = this.playing || (this.scratching && this.scratchWasPlaying);
    el.play.classList.toggle('on', running);
    setText(el.play, running ? '❚❚' : '▶');
    el.cue.classList.toggle('on', !!this.buffer && !this.playing && Math.abs(pos - this.cuePoint) < 0.02);
    const o = this.other;
    const synced = this.bpm && o && o.bpm && Math.abs(this.bpm * this.rate - o.bpm * o.rate) < 0.02;
    el.sync.classList.toggle('on', !!synced);
  }
}

/* ---------------- Aufbau ---------------- */

const deckA = new Deck('A', document.getElementById('deckA'));
const deckB = new Deck('B', document.getElementById('deckB'));
deckA.other = deckB;
deckB.other = deckA;
const decks = [deckA, deckB];

setupWorklets(decks);

const eqFmt = v => {
  const g = eqGain(v);
  if (g === 0) return 'KILL';
  const db = 20 * Math.log10(g);
  return (db > 0.05 ? '+' : '') + db.toFixed(1) + ' dB';
};

const filterFmt = v => {
  const a = Math.abs(v);
  if (a < 0.02) return 'aus';
  if (filterMuteGain(v) === 0) return 'STUMM';
  const f = filterFreq(v);
  return (v < 0 ? 'LP ' : 'HP ') + (f >= 1000 ? (f / 1000).toFixed(1) + ' kHz' : Math.round(f) + ' Hz');
};

function buildStrip(deck, container) {
  const knobs = [
    createKnob({ label: 'Gain', bipolar: true, format: v => (v > 0 ? '+' : '') + (v * 12).toFixed(1) + ' dB', onInput: v => deck.setTrim(v) }),
    createKnob({ label: 'Hi', bipolar: true, format: eqFmt, onInput: v => deck.setEq('high', v) }),
    createKnob({ label: 'Mid', bipolar: true, format: eqFmt, onInput: v => deck.setEq('mid', v) }),
    createKnob({ label: 'Low', bipolar: true, format: eqFmt, onInput: v => deck.setEq('low', v) }),
    createKnob({ label: 'Filter', bipolar: true, format: filterFmt, onInput: v => deck.setFilter(v) }),
  ];
  const knobBox = document.createElement('div');
  knobBox.className = 'strip-knobs';
  knobBox.append(...knobs);
  container.append(knobBox);
  const row = document.createElement('div');
  row.className = 'fader-row';
  const meter = createMeter('v');
  const fader = createFader({
    orient: 'v', min: 0, max: 1, value: 1, def: 1,
    onInput: v => deck.setFader(v),
    onCut: on => deck.setCut(on),
  });
  row.append(meter, fader);
  container.append(row);
  deck.meterEl = meter.firstChild;
}

buildStrip(deckA, document.getElementById('stripA'));
buildStrip(deckB, document.getElementById('stripB'));

/* ---------------- Crossfader ---------------- */

let xfValue = 0.5;
let xfCurve = 'smooth';

function applyCrossfader() {
  const x = xfValue;
  let gA, gB;
  if (xfCurve === 'smooth') {
    gA = x <= 0.5 ? 1 : Math.cos((x - 0.5) * Math.PI);
    gB = x >= 0.5 ? 1 : Math.cos((0.5 - x) * Math.PI);
  } else {
    gA = clamp((1 - x) / 0.06, 0, 1);
    gB = clamp(x / 0.06, 0, 1);
  }
  const now = ctx.currentTime;
  deckA.xf.gain.setTargetAtTime(gA, now, 0.005);
  deckB.xf.gain.setTargetAtTime(gB, now, 0.005);
}

const xfader = createFader({
  orient: 'h', min: 0, max: 1, value: 0.5, def: 0.5, center: true,
  onInput: v => { xfValue = v; applyCrossfader(); },
});
xfader.classList.add('xfader-ctl');
document.getElementById('xfSlot').append(xfader);

const xfCurveBtn = document.getElementById('xfCurve');
xfCurveBtn.addEventListener('click', () => {
  xfCurve = xfCurve === 'smooth' ? 'cut' : 'smooth';
  xfCurveBtn.textContent = xfCurve === 'smooth' ? 'Smooth' : 'Cut';
  applyCrossfader();
});
applyCrossfader();

/* ---------------- Wellenform-Modus: Smudge / Vinyl ---------------- */

const modeSwitch = document.getElementById('waveMode');
function setWaveMode(mode) {
  waveMode = mode;
  for (const b of modeSwitch.querySelectorAll('.mode-btn')) {
    const on = b.dataset.mode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  document.documentElement.dataset.waveMode = mode;
  try { localStorage.setItem('tipsyremix.waveMode', mode); } catch (_) { /* egal */ }
}
modeSwitch.addEventListener('click', e => {
  const b = e.target.closest('.mode-btn');
  if (b) setWaveMode(b.dataset.mode);
});
setWaveMode(waveMode);

/* ---------------- Master & Aufnahme ---------------- */

document.getElementById('masterSlot').append(createKnob({
  label: 'Master', min: 0, max: 1, value: 0.8, def: 0.8,
  format: v => Math.round(v * 100) + '%',
  onInput: v => master.gain.setTargetAtTime(v, ctx.currentTime, 0.01),
}));

const masterMeterCover = document.querySelector('#masterMeter .meter-cover');
const masterBuf = new Float32Array(masterAnalyser.fftSize);
let masterLevel = 0;

const recBtn = document.getElementById('recBtn');
const recTime = document.getElementById('recTime');
const recordings = document.getElementById('recordings');
const MP3_KBPS = 320;
let recorder = null;
let recStart = 0;

/* Speichern: lokal/eigener Server = normaler Download-Link.
   Auf claude.ai blockiert der Rahmen direkte Downloads; dort läuft das
   Speichern über die "downloads"-Funktion, die kein .mp3 erlaubt – die
   MP3 wird deshalb unverändert in eine ZIP-Datei gepackt. */
const claudeDownloads = window.claude && typeof window.claude.use === 'function'
  ? window.claude.use('downloads').catch(() => null)
  : Promise.resolve(null);
const CLAUDE_SAVE_EXT = ['webm'];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Minimales ZIP (eine Datei, ohne Kompression – MP3 ist schon komprimiert)
function makeZip(filename, data) {
  const name = new TextEncoder().encode(filename);
  const crc = crc32(data), size = data.length;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(6, 0x0800, true);          // Dateiname in UTF-8
  local.setUint16(10, dosTime, true);
  local.setUint16(12, dosDate, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, size, true);
  local.setUint32(22, size, true);
  local.setUint16(26, name.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, 20, true);
  central.setUint16(6, 20, true);
  central.setUint16(8, 0x0800, true);
  central.setUint16(12, dosTime, true);
  central.setUint16(14, dosDate, true);
  central.setUint32(16, crc, true);
  central.setUint32(20, size, true);
  central.setUint32(24, size, true);
  central.setUint16(28, name.length, true);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + name.length, true);
  end.setUint32(16, 30 + name.length + size, true);
  return new Blob([local, name, data, central, name, end], { type: 'application/zip' });
}

function showRecStatus(msg) {
  const s = document.createElement('span');
  s.className = 'rec-status';
  s.textContent = msg;
  recordings.prepend(s);
  setTimeout(() => s.remove(), 6000);
}

async function addDownload(blob, ext, seconds) {
  const d = new Date();
  const p2 = x => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
  const filename = `TipsyRemix-Mix_${stamp}.${ext}`;
  const mb = (blob.size / 1048576).toFixed(1);
  const label = `Mix ${stamp.replace('_', ' ')} · ${fmtTime(seconds).slice(0, -2)} · ${ext.toUpperCase()} · ${mb} MB`;

  const downloads = await claudeDownloads;
  if (!downloads) {
    const a = document.createElement('a');
    a.className = 'rec-item';
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.textContent = '⬇ ' + label;
    recordings.prepend(a);
    return;
  }
  const btn = document.createElement('button');
  btn.className = 'rec-item';
  const zipped = !CLAUDE_SAVE_EXT.includes(ext);
  btn.textContent = '⬇ ' + label + (zipped ? ' (als ZIP)' : '');
  btn.addEventListener('click', async () => {
    try {
      const data = zipped
        ? makeZip(filename, new Uint8Array(await blob.arrayBuffer()))
        : blob;
      await downloads.save({ filename: zipped ? filename.replace(/\.\w+$/, '.zip') : filename, data });
    } catch (err) {
      const code = err && err.code;
      if (code === 'declined') return;
      showRecStatus(code === 'rate_limited'
        ? 'Es ist schon ein Speichern-Fenster offen.'
        : 'Speichern ist hier nicht möglich (' + (code || 'Fehler') + ').');
    }
  });
  recordings.prepend(btn);
}

function floatTo16(f) {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = f[i] < -1 ? -1 : f[i] > 1 ? 1 : f[i];
    o[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return o;
}

// MP3 320 kbps: PCM vom Recorder-Worklet wird live mit lamejs kodiert
function startMp3Recording(onDone) {
  const enc = new lamejs.Mp3Encoder(2, ctx.sampleRate, MP3_KBPS);
  const parts = [];
  let frames = 0;
  recNode.port.onmessage = e => {
    const m = e.data;
    if (m.l) {
      frames += m.l.length;
      const out = enc.encodeBuffer(floatTo16(m.l), floatTo16(m.r));
      if (out.length) parts.push(out);
    }
    if (m.done) {
      const end = enc.flush();
      if (end.length) parts.push(end);
      recNode.port.onmessage = null;
      addDownload(new Blob(parts, { type: 'audio/mpeg' }), 'mp3', frames / ctx.sampleRate);
      onDone();
    }
  };
  recNode.port.postMessage('start');
  return { stop: () => recNode.port.postMessage('stop') };
}

// Notlösung ohne Worklet/lamejs: Browser-eigenes Format (WebM/OGG)
function startMediaRecording(onDone) {
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
    .find(m => MediaRecorder.isTypeSupported(m)) || '';
  const chunks = [];
  const rec = new MediaRecorder(recDest.stream, mime ? { mimeType: mime } : undefined);
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const type = rec.mimeType || mime || 'audio/webm';
    const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
    addDownload(new Blob(chunks, { type }), ext, (performance.now() - recStart) / 1000);
    onDone();
  };
  rec.start(1000);
  return rec;
}

const mp3Supported = () => recNode && window.lamejs && [32000, 44100, 48000].includes(ctx.sampleRate);

recBtn.addEventListener('click', () => {
  if (recorder) {
    recorder.stop();
    recorder = null;
    recBtn.disabled = true;
    setText(recTime, 'speichere …');
    return;
  }
  const done = () => {
    recBtn.disabled = false;
    recBtn.classList.remove('on');
    setText(recTime, '');
  };
  ctx.resume();
  if (mp3Supported()) {
    recorder = startMp3Recording(done);
  } else if (window.MediaRecorder) {
    recorder = startMediaRecording(done);
  } else {
    showRecStatus('Dieser Browser kann nicht aufnehmen.');
    return;
  }
  recStart = performance.now();
  recBtn.classList.add('on');
});

/* ---------------- Tastatur ---------------- */

const keyActions = {
  q: () => deckA.togglePlay(),
  o: () => deckB.togglePlay(),
  e: () => deckA.echoOut(),
  i: () => deckB.echoOut(),
  1: () => deckA.hotcue(0), 2: () => deckA.hotcue(1), 3: () => deckA.hotcue(2), 4: () => deckA.hotcue(3),
  7: () => deckB.hotcue(0), 8: () => deckB.hotcue(1), 9: () => deckB.hotcue(2), 0: () => deckB.hotcue(3),
  arrowleft: () => xfader.setValue(xfader.getValue() - 0.05, true),
  arrowright: () => xfader.setValue(xfader.getValue() + 0.05, true),
};

document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'w' && !e.repeat) { deckA.cueDown(); return; }
  if (k === 'p' && !e.repeat) { deckB.cueDown(); return; }
  const fn = keyActions[k];
  if (!fn) return;
  e.preventDefault();
  if (e.repeat && !k.startsWith('arrow')) return;
  fn();
});
document.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (k === 'w') deckA.cueUp();
  if (k === 'p') deckB.cueUp();
});

/* ---------------- Render-Loop ---------------- */

function peakLevel(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = buf[i] < 0 ? -buf[i] : buf[i];
    if (a > p) p = a;
  }
  return clamp((20 * Math.log10(p + 1e-9) + 48) / 48, 0, 1);
}

function frame() {
  for (const d of decks) {
    d.render();
    d.meterLevel = Math.max(peakLevel(d.analyser, d.meterBuf), d.meterLevel - 0.02);
    d.meterEl.style.height = (1 - d.meterLevel) * 100 + '%';
  }
  masterLevel = Math.max(peakLevel(masterAnalyser, masterBuf), masterLevel - 0.02);
  masterMeterCover.style.width = (1 - masterLevel) * 100 + '%';
  if (recorder) setText(recTime, fmtTime((performance.now() - recStart) / 1000).slice(0, -2));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------------- Ein Bildschirm: Konsole passend skalieren ----------------
   Die Konsole wird in einer festen Entwurfsbreite gesetzt (quer 1180 px,
   hoch 820 px) und als Ganzes auf den verfügbaren Platz skaliert – so ist
   alles ohne Scrollen sichtbar. Nur wenn das Ergebnis zu klein zum Bedienen
   wäre (Handy), bleibt es bei der normalen, scrollenden Seite. */

const LAYOUT_WIDTH = { land: 1180, port: 820 };
const LAYOUT_MAX_LAND = 1560;
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.6;
const appEl = document.querySelector('.app');
const rootEl = document.documentElement;

function fitToScreen() {
  const cs = getComputedStyle(rootEl);
  const padTop = parseFloat(cs.paddingTop) || 0;
  const padBottom = parseFloat(cs.paddingBottom) || 0;
  const vw = rootEl.clientWidth || window.innerWidth;
  const vh = window.innerHeight - padTop - padBottom;
  const mode = vw >= vh * 0.95 ? 'land' : 'port';

  rootEl.dataset.layout = mode;
  rootEl.classList.add('fit');
  let W = LAYOUT_WIDTH[mode];
  appEl.style.width = W + 'px';
  appEl.style.transform = 'none';
  let H = appEl.offsetHeight;
  // Flaches Querformat-Fenster: Konsole in die Breite wachsen lassen statt Rand zu lassen
  if (mode === 'land' && vw / vh > W / H) {
    W = Math.min(LAYOUT_MAX_LAND, Math.round(H * vw / vh));
    appEl.style.width = W + 'px';
    H = appEl.offsetHeight;
  }
  const s = Math.min(vw / W, vh / H, MAX_SCALE);

  if (s < MIN_SCALE) {
    rootEl.dataset.layout = 'flow';
    rootEl.classList.remove('fit');
    appEl.style.width = '';
    appEl.style.transform = '';
    uiScale = 1;
  } else {
    const x = (vw - W * s) / 2;
    const y = padTop + Math.max(0, (vh - H * s) / 2);
    appEl.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    uiScale = s;
  }
  for (const d of decks) d.resize();
}

let fitQueued = false;
const queueFit = () => {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitToScreen(); });
};
window.addEventListener('resize', queueFit);
window.addEventListener('orientationchange', queueFit);
if (window.visualViewport) window.visualViewport.addEventListener('resize', queueFit);
// Inhalt wird höher/niedriger (z. B. Schrift geladen, Aufnahme-Liste) → neu einpassen
new ResizeObserver(queueFit).observe(appEl);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueFit);
fitToScreen();
