/* =============================================================================
   Agent Trace Query Console
   An independent mini-demo by Aarush Kandukoori. No dependencies, no network.

   What actually runs here:
     1. A seeded generator builds a synthetic fleet of AI-agent runs (traces)
        made of spans, and loads them into a columnar store: one typed array
        per column, dictionary-encoded strings.
     2. Every UI change re-runs a real scan over those typed arrays, touching
        only the columns the query mentions, and times it with performance.now().
     3. Aggregation (count / failure rate / p50 / p95 / spend) is computed from
        the selection vector, not precomputed.
     4. Rule-based evaluators score whole runs by walking their span ranges;
        the pass rate gets a nonparametric bootstrap confidence interval.
     5. Any run can be opened as a span waterfall laid out from the real
        start-offset and duration columns.
   ========================================================================== */

(function () {
  "use strict";

  /* --------------------------------------------------------------------- */
  /* 0. Small utilities                                                     */
  /* --------------------------------------------------------------------- */

  function $(id) {
    return document.getElementById(id);
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Standard normal via Box-Muller, used for log-normal latency jitter. */
  function makeNormal(rand) {
    return function () {
      var u = 1 - rand();
      var v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
  }

  function pickWeighted(rand, arr, weights) {
    var total = 0,
      i;
    for (i = 0; i < weights.length; i++) total += weights[i];
    var r = rand() * total;
    for (i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  function between(rand, lo, hi) {
    return lo + rand() * (hi - lo);
  }

  function fmtInt(n) {
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function fmtDur(ms) {
    if (!isFinite(ms)) return "\u2014";
    if (ms >= 10000) return (ms / 1000).toFixed(1) + " s";
    if (ms >= 1000) return (ms / 1000).toFixed(2) + " s";
    if (ms >= 100) return Math.round(ms) + " ms";
    if (ms >= 10) return ms.toFixed(1) + " ms";
    return ms.toFixed(2) + " ms";
  }

  function fmtUsd(v) {
    if (v >= 10) return "$" + v.toFixed(2);
    if (v >= 1) return "$" + v.toFixed(3);
    return "$" + v.toFixed(4);
  }

  function fmtBytes(b) {
    if (b >= 1048576) return (b / 1048576).toFixed(2) + " MB";
    if (b >= 1024) return (b / 1024).toFixed(0) + " KB";
    return b + " B";
  }

  function fmtPct(x) {
    return (x * 100).toFixed(1) + "%";
  }

  function clockOf(sec) {
    var t = 9 * 3600 + Math.round(sec);
    var h = Math.floor(t / 3600) % 24;
    var m = Math.floor(t / 60) % 60;
    var s = t % 60;
    return (
      (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" +
      (s < 10 ? "0" : "") + s
    );
  }

  function quantileSorted(sorted, q) {
    var n = sorted.length;
    if (n === 0) return NaN;
    if (n === 1) return sorted[0];
    var pos = (n - 1) * q;
    var lo = Math.floor(pos);
    var hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function numericSort(a, b) {
    return a - b;
  }

  /* --------------------------------------------------------------------- */
  /* 1. Schema and vocabulary                                               */
  /* --------------------------------------------------------------------- */

  var AGENTS = ["support-triage", "invoice-extract", "code-review", "web-research"];
  var MODELS = ["atlas-70b", "atlas-8b", "orion-mini"];
  var ENVS = ["prod", "staging"];
  var VERSIONS = ["v1.4.2", "v1.5.0", "v1.5.1"];
  var KINDS = ["agent", "llm", "tool", "retriever", "guardrail"];
  var STATUSES = ["ok", "error", "timeout"];
  var ERRORS = [
    "none",
    "tool_http_502",
    "json_schema_invalid",
    "rate_limited",
    "context_overflow",
    "upstream_timeout"
  ];

  var KIND_AGENT = 0,
    KIND_LLM = 1,
    KIND_TOOL = 2,
    KIND_RETRIEVER = 3;
  var ST_OK = 0,
    ST_ERROR = 1,
    ST_TIMEOUT = 2;

  /* Synthetic list prices, USD per million tokens, and synthetic decode
     speeds. These are invented for the demo, not any vendor's real numbers. */
  var MODEL_SPEC = {
    "atlas-70b": { pin: 3.0, pout: 15.0, ttft: 220, msPerTok: 11.0 },
    "atlas-8b": { pin: 0.3, pout: 1.2, ttft: 120, msPerTok: 4.2 },
    "orion-mini": { pin: 0.15, pout: 0.6, ttft: 90, msPerTok: 2.6 }
  };

  /* Column name -> bytes per value. This drives the "bytes read" model. */
  var COLUMNS = [
    { key: "traceIdx", label: "trace_id", bytes: 4 },
    { key: "depth", label: "depth", bytes: 1 },
    { key: "parent", label: "parent_span", bytes: 4 },
    { key: "kind", label: "kind", bytes: 1 },
    { key: "name", label: "name", bytes: 2 },
    { key: "agent", label: "agent", bytes: 1 },
    { key: "model", label: "model", bytes: 1 },
    { key: "env", label: "env", bytes: 1 },
    { key: "version", label: "version", bytes: 1 },
    { key: "status", label: "status", bytes: 1 },
    { key: "errType", label: "error_type", bytes: 1 },
    { key: "startMs", label: "start_offset_ms", bytes: 4 },
    { key: "durMs", label: "duration_ms", bytes: 4 },
    { key: "inTok", label: "input_tokens", bytes: 4 },
    { key: "outTok", label: "output_tokens", bytes: 4 },
    { key: "cost", label: "cost_usd", bytes: 4 }
  ];

  var COL_BY_KEY = {};
  var ROW_BYTES = 0;
  (function () {
    for (var i = 0; i < COLUMNS.length; i++) {
      COL_BY_KEY[COLUMNS[i].key] = COLUMNS[i];
      ROW_BYTES += COLUMNS[i].bytes;
    }
  })();

  var DICT_OF = {
    kind: KINDS,
    agent: AGENTS,
    model: MODELS,
    env: ENVS,
    version: VERSIONS,
    status: STATUSES,
    errType: ERRORS
  };

  /* Per-agent step templates. `p` = probability the step happens at all,
     `repeat` = up to this many sibling calls, `tok` = [input range, output
     range], `base` = duration range for non-model spans, `failP` = base
     failure probability before environment and version multipliers. */
  var TEMPLATES = {
    "support-triage": [
      { kind: "retriever", name: "kb.vector_search", p: 1, base: [18, 90] },
      { kind: "llm", name: "llm.classify_intent", p: 1, tok: [[380, 900], [18, 70]] },
      {
        kind: "tool",
        name: "crm.lookup_customer",
        p: 0.85,
        base: [40, 320],
        failP: 0.05,
        err: "tool_http_502"
      },
      { kind: "llm", name: "llm.draft_reply", p: 1, tok: [[700, 1700], [120, 420]] },
      { kind: "guardrail", name: "guardrail.pii_scan", p: 1, base: [6, 28] }
    ],
    "invoice-extract": [
      {
        kind: "tool",
        name: "pdf.parse",
        p: 1,
        base: [120, 900],
        failP: 0.06,
        err: "tool_http_502"
      },
      { kind: "retriever", name: "vendor.kb_lookup", p: 0.35, base: [15, 110] },
      { kind: "llm", name: "llm.extract_fields", p: 1, tok: [[1200, 3200], [160, 620]] },
      {
        kind: "tool",
        name: "schema.validate",
        p: 1,
        base: [3, 18],
        failP: 0.12,
        err: "json_schema_invalid"
      },
      { kind: "llm", name: "llm.repair_json", p: 0.25, tok: [[900, 2200], [120, 380]] },
      {
        kind: "tool",
        name: "ledger.write",
        p: 0.9,
        base: [30, 180],
        failP: 0.04,
        err: "tool_http_502"
      }
    ],
    "code-review": [
      {
        kind: "tool",
        name: "repo.diff",
        p: 1,
        base: [60, 400],
        failP: 0.03,
        err: "tool_http_502"
      },
      { kind: "retriever", name: "index.symbol_lookup", p: 0.5, base: [20, 180] },
      { kind: "llm", name: "llm.plan_review", p: 1, tok: [[800, 2400], [80, 260]] },
      {
        kind: "llm",
        name: "llm.review_hunk",
        p: 1,
        repeat: 3,
        tok: [[600, 1800], [90, 340]]
      },
      {
        kind: "tool",
        name: "lint.run",
        p: 0.8,
        base: [200, 1400],
        failP: 0.07,
        err: "tool_http_502"
      },
      { kind: "guardrail", name: "guardrail.secret_scan", p: 1, base: [8, 40] }
    ],
    "web-research": [
      { kind: "llm", name: "llm.plan_queries", p: 1, tok: [[300, 800], [40, 140]] },
      {
        kind: "tool",
        name: "web.search",
        p: 1,
        repeat: 3,
        parallel: true,
        base: [120, 700],
        failP: 0.08,
        err: "rate_limited"
      },
      { kind: "retriever", name: "index.rerank", p: 0.75, base: [20, 140] },
      {
        kind: "llm",
        name: "llm.synthesize_answer",
        p: 1,
        tok: [[2200, 5200], [260, 900]]
      },
      { kind: "guardrail", name: "guardrail.citation_check", p: 0.7, base: [10, 45] }
    ]
  };

  var TRACE_COUNT = 3200;
  var GROUND_TOKENS = 120; /* threshold used by the grounded_answer evaluator */

  /* --------------------------------------------------------------------- */
  /* 2. Dataset generation -> columnar store                                */
  /* --------------------------------------------------------------------- */

  function buildDataset(seed) {
    var rand = mulberry32(seed);
    var norm = makeNormal(rand);

    var nameDict = [];
    var nameIndex = Object.create(null);
    function nameId(s) {
      var i = nameIndex[s];
      if (i === undefined) {
        i = nameDict.length;
        nameDict.push(s);
        nameIndex[s] = i;
      }
      return i;
    }

    /* Row-wise staging arrays; copied into typed arrays at the end. */
    var traceIdx = [], depth = [], parent = [], kind = [], name = [],
      agentC = [], modelC = [], envC = [], verC = [], statusC = [],
      errC = [], startMs = [], durMs = [], inTok = [], outTok = [], cost = [];

    var traces = [];

    function pushSpan(t, d, par, k, nm, st, dur, status, err, tin, tout, usd) {
      traceIdx.push(t);
      depth.push(d);
      parent.push(par);
      kind.push(k);
      name.push(nameId(nm));
      agentC.push(0);
      modelC.push(0);
      envC.push(0);
      verC.push(0);
      statusC.push(status);
      errC.push(err);
      startMs.push(st);
      durMs.push(dur);
      inTok.push(tin);
      outTok.push(tout);
      cost.push(usd);
      return traceIdx.length - 1;
    }

    for (var ti = 0; ti < TRACE_COUNT; ti++) {
      var agent = pickWeighted(rand, AGENTS, [0.34, 0.24, 0.22, 0.2]);
      var model =
        agent === "invoice-extract"
          ? pickWeighted(rand, MODELS, [0.15, 0.6, 0.25])
          : agent === "web-research"
          ? pickWeighted(rand, MODELS, [0.5, 0.35, 0.15])
          : pickWeighted(rand, MODELS, [0.3, 0.45, 0.25]);
      var env = pickWeighted(rand, ENVS, [0.78, 0.22]);
      var version = pickWeighted(rand, VERSIONS, [0.2, 0.3, 0.5]);
      var spec = MODEL_SPEC[model];

      var failMul = (env === "staging" ? 2.2 : 1) * (version === "v1.4.2" ? 1.4 : 1);
      var steps = TEMPLATES[agent];
      var spanStart = traceIdx.length;
      var cursor = 0;
      var aborted = false;

      /* Root span: a container. It carries no tokens and no cost of its own,
         so aggregating the cost column never double-counts. */
      var rootIdx = pushSpan(ti, 0, -1, KIND_AGENT, "agent." + agent, 0, 0, ST_OK, 0, 0, 0, 0);

      for (var si = 0; si < steps.length && !aborted; si++) {
        var step = steps[si];
        if (rand() >= step.p) continue;

        var reps = step.repeat ? 1 + Math.floor(rand() * step.repeat) : 1;
        var batchStart = cursor;
        var batchEnd = cursor;

        for (var r = 0; r < reps && !aborted; r++) {
          var st = step.parallel ? batchStart : cursor;
          var dur, tin = 0, tout = 0, usd = 0;
          var status = ST_OK;
          var err = 0;

          if (step.kind === "llm") {
            tin = Math.round(between(rand, step.tok[0][0], step.tok[0][1]));
            tout = Math.round(between(rand, step.tok[1][0], step.tok[1][1]));
            usd = (tin * spec.pin + tout * spec.pout) / 1e6;
            dur = (spec.ttft + tout * spec.msPerTok) * Math.exp(norm() * 0.22);

            if (rand() < 0.012) {
              status = ST_TIMEOUT;
              err = ERRORS.indexOf("upstream_timeout");
              dur = between(rand, 15000, 30000);
              aborted = true;
            } else if (tin > 4600 && rand() < 0.05) {
              status = ST_ERROR;
              err = ERRORS.indexOf("context_overflow");
              dur = between(rand, 200, 900);
              tout = 0;
              usd = (tin * spec.pin) / 1e6;
              aborted = true;
            }
          } else {
            dur = between(rand, step.base[0], step.base[1]) * Math.exp(norm() * 0.3);
            if (step.failP && rand() < step.failP * failMul) {
              status = ST_ERROR;
              err = ERRORS.indexOf(step.err || "tool_http_502");
            }
          }

          if (dur < 0.5) dur = 0.5;

          var idx = pushSpan(
            ti, 1, rootIdx, KINDS.indexOf(step.kind), step.name,
            st, dur, status, err, tin, tout, usd
          );
          var end = st + dur;

          /* A failed tool call gets one retry as a nested child span. */
          if (status === ST_ERROR && step.kind === "tool") {
            if (rand() < 0.7) {
              var rGap = between(rand, 2, 24);
              var rDur = dur * between(rand, 0.4, 0.9) + 4;
              var rOk = rand() < 0.8;
              pushSpan(
                ti, 2, idx, KIND_TOOL, step.name + ".retry",
                end + rGap, rDur,
                rOk ? ST_OK : ST_ERROR, rOk ? 0 : err, 0, 0, 0
              );
              end = end + rGap + rDur;
              if (!rOk) aborted = true;
            } else {
              aborted = true;
            }
          }

          if (step.parallel) {
            if (end > batchEnd) batchEnd = end;
          } else {
            cursor = end + between(rand, 2, 20);
          }
        }

        if (step.parallel) cursor = batchEnd + between(rand, 2, 20);
      }

      /* Close the root span over everything it contains. */
      var spanCount = traceIdx.length - spanStart;
      var rootDur = cursor + between(rand, 5, 28);
      durMs[rootIdx] = rootDur;

      var traceCost = 0;
      var errCount = 0;
      var lastErr = 0;
      var lastStatus = ST_ERROR;
      var i;
      for (i = spanStart; i < spanStart + spanCount; i++) {
        traceCost += cost[i];
        if (statusC[i] !== ST_OK) {
          errCount++;
          lastErr = errC[i];
          lastStatus = statusC[i];
        }
      }
      if (aborted) {
        /* A run that never reached its final step is reported as failed on
           the root span, carrying the status and error type that stopped it. */
        statusC[rootIdx] = lastStatus;
        errC[rootIdx] = lastErr || ERRORS.indexOf("tool_http_502");
      }

      /* Denormalised run attributes onto every span: this is what makes a
         wide columnar layout worth having - filters never need a join. */
      var aId = AGENTS.indexOf(agent),
        mId = MODELS.indexOf(model),
        eId = ENVS.indexOf(env),
        vId = VERSIONS.indexOf(version);
      for (i = spanStart; i < spanStart + spanCount; i++) {
        agentC[i] = aId;
        modelC[i] = mId;
        envC[i] = eId;
        verC[i] = vId;
      }

      traces.push({
        id: ti,
        agent: aId,
        model: mId,
        env: eId,
        version: vId,
        start: spanStart,
        count: spanCount,
        dur: rootDur,
        cost: traceCost,
        errors: errCount,
        ts: rand() * 6 * 3600
      });
    }

    var rows = traceIdx.length;
    function fill(Ctor, src) {
      var out = new Ctor(rows);
      for (var i = 0; i < rows; i++) out[i] = src[i];
      return out;
    }

    var cols = {
      traceIdx: fill(Int32Array, traceIdx),
      depth: fill(Uint8Array, depth),
      parent: fill(Int32Array, parent),
      kind: fill(Uint8Array, kind),
      name: fill(Uint16Array, name),
      agent: fill(Uint8Array, agentC),
      model: fill(Uint8Array, modelC),
      env: fill(Uint8Array, envC),
      version: fill(Uint8Array, verC),
      status: fill(Uint8Array, statusC),
      errType: fill(Uint8Array, errC),
      startMs: fill(Float32Array, startMs),
      durMs: fill(Float32Array, durMs),
      inTok: fill(Int32Array, inTok),
      outTok: fill(Int32Array, outTok),
      cost: fill(Float32Array, cost)
    };

    /* Names that count as retrieval for the grounded_answer evaluator. */
    var searchNames = new Uint8Array(nameDict.length);
    for (var k = 0; k < nameDict.length; k++) {
      searchNames[k] = /search|retriev|rerank/.test(nameDict[k]) ? 1 : 0;
    }

    return {
      seed: seed,
      rows: rows,
      cols: cols,
      traces: traces,
      nameDict: nameDict,
      searchNames: searchNames,
      sel: new Int32Array(rows)
    };
  }

  function dictValues(key) {
    if (key === "name") return DS.nameDict;
    return DICT_OF[key];
  }

  /* --------------------------------------------------------------------- */
  /* 3. Query: scan the columns the predicate actually mentions             */
  /* --------------------------------------------------------------------- */

  function scanOnce(f, out) {
    var c = DS.cols,
      n = DS.rows,
      k = 0;
    var agent = c.agent, model = c.model, env = c.env,
      kind = c.kind, status = c.status, dur = c.durMs;
    var fa = f.agent, fm = f.model, fe = f.env, fk = f.kind, fs = f.status,
      fd = f.minDur;

    for (var i = 0; i < n; i++) {
      if (fa >= 0 && agent[i] !== fa) continue;
      if (fm >= 0 && model[i] !== fm) continue;
      if (fe >= 0 && env[i] !== fe) continue;
      if (fk >= 0 && kind[i] !== fk) continue;
      if (fs >= 0 && status[i] !== fs) continue;
      if (fd > 0 && dur[i] < fd) continue;
      out[k++] = i;
    }
    return k;
  }

  var SCAN_PASSES = 16;
  var SCAN_SAMPLES = 3;

  function runQuery(f) {
    var samples = [];
    var count = 0;
    for (var s = 0; s < SCAN_SAMPLES; s++) {
      var t0 = performance.now();
      for (var p = 0; p < SCAN_PASSES; p++) count = scanOnce(f, DS.sel);
      samples.push((performance.now() - t0) / SCAN_PASSES);
    }
    samples.sort(numericSort);
    return { count: count, ms: samples[Math.floor(samples.length / 2)] };
  }

  /* Which columns the current query has to read: predicates + projection. */
  function touchedColumns(f, groupKey) {
    var set = {};
    if (f.agent >= 0) set.agent = 1;
    if (f.model >= 0) set.model = 1;
    if (f.env >= 0) set.env = 1;
    if (f.kind >= 0) set.kind = 1;
    if (f.status >= 0) set.status = 1;
    if (f.minDur > 0) set.durMs = 1;
    /* Projection needed by the aggregates on this page. */
    set.durMs = 1;
    set.cost = 1;
    set.status = 1;
    set[groupKey] = 1;
    var keys = [];
    for (var i = 0; i < COLUMNS.length; i++) {
      if (set[COLUMNS[i].key]) keys.push(COLUMNS[i].key);
    }
    return keys;
  }

  /* --------------------------------------------------------------------- */
  /* 4. Aggregation over the selection vector                               */
  /* --------------------------------------------------------------------- */

  var HIST_EDGES = [25, 50, 100, 250, 500, 1000, 2500, Infinity];
  var HIST_LABELS = [
    "<25", "25\u201350", "50\u2013100", "100\u2013250", "250\u2013500", "500\u20131k", "1k\u20132.5k", "\u22652.5k"
  ];

  function aggregate(count, groupKey) {
    var c = DS.cols,
      sel = DS.sel;
    var codes = c[groupKey];
    var values = dictValues(groupKey);
    var groups = new Array(values.length);
    var hist = new Array(HIST_EDGES.length);
    var i, j;
    for (i = 0; i < hist.length; i++) hist[i] = 0;

    var all = new Float64Array(count);
    var totalCost = 0;
    var failed = 0;

    for (i = 0; i < count; i++) {
      var row = sel[i];
      var d = c.durMs[row];
      var code = codes[row];
      var g = groups[code];
      if (!g) {
        g = groups[code] = { code: code, n: 0, fail: 0, cost: 0, durs: [] };
      }
      g.n++;
      g.cost += c.cost[row];
      g.durs.push(d);
      if (c.status[row] !== ST_OK) {
        g.fail++;
        failed++;
      }
      totalCost += c.cost[row];
      all[i] = d;

      for (j = 0; j < HIST_EDGES.length; j++) {
        if (d < HIST_EDGES[j]) {
          hist[j]++;
          break;
        }
      }
    }

    var list = [];
    for (i = 0; i < groups.length; i++) {
      var gr = groups[i];
      if (!gr) continue;
      gr.durs.sort(numericSort);
      gr.p50 = quantileSorted(gr.durs, 0.5);
      gr.p95 = quantileSorted(gr.durs, 0.95);
      gr.label = values[gr.code];
      list.push(gr);
    }
    list.sort(function (a, b) {
      return b.n - a.n;
    });

    var sorted = Array.prototype.slice.call(all);
    sorted.sort(numericSort);

    return {
      groups: list,
      hist: hist,
      p50: quantileSorted(sorted, 0.5),
      p95: quantileSorted(sorted, 0.95),
      failed: failed,
      cost: totalCost
    };
  }

  /* --------------------------------------------------------------------- */
  /* 5. Evaluators - they score a whole run, by walking its span range      */
  /* --------------------------------------------------------------------- */

  var EVALUATORS = [
    {
      id: "latency",
      name: "latency_budget",
      toggle: "e-latency",
      describe: function (st) {
        return "Root span wall-clock is within " + fmtDur(st.latBudget) + ".";
      },
      test: function (t, st) {
        return t.dur <= st.latBudget;
      }
    },
    {
      id: "cost",
      name: "cost_ceiling",
      toggle: "e-cost",
      describe: function (st) {
        return "Total model spend for the run is at most " + fmtUsd(st.costCeil) + ".";
      },
      test: function (t, st) {
        return t.cost <= st.costCeil;
      }
    },
    {
      id: "steps",
      name: "no_failed_step",
      toggle: "e-steps",
      describe: function () {
        return "No span in the run ended in error or timeout, retries included.";
      },
      test: function (t) {
        return t.errors === 0;
      }
    },
    {
      id: "grounded",
      name: "grounded_answer",
      toggle: "e-grounded",
      describe: function () {
        return (
          "If the run's last model call emits more than " + GROUND_TOKENS +
          " output tokens, a retrieval or search span must precede it."
        );
      },
      test: function (t) {
        var c = DS.cols;
        var end = t.start + t.count;
        var lastLlm = -1;
        var i;
        for (i = t.start; i < end; i++) {
          if (c.kind[i] === KIND_LLM) lastLlm = i;
        }
        if (lastLlm < 0) return true;
        if (c.outTok[lastLlm] <= GROUND_TOKENS) return true;
        var t0 = c.startMs[lastLlm];
        for (i = t.start; i < end; i++) {
          if (c.startMs[i] >= t0) continue;
          if (c.kind[i] === KIND_RETRIEVER || DS.searchNames[c.name[i]] === 1) {
            return true;
          }
        }
        return false;
      }
    }
  ];

  function evaluateRuns(f, st) {
    var traces = DS.traces;
    var active = [];
    for (var e = 0; e < EVALUATORS.length; e++) {
      if (st.evals[EVALUATORS[e].id]) active.push(EVALUATORS[e]);
    }

    var rows = [];
    var perEval = {};
    for (var a = 0; a < EVALUATORS.length; a++) perEval[EVALUATORS[a].id] = 0;

    var flags = [];
    for (var i = 0; i < traces.length; i++) {
      var t = traces[i];
      if (f.agent >= 0 && t.agent !== f.agent) continue;
      if (f.model >= 0 && t.model !== f.model) continue;
      if (f.env >= 0 && t.env !== f.env) continue;

      var failedNames = [];
      var passAll = true;
      for (var k = 0; k < EVALUATORS.length; k++) {
        var ev = EVALUATORS[k];
        var ok = ev.test(t, st);
        if (ok) perEval[ev.id]++;
        if (st.evals[ev.id] && !ok) {
          passAll = false;
          failedNames.push(ev.name);
        }
      }
      rows.push({ trace: t, pass: passAll, failed: failedNames });
      flags.push(passAll ? 1 : 0);
    }

    return {
      rows: rows,
      n: rows.length,
      perEval: perEval,
      active: active,
      flags: flags
    };
  }

  /* Percentile bootstrap on the pass rate. Deterministic seed so the interval
     does not jitter while a slider is being dragged. */
  function bootstrapCI(flags) {
    var n = flags.length;
    if (n === 0) return null;
    var B = Math.max(200, Math.min(2000, Math.floor(8e5 / n)));
    var rand = mulberry32(0xc0ffee);
    var means = new Float64Array(B);
    for (var b = 0; b < B; b++) {
      var s = 0;
      for (var i = 0; i < n; i++) s += flags[(rand() * n) | 0];
      means[b] = s / n;
    }
    var arr = Array.prototype.slice.call(means);
    arr.sort(numericSort);
    return {
      B: B,
      lo: quantileSorted(arr, 0.025),
      hi: quantileSorted(arr, 0.975)
    };
  }

  /* --------------------------------------------------------------------- */
  /* 6. State                                                              */
  /* --------------------------------------------------------------------- */

  var DS = null;
  var state = {
    latBudget: 6000,
    costCeil: 0.015,
    evals: { latency: true, cost: true, steps: true, grounded: true },
    groupKey: "name",
    sortKey: "fail",
    selectedTrace: -1
  };

  var els = {};
  var ID_LIST = [
    "scan-status", "m-matched", "m-scan", "m-thru", "m-cols", "m-bytes",
    "scan-note", "scan-cols", "m-p50", "m-p95", "m-err", "m-cost", "hist",
    "g-dim", "g-body", "g-empty", "g-wrap", "ev-n", "ev-rate", "ev-ci",
    "ev-list", "ev-boot", "r-sort", "r-body", "r-empty", "r-wrap",
    "wf-title", "wf-meta", "wf-rows", "wf-verdict", "wf-foot",
    "f-agent", "f-model", "f-env", "f-kind", "f-status", "f-mindur",
    "f-mindur-out", "t-latency", "t-latency-out", "t-cost", "t-cost-out",
    "e-latency", "e-cost", "e-steps", "e-grounded",
    "btn-reset", "btn-regen", "ds-info"
  ];

  function cacheEls() {
    for (var i = 0; i < ID_LIST.length; i++) els[ID_LIST[i]] = $(ID_LIST[i]);
  }

  function readFilters() {
    return {
      agent: parseInt(els["f-agent"].value, 10),
      model: parseInt(els["f-model"].value, 10),
      env: parseInt(els["f-env"].value, 10),
      kind: parseInt(els["f-kind"].value, 10),
      status: parseInt(els["f-status"].value, 10),
      minDur: parseFloat(els["f-mindur"].value)
    };
  }

  function fillSelect(el, values, allLabel) {
    var html = '<option value="-1">' + allLabel + "</option>";
    for (var i = 0; i < values.length; i++) {
      html += '<option value="' + i + '">' + values[i] + "</option>";
    }
    el.innerHTML = html;
  }

  /* --------------------------------------------------------------------- */
  /* 7. Rendering                                                          */
  /* --------------------------------------------------------------------- */

  var SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) {
        n.setAttribute(k, attrs[k]);
      }
    }
    return n;
  }

  function renderHistogram(hist, total) {
    var host = els["hist"];
    host.textContent = "";

    if (!total) {
      var empty = document.createElement("p");
      empty.className = "chart-empty";
      empty.textContent =
        "No spans match the current filters, so there is no distribution to draw.";
      host.appendChild(empty);
      return;
    }

    var W = 720, H = 260, padTop = 30, padBottom = 56, padX = 8;
    var plotH = H - padTop - padBottom;
    var n = hist.length;
    var slot = (W - padX * 2) / n;
    var barW = Math.min(64, slot * 0.62);

    var max = 0, i;
    for (i = 0; i < n; i++) if (hist[i] > max) max = hist[i];
    if (max === 0) max = 1;

    var summary = [];
    for (i = 0; i < n; i++) summary.push(HIST_LABELS[i] + " ms: " + hist[i]);

    var svg = svgEl("svg", {
      viewBox: "0 0 " + W + " " + H,
      role: "img",
      "aria-label":
        "Histogram of matched span durations. " + summary.join("; ") + "."
    });

    svg.appendChild(
      svgEl("line", {
        x1: padX, y1: padTop + plotH, x2: W - padX, y2: padTop + plotH,
        class: "hist-axis"
      })
    );

    for (i = 0; i < n; i++) {
      var cx = padX + slot * i + slot / 2;
      var h = hist[i] === 0 ? 0 : Math.max(3, (hist[i] / max) * plotH);
      if (h > 0) {
        svg.appendChild(
          svgEl("rect", {
            x: cx - barW / 2, y: padTop + plotH - h, width: barW, height: h,
            rx: 3, class: "hist-bar"
          })
        );
      }
      var count = svgEl("text", {
        x: cx, y: padTop + plotH - h - 8, "text-anchor": "middle",
        class: "hist-count"
      });
      count.textContent = hist[i] === 0 ? "0" : fmtInt(hist[i]);
      svg.appendChild(count);

      var lab = svgEl("text", {
        x: cx, y: padTop + plotH + 22, "text-anchor": "middle",
        class: "hist-label"
      });
      lab.textContent = HIST_LABELS[i];
      svg.appendChild(lab);
    }

    var cap = svgEl("text", {
      x: W / 2, y: H - 12, "text-anchor": "middle", class: "hist-label"
    });
    cap.textContent = "span duration (ms) \u2014 " + fmtInt(total) + " spans";
    svg.appendChild(cap);

    host.appendChild(svg);
  }

  function renderGroups(agg, count) {
    var body = els["g-body"];
    body.textContent = "";
    var isEmpty = count === 0;
    els["g-empty"].hidden = !isEmpty;
    els["g-wrap"].hidden = isEmpty;
    if (isEmpty) return;

    var list = agg.groups.slice(0, 12);
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      var tr = document.createElement("tr");
      tr.appendChild(cell(g.label, "mono"));
      tr.appendChild(cell(fmtInt(g.n), "num"));
      tr.appendChild(cell(g.n ? fmtPct(g.fail / g.n) : "\u2014", "num"));
      tr.appendChild(cell(fmtDur(g.p50), "num"));
      tr.appendChild(cell(fmtDur(g.p95), "num"));
      tr.appendChild(cell(g.cost > 0 ? fmtUsd(g.cost) : "\u2014", "num"));
      body.appendChild(tr);
    }
  }

  function cell(text, cls) {
    var td = document.createElement("td");
    if (cls) td.className = cls;
    td.textContent = text;
    return td;
  }

  function renderEvals(res, ci) {
    els["ev-n"].textContent = fmtInt(res.n);

    var passed = 0;
    for (var i = 0; i < res.flags.length; i++) passed += res.flags[i];
    var rate = res.n ? passed / res.n : NaN;

    if (!res.n) {
      els["ev-rate"].textContent = "\u2014";
      els["ev-ci"].textContent = "\u2014";
      els["ev-boot"].textContent =
        "No runs in this slice, so there is nothing to score.";
    } else if (!res.active.length) {
      els["ev-rate"].textContent = "\u2014";
      els["ev-ci"].textContent = "\u2014";
      els["ev-boot"].textContent =
        "Every evaluator is switched off. Turn at least one on to score the runs.";
    } else {
      els["ev-rate"].textContent = fmtPct(rate);
      els["ev-ci"].textContent = ci
        ? "[" + fmtPct(ci.lo) + ", " + fmtPct(ci.hi) + "]"
        : "\u2014";
      els["ev-boot"].textContent = ci
        ? "Interval from a nonparametric bootstrap: " + fmtInt(ci.B) +
          " resamples of the " + fmtInt(res.n) +
          " runs above, percentile method, recomputed in your browser on every change."
        : "\u2014";
    }

    var host = els["ev-list"];
    host.textContent = "";
    for (var e = 0; e < EVALUATORS.length; e++) {
      var ev = EVALUATORS[e];
      var on = !!state.evals[ev.id];
      var pass = res.perEval[ev.id];
      var pct = res.n ? pass / res.n : 0;

      var li = document.createElement("li");
      li.className = "eval-item";
      li.setAttribute("data-off", on ? "false" : "true");

      var top = document.createElement("div");
      top.className = "eval-top";
      var nm = document.createElement("span");
      nm.className = "eval-name";
      nm.textContent = ev.name + (on ? "" : " (off)");
      var sc = document.createElement("span");
      sc.className = "eval-score";
      sc.textContent = res.n
        ? fmtInt(pass) + " / " + fmtInt(res.n) + " pass \u00b7 " + fmtPct(pct)
        : "no runs";
      top.appendChild(nm);
      top.appendChild(sc);

      var bar = document.createElement("div");
      bar.className = "bar";
      var fill = document.createElement("span");
      fill.style.width = (res.n ? pct * 100 : 0).toFixed(1) + "%";
      bar.appendChild(fill);

      var desc = document.createElement("p");
      desc.className = "eval-desc";
      desc.textContent = ev.describe(state);

      li.appendChild(top);
      li.appendChild(bar);
      li.appendChild(desc);
      host.appendChild(li);
    }
  }

  var pendingFocus = null;

  function sortRuns(rows, key) {
    var copy = rows.slice();
    copy.sort(function (a, b) {
      switch (key) {
        case "slow":
          return b.trace.dur - a.trace.dur;
        case "cost":
          return b.trace.cost - a.trace.cost;
        case "spans":
          return b.trace.count - a.trace.count;
        case "recent":
          return b.trace.ts - a.trace.ts;
        default:
          if (a.pass !== b.pass) return a.pass ? 1 : -1;
          return b.trace.dur - a.trace.dur;
      }
    });
    return copy;
  }

  function renderRuns(res) {
    var rows = sortRuns(res.rows, state.sortKey).slice(0, 8);
    var body = els["r-body"];
    body.textContent = "";
    var isEmpty = rows.length === 0;
    els["r-empty"].hidden = !isEmpty;
    els["r-wrap"].hidden = isEmpty;

    if (isEmpty) {
      state.selectedTrace = -1;
      pendingFocus = null;
      renderWaterfall(null);
      return;
    }

    var stillThere = false;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].trace.id === state.selectedTrace) stillThere = true;
    }
    if (!stillThere) state.selectedTrace = rows[0].trace.id;

    var chosen = rows[0];
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      var t = row.trace;
      if (t.id === state.selectedTrace) chosen = row;

      var tr = document.createElement("tr");
      if (t.id === state.selectedTrace) tr.setAttribute("data-selected", "true");

      tr.appendChild(cell(runId(t), "run-id"));
      tr.appendChild(cell(AGENTS[t.agent]));
      tr.appendChild(cell(MODELS[t.model]));
      tr.appendChild(cell(fmtDur(t.dur), "num"));
      tr.appendChild(cell(fmtUsd(t.cost), "num"));
      tr.appendChild(cell(String(t.count), "num"));

      var vtd = document.createElement("td");
      var vspan = document.createElement("span");
      vspan.className = row.pass ? "verdict-pass" : "verdict-fail";
      vspan.textContent = row.pass
        ? "pass"
        : row.failed.slice(0, 2).join(", ") +
          (row.failed.length > 2 ? " +" + (row.failed.length - 2) : "");
      vtd.appendChild(vspan);
      tr.appendChild(vtd);

      var btd = document.createElement("td");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      var isShown = t.id === state.selectedTrace;
      btn.textContent = isShown ? "Showing" : "Waterfall";
      btn.setAttribute(
        "aria-label",
        (isShown ? "Now showing the span waterfall for run " : "Show the span waterfall for run ") +
          runId(t)
      );
      btn.setAttribute("data-trace", String(t.id));
      btd.appendChild(btn);
      tr.appendChild(btd);

      body.appendChild(tr);
    }

    /* The table is rebuilt on every change, which would drop keyboard focus
       on the button that was just activated. Put it back. */
    if (pendingFocus !== null) {
      var again = body.querySelector('button[data-trace="' + pendingFocus + '"]');
      pendingFocus = null;
      if (again) again.focus();
    }

    renderWaterfall(chosen);
  }

  function runId(t) {
    /* Read the id back out of the trace_id column rather than the JS object,
       so the label always agrees with what the store holds. */
    var id = DS.cols.traceIdx[t.start];
    var hex = ((id * 2654435761) % 16777216).toString(16);
    while (hex.length < 6) hex = "0" + hex;
    return "run_" + hex;
  }

  function renderWaterfall(row) {
    var host = els["wf-rows"];
    host.textContent = "";

    if (!row) {
      els["wf-title"].textContent = "Span waterfall";
      els["wf-verdict"].textContent = "\u2014";
      els["wf-meta"].textContent =
        "Pick a run above to lay its spans out on a shared time axis.";
      els["wf-foot"].hidden = true;
      return;
    }
    els["wf-foot"].hidden = false;

    var t = row.trace;
    var c = DS.cols;
    var total = t.dur > 0 ? t.dur : 1;

    els["wf-title"].textContent = "Span waterfall \u2014 " + runId(t);
    els["wf-verdict"].textContent = row.pass
      ? "all enabled evaluators pass"
      : "fails: " + row.failed.join(", ");
    els["wf-meta"].textContent =
      AGENTS[t.agent] + " \u00b7 " + MODELS[t.model] + " \u00b7 " + ENVS[t.env] +
      " \u00b7 " + VERSIONS[t.version] + " \u00b7 started " + clockOf(t.ts) +
      " (synthetic clock) \u00b7 " + t.count + " spans \u00b7 " + fmtDur(t.dur) +
      " wall-clock \u00b7 " + fmtUsd(t.cost) + " spend";

    var end = t.start + t.count;
    for (var i = t.start; i < end; i++) {
      var depth = c.depth[i];
      var status = c.status[i];
      var isRoot = depth === 0;

      var li = document.createElement("li");
      li.className = "wf-row wf-depth-" + depth;
      li.setAttribute(
        "data-status",
        isRoot ? "root" : status === ST_OK ? "ok" : "failed"
      );

      var label = document.createElement("div");
      label.className = "wf-label";
      var kindEl = document.createElement("span");
      kindEl.className = "wf-kind";
      kindEl.textContent = KINDS[c.kind[i]];
      var nameEl = document.createElement("span");
      nameEl.className = "wf-name";
      nameEl.textContent = DS.nameDict[c.name[i]];
      label.appendChild(kindEl);
      label.appendChild(nameEl);

      if (status !== ST_OK) {
        var flag = document.createElement("span");
        flag.className = "wf-flag";
        flag.textContent = STATUSES[status] + " \u00b7 " + ERRORS[c.errType[i]];
        label.appendChild(flag);
      }
      if (depth === 2) {
        var par = document.createElement("span");
        par.className = "wf-flag";
        par.style.color = "var(--text-faint)";
        par.textContent = "retry of " + DS.nameDict[c.name[c.parent[i]]];
        label.appendChild(par);
      }
      if (c.kind[i] === KIND_LLM && c.outTok[i] > 0) {
        var tok = document.createElement("span");
        tok.className = "wf-flag";
        tok.style.color = "var(--text-faint)";
        tok.textContent = c.inTok[i] + " in / " + c.outTok[i] + " out";
        label.appendChild(tok);
      }

      var track = document.createElement("div");
      track.className = "wf-track";
      var bar = document.createElement("span");
      bar.className = "wf-bar";
      var left = Math.max(0, Math.min(99, (c.startMs[i] / total) * 100));
      var width = Math.max(0.8, Math.min(100 - left, (c.durMs[i] / total) * 100));
      bar.style.left = left.toFixed(2) + "%";
      bar.style.width = width.toFixed(2) + "%";
      track.appendChild(bar);

      var dur = document.createElement("div");
      dur.className = "wf-dur";
      dur.textContent = fmtDur(c.durMs[i]);

      li.appendChild(label);
      li.appendChild(track);
      li.appendChild(dur);
      host.appendChild(li);
    }
  }

  function renderScan(f, q, agg) {
    els["m-matched"].textContent =
      fmtInt(q.count) + " / " + fmtInt(DS.rows);
    els["m-scan"].textContent = q.ms >= 1 ? q.ms.toFixed(2) + " ms" : (q.ms * 1000).toFixed(0) + " \u00b5s";
    var perSec = q.ms > 0 ? DS.rows / (q.ms / 1000) : 0;
    els["m-thru"].textContent = perSec
      ? (perSec / 1e6).toFixed(1) + "M rows/s"
      : "\u2014";

    var keys = touchedColumns(f, state.groupKey);
    var bytes = 0,
      labels = [];
    for (var i = 0; i < keys.length; i++) {
      bytes += COL_BY_KEY[keys[i]].bytes * DS.rows;
      labels.push(COL_BY_KEY[keys[i]].label);
    }
    var rowBytes = ROW_BYTES * DS.rows;

    els["m-cols"].textContent = keys.length + " / " + COLUMNS.length;
    els["m-bytes"].textContent = fmtBytes(bytes);
    els["scan-cols"].textContent =
      "Columns touched: " + labels.join(", ") +
      ". Scan time is the median of " + SCAN_SAMPLES + " samples of " +
      SCAN_PASSES + " warm passes over the whole store, single-threaded, in " +
      "this tab.";
    els["scan-note"].textContent =
      "This query read " + fmtBytes(bytes) + " \u2014 only the " + keys.length +
      " columns it mentions, across all " + fmtInt(DS.rows) +
      " spans. A row-oriented layout has to pull whole rows, so the same scan " +
      "would move " + fmtBytes(rowBytes) + " (" + (rowBytes / bytes).toFixed(1) +
      "\u00d7 more). The byte figures are arithmetic from the column widths, not a " +
      "benchmark of a real row store; the scan time beside them is measured.";

    els["m-p50"].textContent = q.count ? fmtDur(agg.p50) : "\u2014";
    els["m-p95"].textContent = q.count ? fmtDur(agg.p95) : "\u2014";
    els["m-err"].textContent = q.count
      ? fmtInt(agg.failed) + " (" + fmtPct(agg.failed / q.count) + ")"
      : "\u2014";
    els["m-cost"].textContent = q.count ? fmtUsd(agg.cost) : "\u2014";

    els["scan-status"].setAttribute("data-state", q.count ? "running" : "warn");
    els["scan-status"].textContent = q.count
      ? fmtInt(q.count) + " spans matched in " +
        (q.ms >= 1 ? q.ms.toFixed(2) + " ms" : (q.ms * 1000).toFixed(0) + " \u00b5s")
      : "no spans matched";
  }

  /* --------------------------------------------------------------------- */
  /* 8. Update cycle                                                       */
  /* --------------------------------------------------------------------- */

  function update() {
    var f = readFilters();
    var q = runQuery(f);
    var agg = aggregate(q.count, state.groupKey);

    renderScan(f, q, agg);
    renderHistogram(agg.hist, q.count);
    renderGroups(agg, q.count);

    var res = evaluateRuns(f, state);
    var ci = res.active.length ? bootstrapCI(res.flags) : null;
    renderEvals(res, ci);
    renderRuns(res);
  }

  /* Coalesce bursts of input (dragging a slider) into one recompute per
     frame. Falls back to a timer when frames are throttled, e.g. in a
     background tab, so a queued update can never be stranded. */
  var frameQueued = false;
  function schedule() {
    if (frameQueued) return;
    frameQueued = true;
    var run = function () {
      frameQueued = false;
      update();
    };
    if (typeof requestAnimationFrame === "function" && !document.hidden) {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 16);
    }
  }

  function syncReadouts() {
    els["f-mindur-out"].textContent = fmtInt(els["f-mindur"].value) + " ms";
    state.latBudget = parseFloat(els["t-latency"].value);
    state.costCeil = parseFloat(els["t-cost"].value) / 1000;
    els["t-latency-out"].textContent = (state.latBudget / 1000).toFixed(1) + " s";
    els["t-cost-out"].textContent = "$" + state.costCeil.toFixed(3);
    for (var i = 0; i < EVALUATORS.length; i++) {
      var ev = EVALUATORS[i];
      state.evals[ev.id] = els[ev.toggle].checked;
    }
  }

  function describeDataset() {
    els["ds-info"].textContent =
      fmtInt(DS.traces.length) + " synthetic runs \u00b7 " + fmtInt(DS.rows) +
      " spans \u00b7 " + COLUMNS.length + " columns \u00b7 seed " + DS.seed +
      ". Every load builds the same fleet; \u201cNew sample\u201d draws a fresh one.";
  }

  /* --------------------------------------------------------------------- */
  /* 9. Wiring                                                             */
  /* --------------------------------------------------------------------- */

  function init() {
    cacheEls();

    DS = buildDataset(20260813);

    fillSelect(els["f-agent"], AGENTS, "all agents");
    fillSelect(els["f-model"], MODELS, "all models");
    fillSelect(els["f-env"], ENVS, "all environments");
    fillSelect(els["f-kind"], KINDS, "all span kinds");
    fillSelect(els["f-status"], STATUSES, "any status");

    var filterIds = ["f-agent", "f-model", "f-env", "f-kind", "f-status", "f-mindur"];
    for (var i = 0; i < filterIds.length; i++) {
      els[filterIds[i]].addEventListener("input", function () {
        syncReadouts();
        schedule();
      });
    }

    var evalIds = ["t-latency", "t-cost", "e-latency", "e-cost", "e-steps", "e-grounded"];
    for (i = 0; i < evalIds.length; i++) {
      els[evalIds[i]].addEventListener("input", function () {
        syncReadouts();
        schedule();
      });
    }

    els["g-dim"].addEventListener("input", function () {
      state.groupKey = els["g-dim"].value;
      schedule();
    });

    els["r-sort"].addEventListener("input", function () {
      state.sortKey = els["r-sort"].value;
      schedule();
    });

    els["r-body"].addEventListener("click", function (evt) {
      var btn = evt.target.closest ? evt.target.closest("button[data-trace]") : null;
      if (!btn) return;
      state.selectedTrace = parseInt(btn.getAttribute("data-trace"), 10);
      pendingFocus = state.selectedTrace;
      schedule();
    });

    els["btn-reset"].addEventListener("click", function () {
      els["f-agent"].value = "-1";
      els["f-model"].value = "-1";
      els["f-env"].value = "-1";
      els["f-kind"].value = "-1";
      els["f-status"].value = "-1";
      els["f-mindur"].value = "0";
      els["t-latency"].value = "6000";
      els["t-cost"].value = "15";
      els["e-latency"].checked = true;
      els["e-cost"].checked = true;
      els["e-steps"].checked = true;
      els["e-grounded"].checked = true;
      els["g-dim"].value = "name";
      els["r-sort"].value = "fail";
      state.groupKey = "name";
      state.sortKey = "fail";
      state.selectedTrace = -1;
      syncReadouts();
      schedule();
    });

    els["btn-regen"].addEventListener("click", function () {
      var seed = (DS.seed * 1103515245 + 12345) >>> 0;
      DS = buildDataset(seed);
      state.selectedTrace = -1;
      describeDataset();
      schedule();
    });

    syncReadouts();
    describeDataset();
    update();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
