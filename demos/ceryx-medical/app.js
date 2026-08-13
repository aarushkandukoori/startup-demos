/* =============================================================================
   Respiratory-Coupled Pacing Bench
   An independent mini-demo by Aarush Kandukoori. No dependencies, no network.

   Three pacing controllers are integrated in parallel against ONE synthetic
   breathing signal:

     fixed     — constant rate, ignores everything (VVI-style)
     adaptive  — rate follows a slow metabolic-demand estimate, no beat-to-beat
                 respiratory modulation
     coupled   — adaptive rate PLUS beat-to-beat modulation locked to the
                 sensed respiratory waveform (respiratory sinus arrhythmia)

   Everything drawn or tabulated is computed here, in-browser, from a seeded
   PRNG. Nothing is measured, recorded or clinical.
   ========================================================================== */

var PacingBench = (function () {
  'use strict';

  /* --- integration / windows ------------------------------------------- */
  var DT = 4; /* ms per integration step */
  var SAMPLE_EVERY = 20; /* ms per stored trace sample */
  var VIEW_MS = 20000; /* strip-chart width */
  var TRACE_MS = 21000; /* waveform history retained for drawing */
  var BEAT_KEEP = 32000; /* beat history retained for metrics */
  var WINDOW_MS = 30000; /* metric averaging window */

  /* --- model constants (toy physiology, documented in README) ----------- */
  var SV_MAX = 98; /* mL, stroke volume ceiling at full filling */
  var TAU_FILL = 470; /* ms, ventricular filling time constant */
  var BETA = 0.14; /* respiratory preload swing, fraction of SV */
  var INOTROPY = 0.35; /* extra SV at full metabolic demand */
  var ADAPT_GAIN = 46; /* bpm added at full metabolic demand */
  var ADAPT_TAU = 16000; /* ms, sensor-driven rate response time constant */
  var SENSE_TAU = 70; /* ms, respiration sensor low-pass */
  var NOISE_TAU = 300; /* ms, correlation time of the sensor artefact */
  var NOISE_DRIVE = 12.3; /* makes the artefact's SD equal the noise setting */
  var HR_MIN = 40;
  var HR_MAX = 165;
  var INSP_FRAC = 0.4; /* inspiration occupies 40% of the breath cycle */
  var WAVE_PP = 1 + INSP_FRAC / (1 - INSP_FRAC); /* peak-to-peak of the wave */

  var MODES = ['fixed', 'adaptive', 'coupled'];
  var MODE_LABEL = {
    fixed: 'Fixed rate',
    adaptive: 'Rate-adaptive',
    coupled: 'Respiratory-coupled'
  };

  var DEFAULTS = {
    mode: 'coupled',
    baseRate: 62, /* bpm */
    rsaDepth: 18, /* bpm, peak-to-peak respiratory rate swing */
    latency: 120, /* ms, sense -> pace delay */
    breathRate: 12, /* breaths / min */
    breathVar: 0.08, /* breath-to-breath period jitter, fraction */
    noise: 0.1, /* respiration sensor noise, fraction of tidal */
    activity: 0.1, /* metabolic demand, 0..1 */
    tidal: 1, /* tidal depth multiplier */
    speed: 1
  };

  /* Scenario presets move the patient, never the device settings. */
  var PRESETS = {
    rest: { breathRate: 12, activity: 0.1, tidal: 1 },
    walk: { breathRate: 19, activity: 0.5, tidal: 1.25 },
    stairs: { breathRate: 26, activity: 0.85, tidal: 1.5 }
  };

  /* --- small helpers ---------------------------------------------------- */
  function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
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

  function gauss(rng) {
    var u = 1 - rng();
    var v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function mean(a) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return a.length ? s / a.length : 0;
  }

  function std(a) {
    if (a.length < 2) return 0;
    var m = mean(a), s = 0;
    for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / (a.length - 1));
  }

  function percentile(sorted, q) {
    if (!sorted.length) return 0;
    var idx = (sorted.length - 1) * q;
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  /* Zero-mean airflow-shaped breath: a short positive inspiratory hump and a
     longer, shallower negative expiratory trough. Area cancels exactly. */
  function breathWave(phase) {
    if (phase < INSP_FRAC) {
      return Math.sin((Math.PI * phase) / INSP_FRAC);
    }
    return (
      -(INSP_FRAC / (1 - INSP_FRAC)) *
      Math.sin((Math.PI * (phase - INSP_FRAC)) / (1 - INSP_FRAC))
    );
  }

  /* --- state ------------------------------------------------------------ */
  function createState(params, seed) {
    var s = {
      p: params,
      t: 0,
      rng: mulberry32(seed || 20260813),
      breathPhase: 0,
      breathJitter: 1,
      delay: new Float32Array(512), /* 512 * 4 ms = 2048 ms of history */
      uHist: new Float32Array(512), /* same window, un-scaled true waveform */
      delayIdx: 0,
      senseFilt: 0,
      noiseState: 0,
      lastRaw: 0,
      aSmooth: params.activity,
      sampleAcc: 0,
      trace: [],
      ctrls: []
    };
    for (var i = 0; i < MODES.length; i++) {
      s.ctrls.push({ mode: MODES[i], theta: i * 0.11, lastBeat: null, beats: [] });
    }
    return s;
  }

  function stepOnce(s) {
    var p = s.p;

    /* respiration ------------------------------------------------------- */
    var period = clamp((60000 / p.breathRate) * s.breathJitter, 800, 12000);
    s.breathPhase += DT / period;
    while (s.breathPhase >= 1) {
      s.breathPhase -= 1;
      s.breathJitter = 1 + (s.rng() * 2 - 1) * p.breathVar;
    }
    var uTrue = breathWave(s.breathPhase); /* normalised, zero mean */
    var v = uTrue * p.tidal; /* "true" airflow */

    /* sensing: transport delay -> additive noise -> one-pole filter ------ */
    s.delay[s.delayIdx] = v;
    s.uHist[s.delayIdx] = uTrue;
    s.delayIdx = (s.delayIdx + 1) % s.delay.length;
    var lagSteps = Math.min(s.delay.length - 1, Math.round(p.latency / DT));
    var readIdx =
      (s.delayIdx - 1 - lagSteps + s.delay.length * 2) % s.delay.length;
    /* Belt/impedance artefact is slow and wandering, not white — so a
       one-pole-shaped noise the sensing filter cannot simply average away. */
    s.noiseState +=
      (gauss(s.rng) * p.noise * NOISE_DRIVE - s.noiseState) *
      (DT / (NOISE_TAU + DT));
    var raw = s.delay[readIdx] + s.noiseState;
    s.lastRaw = raw;
    s.senseFilt += (raw - s.senseFilt) * (DT / (SENSE_TAU + DT));
    var uHat = clamp(s.senseFilt / Math.max(p.tidal, 0.2), -1.8, 1.8);

    /* slow metabolic-demand estimate ------------------------------------ */
    s.aSmooth += (p.activity - s.aSmooth) * (DT / (ADAPT_TAU + DT));

    s.t += DT;

    /* three controllers, same inputs ------------------------------------ */
    for (var i = 0; i < s.ctrls.length; i++) {
      var c = s.ctrls[i];
      var hr = p.baseRate;
      if (c.mode !== 'fixed') hr += ADAPT_GAIN * s.aSmooth;
      if (c.mode === 'coupled') hr += (p.rsaDepth / WAVE_PP) * uHat;
      hr = clamp(hr, HR_MIN, HR_MAX);

      c.theta += DT / (60000 / hr);
      while (c.theta >= 1) {
        c.theta -= 1;
        var rr = c.lastBeat === null ? 60000 / hr : s.t - c.lastBeat;
        c.lastBeat = s.t;
        /* The interval, not the instant, is what filled the ventricle, so
           preload and the tachogram sample are taken at its midpoint — the
           standard convention when relating RR intervals to a slower rhythm. */
        var midSteps = Math.min(s.uHist.length - 1, Math.round(rr / 2 / DT));
        var midIdx =
          (s.delayIdx - 1 - midSteps + s.uHist.length * 2) % s.uHist.length;
        var uMid = s.uHist[midIdx];
        var sv =
          SV_MAX *
          (1 - Math.exp(-rr / TAU_FILL)) *
          (1 + BETA * uMid) *
          (1 + INOTROPY * s.aSmooth);
        sv = clamp(sv, 8, 145);
        c.beats.push({ t: s.t, rr: rr, sv: sv, u: uMid, insp: uTrue > 0 });
        while (c.beats.length && c.beats[0].t < s.t - BEAT_KEEP) c.beats.shift();
      }
    }

    /* trace sampling ----------------------------------------------------- */
    s.sampleAcc += DT;
    if (s.sampleAcc >= SAMPLE_EVERY) {
      s.sampleAcc = 0;
      s.trace.push({ t: s.t, v: v, vr: s.lastRaw, vh: s.senseFilt });
      while (s.trace.length && s.trace[0].t < s.t - TRACE_MS) s.trace.shift();
    }
  }

  function advance(s, ms) {
    var steps = Math.round(ms / DT);
    if (steps < 0) steps = 0;
    if (steps > 20000) steps = 20000; /* hard ceiling: 80 s in one call */
    for (var i = 0; i < steps; i++) stepOnce(s);
    return steps;
  }

  /* --- metrics over the trailing window --------------------------------- */
  function metrics(s, c) {
    var t0 = s.t - WINDOW_MS;
    var b = [];
    for (var i = 0; i < c.beats.length; i++) {
      if (c.beats[i].t >= t0) b.push(c.beats[i]);
    }
    if (b.length < 4) return null;
    var span = b[b.length - 1].t - b[0].t;
    if (span <= 0) return null;

    var hrs = [], rrs = [], flows = [], us = [];
    var svSum = 0, insp = 0;
    for (i = 1; i < b.length; i++) {
      var bi = b[i];
      hrs.push(60000 / bi.rr);
      rrs.push(bi.rr);
      flows.push(bi.sv / bi.rr); /* mL per ms of pulmonary flow */
      us.push(bi.u);
      svSum += bi.sv;
      if (bi.insp) insp++;
    }
    var n = hrs.length;
    var sorted = hrs.slice().sort(function (x, y) { return x - y; });

    /* Least-squares fit of a per-beat quantity against the breathing waveform.
       slope * RMS(u) is the part of that quantity genuinely locked in phase
       with breathing; a negative value means it peaks during expiration. */
    var ubar = mean(us);
    var sxx = 0;
    for (i = 0; i < n; i++) {
      var du = us[i] - ubar;
      sxx += du * du;
    }
    var rmsU = Math.sqrt(sxx / n);
    function inPhase(ys) {
      if (sxx <= 1e-9) return 0;
      var ybar = mean(ys), sxy = 0;
      for (var j = 0; j < n; j++) sxy += (us[j] - ubar) * (ys[j] - ybar);
      return (sxy / sxx) * rmsU;
    }
    var rateMod = inPhase(hrs); /* bpm of breathing-locked rate modulation */
    var fbar = mean(flows);
    var inphase = fbar > 1e-9 ? (inPhase(flows) * 100) / fbar : 0;

    var co = ((svSum / span) * 60000) / 1000; /* L/min */
    var demand = 4.8 + 6.2 * s.aSmooth; /* L/min required */

    return {
      beats: n,
      meanHR: mean(hrs),
      swing: percentile(sorted, 0.95) - percentile(sorted, 0.05),
      sdnn: std(rrs),
      rateMod: rateMod,
      co: co,
      demandMet: (co / demand) * 100,
      inspPct: (insp / n) * 100,
      inphase: inphase
    };
  }

  function phaseErrorDeg(p) {
    return (p.latency * p.breathRate * 360) / 60000;
  }

  return {
    DT: DT,
    VIEW_MS: VIEW_MS,
    TRACE_MS: TRACE_MS,
    BEAT_KEEP: BEAT_KEEP,
    WINDOW_MS: WINDOW_MS,
    INSP_FRAC: INSP_FRAC,
    MODES: MODES,
    MODE_LABEL: MODE_LABEL,
    DEFAULTS: DEFAULTS,
    PRESETS: PRESETS,
    breathWave: breathWave,
    createState: createState,
    advance: advance,
    metrics: metrics,
    phaseErrorDeg: phaseErrorDeg,
    clamp: clamp
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PacingBench; /* lets the model be exercised headlessly */
}

/* =============================================================================
   UI — only runs in a browser.
   ========================================================================== */
if (typeof document !== 'undefined') {
  (function () {
    'use strict';

    var M = PacingBench;
    var params = {};
    for (var k in M.DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(M.DEFAULTS, k)) {
        params[k] = M.DEFAULTS[k];
      }
    }

    var sim = M.createState(params, 20260813);
    var running = false;
    var rafId = 0;
    var lastTs = 0;
    var carry = 0;
    var lastReadout = -1e9;
    var lastSummary = -1e9;

    var canvas = document.getElementById('chart');
    var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    var statusEl = document.getElementById('status');
    var summaryEl = document.getElementById('summary');
    var runBtn = document.getElementById('run');
    var stepBtn = document.getElementById('step');
    var resetBtn = document.getElementById('reset');
    var phaseValEl = document.getElementById('phase-val');

    var SLIDERS = [
      { id: 'baseRate', key: 'baseRate', scale: 1, fmt: function (x) { return x.toFixed(0) + ' bpm'; } },
      { id: 'rsaDepth', key: 'rsaDepth', scale: 1, fmt: function (x) { return x.toFixed(0) + ' bpm'; } },
      { id: 'latency', key: 'latency', scale: 1, fmt: function (x) { return x.toFixed(0) + ' ms'; } },
      { id: 'breathRate', key: 'breathRate', scale: 1, fmt: function (x) { return x.toFixed(0) + ' / min'; } },
      { id: 'activity', key: 'activity', scale: 0.01, fmt: function (x) { return Math.round(x * 100) + '%'; } },
      { id: 'noise', key: 'noise', scale: 0.01, fmt: function (x) { return Math.round(x * 100) + '%'; } },
      { id: 'breathVar', key: 'breathVar', scale: 0.01, fmt: function (x) { return Math.round(x * 100) + '%'; } }
    ];

    var reduceMotion =
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* --- theme colours read from base.css tokens ----------------------- */
    var theme = {};
    function readTheme() {
      var cs = getComputedStyle(document.documentElement);
      function tok(name, fallback) {
        var val = cs.getPropertyValue(name);
        val = val ? val.trim() : '';
        return val || fallback;
      }
      theme = {
        accent: tok('--accent', '#0f6e60'),
        text: tok('--text', '#191b1f'),
        muted: tok('--text-muted', '#5d646e'),
        faint: tok('--text-faint', '#868d97'),
        border: tok('--border', '#e4e0d9'),
        borderStrong: tok('--border-strong', '#cfcac1'),
        surface2: tok('--surface-2', '#f7f5f2'),
        warn: tok('--warn', '#9a6212')
      };
    }
    readTheme();
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onScheme = function () { readTheme(); draw(); };
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
      else if (mq.addListener) mq.addListener(onScheme);
    }
    if (window.MutationObserver) {
      new MutationObserver(function () {
        readTheme();
        draw();
      }).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme']
      });
    }

    var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    /* --- drawing -------------------------------------------------------- */
    function sizeCanvas() {
      var w = Math.max(1, Math.round(canvas.clientWidth));
      var h = Math.max(1, Math.round(canvas.clientHeight));
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: w, h: h };
    }

    function draw() {
      if (!ctx) return;
      var size = sizeCanvas();
      var w = size.w, h = size.h;
      ctx.clearRect(0, 0, w, h);

      var narrow = w < 460;
      var padL = narrow ? 44 : 60;
      var padR = 8;
      var padT = 8;
      var padB = 18;
      var gap = 8;
      var plotW = Math.max(10, w - padL - padR);
      var avail = Math.max(60, h - padT - padB);
      var hResp = Math.round(avail * 0.26);
      var hRast = Math.round(avail * 0.24);
      var hTach = avail - hResp - hRast - gap * 2;
      var yResp = padT;
      var yRast = yResp + hResp + gap;
      var yTach = yRast + hRast + gap;

      var tEnd = sim.t;
      var tStart = tEnd - M.VIEW_MS;
      function X(t) {
        return padL + ((t - tStart) / M.VIEW_MS) * plotW;
      }

      /* lane frames */
      ctx.lineWidth = 1;
      ctx.strokeStyle = theme.border;
      ctx.fillStyle = theme.surface2;
      [[yResp, hResp], [yRast, hRast], [yTach, hTach]].forEach(function (lane) {
        ctx.globalAlpha = 0.55;
        ctx.fillRect(padL, lane[0], plotW, lane[1]);
        ctx.globalAlpha = 1;
        ctx.strokeRect(padL + 0.5, lane[0] + 0.5, plotW - 1, lane[1] - 1);
      });

      /* empty state */
      if (sim.trace.length < 2) {
        ctx.fillStyle = theme.muted;
        ctx.font = '13px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          'No samples yet — press Start or Step 10 s.',
          padL + plotW / 2,
          padT + avail / 2
        );
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        return;
      }

      /* inspiration bands, drawn across every lane */
      ctx.fillStyle = theme.accent;
      ctx.globalAlpha = 0.09;
      var segStart = null;
      for (var i = 0; i < sim.trace.length; i++) {
        var pt = sim.trace[i];
        if (pt.v > 0 && segStart === null) segStart = pt.t;
        if (pt.v <= 0 && segStart !== null) {
          ctx.fillRect(X(segStart), padT, Math.max(1, X(pt.t) - X(segStart)), avail);
          segStart = null;
        }
      }
      if (segStart !== null) {
        ctx.fillRect(X(segStart), padT, Math.max(1, X(tEnd) - X(segStart)), avail);
      }
      ctx.globalAlpha = 1;

      /* clip everything time-varying to the plot rectangle */
      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, padT, plotW, avail);
      ctx.clip();

      /* --- lane 1: respiration --------------------------------------- */
      var cyResp = yResp + hResp / 2;
      var respScale = hResp / 2 / 1.7;
      ctx.strokeStyle = theme.border;
      ctx.beginPath();
      ctx.moveTo(padL, cyResp);
      ctx.lineTo(padL + plotW, cyResp);
      ctx.stroke();

      function traceLine(field, colour, width, dash, alpha) {
        ctx.beginPath();
        ctx.setLineDash(dash || []);
        ctx.strokeStyle = colour;
        ctx.lineWidth = width;
        ctx.globalAlpha = alpha || 1;
        for (var j = 0; j < sim.trace.length; j++) {
          var p = sim.trace[j];
          var x = X(p.t);
          /* clamped so a large artefact cannot bleed into the lane below */
          var y = cyResp - M.clamp(p[field], -1.7, 1.7) * respScale;
          if (j === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      traceLine('vr', theme.faint, 1, null, 0.75); /* raw, artefact included */
      traceLine('v', theme.muted, 1.6); /* true airflow */
      traceLine('vh', theme.accent, 1.6, [5, 4]); /* what the loop acts on */

      /* --- lane 2: beat raster ---------------------------------------- */
      var rowH = hRast / 3;
      for (var m = 0; m < M.MODES.length; m++) {
        var ctrl = sim.ctrls[m];
        var selected = ctrl.mode === params.mode;
        var yTop = yRast + m * rowH;
        ctx.strokeStyle = selected ? theme.accent : theme.faint;
        ctx.lineWidth = selected ? 2 : 1;
        var tickTop = yTop + rowH * (selected ? 0.14 : 0.26);
        var tickBot = yTop + rowH * (selected ? 0.86 : 0.74);
        ctx.beginPath();
        for (var bIdx = 0; bIdx < ctrl.beats.length; bIdx++) {
          var bt = ctrl.beats[bIdx].t;
          if (bt < tStart) continue;
          var bx = Math.round(X(bt)) + 0.5;
          ctx.moveTo(bx, tickTop);
          ctx.lineTo(bx, tickBot);
        }
        ctx.stroke();
      }

      /* --- lane 3: tachogram ------------------------------------------ */
      var lo = Infinity, hi = -Infinity;
      for (m = 0; m < sim.ctrls.length; m++) {
        var bs = sim.ctrls[m].beats;
        for (i = 0; i < bs.length; i++) {
          if (bs[i].t < tStart) continue;
          var hv = 60000 / bs[i].rr;
          if (hv < lo) lo = hv;
          if (hv > hi) hi = hv;
        }
      }
      if (!isFinite(lo) || !isFinite(hi)) { lo = 50; hi = 90; }
      if (hi - lo < 24) {
        var mid = (hi + lo) / 2;
        lo = mid - 12;
        hi = mid + 12;
      }
      lo = Math.max(30, Math.floor((lo - 4) / 10) * 10);
      hi = Math.min(180, Math.ceil((hi + 4) / 10) * 10);
      function Y(hr) {
        return yTach + hTach - ((hr - lo) / (hi - lo)) * hTach;
      }

      var gridStep = hi - lo > 80 ? 40 : hi - lo > 40 ? 20 : 10;
      ctx.strokeStyle = theme.border;
      ctx.lineWidth = 1;
      for (var g = Math.ceil(lo / gridStep) * gridStep; g <= hi; g += gridStep) {
        var gy = Math.round(Y(g)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(padL, gy);
        ctx.lineTo(padL + plotW, gy);
        ctx.stroke();
      }

      var DASHES = { fixed: [2, 3], adaptive: [7, 3], coupled: [] };
      for (m = 0; m < sim.ctrls.length; m++) {
        var c2 = sim.ctrls[m];
        var sel = c2.mode === params.mode;
        var pts = [];
        for (i = 1; i < c2.beats.length; i++) {
          if (c2.beats[i].t < tStart - 2000) continue;
          pts.push({
            t0: c2.beats[i - 1].t,
            t1: c2.beats[i].t,
            hr: 60000 / c2.beats[i].rr
          });
        }
        if (!pts.length) continue;
        ctx.setLineDash(sel ? [] : DASHES[c2.mode]);
        ctx.strokeStyle = sel ? theme.accent : theme.faint;
        ctx.lineWidth = sel ? 2 : 1;
        ctx.beginPath();
        for (i = 0; i < pts.length; i++) {
          var y0 = Y(pts[i].hr);
          if (i === 0) ctx.moveTo(X(pts[i].t0), y0);
          else ctx.lineTo(X(pts[i].t0), y0);
          ctx.lineTo(X(pts[i].t1), y0);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        if (sel) {
          ctx.fillStyle = theme.accent;
          for (i = 0; i < pts.length; i++) {
            ctx.beginPath();
            ctx.arc(X(pts[i].t1), Y(pts[i].hr), 2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.restore();

      /* --- gutter labels ---------------------------------------------- */
      ctx.font = (narrow ? '9px ' : '10px ') + FONT;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      ctx.fillStyle = theme.muted;
      ctx.fillText(narrow ? 'Breath' : 'Breathing', padL - 6, cyResp);
      for (m = 0; m < M.MODES.length; m++) {
        var label = narrow
          ? ['Fixed', 'Adapt', 'Coupled'][m]
          : ['Fixed', 'Rate-adapt', 'Coupled'][m];
        var sel2 = M.MODES[m] === params.mode;
        ctx.fillStyle = sel2 ? theme.accent : theme.faint;
        ctx.fillText(label, padL - 6, yRast + rowH * (m + 0.5));
      }
      ctx.fillStyle = theme.faint;
      for (g = Math.ceil(lo / gridStep) * gridStep; g <= hi; g += gridStep) {
        ctx.fillText(g + (narrow ? '' : ' bpm'), padL - 6, Y(g));
      }

      /* time axis */
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = theme.faint;
      ctx.fillText('−20 s', padL, padT + avail + 4);
      ctx.textAlign = 'center';
      ctx.fillText('−10 s', padL + plotW / 2, padT + avail + 4);
      ctx.textAlign = 'right';
      ctx.fillText('now', padL + plotW, padT + avail + 4);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }

    /* --- numeric readouts ------------------------------------------------ */
    function fmt(x, digits, suffix) {
      if (x === null || x === undefined || !isFinite(x)) return '—';
      return x.toFixed(digits) + (suffix || '');
    }

    /* Signed values carry the whole point of the phase metrics, so the sign is
       always shown and a true minus sign is used. */
    function fmtSigned(x, digits, suffix) {
      if (x === null || x === undefined || !isFinite(x)) return '—';
      var eps = 0.5 / Math.pow(10, digits);
      var sign = x > eps ? '+' : x < -eps ? '−' : '';
      return sign + Math.abs(x).toFixed(digits) + (suffix || '');
    }

    function setText(id, value) {
      var el = document.getElementById(id);
      if (el) el.textContent = value;
    }

    function updateReadouts() {
      var all = {};
      for (var i = 0; i < sim.ctrls.length; i++) {
        var c = sim.ctrls[i];
        var mtr = M.metrics(sim, c);
        var selected = c.mode === params.mode;
        all[c.mode] = mtr;
        setText('c-' + c.mode + '-hr', mtr ? fmt(mtr.meanHR, 1) : '—');
        setText('c-' + c.mode + '-swing', mtr ? fmt(mtr.swing, 1) : '—');
        setText('c-' + c.mode + '-ratemod', mtr ? fmtSigned(mtr.rateMod, 1) : '—');
        setText('c-' + c.mode + '-co', mtr ? fmt(mtr.co, 2) : '—');
        setText('c-' + c.mode + '-demand', mtr ? fmt(mtr.demandMet, 0) + '%' : '—');
        setText('c-' + c.mode + '-insp', mtr ? fmt(mtr.inspPct, 0) + '%' : '—');
        setText(
          'c-' + c.mode + '-inphase',
          mtr ? fmtSigned(mtr.inphase, 1, '%') : '—'
        );

        var row = document.getElementById('row-' + c.mode);
        if (row) row.setAttribute('data-selected', selected ? 'true' : 'false');
        var tagEl = document.getElementById('sel-' + c.mode);
        if (tagEl) tagEl.hidden = !selected;
      }

      var sel = all[params.mode];
      setText('m-hr', sel ? fmt(sel.meanHR, 1) : '—');
      setText('m-swing', sel ? fmt(sel.swing, 1) : '—');
      setText('m-ratemod', sel ? fmtSigned(sel.rateMod, 1) : '—');
      setText('m-sdnn', sel ? fmt(sel.sdnn, 0) : '—');
      setText('m-co', sel ? fmt(sel.co, 2) : '—');
      setText('m-demand', sel ? fmt(sel.demandMet, 0) + '%' : '—');
      setText('m-insp', sel ? fmt(sel.inspPct, 0) + '%' : '—');

      var deg = M.phaseErrorDeg(params);
      if (phaseValEl) {
        phaseValEl.textContent = Math.round(deg) + '° of the breath cycle';
        phaseValEl.className = deg > 30 ? 'phase-warn' : 'phase-ok';
      }
      setText('m-phase', Math.round(deg) + '°');

      var demandEl = document.getElementById('demand-target');
      if (demandEl) {
        demandEl.textContent = (4.8 + 6.2 * sim.aSmooth).toFixed(2) + ' L/min';
      }
      return all;
    }

    function updateSummary(all) {
      if (!summaryEl) return;
      var sel = all[params.mode];
      if (!sel) {
        summaryEl.textContent =
          'Simulation cleared. Press Start or Step 10 s to generate beats.';
        return;
      }
      var phase =
        sel.rateMod > 0.3
          ? 'pacing fastest during inspiration'
          : sel.rateMod < -0.3
          ? 'pacing fastest during expiration — the loop is running late'
          : 'no breathing-locked component';
      summaryEl.textContent =
        M.MODE_LABEL[params.mode] +
        ': mean rate ' + sel.meanHR.toFixed(1) + ' bpm, ' +
        'swing ' + sel.swing.toFixed(1) + ' bpm, ' +
        'breathing-locked component ' + fmtSigned(sel.rateMod, 1) + ' bpm (' +
        phase + '). ' +
        sel.inspPct.toFixed(0) + '% of beats fall in inspiration. ' +
        'Modelled output ' + sel.co.toFixed(2) + ' L/min, ' +
        sel.demandMet.toFixed(0) + '% of demand; pulmonary flow in phase with ' +
        'breathing at ' + fmtSigned(sel.inphase, 1) + '% of mean.';
    }

    function refresh(force) {
      var now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!force && now - lastReadout < 240) return;
      lastReadout = now;
      var all = updateReadouts();
      setStatus();
      if (force || now - lastSummary > 2200) {
        lastSummary = now;
        updateSummary(all);
      }
    }

    /* --- run loop -------------------------------------------------------- */
    function setStatus() {
      if (!statusEl) return;
      statusEl.setAttribute('data-state', running ? 'running' : 'idle');
      statusEl.textContent =
        (running ? 'Running' : 'Paused') +
        ' · ' + params.speed + '× · sim clock ' +
        (sim.t / 1000).toFixed(1) + ' s';
    }

    function frame(ts) {
      if (!running) return;
      if (!lastTs) lastTs = ts;
      var dtReal = Math.min(250, ts - lastTs);
      lastTs = ts;
      /* carry the sub-step remainder so 1× really is 1× */
      var want = dtReal * params.speed + carry;
      var steps = Math.floor(want / M.DT);
      carry = want - steps * M.DT;
      if (steps > 0) M.advance(sim, steps * M.DT);
      draw();
      refresh(false);
      rafId = window.requestAnimationFrame(frame);
    }

    function start() {
      if (running) return;
      running = true;
      lastTs = 0;
      if (runBtn) runBtn.textContent = 'Pause';
      setStatus();
      rafId = window.requestAnimationFrame(frame);
    }

    function pause() {
      if (!running) return;
      running = false;
      if (rafId) window.cancelAnimationFrame(rafId);
      rafId = 0;
      if (runBtn) runBtn.textContent = 'Start';
      setStatus();
    }

    /* --- controls -------------------------------------------------------- */
    function bindSlider(spec) {
      var input = document.getElementById(spec.id);
      var out = document.getElementById(spec.id + '-out');
      if (!input) return;
      function apply() {
        var raw = parseFloat(input.value);
        if (!isFinite(raw)) return;
        params[spec.key] = raw * spec.scale;
        if (out) out.textContent = spec.fmt(params[spec.key]);
        refresh(true);
        if (!running) draw();
      }
      input.addEventListener('input', apply);
      input.addEventListener('change', apply);
      apply();
    }
    SLIDERS.forEach(bindSlider);

    function syncSliders() {
      SLIDERS.forEach(function (spec) {
        var input = document.getElementById(spec.id);
        var out = document.getElementById(spec.id + '-out');
        if (!input) return;
        /* round away float dust from the scale division (0.1 / 0.01) */
        input.value = String(Math.round((params[spec.key] / spec.scale) * 1e6) / 1e6);
        if (out) out.textContent = spec.fmt(params[spec.key]);
      });
    }

    var modeBtns = document.querySelectorAll('[data-mode]');
    Array.prototype.forEach.call(modeBtns, function (btn) {
      btn.addEventListener('click', function () {
        params.mode = btn.getAttribute('data-mode');
        Array.prototype.forEach.call(modeBtns, function (b) {
          b.setAttribute(
            'aria-pressed',
            b.getAttribute('data-mode') === params.mode ? 'true' : 'false'
          );
        });
        draw();
        refresh(true);
      });
    });

    var presetBtns = document.querySelectorAll('[data-preset]');
    Array.prototype.forEach.call(presetBtns, function (btn) {
      btn.addEventListener('click', function () {
        var preset = M.PRESETS[btn.getAttribute('data-preset')];
        if (!preset) return;
        for (var key in preset) {
          if (Object.prototype.hasOwnProperty.call(preset, key)) {
            params[key] = preset[key];
          }
        }
        syncSliders();
        draw();
        refresh(true);
      });
    });

    var speedBtns = document.querySelectorAll('[data-speed]');
    Array.prototype.forEach.call(speedBtns, function (btn) {
      btn.addEventListener('click', function () {
        params.speed = parseFloat(btn.getAttribute('data-speed')) || 1;
        Array.prototype.forEach.call(speedBtns, function (b) {
          b.setAttribute(
            'aria-pressed',
            parseFloat(b.getAttribute('data-speed')) === params.speed
              ? 'true'
              : 'false'
          );
        });
        setStatus();
      });
    });

    if (runBtn) {
      runBtn.addEventListener('click', function () {
        if (running) pause();
        else start();
      });
    }

    if (stepBtn) {
      stepBtn.addEventListener('click', function () {
        M.advance(sim, 10000);
        draw();
        refresh(true);
        setStatus();
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        pause();
        for (var key in M.DEFAULTS) {
          if (Object.prototype.hasOwnProperty.call(M.DEFAULTS, key)) {
            params[key] = M.DEFAULTS[key];
          }
        }
        sim = M.createState(params, 20260813);
        syncSliders();
        Array.prototype.forEach.call(modeBtns, function (b) {
          b.setAttribute(
            'aria-pressed',
            b.getAttribute('data-mode') === params.mode ? 'true' : 'false'
          );
        });
        Array.prototype.forEach.call(speedBtns, function (b) {
          b.setAttribute(
            'aria-pressed',
            parseFloat(b.getAttribute('data-speed')) === params.speed
              ? 'true'
              : 'false'
          );
        });
        draw();
        refresh(true);
        setStatus();
      });
    }

    /* --- resize / visibility --------------------------------------------- */
    if (window.ResizeObserver) {
      new ResizeObserver(function () { draw(); }).observe(canvas.parentNode);
    }
    window.addEventListener('resize', draw);
    window.addEventListener('orientationchange', function () {
      window.setTimeout(draw, 120);
    });

    var wasRunning = false;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        wasRunning = running;
        pause();
      } else if (wasRunning) {
        wasRunning = false;
        start();
      }
    });

    /* --- first paint ------------------------------------------------------ */
    M.advance(sim, 26000); /* pre-roll so the window is full immediately */
    draw();
    refresh(true);
    setStatus();
    if (!reduceMotion) start();
  })();
}
