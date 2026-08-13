/* Streaming 6-Lead QRS Detector — everything on this page is computed here.
 *
 * Pipeline, per 250 Hz sample:
 *   synthesise dipole -> project to leads I and II -> add noise
 *   -> derive the analysis lead -> 5-15 Hz band-pass -> derivative -> square
 *   -> moving-window integration -> adaptive Pan-Tompkins thresholding
 *   -> R-peak back-search -> beat features -> 3-class softmax -> rhythm call.
 *
 * The simulator writes the ground-truth R peak and beat type for every beat it
 * generates, so the detector is scored against truth in the same tick.
 * No network, no dependencies, no build step.
 */
(function () {
  "use strict";

  /* ----------------------------------------------------------------------
   * 0. Constants
   * -------------------------------------------------------------------- */

  var FS = 250; // sample rate, Hz
  var CAP = 2048; // ring-buffer length, ~8.2 s
  var WINDOW_S = 5; // seconds of signal on screen
  var TOL = Math.round(0.15 * FS); // +/-150 ms beat-matching tolerance
  var RESOLVE_SLACK = Math.round(1.4 * FS); // wait before declaring a miss
  var WARMUP_S = 2.5;
  var CLASS_LAG = Math.round(0.26 * FS); // samples needed after R to classify
  var LOOKAHEAD = Math.round(0.6 * FS); // beat scheduling horizon
  var LEARN_N = Math.round(2.0 * FS); // detector learning phase
  var BUDGET_MS = 250;
  var SEED = 20260813;

  var LEAD_NAMES = ["I", "II", "III", "aVR", "aVL", "aVF"];
  var CLASSES = ["N", "V", "A"];
  var CLASS_LABEL = { N: "Normal", V: "PVC", A: "Atrial premature" };

  /* ----------------------------------------------------------------------
   * 1. Small utilities
   * -------------------------------------------------------------------- */

  function $(id) {
    return document.getElementById(id);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function median(arr) {
    if (!arr.length) return 0;
    var c = arr.slice().sort(function (x, y) {
      return x - y;
    });
    var m = c.length >> 1;
    return c.length % 2 ? c[m] : (c[m - 1] + c[m]) / 2;
  }

  function fmtClock(n) {
    var s = n / FS;
    var mm = Math.floor(s / 60);
    var ss = s - mm * 60;
    return (mm < 10 ? "0" : "") + mm + ":" + (ss < 10 ? "0" : "") + ss.toFixed(1);
  }

  var RAD = Math.PI / 180;

  /* ----------------------------------------------------------------------
   * 2. Biquad filters (RBJ cookbook), used for the 5-15 Hz band-pass
   * -------------------------------------------------------------------- */

  function Biquad() {
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.reset();
  }

  Biquad.prototype.reset = function () {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  };

  Biquad.prototype.setLowpass = function (fs, f0, q) {
    var w0 = (2 * Math.PI * f0) / fs;
    var cw = Math.cos(w0);
    var al = Math.sin(w0) / (2 * q);
    var a0 = 1 + al;
    this.b0 = ((1 - cw) / 2) / a0;
    this.b1 = (1 - cw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - al) / a0;
  };

  Biquad.prototype.setHighpass = function (fs, f0, q) {
    var w0 = (2 * Math.PI * f0) / fs;
    var cw = Math.cos(w0);
    var al = Math.sin(w0) / (2 * q);
    var a0 = 1 + al;
    this.b0 = ((1 + cw) / 2) / a0;
    this.b1 = (-(1 + cw)) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - al) / a0;
  };

  Biquad.prototype.process = function (x) {
    var y =
      this.b0 * x +
      this.b1 * this.x1 +
      this.b2 * this.x2 -
      this.a1 * this.y1 -
      this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  };

  /* The band-pass is causal, so its output lags the input. Measure that lag
     once, from the impulse response of the actual cascade, and subtract it
     when reporting where the R peak was — otherwise every R location is
     biased late by the filter's group delay. */
  function bandpassDelaySamples() {
    var hp = new Biquad(),
      lp = new Biquad();
    hp.setHighpass(FS, 5, 0.707);
    lp.setLowpass(FS, 15, 0.707);
    /* Push a QRS-shaped pulse through and see how far its peak moves. Using
       the impulse response would measure the wrong thing — the high-pass
       responds instantly, but a 9 ms Gaussian does not. */
    var sigma = 0.009 * FS;
    var peakIn = Math.round(0.4 * FS);
    var best = peakIn,
      bestV = -1;
    for (var i = 0; i < FS; i++) {
      var z = (i - peakIn) / sigma;
      var y = Math.abs(lp.process(hp.process(Math.exp(-0.5 * z * z))));
      if (y > bestV) {
        bestV = y;
        best = i;
      }
    }
    return Math.max(0, best - peakIn);
  }

  var BP_DELAY = 0; // filled in once Biquad is available (see below)

  /* Moving average over a fixed window — the "moving-window integration"
     stage. Kept as a mean (not a sum) so the threshold survives a window
     change without rescaling. */
  function MovingWindow(n) {
    this.setWindow(n);
  }

  MovingWindow.prototype.setWindow = function (n) {
    this.n = Math.max(1, n | 0);
    this.buf = new Float32Array(this.n);
    this.i = 0;
    this.sum = 0;
    this.filled = 0;
  };

  MovingWindow.prototype.process = function (x) {
    this.sum -= this.buf[this.i];
    this.buf[this.i] = x;
    this.sum += x;
    this.i = (this.i + 1) % this.n;
    if (this.filled < this.n) this.filled++;
    return this.sum / this.filled;
  };

  /* ----------------------------------------------------------------------
   * 3. Parameters (mirrors the controls)
   * -------------------------------------------------------------------- */

  var params = {
    scenario: "sinus",
    hr: 72,
    motion: 0.12,
    wanderMv: 0.15,
    mains: false,
    lead: 1,
    winSamples: Math.round(0.15 * FS),
    refracSamples: Math.round(0.2 * FS),
    thrK: 0.25,
    searchback: true,
    twave: true,
    inferMs: 0.06,
    uplinkMs: 90,
    speed: 1
  };

  /* ----------------------------------------------------------------------
   * 4. Signal simulator
   *
   * A single cardiac dipole per wave component. Each component has a
   * magnitude (mV), a Gaussian shape in time, and an axis in the frontal
   * plane. A limb lead at angle theta sees magnitude * cos(theta - axis),
   * which is exactly the projection that makes Einthoven's law hold.
   * -------------------------------------------------------------------- */

  function Sim(seed) {
    this.rng = mulberry32(seed);
    this.spare = null;
    this.beats = [];
    this.idx = 0;
    this.afterEctopic = 0;
    this.pendingPVC = false;
    this.pendingPause = false;
    this.burstEnd = -1;
    this.burstAmp = 0;
    this.burstF = 4;
    this.burstPh = 0;
    this.nextBurstN = Math.round(2.4 * FS);
    this.lastBeatN = Math.round(0.35 * FS);
    this.emit(this.lastBeatN, "N");
  }

  Sim.prototype.gauss = function () {
    if (this.spare !== null) {
      var s = this.spare;
      this.spare = null;
      return s;
    }
    var u = 0,
      v = 0,
      r = 0;
    do {
      u = this.rng() * 2 - 1;
      v = this.rng() * 2 - 1;
      r = u * u + v * v;
    } while (r === 0 || r >= 1);
    var f = Math.sqrt((-2 * Math.log(r)) / r);
    this.spare = v * f;
    return u * f;
  };

  Sim.prototype.rsa = function (t) {
    /* Respiratory sinus arrhythmia: a few percent of RR modulation at ~0.24 Hz. */
    return 1 + 0.035 * Math.sin(2 * Math.PI * 0.24 * t) + 0.012 * this.gauss();
  };

  function makeComps(type, rng, scenario) {
    var comps;
    if (type === "V") {
      var va = -112 + (rng() * 2 - 1) * 14; // bizarre, ventricular origin
      comps = [
        { c: -0.03, s: 0.019, m: -0.28, a: va },
        { c: 0.01, s: 0.026, m: 1.32, a: va },
        { c: 0.064, s: 0.03, m: -0.62, a: va },
        { c: 0.31, s: 0.072, m: 0.55, a: va + 180 } // discordant T
      ];
    } else {
      var axis = 58 + (rng() * 2 - 1) * 8;
      comps = [
        { c: -0.022, s: 0.0068, m: -0.115, a: axis },
        { c: 0.0, s: 0.009, m: 1.02, a: axis },
        { c: 0.026, s: 0.01, m: -0.235, a: axis },
        { c: 0.275, s: 0.05, m: 0.305, a: 44 }
      ];
      if (type === "A") {
        comps.unshift({ c: -0.132, s: 0.0215, m: 0.115, a: 18 });
      } else if (scenario !== "afib") {
        comps.unshift({ c: -0.165, s: 0.024, m: 0.155, a: 52 });
      }
    }
    for (var i = 0; i < comps.length; i++) {
      var k = comps[i];
      k.p0 = Math.cos((0 - k.a) * RAD);
      k.p60 = Math.cos((60 - k.a) * RAD);
      k.p120 = Math.cos((120 - k.a) * RAD);
      k.inv = 1 / k.s;
    }
    return comps;
  }

  Sim.prototype.emit = function (n, type) {
    var comps = makeComps(type, this.rng, params.scenario);
    /* Respiratory amplitude modulation: the heart swings in the chest, so R
       height breathes by roughly +/-15%. This is what makes a fixed detector
       threshold miss the small beats. */
    var gain = 1 + 0.14 * Math.sin(2 * Math.PI * 0.28 * (n / FS) + 0.7) + 0.1 * this.gauss();
    for (var g = 0; g < comps.length; g++) comps[g].m *= gain;
    var b = { n: n, type: type, comps: comps };
    this.beats.push(b);
    state.truth.push({ n: n, type: type, matched: false, missed: false });
    this.idx++;
    return b;
  };

  Sim.prototype.scheduleOne = function () {
    var baseRR = 60 / params.hr;
    var t = this.lastBeatN / FS;
    var type = "N";
    var rr;

    if (this.afterEctopic > 0) {
      rr = this.afterEctopic * baseRR;
      this.afterEctopic = 0;
    } else if (this.pendingPVC) {
      this.pendingPVC = false;
      type = "V";
      rr = 0.6 * baseRR;
      this.afterEctopic = 1.4;
    } else if (this.pendingPause) {
      this.pendingPause = false;
      rr = Math.max(3.2, baseRR);
    } else {
      switch (params.scenario) {
        case "pvc":
          if (this.idx % 3 === 2) {
            type = "V";
            rr = 0.6 * baseRR;
            this.afterEctopic = 1.4;
          } else {
            rr = baseRR * this.rsa(t);
          }
          break;
        case "apb":
          if (this.idx % 7 === 5) {
            type = "A";
            rr = 0.68 * baseRR;
            this.afterEctopic = 1.18;
          } else {
            rr = baseRR * this.rsa(t);
          }
          break;
        case "afib":
          rr = clamp(baseRR * Math.exp(0.19 * this.gauss()), 0.4, 2.4);
          break;
        case "pause":
          rr = this.idx % 9 === 7 ? Math.max(3.2, baseRR) : baseRR * this.rsa(t);
          break;
        default:
          rr = baseRR * this.rsa(t);
      }
    }

    var step = Math.max(Math.round(0.2 * FS), Math.round(rr * FS));
    this.lastBeatN += step;
    this.emit(this.lastBeatN, type);
  };

  Sim.prototype.ensure = function (untilN) {
    var guard = 0;
    while (this.lastBeatN < untilN && guard++ < 200) this.scheduleOne();
    /* Drop beats whose T wave has fully passed. */
    while (this.beats.length && this.beats[0].n < untilN - LOOKAHEAD - Math.round(0.9 * FS)) {
      this.beats.shift();
    }
  };

  Sim.prototype.burstBump = function (n) {
    if (params.motion > 0.02 && n >= this.nextBurstN && n > this.burstEnd) {
      var dur = (0.35 + 0.6 * this.rng()) * FS;
      this.burstStart = n;
      this.burstEnd = n + Math.round(dur);
      this.burstAmp = (0.3 + 0.9 * this.rng()) * params.motion;
      this.burstF = 2.5 + 6 * this.rng();
      this.burstPh = this.rng() * 6.283;
      this.nextBurstN =
        this.burstEnd + Math.round((1.0 + 5.0 * (1 - params.motion)) * FS);
    }
    if (n > this.burstEnd || this.burstEnd < 0) return 0;
    var prog = (n - this.burstStart) / Math.max(1, this.burstEnd - this.burstStart);
    var env = this.burstAmp * Math.sin(Math.PI * clamp(prog, 0, 1));
    var t = n / FS;
    return env * (Math.sin(2 * Math.PI * this.burstF * t + this.burstPh) + 0.6 * this.gauss());
  };

  Sim.prototype.forceBurst = function (n) {
    this.burstStart = n;
    this.burstEnd = n + Math.round(1.5 * FS);
    this.burstAmp = Math.max(0.45, params.motion);
    this.burstF = 3.4;
    this.burstPh = this.rng() * 6.283;
    this.nextBurstN = this.burstEnd + Math.round(2 * FS);
  };

  /* Returns the clean projections onto 0 deg (I), 60 deg (II) and 120 deg
     (III), plus the noisy measured channels. */
  Sim.prototype.sampleAt = function (n) {
    var t = n / FS;
    var c0 = 0,
      c60 = 0,
      c120 = 0;
    var beats = this.beats;
    for (var i = 0; i < beats.length; i++) {
      var b = beats[i];
      var dt = t - b.n / FS;
      if (dt < -0.34 || dt > 0.56) continue;
      var cs = b.comps;
      for (var j = 0; j < cs.length; j++) {
        var k = cs[j];
        var d = (dt - k.c) * k.inv;
        if (d > 5 || d < -5) continue;
        var g = k.m * Math.exp(-0.5 * d * d);
        c0 += g * k.p0;
        c60 += g * k.p60;
        c120 += g * k.p120;
      }
    }

    if (params.scenario === "afib") {
      var f =
        0.035 * Math.sin(2 * Math.PI * 5.6 * t) +
        0.024 * Math.sin(2 * Math.PI * 7.9 * t + 1.7) +
        0.02 * Math.sin(2 * Math.PI * 9.7 * t + 3.1);
      c0 += f * Math.cos(-50 * RAD);
      c60 += f * Math.cos(10 * RAD);
      c120 += f * Math.cos(70 * RAD);
    }

    var w = params.wanderMv;
    var bw0 =
      w * (0.72 * Math.sin(2 * Math.PI * 0.21 * t + 0.4) + 0.34 * Math.sin(2 * Math.PI * 0.063 * t + 1.9));
    var bw60 =
      w * (0.66 * Math.sin(2 * Math.PI * 0.21 * t + 0.9) + 0.4 * Math.sin(2 * Math.PI * 0.063 * t + 2.6));

    var burst = this.burstBump(n);
    var hum = params.mains ? 0.25 * Math.sin(2 * Math.PI * 60 * t) : 0;
    var sd = 0.006 + 0.045 * params.motion;

    return {
      c0: c0,
      c60: c60,
      c120: c120,
      a: c0 + bw0 + 0.9 * burst + hum + sd * this.gauss(),
      b: c60 + bw60 + 1.1 * burst + hum + sd * this.gauss()
    };
  };

  /* Derive any of the six limb leads from the two measured channels. */
  function deriveLead(idx, a, b) {
    switch (idx) {
      case 0:
        return a; // I
      case 1:
        return b; // II
      case 2:
        return b - a; // III  = II - I
      case 3:
        return -(a + b) / 2; // aVR
      case 4:
        return a - b / 2; // aVL
      default:
        return b - a / 2; // aVF
    }
  }

  /* ----------------------------------------------------------------------
   * 5. State
   * -------------------------------------------------------------------- */

  var state = null;

  function makeState() {
    return {
      n: 0,
      sim: null,
      hp: new Biquad(), // 5-15 Hz detection band
      lp: new Biquad(),
      hpD: new Biquad(), // 0.5-40 Hz diagnostic band, for beat features
      lpD: new Biquad(),
      mwi: new MovingWindow(params.winSamples),
      dbuf: [0, 0, 0, 0, 0],

      ringI: new Float32Array(CAP),
      ringII: new Float32Array(CAP),
      ringDiag: new Float32Array(CAP),
      ringBp: new Float32Array(CAP),
      ringDeriv: new Float32Array(CAP),
      ringMwi: new Float32Array(CAP),
      ringThr: new Float32Array(CAP),

      truth: [],
      truthHead: 0,
      dets: [],
      pendingClass: [],

      det: null,
      scoreStartN: Math.round(WARMUP_S * FS),
      tp: 0,
      fp: 0,
      fn: 0,
      locErrSum: 0,
      lagSum: 0,
      lagN: 0,
      classBeats: 0,
      classRight: 0,
      conf: { N: { N: 0, V: 0, A: 0 }, V: { N: 0, V: 0, A: 0 }, A: { N: 0, V: 0, A: 0 } },

      refHist: [],

      rrHist: [],
      rrNHist: [],
      pHist: [],
      clsHist: [],
      lastDetN: -1,
      hr: 0,
      irreg: 0,
      pMean: 0,
      rhythm: "—",
      rhythmSev: "ok",
      pendingLabel: null,
      pendingCount: 0,
      residual: 0
    };
  }

  /* ----------------------------------------------------------------------
   * 6. Pan-Tompkins detector
   * -------------------------------------------------------------------- */

  function Detector() {
    this.reset(0);
  }

  Detector.prototype.reset = function (n) {
    this.startN = n;
    this.learning = true;
    this.lMax = 0;
    this.lSum = 0;
    this.lCount = 0;
    this.spki = 0;
    this.npki = 0;
    this.prev = 0;
    this.rising = false;
    this.lastQrsN = -1e9;
    this.lastRn = -1e9;
    this.lastSlope = 0;
    this.cands = [];
    this.rr8 = [];
    this.rrSel8 = [];
    this.rrAvg = 0.8 * FS;
    this.rrAvgSel = 0.8 * FS;
    this.outBand = 0;
    this.sbBlock = -1;
  };

  Detector.prototype.threshold = function () {
    var t1 = this.npki + params.thrK * Math.max(0, this.spki - this.npki);
    return t1;
  };

  /* Steepest slope inside the QRS itself. It has to be measured around where
     the complex actually is, not around the integrator peak — the integrator
     peak sits half a window later, by which point the upstroke has left the
     measurement window entirely. */
  function slopeAround(nE) {
    var lo = Math.max(0, Math.max(nE - 10, state.n - CAP + 2));
    var hi = Math.min(nE + 10, state.n - 1);
    var m = 0;
    for (var i = lo; i <= hi; i++) {
      var v = Math.abs(state.ringDeriv[i % CAP]);
      if (v > m) m = v;
    }
    return m;
  }

  Detector.prototype.process = function (n, mwiVal) {
    if (this.learning) {
      this.lCount++;
      this.lSum += mwiVal;
      if (mwiVal > this.lMax) this.lMax = mwiVal;
      if (n - this.startN >= LEARN_N) {
        this.learning = false;
        this.spki = 0.33 * this.lMax;
        this.npki = 0.5 * (this.lSum / Math.max(1, this.lCount));
        if (this.spki <= this.npki) this.spki = this.npki * 2 + 1e-9;
      }
    }

    /* Local-maximum detection on the integrated signal. */
    if (mwiVal > this.prev) {
      this.rising = true;
    } else if (this.rising && mwiVal < this.prev) {
      this.rising = false;
      this.onPeak(n - 1, this.prev);
    }
    this.prev = mwiVal;

    /* Search-back: no QRS for 1.66 average RR means we probably missed one. */
    if (
      params.searchback &&
      !this.learning &&
      this.lastQrsN > -1e8 &&
      n > this.sbBlock &&
      n - this.lastQrsN > 1.66 * this.rrAvgSel
    ) {
      var lo = this.lastQrsN + params.refracSamples;
      var t2 = 0.5 * this.threshold();
      var best = null;
      for (var i = 0; i < this.cands.length; i++) {
        var c = this.cands[i];
        if (c.n <= lo || c.n > n) continue;
        if (c.v < t2) continue;
        if (!best || c.v > best.v) best = c;
      }
      if (best) {
        this.spki = 0.25 * best.v + 0.75 * this.spki;
        var loc2 = this.locateR(best.n);
        this.accept(best.n, loc2, slopeAround(loc2.energyN), true);
      } else {
        this.sbBlock = n + Math.round(0.2 * FS); // retry 5x per second
      }
    }

    if (n % 64 === 0) {
      while (this.cands.length && this.cands[0].n < n - 3 * FS) this.cands.shift();
    }
  };

  Detector.prototype.onPeak = function (pn, pv) {
    this.cands.push({ n: pn, v: pv });
    if (this.learning) return;

    var t1 = this.threshold();
    if (pv > t1) {
      if (pn - this.lastQrsN > params.refracSamples) {
        var loc = this.locateR(pn);
        var slope = slopeAround(loc.energyN);
        var isT =
          params.twave &&
          this.lastQrsN > -1e8 &&
          pn - this.lastQrsN < 0.36 * FS &&
          slope < 0.5 * this.lastSlope;
        if (isT) {
          this.npki = 0.125 * pv + 0.875 * this.npki;
        } else {
          this.spki = 0.125 * pv + 0.875 * this.spki;
          this.accept(pn, loc, slope, false);
        }
      }
      /* Peaks inside the refractory window update nothing — they are the
         tail of the QRS we already took. */
    } else {
      this.npki = 0.125 * pv + 0.875 * this.npki;
    }
  };

  /* Back-search the band-passed signal for the actual R peak: the integrator
     peak sits roughly half a window after it. */
  Detector.prototype.locateR = function (pn) {
    var back = params.winSamples + Math.round(0.05 * FS);
    var lo = Math.max(0, pn - back);
    var hi = Math.min(pn + 2, state.n - 1);
    var bestI = pn,
      bestV = -1;
    for (var i = lo; i <= hi; i++) {
      if (i < state.n - CAP + 2) continue;
      var v = Math.abs(state.ringBp[i % CAP]);
      if (v > bestV) {
        bestV = v;
        bestI = i;
      }
    }
    return {
      n: Math.max(0, bestI - BP_DELAY), // group-delay compensated
      energyN: bestI, // where the filtered energy actually peaked
      amp: bestV < 0 ? 0 : bestV
    };
  };

  Detector.prototype.accept = function (pn, loc, slope, viaSearchback) {
    var nR = loc.n;

    if (this.lastRn > -1e8) {
      var rr = nR - this.lastRn;
      if (rr > 0.15 * FS && rr < 5 * FS) {
        /* Seed both averages from the first interval we see, otherwise a rate
           far from the 0.8 s default never enters the acceptance band and the
           missed-beat limit stays frozen. */
        if (this.rr8.length === 0) {
          this.rrAvg = rr;
          this.rrAvgSel = rr;
        }
        this.rr8.push(rr);
        if (this.rr8.length > 8) this.rr8.shift();
        var s = 0;
        for (var i = 0; i < this.rr8.length; i++) s += this.rr8[i];
        this.rrAvg = s / this.rr8.length;

        if (rr >= 0.92 * this.rrAvgSel && rr <= 1.16 * this.rrAvgSel) {
          this.rrSel8.push(rr);
          if (this.rrSel8.length > 8) this.rrSel8.shift();
          var s2 = 0;
          for (var j = 0; j < this.rrSel8.length; j++) s2 += this.rrSel8[j];
          this.rrAvgSel = s2 / this.rrSel8.length;
          this.outBand = 0;
        } else if (++this.outBand >= 8) {
          /* Eight intervals in a row outside the band means the rate really
             moved — resynchronise instead of chasing a stale average. */
          this.rrSel8 = [];
          this.rrAvgSel = this.rrAvg;
          this.outBand = 0;
        }
      }
    }

    this.lastQrsN = pn;
    this.lastRn = nR;
    this.lastSlope = slope;
    this.sbBlock = -1;

    onQRS(nR, loc.energyN, pn, loc.amp, viaSearchback);
  };

  /* ----------------------------------------------------------------------
   * 7. Scoring, beat classification, rhythm
   * -------------------------------------------------------------------- */

  function onQRS(nR, nE, nDet, amp, viaSearchback) {
    var d = {
      nR: nR,
      nE: nE,
      nDet: nDet,
      amp: amp,
      sb: !!viaSearchback,
      tp: false,
      fp: false,
      counted: false,
      gt: null,
      cls: null,
      conf: 0,
      locErr: 0,
      lag: nDet - nR
    };
    state.dets.push(d);

    /* Match to ground truth within +/-150 ms. */
    var best = -1,
      bestD = 1e9;
    for (var k = state.truthHead; k < state.truth.length; k++) {
      var tb = state.truth[k];
      if (tb.n > nR + TOL) break;
      if (tb.matched) continue;
      var dd = Math.abs(tb.n - nR);
      if (dd <= TOL && dd < bestD) {
        bestD = dd;
        best = k;
      }
    }

    var scored = nR >= state.scoreStartN;
    if (best >= 0) {
      var t = state.truth[best];
      t.matched = true;
      d.tp = true;
      d.gt = t.type;
      d.locErr = bestD;
      d.lag = nDet - t.n;
      if (scored && t.n >= state.scoreStartN) {
        state.tp++;
        state.locErrSum += bestD;
        state.lagSum += d.lag;
        state.lagN++;
        d.counted = true;
      }
    } else {
      d.fp = true;
      if (scored) state.fp++;
    }

    state.pendingClass.push(d);
  }

  function softmax3(zN, zV, zA) {
    var m = Math.max(zN, Math.max(zV, zA));
    var eN = Math.exp(zN - m),
      eV = Math.exp(zV - m),
      eA = Math.exp(zA - m);
    var s = eN + eV + eA;
    return [eN / s, eV / s, eA / s];
  }

  function classify(d) {
    var nR = d.nR;
    var lowest = Math.max(0, state.n - CAP + 4);
    function raw(i) {
      return i < lowest || i >= state.n ? null : state.ringDiag[i % CAP];
    }

    /* Isoelectric reference from the PR segment, 70-35 ms before R. It has to
       be this narrow: at 120 bpm and up, a wider window reaches back into the
       previous beat's T wave and the whole measurement tilts. */
    var b0 = nR - Math.round(0.07 * FS),
      b1 = nR - Math.round(0.035 * FS);
    var sum = 0,
      cnt = 0,
      v;
    for (var j = b0; j <= b1; j++) {
      v = raw(j);
      if (v === null) continue;
      sum += v;
      cnt++;
    }
    var base = cnt ? sum / cnt : 0;

    /* P-wave energy: RMS about that reference over 200-75 ms before R, where
       a P wave would be. The detection band-pass throws P waves away, so this
       has to come off the diagnostic band. */
    var a0 = nR - Math.round(0.2 * FS),
      a1 = nR - Math.round(0.075 * FS);
    var sq = 0,
      pn = 0;
    for (var j2 = a0; j2 <= a1; j2++) {
      v = raw(j2);
      if (v === null) continue;
      sq += (v - base) * (v - base);
      pn++;
    }
    var pRms = pn ? Math.sqrt(sq / pn) : 0;

    var rRaw = 0;
    for (var j3 = nR - 8; j3 <= nR + 8; j3++) {
      v = raw(j3);
      if (v === null) continue;
      var av = Math.abs(v - base);
      if (av > rRaw) rRaw = av;
    }
    var pRatio = pRms / Math.max(0.05, rRaw);

    /* QRS onset and offset: walk outwards from R while the trace keeps
       leaving baseline by more than 20% of the R height, tolerating up to
       32 ms below that. The tolerance matters because a biphasic complex
       crosses zero between its R and S; the cap on it is what stops the walk
       from running into the T wave of the beat before. */
    var wThr = Math.max(0.05, 0.2 * rRaw);
    var on = nR,
      off = nR,
      gap = 0;
    for (var l = nR - 1; l >= nR - 30; l--) {
      v = raw(l);
      if (v !== null && Math.abs(v - base) > wThr) {
        on = l;
        gap = 0;
      } else if (++gap > 8) break;
    }
    gap = 0;
    for (var r = nR + 1; r <= nR + 35; r++) {
      v = raw(r);
      if (v !== null && Math.abs(v - base) > wThr) {
        off = r;
        gap = 0;
      } else if (++gap > 8) break;
    }
    var widthMs = ((off - on) / FS) * 1000;

    var rrSec = state.lastDetN >= 0 ? (nR - state.lastDetN) / FS : 0;
    state.lastDetN = nR;

    /* References are medians of the last eight beats, not averages of the
       beats we already called normal — an average fed by its own decisions
       can latch onto a wrong reference and never recover. */
    var h = state.refHist;
    var ws = [],
      as = [],
      ps = [],
      rs = [];
    for (var q = 0; q < h.length; q++) {
      ws.push(h[q].w);
      as.push(h[q].a);
      ps.push(h[q].p);
      if (h[q].r > 0) rs.push(h[q].r);
    }
    var wRef = ws.length >= 3 ? median(ws) : widthMs;
    var ampRef = as.length >= 3 ? median(as) : d.amp;
    var pRef = ps.length >= 3 ? median(ps) : pRatio;
    var rrOk = rrSec > 0.25 && rrSec < 2.5;
    var rrRef = rs.length >= 3 ? median(rs) : rrOk ? rrSec : 60 / params.hr;

    var wZ = clamp((widthMs - wRef) / Math.max(28, 0.45 * wRef), -3, 4);
    var rrZ = rrSec > 0 ? clamp((rrSec / Math.max(0.2, rrRef) - 1) / 0.25, -3, 3) : 0;
    var pZ = clamp((pRatio - pRef) / (0.5 * pRef + 0.015), -2.5, 2.5);
    var aZ = clamp((d.amp / Math.max(1e-4, ampRef) - 1) / 0.35, -3, 3);

    var zN = 1.35 - 1.3 * wZ + 0.95 * rrZ + 0.2 * pZ - 0.15 * aZ;
    var zV = -1.6 + 2.1 * wZ - 0.95 * rrZ - 0.45 * pZ + 0.35 * aZ;
    var zA = -1.3 - 0.55 * wZ - 1.9 * rrZ + 0.35 * pZ - 0.2 * aZ;
    var p = softmax3(zN, zV, zA);

    var bi = 0;
    if (p[1] > p[bi]) bi = 1;
    if (p[2] > p[bi]) bi = 2;
    d.cls = CLASSES[bi];
    d.conf = p[bi];
    d.widthMs = widthMs;
    d.pRatio = pRatio;
    d.rrSec = rrSec;

    h.push({ w: widthMs, a: d.amp, p: pRatio, r: rrOk ? rrSec : 0 });
    if (h.length > 8) h.shift();

    if (d.counted && d.gt && ws.length >= 3) {
      state.conf[d.gt][d.cls]++;
      state.classBeats++;
      if (d.gt === d.cls) state.classRight++;
    }

    updateRhythm(d, rrSec, pRatio);
  }

  function updateRhythm(d, rrSec, pRatio) {
    if (rrSec > 0.2) {
      state.rrHist.push(rrSec);
      if (state.rrHist.length > 16) state.rrHist.shift();
      var prevCls = state.clsHist.length ? state.clsHist[state.clsHist.length - 1] : null;
      if (d.cls === "N" && prevCls === "N" && rrSec < 2.0) {
        state.rrNHist.push(rrSec);
        if (state.rrNHist.length > 10) state.rrNHist.shift();
      }
    }
    state.clsHist.push(d.cls);
    if (state.clsHist.length > 24) state.clsHist.shift();
    state.pHist.push(pRatio);
    if (state.pHist.length > 8) state.pHist.shift();

    var med = median(state.rrHist.filter(function (x) {
      return x < 2.5;
    }));
    var hr = med > 0 ? 60 / med : 0;
    state.hr = hr;

    var irreg = 0;
    if (state.rrNHist.length >= 5) {
      var s = 0,
        m = 0;
      for (var i = 1; i < state.rrNHist.length; i++) {
        var dd = state.rrNHist[i] - state.rrNHist[i - 1];
        s += dd * dd;
      }
      for (var j = 0; j < state.rrNHist.length; j++) m += state.rrNHist[j];
      m /= state.rrNHist.length;
      irreg = m > 0 ? Math.sqrt(s / (state.rrNHist.length - 1)) / m : 0;
    }
    state.irreg = irreg;

    var pMean = state.pHist.length ? median(state.pHist) : 0;
    state.pMean = pMean;

    var pvcs = 0;
    for (var q = 0; q < state.clsHist.length; q++) if (state.clsHist[q] === "V") pvcs++;

    /* The AF test is the beat-to-beat irregularity of intervals between two
       beats both believed normal. It is deliberately not a P-wave test: on a
       patch the P wave is small enough that motion and a fast rate swamp it,
       which the P-wave readout on the page shows. */
    var irregular = irreg > 0.1 && state.rrNHist.length >= 6;

    var label,
      sev,
      immediate = false;
    if (rrSec > 2.8) {
      label = "Pause " + rrSec.toFixed(1) + " s";
      sev = "alarm";
      immediate = true;
    } else if (irregular) {
      label = "Irregularly irregular — possible AF";
      if (hr > 110) {
        label += ", rapid ventricular response " + Math.round(hr) + " bpm";
        sev = hr > 150 ? "alarm" : "warn";
      } else if (hr > 0 && hr < 50) {
        label += ", slow ventricular response " + Math.round(hr) + " bpm";
        sev = "alarm";
      } else {
        sev = "warn";
      }
    } else if (hr > 0 && hr < 40) {
      label = "Severe bradycardia " + Math.round(hr) + " bpm";
      sev = "alarm";
    } else if (hr > 0 && hr < 50) {
      label = "Bradycardia " + Math.round(hr) + " bpm";
      sev = "warn";
    } else if (hr > 150) {
      label = "Marked tachycardia " + Math.round(hr) + " bpm";
      sev = "alarm";
    } else if (hr > 100) {
      label = "Tachycardia " + Math.round(hr) + " bpm";
      sev = "warn";
    } else if (pvcs >= 4) {
      label = "Sinus with frequent ventricular ectopy";
      sev = "warn";
    } else if (hr > 0) {
      label = "Sinus rhythm";
      sev = "ok";
    } else {
      return;
    }

    if (label === state.rhythm) {
      state.pendingLabel = null;
      state.pendingCount = 0;
      return;
    }
    if (immediate) {
      commitRhythm(label, sev, d);
      return;
    }
    if (state.pendingLabel === label) {
      state.pendingCount++;
    } else {
      state.pendingLabel = label;
      state.pendingCount = 1;
    }
    if (state.pendingCount >= 2) commitRhythm(label, sev, d);
  }

  function commitRhythm(label, sev, d) {
    state.rhythm = label;
    state.rhythmSev = sev;
    state.pendingLabel = null;
    state.pendingCount = 0;
    var lagMs = state.lagN ? (state.lagSum / state.lagN / FS) * 1000 : (d.lag / FS) * 1000;
    var total = lagMs + params.inferMs + params.uplinkMs;
    logLine(
      d.nDet,
      label + "  (alert at +" + total.toFixed(0) + " ms)",
      sev === "ok" ? "ok" : sev
    );
  }

  /* ----------------------------------------------------------------------
   * 8. Per-sample step
   * -------------------------------------------------------------------- */

  function stepOne() {
    var n = state.n;
    state.sim.ensure(n + LOOKAHEAD);
    var s = state.sim.sampleAt(n);
    state.residual = s.c0 + s.c120 - s.c60;

    var idx = n % CAP;
    state.ringI[idx] = s.a;
    state.ringII[idx] = s.b;

    var raw = deriveLead(params.lead, s.a, s.b);

    /* Two bands off the same lead: a narrow one for finding beats, a wide one
       for measuring them. Baseline wander is below 0.5 Hz and mains is above
       40 Hz, so neither reaches the beat features. */
    state.ringDiag[idx] = state.lpD.process(state.hpD.process(raw));

    var bp = state.lp.process(state.hp.process(raw));
    state.ringBp[idx] = bp;

    var db = state.dbuf;
    var deriv = (2 * bp + db[0] - db[2] - 2 * db[3]) / 8;
    db[3] = db[2];
    db[2] = db[1];
    db[1] = db[0];
    db[0] = bp;

    state.ringDeriv[idx] = deriv;
    var sq = deriv * deriv;

    var mwi = state.mwi.process(sq);
    state.ringMwi[idx] = mwi;

    state.det.process(n, mwi);
    state.ringThr[idx] = state.det.learning ? 0 : state.det.threshold();

    state.n = n + 1;

    /* Resolve misses once no late detection can still claim the beat. */
    while (
      state.truthHead < state.truth.length &&
      state.truth[state.truthHead].n + TOL + RESOLVE_SLACK < state.n
    ) {
      var tb = state.truth[state.truthHead];
      if (!tb.matched && tb.n >= state.scoreStartN) {
        state.fn++;
        tb.missed = true;
      }
      state.truthHead++;
    }

    while (state.pendingClass.length && state.pendingClass[0].nR + CLASS_LAG <= state.n) {
      classify(state.pendingClass.shift());
    }

    if (state.n % 512 === 0) {
      var cut = 0;
      while (cut < state.truthHead && state.truth[cut].n < state.n - CAP) cut++;
      if (cut > 0) {
        state.truth.splice(0, cut);
        state.truthHead -= cut;
      }
      while (state.dets.length && state.dets[0].nR < state.n - CAP) state.dets.shift();
    }
  }

  function advance(seconds) {
    var steps = Math.round(seconds * FS);
    if (steps > 8 * FS) steps = 8 * FS;
    for (var i = 0; i < steps; i++) stepOne();
  }

  /* ----------------------------------------------------------------------
   * 9. Canvas rendering
   * -------------------------------------------------------------------- */

  var PAD_L = 38,
    PAD_R = 6,
    AXIS_H = 20;

  var theme = null;

  function readTheme() {
    var cs = getComputedStyle(document.documentElement);
    function g(name, fb) {
      var v = cs.getPropertyValue(name);
      v = v ? v.trim() : "";
      return v || fb;
    }
    theme = {
      text: g("--text", "#191b1f"),
      muted: g("--text-muted", "#5d646e"),
      faint: g("--text-faint", "#868d97"),
      border: g("--border", "#e4e0d9"),
      strong: g("--border-strong", "#cfcac1"),
      accent: g("--accent", "#0f6e60"),
      warn: g("--warn", "#9a6212"),
      danger: g("--danger", "#a03028"),
      sunken: g("--bg-sunken", "#f2f0ec"),
      font: getComputedStyle(document.body).fontFamily || "sans-serif"
    };
  }

  function fitCanvas(cv, heightFor) {
    var parent = cv.parentNode;
    var w = Math.floor(parent.clientWidth);
    if (!(w > 0)) return null;
    var h = heightFor(w);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.style.height = h + "px";
    var bw = Math.max(1, Math.round(w * dpr));
    var bh = Math.max(1, Math.round(h * dpr));
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function xOf(i, w) {
    var span = w - PAD_L - PAD_R;
    return PAD_L + span * (1 - (state.n - i) / (WINDOW_S * FS));
  }

  function emptyMessage(ctx, w, h, msg) {
    ctx.fillStyle = theme.muted;
    ctx.font = "13px " + theme.font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(msg, w / 2, h / 2);
    ctx.textAlign = "left";
  }

  function drawTimeAxis(ctx, w, h) {
    var span = w - PAD_L - PAD_R;
    ctx.fillStyle = theme.faint;
    ctx.font = "10px " + theme.font;
    ctx.textBaseline = "top";
    for (var s = WINDOW_S; s >= 0; s--) {
      var x = PAD_L + span * (1 - s / WINDOW_S);
      var label = s === 0 ? "now" : "-" + s + "s";
      ctx.textAlign = s === 0 ? "right" : s === WINDOW_S ? "left" : "center";
      ctx.fillText(label, s === 0 ? w - PAD_R : x, h - AXIS_H + 5);
    }
    ctx.textAlign = "left";
  }

  /* Envelope polyline: one min/max column per pixel, so R peaks survive
     decimation on a narrow screen. */
  function tracePath(ctx, w, top, height, valueAt, lo, hi) {
    var total = WINDOW_S * FS;
    var startN = Math.max(0, state.n - total);
    var span = w - PAD_L - PAD_R;
    if (span <= 0 || state.n <= startN) return;
    var step = Math.max(1, Math.ceil(total / Math.max(1, span)));
    var range = hi - lo;
    if (!(range > 0)) range = 1;
    var yOf = function (v) {
      return top + height * (1 - (clamp(v, lo, hi) - lo) / range);
    };
    ctx.beginPath();
    var started = false;
    for (var i = startN; i < state.n; i += step) {
      var mn = Infinity,
        mx = -Infinity;
      var end = Math.min(i + step, state.n);
      for (var j = i; j < end; j++) {
        var v = valueAt(j);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (mn === Infinity) continue;
      var x = xOf(i, w);
      if (!started) {
        ctx.moveTo(x, yOf(mx));
        started = true;
      } else {
        ctx.lineTo(x, yOf(mx));
      }
      if (mn !== mx) ctx.lineTo(x, yOf(mn));
    }
    if (started) ctx.stroke();
  }

  function drawStrip() {
    var cv = $("strip");
    var fit = fitCanvas(cv, function (w) {
      return 6 * (w < 520 ? 42 : 54) + AXIS_H;
    });
    if (!fit) return;
    var ctx = fit.ctx,
      w = fit.w,
      h = fit.h;
    var laneH = (h - AXIS_H) / 6;
    var span = w - PAD_L - PAD_R;
    var mvRange = 1.7;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = theme.sunken;
    ctx.fillRect(0, 0, w, h);

    /* Grid: 200 ms x 0.5 mV. */
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    for (var s = 0; s <= WINDOW_S * 5; s++) {
      var gx = Math.round(PAD_L + (span * s) / (WINDOW_S * 5)) + 0.5;
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h - AXIS_H);
    }
    for (var lane = 0; lane < 6; lane++) {
      for (var mv = -1.5; mv <= 1.51; mv += 0.5) {
        var gy = Math.round(lane * laneH + laneH * (1 - (mv + mvRange) / (2 * mvRange))) + 0.5;
        ctx.moveTo(PAD_L, gy);
        ctx.lineTo(w - PAD_R, gy);
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (state.n === 0) {
      drawTimeAxis(ctx, w, h);
      emptyMessage(ctx, w, h, "Stream idle — press Run to start the simulated feed.");
      return;
    }

    for (var L = 0; L < 6; L++) {
      var top = L * laneH;
      /* 1 mV calibration bar in the gutter. */
      ctx.strokeStyle = theme.strong;
      ctx.lineWidth = 2;
      ctx.beginPath();
      var y0 = top + laneH * (1 - (0 + mvRange) / (2 * mvRange));
      var y1 = top + laneH * (1 - (1 + mvRange) / (2 * mvRange));
      ctx.moveTo(PAD_L - 6.5, y0);
      ctx.lineTo(PAD_L - 6.5, y1);
      ctx.stroke();

      ctx.fillStyle = theme.muted;
      ctx.font = "600 10px " + theme.font;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText(LEAD_NAMES[L], 3, top + 3);

      ctx.strokeStyle = L === params.lead ? theme.accent : theme.text;
      ctx.lineWidth = L === params.lead ? 1.4 : 1;
      ctx.globalAlpha = L === params.lead ? 1 : 0.72;
      (function (leadIdx) {
        tracePath(
          ctx,
          w,
          top,
          laneH,
          function (i) {
            var k = i % CAP;
            return deriveLead(leadIdx, state.ringI[k], state.ringII[k]);
          },
          -mvRange,
          mvRange
        );
      })(L);
      ctx.globalAlpha = 1;
    }

    drawTimeAxis(ctx, w, h);
  }

  function drawPipeline() {
    var cv = $("pipeline");
    var fit = fitCanvas(cv, function (w) {
      return 2 * (w < 520 ? 68 : 84) + AXIS_H;
    });
    if (!fit) return;
    var ctx = fit.ctx,
      w = fit.w,
      h = fit.h;
    var laneH = (h - AXIS_H) / 2;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = theme.sunken;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, Math.round(laneH) + 0.5);
    ctx.lineTo(w - PAD_R, Math.round(laneH) + 0.5);
    ctx.stroke();

    if (state.n === 0) {
      drawTimeAxis(ctx, w, h);
      emptyMessage(ctx, w, h, "Detector idle — no samples yet.");
      return;
    }

    var total = WINDOW_S * FS;
    var startN = Math.max(0, state.n - total);
    var bpMax = 1e-6,
      mwiMax = 1e-9;
    for (var i = startN; i < state.n; i++) {
      var k = i % CAP;
      var b = Math.abs(state.ringBp[k]);
      if (b > bpMax) bpMax = b;
      var m = state.ringMwi[k];
      if (m > mwiMax) mwiMax = m;
      var th = state.ringThr[k];
      if (th > mwiMax) mwiMax = th;
    }

    ctx.fillStyle = theme.faint;
    ctx.font = "600 10px " + theme.font;
    ctx.textBaseline = "top";
    ctx.fillText("band-pass", 3, 3);
    ctx.fillText("integrated", 3, laneH + 3);

    ctx.strokeStyle = theme.text;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.85;
    tracePath(ctx, w, 2, laneH - 4, function (i) {
      return state.ringBp[i % CAP];
    }, -bpMax * 1.05, bpMax * 1.05);
    ctx.globalAlpha = 1;

    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.2;
    tracePath(ctx, w, laneH + 2, laneH - 8, function (i) {
      return state.ringMwi[i % CAP];
    }, 0, mwiMax * 1.05);

    ctx.strokeStyle = theme.warn;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    tracePath(ctx, w, laneH + 2, laneH - 8, function (i) {
      return state.ringThr[i % CAP];
    }, 0, mwiMax * 1.05);
    ctx.setLineDash([]);

    /* Ground-truth ticks along the bottom. */
    ctx.strokeStyle = theme.faint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var t = 0; t < state.truth.length; t++) {
      var tb = state.truth[t];
      if (tb.n < startN || tb.n > state.n) continue;
      var tx = Math.round(xOf(tb.n, w)) + 0.5;
      ctx.moveTo(tx, h - AXIS_H - 7);
      ctx.lineTo(tx, h - AXIS_H - 1);
    }
    ctx.stroke();

    ctx.font = "11px " + theme.font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (var t2 = 0; t2 < state.truth.length; t2++) {
      var tb2 = state.truth[t2];
      if (!tb2.missed || tb2.n < startN || tb2.n > state.n) continue;
      ctx.fillStyle = theme.danger;
      ctx.fillText("○", xOf(tb2.n, w), h - AXIS_H - 14);
    }

    for (var dI = 0; dI < state.dets.length; dI++) {
      var d = state.dets[dI];
      if (d.nR < startN || d.nR > state.n) continue;
      var x = Math.round(xOf(d.nR, w)) + 0.5;
      ctx.strokeStyle = d.tp ? theme.accent : theme.danger;
      ctx.globalAlpha = 0.45;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 2);
      ctx.lineTo(x, h - AXIS_H - 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = d.tp ? theme.accent : theme.danger;
      ctx.fillText(d.tp ? "▲" : "✕", x, 10);
      if (d.cls && d.cls !== "N") {
        ctx.fillStyle = theme.warn;
        ctx.fillText(d.cls, x, laneH - 8);
      }
    }
    ctx.textAlign = "left";

    drawTimeAxis(ctx, w, h);
  }

  function draw() {
    if (!theme) readTheme();
    drawStrip();
    drawPipeline();
  }

  /* ----------------------------------------------------------------------
   * 10. DOM output
   * -------------------------------------------------------------------- */

  function pct(x) {
    return (x * 100).toFixed(2) + "%";
  }

  function setBar(id, ms, maxMs, over) {
    var el = $(id);
    el.style.width = clamp((ms / maxMs) * 100, 0, 100).toFixed(1) + "%";
    var bar = el.parentNode;
    if (over) bar.classList.add("over");
    else bar.classList.remove("over");
  }

  function updateDom() {
    var se = state.tp + state.fn > 0 ? state.tp / (state.tp + state.fn) : 0;
    var ppv = state.tp + state.fp > 0 ? state.tp / (state.tp + state.fp) : 0;

    $("m-hr").textContent = state.hr ? Math.round(state.hr) + " bpm" : "—";
    $("m-rhythm").textContent = state.rhythm;
    $("m-se").textContent = state.tp + state.fn > 0 ? pct(se) : "—";
    $("m-ppv").textContent = state.tp + state.fp > 0 ? pct(ppv) : "—";

    $("k-counts").textContent = state.tp + " / " + state.fp + " / " + state.fn;
    $("k-locerr").textContent = state.tp
      ? ((state.locErrSum / state.tp / FS) * 1000).toFixed(1) + " ms"
      : "—";
    var lagMs = state.lagN ? (state.lagSum / state.lagN / FS) * 1000 : 0;
    $("k-lag").textContent = state.lagN ? lagMs.toFixed(1) + " ms" : "—";
    $("k-acc").textContent = state.classBeats
      ? pct(state.classRight / state.classBeats) +
        " of " +
        state.classBeats +
        " beats"
      : "—";
    $("k-irreg").textContent = state.rrNHist.length >= 5 ? pct(state.irreg) : "—";
    $("k-pwave").textContent = state.pHist.length ? pct(state.pMean) : "—";

    for (var a = 0; a < 3; a++) {
      for (var b = 0; b < 3; b++) {
        $("c-" + CLASSES[a] + CLASSES[b]).textContent = state.conf[CLASSES[a]][CLASSES[b]];
      }
    }

    $("einthoven").textContent =
      state.n === 0 ? "—" : state.residual.toExponential(1) + " mV";

    var infer = params.inferMs,
      up = params.uplinkMs;
    var totalMs = lagMs + infer + up;
    var scale = Math.max(BUDGET_MS, totalMs);
    $("b-det").textContent = state.lagN ? lagMs.toFixed(1) + " ms" : "not measured yet";
    $("b-inf").textContent = (infer < 1 ? infer.toFixed(2) : infer.toFixed(1)) + " ms";
    $("b-up").textContent = up.toFixed(0) + " ms";
    var over = totalMs > BUDGET_MS;
    setBar("b-det-bar", lagMs, scale, over);
    setBar("b-inf-bar", infer, scale, over);
    setBar("b-up-bar", up, scale, over);

    var tot = $("b-total");
    if (!state.lagN) {
      tot.textContent = "Start the stream to measure the detection stage.";
      tot.removeAttribute("data-state");
    } else {
      tot.textContent =
        "Sensor to alert: " +
        totalMs.toFixed(0) +
        " ms of the " +
        BUDGET_MS +
        " ms budget — " +
        (over
          ? "over by " + (totalMs - BUDGET_MS).toFixed(0) + " ms."
          : (BUDGET_MS - totalMs).toFixed(0) + " ms of headroom.");
      tot.setAttribute("data-state", over ? "over" : "ok");
    }

    var st = $("run-status");
    st.textContent = running
      ? "Streaming · " + fmtClock(state.n)
      : state.n === 0
      ? "Idle"
      : "Paused · " + fmtClock(state.n);
    st.setAttribute("data-state", running ? "running" : "idle");
  }

  var logCount = 0;

  function logLine(n, msg, sev) {
    var box = $("log");
    if (logCount === 0) box.textContent = "";
    var row = document.createElement("div");
    row.className = "log-row";
    if (sev) row.setAttribute("data-sev", sev);
    var t = document.createElement("span");
    t.className = "log-time";
    t.textContent = fmtClock(n);
    var m = document.createElement("span");
    m.textContent = msg;
    row.appendChild(t);
    row.appendChild(m);
    box.insertBefore(row, box.firstChild);
    logCount++;
    while (box.childNodes.length > 40) box.removeChild(box.lastChild);
  }

  /* ----------------------------------------------------------------------
   * 11. Wiring
   * -------------------------------------------------------------------- */

  var running = false;
  var rafId = 0;
  var lastTs = 0;
  var domTick = 0;

  function loop(ts) {
    rafId = 0;
    if (running) {
      var dt = lastTs ? (ts - lastTs) / 1000 : 1 / 60;
      lastTs = ts;
      advance(clamp(dt, 0, 0.12) * params.speed);
      draw();
      if (++domTick % 6 === 0) updateDom();
      rafId = requestAnimationFrame(loop);
    } else {
      draw();
      updateDom();
    }
  }

  function requestDraw() {
    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    running = true;
    lastTs = 0;
    $("run").textContent = "Pause";
    if (!rafId) rafId = requestAnimationFrame(loop);
    updateDom();
  }

  function stop() {
    running = false;
    $("run").textContent = "Run";
    requestDraw();
  }

  function clearScores(reason) {
    state.scoreStartN = state.n + Math.round(WARMUP_S * FS);
    state.tp = 0;
    state.fp = 0;
    state.fn = 0;
    state.locErrSum = 0;
    state.lagSum = 0;
    state.lagN = 0;
    state.classBeats = 0;
    state.classRight = 0;
    for (var a = 0; a < 3; a++)
      for (var b = 0; b < 3; b++) state.conf[CLASSES[a]][CLASSES[b]] = 0;
    for (var t = 0; t < state.truth.length; t++) state.truth[t].missed = false;
    if (reason) logLine(state.n, reason + " — scores cleared, 2.5 s re-warm-up", null);
  }

  function resetAll() {
    state = makeState();
    state.sim = new Sim(SEED);
    state.det = new Detector();
    state.det.reset(0);
    state.hp.setHighpass(FS, 5, 0.707);
    state.lp.setLowpass(FS, 15, 0.707);
    state.hpD.setHighpass(FS, 0.5, 0.707);
    state.lpD.setLowpass(FS, 40, 0.707);
    state.mwi.setWindow(params.winSamples);
    state.hr = 0;
    state.irreg = 0;
    logCount = 0;
    $("log").textContent = "";
    logLine(0, "stream reset — synthetic 6-lead feed at 250 Hz", null);
    draw();
    updateDom();
  }

  function resetSignalChain() {
    state.hp.reset();
    state.lp.reset();
    state.hpD.reset();
    state.lpD.reset();
    state.mwi.setWindow(params.winSamples);
    state.dbuf = [0, 0, 0, 0, 0];
    state.det.reset(state.n);
    state.refHist = [];
    state.lastDetN = -1;
    state.rrHist = [];
    state.rrNHist = [];
    state.pHist = [];
    state.clsHist = [];
    state.pendingClass = [];
  }

  function bindRange(id, outId, format, onChange) {
    var el = $(id),
      out = $(outId);
    function apply() {
      out.textContent = format(+el.value);
      onChange(+el.value);
      requestDraw();
    }
    el.addEventListener("input", apply);
    apply();
  }

  function init() {
    BP_DELAY = bandpassDelaySamples();
    readTheme();
    state = makeState();

    /* Adopt whatever the controls actually say — some browsers restore
       previous selections across a reload. */
    params.scenario = $("scenario").value;
    params.lead = +$("lead").value;
    params.mains = $("mains").checked;
    params.searchback = $("searchback").checked;
    params.twave = $("twave").checked;
    params.speed = +$("speed").value;
    $("lead-name").textContent = LEAD_NAMES[params.lead];

    /* Controls -------------------------------------------------------- */
    bindRange("hr", "hr-out", function (v) {
      return v + " bpm";
    }, function (v) {
      params.hr = v;
    });
    bindRange("motion", "motion-out", function (v) {
      return v + "%";
    }, function (v) {
      params.motion = v / 100;
    });
    bindRange("wander", "wander-out", function (v) {
      return ((v / 100) * 0.6).toFixed(2) + " mV";
    }, function (v) {
      params.wanderMv = (v / 100) * 0.6;
    });
    bindRange("infer", "infer-out", function (v) {
      var ms = v * 0.06;
      return (ms < 1 ? ms.toFixed(2) : ms.toFixed(1)) + " ms";
    }, function (v) {
      params.inferMs = v * 0.06;
    });
    bindRange("uplink", "uplink-out", function (v) {
      return v + " ms";
    }, function (v) {
      params.uplinkMs = v;
    });

    bindRange("win", "win-out", function (v) {
      return v + " ms";
    }, function (v) {
      var samples = Math.max(1, Math.round((v / 1000) * FS));
      if (samples === params.winSamples) return;
      params.winSamples = samples;
      if (state.mwi) state.mwi.setWindow(samples);
      if (state.n > 0) clearScores("integration window " + v + " ms");
    });
    bindRange("refrac", "refrac-out", function (v) {
      return v + " ms";
    }, function (v) {
      var samples = Math.round((v / 1000) * FS);
      if (samples === params.refracSamples) return;
      params.refracSamples = samples;
      if (state.n > 0) clearScores("refractory " + v + " ms");
    });
    bindRange("thrk", "thrk-out", function (v) {
      return (v / 100).toFixed(2);
    }, function (v) {
      var k = v / 100;
      if (k === params.thrK) return;
      params.thrK = k;
      if (state.n > 0) clearScores("threshold coefficient " + k.toFixed(2));
    });

    $("scenario").addEventListener("change", function () {
      params.scenario = this.value;
      logLine(state.n, "rhythm source set to " + this.options[this.selectedIndex].text, null);
      requestDraw();
    });

    $("mains").addEventListener("change", function () {
      params.mains = this.checked;
      requestDraw();
    });

    $("lead").addEventListener("change", function () {
      params.lead = +this.value;
      $("lead-name").textContent = LEAD_NAMES[params.lead];
      resetSignalChain();
      clearScores("analysis lead " + LEAD_NAMES[params.lead]);
      requestDraw();
    });

    $("searchback").addEventListener("change", function () {
      params.searchback = this.checked;
      clearScores("search-back " + (this.checked ? "on" : "off"));
      requestDraw();
    });

    $("twave").addEventListener("change", function () {
      params.twave = this.checked;
      clearScores("T-wave discrimination " + (this.checked ? "on" : "off"));
      requestDraw();
    });

    $("speed").addEventListener("change", function () {
      params.speed = +this.value;
    });

    $("run").addEventListener("click", function () {
      if (running) stop();
      else start();
    });

    $("step").addEventListener("click", function () {
      stop();
      advance(2);
      draw();
      updateDom();
    });

    $("reset").addEventListener("click", function () {
      stop();
      resetAll();
    });

    $("inj-pvc").addEventListener("click", function () {
      state.sim.pendingPVC = true;
      logLine(state.n, "injected: premature ventricular beat queued", null);
    });

    $("inj-pause").addEventListener("click", function () {
      state.sim.pendingPause = true;
      logLine(state.n, "injected: 3.2 s sinus pause queued", null);
    });

    $("inj-motion").addEventListener("click", function () {
      state.sim.forceBurst(state.n);
      logLine(state.n, "injected: 1.5 s motion artifact burst", null);
    });

    $("clear-log").addEventListener("click", function () {
      $("log").textContent = "";
      logCount = 0;
      logLine(state.n, "log cleared", null);
    });

    /* Resize + theme -------------------------------------------------- */
    var wraps = document.querySelectorAll(".canvas-wrap");
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () {
        requestDraw();
      });
      for (var i = 0; i < wraps.length; i++) ro.observe(wraps[i]);
    }
    window.addEventListener("resize", function () {
      readTheme();
      requestDraw();
    });

    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onScheme = function () {
        readTheme();
        requestDraw();
      };
      if (mq.addEventListener) mq.addEventListener("change", onScheme);
      else if (mq.addListener) mq.addListener(onScheme);
    }
    if (window.MutationObserver) {
      new MutationObserver(function () {
        readTheme();
        requestDraw();
      }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    }

    document.addEventListener("visibilitychange", function () {
      if (document.hidden && running) {
        stop();
        logLine(state.n, "tab hidden — stream paused", null);
      }
    });

    resetAll();

    var reduce =
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      logLine(0, "reduced motion preferred — use Step 2 s, or press Run to animate", null);
      advance(6);
      draw();
      updateDom();
    } else {
      start();
    }
    /* init can run before first layout, when the canvases still measure zero
       and draw() is a no-op. Queue one more frame so the first paint happens
       once the grid has actually sized. */
    requestDraw();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
