/* ==========================================================================
   Closed-Loop Rescue-Dose Simulator
   An independent mini-demo by Aarush Kandukoori.

   Everything here runs locally: a seeded generator makes 40 synthetic
   recordings of breathing rate / heart rate / signal quality, a causal
   detector state machine replays over them, and the page reports what it
   would have done. No network, no dependencies, no build step.
   ========================================================================== */

(function () {
  "use strict";

  /* ---------------------------------------------------------------- config */

  var DUR = 600; /* seconds per recording, sampled at 1 Hz */
  var MAX_DROPOUT = 20; /* s of artifact-gated data before evidence clears */
  var GUARDRAIL = 120; /* s: engineering budget from apnea onset to dose */
  var APNEA_RR = 6; /* br/min: fixed clinical definition of onset */

  var DEFAULTS = {
    rrThresh: 6,
    requireBrady: true,
    hrThresh: 48,
    sustainSec: 35,
    confirmSec: 10,
    minSqi: 0.55,
    duty: 5
  };

  var PRESETS = {
    aggressive: {
      rrThresh: 8,
      requireBrady: false,
      hrThresh: 52,
      sustainSec: 15,
      confirmSec: 0,
      minSqi: 0.25,
      duty: 1
    },
    balanced: {
      rrThresh: 6,
      requireBrady: true,
      hrThresh: 48,
      sustainSec: 35,
      confirmSec: 10,
      minSqi: 0.55,
      duty: 5
    },
    conservative: {
      rrThresh: 4,
      requireBrady: true,
      hrThresh: 44,
      sustainSec: 60,
      confirmSec: 20,
      minSqi: 0.7,
      duty: 10
    }
  };

  var SCENARIOS = {
    opioid: {
      label: "Opioid respiratory depression",
      short: "Opioid depression",
      needsDose: true
    },
    osa: {
      label: "Obstructive sleep apnea",
      short: "Sleep apnea",
      needsDose: false
    },
    motion: {
      label: "Motion artifact (walking, stairs)",
      short: "Motion artifact",
      needsDose: false
    },
    rest: {
      label: "Quiet sleep, normal breathing",
      short: "Quiet sleep",
      needsDose: false
    },
    decouple: {
      label: "Sensor coupling loss",
      short: "Coupling loss",
      needsDose: false
    }
  };

  var MIX = [
    ["opioid", 12],
    ["osa", 9],
    ["rest", 8],
    ["motion", 7],
    ["decouple", 4]
  ];

  /* ------------------------------------------------------------- utilities */

  function mulberry32(a) {
    a = a | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function jitter(rnd, amp) {
    return (rnd() - 0.5) * 2 * amp;
  }

  function logistic(x) {
    return 1 / (1 + Math.exp(-x));
  }

  function median(list) {
    if (!list.length) return null;
    var s = list.slice().sort(function (a, b) {
      return a - b;
    });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function mmss(sec) {
    var s = Math.max(0, Math.round(sec));
    var m = Math.floor(s / 60);
    return m + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function $(id) {
    return document.getElementById(id);
  }

  /* ------------------------------------------------- synthetic physiology */

  /* Opioid-induced respiratory depression: breathing rate decays along a
     logistic ramp to near-apnea and stays there; heart rate follows after a
     lag. Signal quality stays high because the subject stops moving. */
  function genOpioid(rnd) {
    var rrBase = 12.5 + rnd() * 4.5;
    var hrBase = 62 + rnd() * 16;
    var onset = 130 + Math.floor(rnd() * 220);
    var ramp = 50 + rnd() * 60;
    var rrFloor = rnd() * 2.2;
    var hrFloor = 34 + rnd() * 13;
    var hrLag = 12 + rnd() * 28;
    var rr = [],
      hr = [],
      sqi = [],
      onsetIdx = -1;
    for (var i = 0; i < DUR; i++) {
      var p = logistic((i - (onset + ramp / 2)) / (ramp / 6));
      var trueRr = rrBase + (rrFloor - rrBase) * p;
      if (onsetIdx < 0 && trueRr <= APNEA_RR) onsetIdx = i;
      rr.push(clamp(trueRr + jitter(rnd, 0.55), 0, 40));
      var q = logistic((i - (onset + ramp / 2 + hrLag)) / (ramp / 5));
      hr.push(clamp(hrBase + (hrFloor - hrBase) * q + jitter(rnd, 1.6), 20, 190));
      sqi.push(clamp(0.93 + jitter(rnd, 0.04) - (rnd() < 0.015 ? rnd() * 0.4 : 0), 0, 1));
    }
    return { rr: rr, hr: hr, sqi: sqi, onsetIdx: onsetIdx < 0 ? onset : onsetIdx };
  }

  /* Obstructive sleep apnea: repeated 13–26 s apneas with arousal
     hyperventilation, and the bradycardia–tachycardia swing that goes with
     them. Real apnea, real desaturation risk — but not an overdose. */
  function genOsa(rnd) {
    /* Severe events are the hard ones: 30–46 s apneas with real bradycardia,
       which is the confounder that looks most like an overdose. */
    var severe = rnd() < 0.45;
    var rrBase = 13 + rnd() * 3;
    var hrBase = severe ? 52 + rnd() * 10 : 60 + rnd() * 10;
    var rr = new Array(DUR),
      hr = new Array(DUR),
      sqi = new Array(DUR);
    for (var i = 0; i < DUR; i++) {
      rr[i] = clamp(rrBase + jitter(rnd, 0.9), 0, 40);
      hr[i] = clamp(hrBase + jitter(rnd, 2.2), 20, 190);
      sqi[i] = clamp(0.88 + jitter(rnd, 0.05), 0, 1);
    }
    var t = 25 + Math.floor(rnd() * 30);
    while (t < DUR - 40) {
      var ap = severe
        ? 30 + Math.floor(rnd() * 17)
        : 13 + Math.floor(rnd() * 14);
      var k;
      for (k = 0; k < ap && t + k < DUR; k++) {
        rr[t + k] = clamp(0.6 + jitter(rnd, 0.5), 0, 40);
        hr[t + k] = clamp(
          hrBase - (severe ? 6 + (k / ap) * 12 : 8 + (k / ap) * 6) + jitter(rnd, 2),
          20,
          190
        );
      }
      var rec = 9 + Math.floor(rnd() * 7);
      for (k = 0; k < rec && t + ap + k < DUR; k++) {
        var d = k / rec;
        rr[t + ap + k] = clamp(24 - 8 * d + jitter(rnd, 1.4), 0, 40);
        hr[t + ap + k] = clamp(hrBase + 22 - 14 * d + jitter(rnd, 2.5), 20, 190);
      }
      t += ap + rec + 14 + Math.floor(rnd() * 18);
    }
    return { rr: rr, hr: hr, sqi: sqi, onsetIdx: -1 };
  }

  /* Quiet sleep: the boring case that must never be dosed. Includes the
     occasional post-sigh pause, which is short enough to be harmless. */
  function genRest(rnd) {
    var rrBase = 11 + rnd() * 4;
    var hrBase = 51 + rnd() * 12;
    var rr = new Array(DUR),
      hr = new Array(DUR),
      sqi = new Array(DUR);
    for (var i = 0; i < DUR; i++) {
      rr[i] = clamp(rrBase + jitter(rnd, 0.8), 0, 40);
      hr[i] = clamp(hrBase + jitter(rnd, 1.8), 20, 190);
      sqi[i] = clamp(0.94 + jitter(rnd, 0.04), 0, 1);
    }
    var pauses = 2 + Math.floor(rnd() * 3);
    for (var n = 0; n < pauses; n++) {
      var t = 30 + Math.floor(rnd() * (DUR - 80));
      var len = 5 + Math.floor(rnd() * 5);
      for (var k = 0; k < len && t + k < DUR; k++) {
        rr[t + k] = clamp(3 + rnd() * 3, 0, 40);
      }
    }
    return { rr: rr, hr: hr, sqi: sqi, onsetIdx: -1 };
  }

  /* Motion artifact: the estimator loses the breath and beat signal and
     returns confident nonsense. The first bout deliberately looks exactly
     like an overdose — low rate, low heart rate — and only the signal
     quality channel gives it away. */
  function genMotion(rnd) {
    var rrBase = 14 + rnd() * 4;
    var hrBase = 88 + rnd() * 32;
    var rr = new Array(DUR),
      hr = new Array(DUR),
      sqi = new Array(DUR);
    for (var i = 0; i < DUR; i++) {
      rr[i] = clamp(rrBase + jitter(rnd, 1.6), 0, 40);
      hr[i] = clamp(hrBase + jitter(rnd, 4), 20, 190);
      sqi[i] = clamp(0.8 + jitter(rnd, 0.07), 0, 1);
    }
    var k;
    var bouts = 2 + Math.floor(rnd() * 3);
    for (var b = 0; b < bouts; b++) {
      var t = 20 + Math.floor(rnd() * (DUR - 70));
      var bl = 18 + Math.floor(rnd() * 38);
      for (k = 0; k < bl && t + k < DUR; k++) {
        rr[t + k] = clamp(2 + rnd() * 26, 0, 40);
        hr[t + k] = clamp(30 + rnd() * 120, 20, 190);
        sqi[t + k] = clamp(0.18 + rnd() * 0.28, 0, 1);
      }
    }
    /* written last so a later random bout can never erase it */
    var start = 60 + Math.floor(rnd() * 200);
    var len = 45 + Math.floor(rnd() * 35);
    for (k = 0; k < len && start + k < DUR; k++) {
      rr[start + k] = clamp(1.5 + jitter(rnd, 1.2), 0, 40);
      hr[start + k] = clamp(38 + jitter(rnd, 5), 20, 190);
      sqi[start + k] = clamp(0.27 + jitter(rnd, 0.1), 0, 1);
    }
    return { rr: rr, hr: hr, sqi: sqi, onsetIdx: -1 };
  }

  /* Sensor coupling loss: the capsule shifts, the breathing channel flatlines
     to zero while the heart-rate channel keeps reporting a perfectly normal
     rate. Mid-range signal quality, so the artifact gate only half helps —
     the heart-rate corroboration is what rules it out. */
  function genDecouple(rnd) {
    var rrBase = 13 + rnd() * 3;
    var hrBase = 62 + rnd() * 14;
    var rr = new Array(DUR),
      hr = new Array(DUR),
      sqi = new Array(DUR);
    for (var i = 0; i < DUR; i++) {
      rr[i] = clamp(rrBase + jitter(rnd, 0.9), 0, 40);
      hr[i] = clamp(hrBase + jitter(rnd, 2.2), 20, 190);
      sqi[i] = clamp(0.9 + jitter(rnd, 0.05), 0, 1);
    }
    var start = 110 + Math.floor(rnd() * 260);
    var len = 45 + Math.floor(rnd() * 55);
    var q = 0.45 + rnd() * 0.23;
    for (var k = 0; k < len && start + k < DUR; k++) {
      rr[start + k] = clamp(0.5 + jitter(rnd, 0.5), 0, 40);
      hr[start + k] = clamp(hrBase + jitter(rnd, 3.5), 20, 190);
      sqi[start + k] = clamp(q + jitter(rnd, 0.05), 0, 1);
    }
    return { rr: rr, hr: hr, sqi: sqi, onsetIdx: -1 };
  }

  var GENERATORS = {
    opioid: genOpioid,
    osa: genOsa,
    rest: genRest,
    motion: genMotion,
    decouple: genDecouple
  };

  function buildCohort(seed) {
    var kinds = [];
    MIX.forEach(function (pair) {
      for (var i = 0; i < pair[1]; i++) kinds.push(pair[0]);
    });
    var shuffleRnd = mulberry32(seed ^ 0x5f3759df);
    for (var i = kinds.length - 1; i > 0; i--) {
      var j = Math.floor(shuffleRnd() * (i + 1));
      var tmp = kinds[i];
      kinds[i] = kinds[j];
      kinds[j] = tmp;
    }
    return kinds.map(function (kind, idx) {
      var series = GENERATORS[kind](mulberry32(seed + idx * 7919 + 13));
      var minRr = Infinity;
      for (var t = 0; t < DUR; t++) if (series.rr[t] < minRr) minRr = series.rr[t];
      return {
        id: "SIM-" + (idx + 1 < 10 ? "0" : "") + (idx + 1),
        kind: kind,
        label: SCENARIOS[kind].label,
        short: SCENARIOS[kind].short,
        needsDose: SCENARIOS[kind].needsDose,
        onsetIdx: series.onsetIdx,
        rr: series.rr,
        hr: series.hr,
        sqi: series.sqi,
        minRr: minRr
      };
    });
  }

  /* ---------------------------------------------------------- the detector */

  /* Causal, single pass, one sample per second. States:
       0 monitoring · 1 armed (evidence accruing) · 2 confirm hold · 3 dosed
     Evidence accrues only on wake samples that clear the quality gate, and it
     accrues in *seconds*, so a coarser duty cycle credits a whole sleep
     interval to a single accepted sample — which is exactly how a duty-cycled
     device over-counts evidence. */
  function runDetector(ep, p) {
    var st = new Uint8Array(DUR);
    var masked = new Uint8Array(DUR);
    var ev = new Float32Array(DUR);
    var cf = new Float32Array(DUR);
    var events = [];
    var phase = 0;
    var sustain = 0;
    var confirm = 0;
    var dropout = 0;
    var dosed = false;
    var doseIdx = -1;
    var aborts = 0;
    var accepted = 0;
    var armInfo = null;

    for (var i = 0; i < DUR; i++) {
      if (dosed) {
        st[i] = 3;
        ev[i] = sustain;
        cf[i] = confirm;
        continue;
      }
      var isWake = i % p.duty === 0;
      var ok = isWake && ep.sqi[i] >= p.minSqi;
      masked[i] = isWake && !ok ? 1 : 0;

      if (!ok) {
        if (isWake) {
          dropout += p.duty;
          if (dropout > MAX_DROPOUT && phase !== 0) {
            events.push({
              t: i,
              kind: "warn",
              text:
                "artifact gate — " +
                dropout +
                " s of samples below quality " +
                p.minSqi.toFixed(2) +
                ", evidence cleared"
            });
            phase = 0;
            sustain = 0;
            confirm = 0;
          }
        }
        st[i] = phase;
        ev[i] = sustain;
        cf[i] = confirm;
        continue;
      }

      dropout = 0;
      accepted++;
      var brady = ep.hr[i] <= p.hrThresh;
      var depressed = ep.rr[i] <= p.rrThresh && (!p.requireBrady || brady);

      if (phase === 0) {
        if (depressed) {
          phase = 1;
          sustain = p.duty;
          /* walk back over each channel's below-threshold run to see which one
             crossed last — that channel is what sets the detector's latency */
          var a = i;
          while (a > 0 && ep.rr[a - 1] <= p.rrThresh) a--;
          var b = i;
          while (b > 0 && ep.hr[b - 1] <= p.hrThresh) b--;
          armInfo = { at: i, rrAt: a, hrAt: b };
          events.push({
            t: i,
            kind: "info",
            text:
              "armed — RR " +
              ep.rr[i].toFixed(1) +
              " br/min, HR " +
              Math.round(ep.hr[i]) +
              " bpm, quality " +
              ep.sqi[i].toFixed(2)
          });
        } else {
          sustain = 0;
        }
      } else if (phase === 1) {
        if (depressed) {
          sustain += p.duty;
          if (sustain >= p.sustainSec) {
            phase = 2;
            confirm = 0;
            events.push({
              t: i,
              kind: "info",
              text:
                "sustain window met (" +
                sustain +
                " s of evidence) — entering confirm hold"
            });
          }
        } else {
          events.push({
            t: i,
            kind: "info",
            text:
              "recovered after " +
              sustain +
              " s of evidence (RR " +
              ep.rr[i].toFixed(1) +
              ") — reset to monitoring"
          });
          phase = 0;
          sustain = 0;
        }
      }

      if (phase === 2) {
        if (!depressed) {
          events.push({
            t: i,
            kind: "warn",
            text:
              "recovery during confirm hold (RR " +
              ep.rr[i].toFixed(1) +
              ") — dose withheld"
          });
          aborts++;
          phase = 0;
          sustain = 0;
          confirm = 0;
        } else {
          confirm += p.duty;
          if (confirm > p.confirmSec) {
            dosed = true;
            doseIdx = i;
            events.push({
              t: i,
              kind: "dose",
              text: "RESCUE DOSE RELEASED (simulated antagonist bolus)"
            });
          }
        }
      }

      st[i] = dosed ? 3 : phase;
      ev[i] = sustain;
      cf[i] = confirm;
    }

    var outcome = ep.needsDose
      ? dosed
        ? "TP"
        : "FN"
      : dosed
      ? "FP"
      : "TN";
    var ttr =
      dosed && ep.needsDose && ep.onsetIdx >= 0
        ? Math.max(0, doseIdx - ep.onsetIdx)
        : null;

    return {
      st: st,
      masked: masked,
      ev: ev,
      cf: cf,
      events: events,
      dosed: dosed,
      doseIdx: doseIdx,
      armInfo: armInfo,
      aborts: aborts,
      accepted: accepted,
      outcome: outcome,
      ttr: ttr
    };
  }

  /* Rough coin-cell budget for a duty-cycled sensing capsule. Not a
     measurement — an order-of-magnitude model, stated as such in the UI. */
  function batteryHours(duty) {
    var activeMa = 2.4;
    var activeS = 0.9;
    var sleepMa = 0.014;
    var capacityMah = 24;
    var perCycleMas = activeMa * activeS + sleepMa * Math.max(0, duty - activeS);
    var avgMa = perCycleMas / duty;
    return capacityMah / avgMa;
  }

  /* ------------------------------------------------------------ page state */

  var state = {
    seed: 20260813,
    params: null,
    episodes: [],
    results: [],
    selected: 0,
    playhead: DUR - 1,
    playing: false,
    filter: "all",
    sweep: null,
    sweepKey: "",
    raf: 0,
    lastFrame: 0,
    lastPaint: 0
  };

  var reduceMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var PLAY_SPEED = reduceMotion ? 8 : 25; /* simulated seconds per real second */

  function cloneParams(src) {
    return {
      rrThresh: src.rrThresh,
      requireBrady: src.requireBrady,
      hrThresh: src.hrThresh,
      sustainSec: src.sustainSec,
      confirmSec: src.confirmSec,
      minSqi: src.minSqi,
      duty: src.duty
    };
  }

  /* -------------------------------------------------------------- geometry */

  var VW = 640; /* chart viewBox width */
  var PL = 44; /* plot left — leaves room for y labels at mobile type sizes */
  var PR = 632; /* plot right */

  function xAt(i) {
    return PL + (i / (DUR - 1)) * (PR - PL);
  }

  function runsOf(arr, len) {
    var out = [];
    var start = 0;
    for (var i = 1; i <= len; i++) {
      if (i === len || arr[i] !== arr[start]) {
        out.push({ from: start, to: i - 1, v: arr[start] });
        start = i;
      }
    }
    return out;
  }

  /* Builds the sample-and-hold path the detector actually sees: one step per
     accepted wake sample, broken wherever samples were gated or the sensor
     was asleep past the playhead. */
  function stepPath(ep, res, p, field, upTo, yFn) {
    var d = "";
    var open = false;
    var segPoints = 0;
    var prevX = 0;
    for (var i = 0; i <= upTo && i < DUR; i++) {
      if (i % p.duty !== 0) continue;
      if (res.masked[i]) {
        /* a gated sample breaks the trace; make sure a lone point still draws */
        if (open && segPoints === 1) d += "H" + (prevX + 1).toFixed(1);
        open = false;
        segPoints = 0;
        continue;
      }
      var x = xAt(i);
      var y = yFn(ep[field][i]);
      if (!open) {
        d += "M" + x.toFixed(1) + " " + y.toFixed(1);
        open = true;
        segPoints = 1;
      } else {
        d += "H" + x.toFixed(1) + "V" + y.toFixed(1);
        segPoints++;
      }
      prevX = x;
    }
    if (open) {
      var endX = xAt(Math.min(upTo, DUR - 1));
      if (endX > prevX + 0.05) d += "H" + endX.toFixed(1);
      else if (segPoints === 1) d += "H" + (prevX + 1).toFixed(1);
    }
    return d;
  }

  function truthPath(values, yFn) {
    var d = "";
    for (var i = 0; i < DUR; i++) {
      d +=
        (i === 0 ? "M" : "L") +
        xAt(i).toFixed(1) +
        " " +
        yFn(values[i]).toFixed(1);
    }
    return d;
  }

  function maskRects(res, p, top, height, patternId) {
    var runs = runsOf(res.masked, DUR);
    var out = "";
    for (var r = 0; r < runs.length; r++) {
      if (!runs[r].v) continue;
      /* a gated wake sample stands for the whole duty interval it covers */
      var from = runs[r].from;
      var to = Math.min(DUR - 1, runs[r].to + p.duty - 1);
      var x = xAt(from);
      var w = Math.max(1.2, xAt(to) - x);
      out +=
        '<rect class="c-mask" x="' +
        x.toFixed(1) +
        '" y="' +
        top +
        '" width="' +
        w.toFixed(1) +
        '" height="' +
        height +
        '" fill="url(#' +
        patternId +
        ')"/>';
    }
    return out;
  }

  function hatchDefs(id) {
    return (
      '<defs><pattern id="' +
      id +
      '" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      '<rect class="c-mask-bg" width="7" height="7"/>' +
      '<line class="c-mask-line" x1="0" y1="0" x2="0" y2="7"/>' +
      "</pattern></defs>"
    );
  }

  /* ----------------------------------------------------------- chart: line */

  function lineChart(opts) {
    var ep = state.episodes[state.selected];
    var res = state.results[state.selected];
    var p = state.params;
    if (!ep || !res) {
      return '<p class="chart-empty">No recording loaded.</p>';
    }
    var H = opts.height;
    var top = 10;
    var bot = H - (opts.xAxis ? 22 : 10);
    var lo = opts.lo;
    var hi = opts.hi;
    function y(v) {
      return bot - ((clamp(v, lo, hi) - lo) / (hi - lo)) * (bot - top);
    }
    var t = Math.round(state.playhead);
    var s = "";

    s += hatchDefs(opts.patternId);
    s +=
      '<rect class="c-frame" x="' +
      PL +
      '" y="' +
      top +
      '" width="' +
      (PR - PL) +
      '" height="' +
      (bot - top) +
      '" rx="4"/>';

    /* horizontal grid + y labels */
    for (var g = 0; g < opts.ticks.length; g++) {
      var gv = opts.ticks[g];
      var gy = y(gv);
      s +=
        '<line class="c-grid" x1="' +
        PL +
        '" y1="' +
        gy.toFixed(1) +
        '" x2="' +
        PR +
        '" y2="' +
        gy.toFixed(1) +
        '" opacity="0.55"/>';
      s +=
        '<text class="c-tick" x="' +
        (PL - 6) +
        '" y="' +
        (gy + 3.5).toFixed(1) +
        '" text-anchor="end">' +
        gv +
        "</text>";
    }

    s += maskRects(res, p, top, bot - top, opts.patternId);

    /* true physiology, faint, always full length for context */
    s += '<path class="c-truth" d="' + truthPath(ep[opts.field], y) + '"/>';

    /* threshold line */
    if (opts.thresh !== null && opts.thresh !== undefined) {
      var ty = y(opts.thresh);
      s +=
        '<line class="c-thresh" x1="' +
        PL +
        '" y1="' +
        ty.toFixed(1) +
        '" x2="' +
        PR +
        '" y2="' +
        ty.toFixed(1) +
        '"/>';
      s +=
        '<text class="c-thresh-label" x="' +
        (PL + 5) +
        '" y="' +
        (ty - 4).toFixed(1) +
        '">' +
        opts.threshLabel +
        "</text>";
    }

    /* what the detector has actually accepted so far */
    var live = stepPath(ep, res, p, opts.field, t, y);
    if (live) s += '<path class="c-live" d="' + live + '"/>';

    /* dose marker */
    if (res.dosed && res.doseIdx <= t) {
      var dx = xAt(res.doseIdx);
      s +=
        '<line class="c-dose" x1="' +
        dx.toFixed(1) +
        '" y1="' +
        top +
        '" x2="' +
        dx.toFixed(1) +
        '" y2="' +
        bot +
        '"/>';
      if (opts.doseLabel) {
        var anchor = dx > PR - 90 ? "end" : "start";
        s +=
          '<text class="c-dose-label" x="' +
          (anchor === "end" ? dx - 5 : dx + 5).toFixed(1) +
          '" y="' +
          (top + 12) +
          '" text-anchor="' +
          anchor +
          '">DOSE ' +
          mmss(res.doseIdx) +
          "</text>";
      }
    }

    /* playhead */
    var px = xAt(t);
    s +=
      '<line class="c-playhead" x1="' +
      px.toFixed(1) +
      '" y1="' +
      top +
      '" x2="' +
      px.toFixed(1) +
      '" y2="' +
      bot +
      '"/>';

    /* x axis */
    if (opts.xAxis) {
      for (var xt = 0; xt <= 600; xt += 100) {
        var xx = xAt(Math.min(xt, DUR - 1));
        s +=
          '<text class="c-tick" x="' +
          xx.toFixed(1) +
          '" y="' +
          (bot + 14) +
          '" text-anchor="middle">' +
          mmss(xt) +
          "</text>";
      }
    }

    return (
      '<svg viewBox="0 0 ' +
      VW +
      " " +
      H +
      '" role="img" aria-label="' +
      esc(opts.aria) +
      '">' +
      s +
      "</svg>"
    );
  }

  /* --------------------------------------------------------- chart: ribbon */

  function ribbonChart() {
    var ep = state.episodes[state.selected];
    var res = state.results[state.selected];
    if (!ep || !res) return '<p class="chart-empty">No recording loaded.</p>';
    var H = 34;
    var t = Math.round(state.playhead);
    var names = ["Monitoring", "Armed", "Confirm hold", "Dose released"];
    var cls = ["r-monitor", "r-armed", "r-confirm", "r-dosed"];
    var runs = runsOf(res.st, DUR);
    var s = "";
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      if (run.from > t) break;
      var to = Math.min(run.to, t);
      var x = xAt(run.from);
      var w = Math.max(1, xAt(to) - x);
      s +=
        '<rect class="' +
        cls[run.v] +
        '" x="' +
        x.toFixed(1) +
        '" y="4" width="' +
        w.toFixed(1) +
        '" height="' +
        (H - 8) +
        '" rx="3"/>';
      if (w > 125) {
        s +=
          '<text class="r-label" x="' +
          (x + w / 2).toFixed(1) +
          '" y="' +
          (H / 2 + 4) +
          '" text-anchor="middle">' +
          names[run.v] +
          "</text>";
      }
    }
    /* the not-yet-played remainder of the strip */
    if (t < DUR - 1) {
      var rx = xAt(t);
      s +=
        '<rect class="c-frame" x="' +
        rx.toFixed(1) +
        '" y="4" width="' +
        Math.max(1, PR - rx).toFixed(1) +
        '" height="' +
        (H - 8) +
        '" rx="3" opacity="0.5"/>';
    }
    var spans = runs
      .filter(function (r2) {
        return r2.v !== 0 && r2.from <= t;
      })
      .slice(0, 6)
      .map(function (r2) {
        return names[r2.v] + " from " + mmss(r2.from) + " to " + mmss(r2.to);
      })
      .join(", ");
    var summary =
      "Detector state over time. " +
      (spans || "Monitoring for the whole recording so far.");
    return (
      '<svg viewBox="0 0 ' +
      VW +
      " " +
      H +
      '" role="img" aria-label="' +
      esc(summary) +
      '">' +
      s +
      "</svg>"
    );
  }

  /* ---------------------------------------------------------- chart: sweep */

  function computeSweep() {
    var p = state.params;
    var key = [
      p.rrThresh,
      p.requireBrady,
      p.hrThresh,
      p.confirmSec,
      p.minSqi,
      p.duty,
      state.seed
    ].join("|");
    if (key === state.sweepKey && state.sweep) return state.sweep;
    var pts = [];
    for (var sVal = 10; sVal <= 90; sVal += 5) {
      var pp = cloneParams(p);
      pp.sustainSec = sVal;
      var fp = 0,
        fn = 0,
        late = 0,
        ttrs = [];
      for (var i = 0; i < state.episodes.length; i++) {
        var ep = state.episodes[i];
        var r = runDetector(ep, pp);
        if (ep.needsDose) {
          if (r.dosed) {
            if (r.ttr !== null) {
              ttrs.push(r.ttr);
              if (r.ttr > GUARDRAIL) late++;
            }
          } else fn++;
        } else if (r.dosed) fp++;
      }
      pts.push({ s: sVal, fp: fp, fn: fn, late: late, ttr: median(ttrs) });
    }
    state.sweep = pts;
    state.sweepKey = key;
    return pts;
  }

  function sweepChart() {
    var pts = computeSweep();
    if (!pts.length) return '<p class="chart-empty">No sweep to show.</p>';
    var H = 214;
    var top = 12,
      bot = H - 44;
    var maxY = 2;
    pts.forEach(function (pt) {
      maxY = Math.max(maxY, pt.fp, pt.fn, pt.late);
    });
    maxY = Math.ceil(maxY / 2) * 2;
    function x(sv) {
      return PL + ((sv - 10) / 80) * (PR - PL);
    }
    function y(v) {
      return bot - (v / maxY) * (bot - top);
    }
    var s = "";
    s +=
      '<rect class="c-frame" x="' +
      PL +
      '" y="' +
      top +
      '" width="' +
      (PR - PL) +
      '" height="' +
      (bot - top) +
      '" rx="4"/>';
    var steps = Math.min(maxY, 6);
    for (var g = 0; g <= steps; g++) {
      var gv = Math.round((maxY / steps) * g);
      var gy = y(gv);
      s +=
        '<line class="c-grid" x1="' +
        PL +
        '" y1="' +
        gy.toFixed(1) +
        '" x2="' +
        PR +
        '" y2="' +
        gy.toFixed(1) +
        '" opacity="0.5"/>';
      s +=
        '<text class="c-tick" x="' +
        (PL - 6) +
        '" y="' +
        (gy + 3.5).toFixed(1) +
        '" text-anchor="end">' +
        gv +
        "</text>";
    }
    var dFp = "",
      dFn = "",
      dLate = "",
      dots = "";
    pts.forEach(function (pt, i) {
      var px = x(pt.s);
      dFp += (i ? "L" : "M") + px.toFixed(1) + " " + y(pt.fp).toFixed(1);
      dFn += (i ? "L" : "M") + px.toFixed(1) + " " + y(pt.fn).toFixed(1);
      dLate += (i ? "L" : "M") + px.toFixed(1) + " " + y(pt.late).toFixed(1);
      dots +=
        '<circle class="s-fp-dot" cx="' +
        px.toFixed(1) +
        '" cy="' +
        y(pt.fp).toFixed(1) +
        '" r="2.8"/>';
      dots +=
        '<rect class="s-fn-dot" x="' +
        (px - 2.6).toFixed(1) +
        '" y="' +
        (y(pt.fn) - 2.6).toFixed(1) +
        '" width="5.2" height="5.2"/>';
      dots +=
        '<polygon class="s-late-dot" points="' +
        px.toFixed(1) +
        "," +
        (y(pt.late) - 3.4).toFixed(1) +
        " " +
        (px + 3.4).toFixed(1) +
        "," +
        y(pt.late).toFixed(1) +
        " " +
        px.toFixed(1) +
        "," +
        (y(pt.late) + 3.4).toFixed(1) +
        " " +
        (px - 3.4).toFixed(1) +
        "," +
        y(pt.late).toFixed(1) +
        '"/>';
    });
    s += '<path class="s-fp" d="' + dFp + '"/>';
    s += '<path class="s-fn" d="' + dFn + '"/>';
    s += '<path class="s-late" d="' + dLate + '"/>';
    s += dots;

    var nowX = x(clamp(state.params.sustainSec, 10, 90));
    s +=
      '<line class="s-now" x1="' +
      nowX.toFixed(1) +
      '" y1="' +
      top +
      '" x2="' +
      nowX.toFixed(1) +
      '" y2="' +
      bot +
      '"/>';
    s +=
      '<text class="s-now-label" x="' +
      (nowX > PR - 70 ? nowX - 5 : nowX + 5).toFixed(1) +
      '" y="' +
      (top + 11) +
      '" text-anchor="' +
      (nowX > PR - 70 ? "end" : "start") +
      '">now ' +
      state.params.sustainSec +
      "s</text>";

    for (var xt = 10; xt <= 90; xt += 10) {
      s +=
        '<text class="c-tick" x="' +
        x(xt).toFixed(1) +
        '" y="' +
        (bot + 18) +
        '" text-anchor="middle">' +
        xt +
        "</text>";
    }
    s +=
      '<text class="c-tick" x="' +
      ((PL + PR) / 2).toFixed(1) +
      '" y="' +
      (bot + 40) +
      '" text-anchor="middle">sustain window (s)</text>';

    var last = pts[pts.length - 1];
    var aria =
      "Line chart of detector errors against the sustain window. From 10 to 90 seconds, false doses go from " +
      pts[0].fp +
      " to " +
      last.fp +
      ", missed overdoses from " +
      pts[0].fn +
      " to " +
      last.fn +
      ", and rescues slower than the " +
      GUARDRAIL +
      " second budget from " +
      pts[0].late +
      " to " +
      last.late +
      ".";
    return (
      '<svg viewBox="0 0 ' +
      VW +
      " " +
      H +
      '" role="img" aria-label="' +
      esc(aria) +
      '">' +
      s +
      "</svg>"
    );
  }

  /* ---------------------------------------------------------------- render */

  function lastAccepted(ep, res, p, t) {
    for (var i = Math.min(t, DUR - 1); i >= 0; i--) {
      if (i % p.duty === 0 && !res.masked[i]) return i;
    }
    return -1;
  }

  function renderEpisode() {
    var ep = state.episodes[state.selected];
    var res = state.results[state.selected];
    var p = state.params;
    var t = Math.round(state.playhead);

    $("scrub-out").textContent = mmss(t);

    /* decision line */
    var dec = $("decision");
    var truth = ep.needsDose
      ? "ground truth: overdose, a dose is required"
      : "ground truth: " + ep.short.toLowerCase() + ", no dose is required";
    var verdict;
    if (res.dosed && res.doseIdx <= t) {
      verdict =
        "Dose released at " +
        mmss(res.doseIdx) +
        (res.ttr !== null ? " — " + res.ttr + " s after apnea onset" : "");
    } else if (res.dosed) {
      verdict = "No dose yet — this detector fires later, at " + mmss(res.doseIdx);
    } else {
      verdict = "No dose released in 10 minutes of monitoring";
    }
    var judgement = {
      TP: "correct rescue",
      TN: "correct hold",
      FP: "FALSE DOSE",
      FN: "MISSED OVERDOSE"
    }[res.outcome];
    /* which channel actually gated the arm, and by how much */
    var binding = "";
    if (p.requireBrady && res.armInfo && res.armInfo.at <= t) {
      var ai = res.armInfo;
      var lag = Math.abs(ai.hrAt - ai.rrAt);
      binding =
        " Breathing crossed at " +
        mmss(ai.rrAt) +
        ", heart rate at " +
        mmss(ai.hrAt) +
        " — the " +
        (ai.hrAt >= ai.rrAt ? "heart-rate" : "breathing") +
        " channel held the arm back " +
        lag +
        " s.";
    }
    dec.setAttribute("data-outcome", res.outcome);
    dec.innerHTML =
      "<strong>" +
      esc(ep.id) +
      " · " +
      esc(ep.label) +
      "</strong><br/>" +
      esc(verdict) +
      ". At full replay: <strong>" +
      esc(judgement) +
      "</strong> (" +
      esc(truth) +
      ")." +
      esc(binding);

    /* readouts */
    var li = lastAccepted(ep, res, p, t);
    var stateNames = [
      "Monitoring",
      "Armed — evidence accruing",
      "Confirm hold",
      "Dose released"
    ];
    var sensor =
      t % p.duty !== 0
        ? "asleep (" + p.duty + " s duty)"
        : res.masked[t]
        ? "gated — quality " + ep.sqi[t].toFixed(2)
        : "sampling";
    var inConfirm = res.st[t] === 2;
    var cells = [
      ["Clock", mmss(t)],
      [
        "Breathing rate",
        li >= 0 ? ep.rr[li].toFixed(1) + " br/min" : "no sample yet"
      ],
      ["Heart rate", li >= 0 ? Math.round(ep.hr[li]) + " bpm" : "—"],
      ["Signal quality", ep.sqi[t].toFixed(2)],
      ["Sensor", sensor],
      ["Detector", stateNames[res.st[t]]],
      [
        inConfirm ? "Confirm hold" : "Evidence",
        inConfirm
          ? Math.round(res.cf[t]) + " s / " + p.confirmSec + " s"
          : Math.round(res.ev[t]) + " s / " + p.sustainSec + " s"
      ]
    ];
    $("readouts").innerHTML = cells
      .map(function (c) {
        return (
          '<div class="readout"><b>' +
          esc(c[0]) +
          "</b><span>" +
          esc(c[1]) +
          "</span></div>"
        );
      })
      .join("");

    /* charts */
    var minRrIdx = 0;
    for (var i = 1; i < DUR; i++) if (ep.rr[i] < ep.rr[minRrIdx]) minRrIdx = i;
    $("chart-rr").innerHTML = lineChart({
      field: "rr",
      height: 170,
      lo: 0,
      hi: 30,
      ticks: [0, 6, 12, 18, 24, 30],
      thresh: p.rrThresh,
      threshLabel: "trigger ≤ " + p.rrThresh + " br/min",
      patternId: "hatch-rr",
      xAxis: false,
      doseLabel: true,
      aria:
        "Breathing rate over ten minutes for " +
        ep.id +
        ", " +
        ep.label +
        ". Minimum " +
        ep.minRr.toFixed(1) +
        " breaths per minute at " +
        mmss(minRrIdx) +
        ". Trigger threshold " +
        p.rrThresh +
        " breaths per minute. " +
        (res.dosed
          ? "A dose was released at " + mmss(res.doseIdx) + "."
          : "No dose was released.")
    });
    $("chart-ribbon").innerHTML = ribbonChart();
    $("chart-hr").innerHTML = lineChart({
      field: "hr",
      height: 130,
      lo: 20,
      hi: 160,
      ticks: [20, 55, 90, 125, 160],
      thresh: p.requireBrady ? p.hrThresh : null,
      threshLabel: "corroboration ≤ " + p.hrThresh + " bpm",
      patternId: "hatch-hr",
      xAxis: false,
      doseLabel: false,
      aria:
        "Heart rate over ten minutes for " +
        ep.id +
        ". " +
        (p.requireBrady
          ? "Corroboration threshold " + p.hrThresh + " bpm."
          : "Heart-rate corroboration is switched off.")
    });
    $("chart-sqi").innerHTML = lineChart({
      field: "sqi",
      height: 120,
      lo: 0,
      hi: 1,
      ticks: [0, 0.5, 1],
      thresh: p.minSqi,
      threshLabel: "reject < " + p.minSqi.toFixed(2),
      patternId: "hatch-sqi",
      xAxis: true,
      doseLabel: false,
      aria:
        "Signal quality over ten minutes for " +
        ep.id +
        ". Samples below " +
        p.minSqi.toFixed(2) +
        " are rejected; " +
        res.accepted +
        " samples were accepted in total."
    });

    /* log */
    var rows = res.events.filter(function (e) {
      return e.t <= t;
    });
    var logEl = $("log");
    if (!rows.length) {
      logEl.innerHTML =
        '<div class="log-row"><span class="log-time">' +
        mmss(t) +
        "</span><span>monitoring — nothing has crossed the trigger condition yet</span></div>";
    } else {
      logEl.innerHTML = rows
        .map(function (e) {
          var cls =
            e.kind === "dose" ? "log-dose" : e.kind === "warn" ? "log-warn" : "";
          return (
            '<div class="log-row"><span class="log-time">' +
            mmss(e.t) +
            '</span><span class="' +
            cls +
            '">' +
            esc(e.text) +
            "</span></div>"
          );
        })
        .join("");
    }
    if (state.playing) logEl.scrollTop = logEl.scrollHeight;
  }

  function renderMetrics() {
    var tp = 0,
      fp = 0,
      fn = 0,
      tn = 0,
      ttrs = [],
      late = 0,
      aborts = 0;
    for (var i = 0; i < state.results.length; i++) {
      var r = state.results[i];
      if (r.outcome === "TP") {
        tp++;
        if (r.ttr !== null) {
          ttrs.push(r.ttr);
          if (r.ttr > GUARDRAIL) late++;
        }
      } else if (r.outcome === "FP") fp++;
      else if (r.outcome === "FN") fn++;
      else tn++;
      aborts += r.aborts;
    }
    var med = median(ttrs);
    var worst = ttrs.length ? Math.max.apply(null, ttrs) : null;
    var hours = batteryHours(state.params.duty);
    var battery =
      hours >= 24 ? (hours / 24).toFixed(1) + " days" : hours.toFixed(1) + " h";

    var cells = [
      ["Rescues delivered", tp + " / " + (tp + fn)],
      ["Missed overdoses", String(fn)],
      ["False doses", fp + " / " + (fp + tn)],
      ["Correct holds", String(tn)],
      ["Median time to dose", med === null ? "—" : med + " s"],
      ["Worst time to dose", worst === null ? "—" : worst + " s"],
      ["Slower than " + GUARDRAIL + " s", String(late)],
      ["Aborted in confirm", String(aborts)],
      ["Cell life (modelled)", battery]
    ];
    $("metrics").innerHTML = cells
      .map(function (c) {
        return (
          '<div class="metric"><span class="metric-label">' +
          esc(c[0]) +
          '</span><span class="metric-value">' +
          esc(c[1]) +
          "</span></div>"
        );
      })
      .join("");

    var g = $("guardrail");
    var msg;
    if (fn > 0 && fp > 0) {
      msg =
        fn +
        " overdose" +
        (fn === 1 ? "" : "s") +
        " went untreated and " +
        fp +
        " healthy recording" +
        (fp === 1 ? "" : "s") +
        " got a dose. Both error types are live at these settings.";
      g.className = "note note-warn";
    } else if (fn > 0) {
      msg =
        fn +
        " overdose" +
        (fn === 1 ? " was" : "s were") +
        " missed entirely — no false doses, but the detector is too deaf.";
      g.className = "note note-warn";
    } else if (fp > 0) {
      msg =
        "Every overdose was caught, but " +
        fp +
        " non-overdose recording" +
        (fp === 1 ? "" : "s") +
        " received a dose the subject did not need.";
      g.className = "note note-warn";
    } else if (late > 0) {
      msg =
        "All " +
        tp +
        " overdoses caught and no false doses, but " +
        late +
        " rescue" +
        (late === 1 ? "" : "s") +
        " landed more than " +
        GUARDRAIL +
        " s after apnea onset.";
      g.className = "note note-warn";
    } else {
      msg =
        "All " +
        tp +
        " overdoses caught inside the " +
        GUARDRAIL +
        " s target, no false doses, " +
        aborts +
        " near-miss" +
        (aborts === 1 ? "" : "es") +
        " aborted during the confirm hold.";
      g.className = "note note-accent";
    }
    g.textContent = msg;
  }

  function renderSweep() {
    $("chart-sweep").innerHTML = sweepChart();
    var pts = computeSweep();
    var cur = null;
    for (var i = 0; i < pts.length; i++)
      if (pts[i].s === state.params.sustainSec) cur = pts[i];
    if (!cur) {
      $("sweep-caption").textContent =
        "The sweep steps in 5 s increments; the marker shows the closest setting.";
      return;
    }
    $("sweep-caption").textContent =
      "At a " +
      cur.s +
      " s sustain window: " +
      cur.fp +
      " false dose" +
      (cur.fp === 1 ? "" : "s") +
      ", " +
      cur.fn +
      " missed overdose" +
      (cur.fn === 1 ? "" : "s") +
      ", " +
      cur.late +
      " rescue" +
      (cur.late === 1 ? "" : "s") +
      " slower than " +
      GUARDRAIL +
      " s, median time to dose " +
      (cur.ttr === null ? "n/a" : cur.ttr + " s") +
      ".";
  }

  function renderTable() {
    var body = $("rows");
    var html = "";
    var shown = 0;
    for (var i = 0; i < state.episodes.length; i++) {
      var ep = state.episodes[i];
      var r = state.results[i];
      var keep =
        state.filter === "all" ||
        (state.filter === "needs" && ep.needsDose) ||
        (state.filter === "benign" && !ep.needsDose) ||
        (state.filter === "fp" && r.outcome === "FP") ||
        (state.filter === "fn" && r.outcome === "FN");
      if (!keep) continue;
      shown++;
      var outcomeText = {
        TP: "Correct rescue",
        TN: "Correct hold",
        FP: "False dose",
        FN: "Missed"
      }[r.outcome];
      html +=
        "<tr" +
        (i === state.selected ? ' data-current="1"' : "") +
        "><td>" +
        esc(ep.id) +
        "</td><td>" +
        esc(ep.short) +
        "</td><td>" +
        (ep.needsDose ? "dose needed" : "no dose") +
        "</td><td>" +
        (r.dosed ? "dosed " + mmss(r.doseIdx) : "held") +
        '</td><td class="num">' +
        (r.ttr === null ? "—" : r.ttr + " s") +
        '</td><td class="num">' +
        ep.minRr.toFixed(1) +
        '</td><td><span class="tag o-' +
        r.outcome.toLowerCase() +
        '">' +
        outcomeText +
        '</span></td><td><button class="btn btn-sm" type="button" data-open="' +
        i +
        '">Open<span class="sr-only"> ' +
        esc(ep.id) +
        "</span></button></td></tr>";
    }
    body.innerHTML = html;
    $("table-empty").hidden = shown > 0;
  }

  function renderControls() {
    var p = state.params;
    $("rrThresh").value = p.rrThresh;
    $("rrThresh-out").textContent = p.rrThresh;
    $("requireBrady").checked = p.requireBrady;
    $("hrThresh").value = p.hrThresh;
    $("hrThresh-out").textContent = p.hrThresh;
    $("hrThresh").disabled = !p.requireBrady;
    $("sustainSec").value = p.sustainSec;
    $("sustainSec-out").textContent = p.sustainSec + " s";
    $("confirmSec").value = p.confirmSec;
    $("confirmSec-out").textContent = p.confirmSec + " s";
    $("minSqi").value = p.minSqi;
    $("minSqi-out").textContent = p.minSqi.toFixed(2);
    $("duty").value = String(p.duty);
    $("seed-line").textContent =
      "Cohort seed " +
      state.seed +
      " · 40 synthetic recordings, 10 minutes each, 1 Hz.";
  }

  function recompute() {
    state.results = state.episodes.map(function (ep) {
      return runDetector(ep, state.params);
    });
  }

  function renderAll() {
    renderEpisode();
    renderMetrics();
    renderSweep();
    renderTable();
  }

  /* --------------------------------------------------------------- wiring */

  function setPlaying(on) {
    state.playing = on;
    $("play").textContent = on ? "Pause" : "Play";
    if (on) {
      /* restart from the top, and show that immediately — the first animation
         frame may be a while away if the tab is in the background */
      if (state.playhead >= DUR - 1) {
        state.playhead = 0;
        $("scrub").value = "0";
        renderEpisode();
      }
      state.lastFrame = 0;
      state.raf = window.requestAnimationFrame(frame);
    } else if (state.raf) {
      window.cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
  }

  function frame(ts) {
    if (!state.playing) return;
    if (!state.lastFrame) state.lastFrame = ts;
    var dt = Math.min(0.1, (ts - state.lastFrame) / 1000);
    state.lastFrame = ts;
    state.playhead = state.playhead + dt * PLAY_SPEED;
    if (state.playhead >= DUR - 1) {
      state.playhead = DUR - 1;
      $("scrub").value = String(Math.round(state.playhead));
      renderEpisode();
      setPlaying(false);
      return;
    }
    $("scrub").value = String(Math.round(state.playhead));
    if (ts - state.lastPaint > 45) {
      state.lastPaint = ts;
      renderEpisode();
    }
    state.raf = window.requestAnimationFrame(frame);
  }

  function paramChanged() {
    recompute();
    renderControls();
    renderAll();
  }

  function bindRange(id, key, isFloat) {
    $(id).addEventListener("input", function () {
      state.params[key] = isFloat
        ? parseFloat(this.value)
        : parseInt(this.value, 10);
      paramChanged();
    });
  }

  function applyPreset(name) {
    state.params = cloneParams(PRESETS[name]);
    paramChanged();
  }

  function buildEpisodeSelect() {
    var sel = $("episode");
    var order = ["opioid", "osa", "rest", "motion", "decouple"];
    var html = "";
    order.forEach(function (kind) {
      var group = "";
      state.episodes.forEach(function (ep, i) {
        if (ep.kind !== kind) return;
        group +=
          '<option value="' +
          i +
          '">' +
          esc(ep.id + " · " + ep.short) +
          "</option>";
      });
      if (group)
        html +=
          '<optgroup label="' + esc(SCENARIOS[kind].label) + '">' + group + "</optgroup>";
    });
    sel.innerHTML = html;
    sel.value = String(state.selected);
  }

  function selectEpisode(idx) {
    state.selected = idx;
    state.playhead = DUR - 1;
    $("scrub").value = String(DUR - 1);
    $("episode").value = String(idx);
    setPlaying(false);
    renderEpisode();
    renderTable();
  }

  function rebuildCohort(seed) {
    state.seed = seed;
    state.episodes = buildCohort(seed);
    state.sweepKey = "";
    /* open on the first overdose recording — the case worth seeing first */
    state.selected = 0;
    for (var i = 0; i < state.episodes.length; i++) {
      if (state.episodes[i].kind === "opioid") {
        state.selected = i;
        break;
      }
    }
    recompute();
    buildEpisodeSelect();
    state.playhead = DUR - 1;
    $("scrub").value = String(DUR - 1);
    renderControls();
    renderAll();
  }

  function init() {
    state.params = cloneParams(DEFAULTS);
    rebuildCohort(state.seed);

    bindRange("rrThresh", "rrThresh", true);
    bindRange("hrThresh", "hrThresh", false);
    bindRange("sustainSec", "sustainSec", false);
    bindRange("confirmSec", "confirmSec", false);
    bindRange("minSqi", "minSqi", true);

    $("requireBrady").addEventListener("change", function () {
      state.params.requireBrady = this.checked;
      paramChanged();
    });
    $("duty").addEventListener("change", function () {
      state.params.duty = parseInt(this.value, 10);
      paramChanged();
    });

    $("preset-aggressive").addEventListener("click", function () {
      applyPreset("aggressive");
    });
    $("preset-balanced").addEventListener("click", function () {
      applyPreset("balanced");
    });
    $("preset-conservative").addEventListener("click", function () {
      applyPreset("conservative");
    });
    $("reset").addEventListener("click", function () {
      state.params = cloneParams(DEFAULTS);
      paramChanged();
    });
    $("reseed").addEventListener("click", function () {
      setPlaying(false);
      rebuildCohort((state.seed * 1664525 + 1013904223) >>> 8);
    });

    $("episode").addEventListener("change", function () {
      selectEpisode(parseInt(this.value, 10));
    });
    $("scrub").addEventListener("input", function () {
      setPlaying(false);
      state.playhead = parseInt(this.value, 10);
      renderEpisode();
    });
    $("play").addEventListener("click", function () {
      setPlaying(!state.playing);
    });
    $("rewind").addEventListener("click", function () {
      setPlaying(false);
      state.playhead = 0;
      $("scrub").value = "0";
      renderEpisode();
    });
    $("filter").addEventListener("change", function () {
      state.filter = this.value;
      renderTable();
    });
    $("rows").addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("button[data-open]") : null;
      if (!btn) return;
      selectEpisode(parseInt(btn.getAttribute("data-open"), 10));
      $("episode").focus();
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden && state.playing) setPlaying(false);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
