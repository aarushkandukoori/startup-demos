/* ==========================================================================
   Symmetric Hash Join Playground
   Two unbounded synthetic streams -> one symmetric hash join -> live state
   pruning derived from the join predicate and per-side watermarks.

   No dependencies, no network, no build step. The simulation core (dataset,
   ground truth, Engine) is pure and DOM-free; the UI layer below only runs
   when a document exists.
   ========================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 1. Small utilities
   * ------------------------------------------------------------------ */

  var BASE_CLOCK = 9 * 3600; /* event-time origin, 09:00:00 */
  var LOG_KEEP = 60;
  var OUT_KEEP = 40;

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function expRand(rnd, mean) {
    return -Math.log(1 - rnd()) * mean;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function fmtClock(sec) {
    if (sec === null || sec === undefined || !isFinite(sec)) return "--:--:--";
    var t = Math.round(BASE_CLOCK + sec);
    if (t < 0) t = 0;
    var h = Math.floor(t / 3600) % 24;
    var m = Math.floor(t / 60) % 60;
    var s = t % 60;
    return pad2(h) + ":" + pad2(m) + ":" + pad2(s);
  }

  function fmtSec(x) {
    if (!isFinite(x)) return "--";
    return (Math.round(x * 10) / 10).toFixed(1) + "s";
  }

  /* Smallest 1/2/5/10 x 10^k step that is at least x, so axis labels stay
     round whatever the peak turns out to be. */
  function niceStep(x) {
    if (!(x > 0)) return 1;
    var pow = Math.pow(10, Math.floor(Math.log(x) / Math.LN10));
    var candidates = [1, 2, 5, 10];
    for (var i = 0; i < candidates.length; i++) {
      var v = candidates[i] * pow;
      if (v >= x) return v;
    }
    return 10 * pow;
  }

  /* ------------------------------------------------------------------ *
   * 2. Synthetic dataset
   *
   * Two streams that a fulfilment team would actually have:
   *   orders(order_id, region, units, ts)
   *   shipments(order_id, carrier, ts)   -- ts is later than the order's
   *
   * Event time is seconds from the 09:00:00 origin. Arrival (ingest) order
   * is event time plus a uniform jitter, so the streams are out of order by
   * a bounded amount -- exactly the condition watermarks exist for.
   * ------------------------------------------------------------------ */

  var REGIONS = ["us-east-1", "us-west-2", "eu-central-1", "ap-south-1"];
  var CARRIERS = [
    "Northbound Freight",
    "Cascade Courier",
    "Harbor Logistics",
    "Trailhead Express",
    "Kestrel Air Cargo"
  ];
  var ORDER_COUNT = 240;

  function buildDataset(seed, disorderSec) {
    var rnd = mulberry32(seed >>> 0);
    var orders = [];
    var shipments = [];
    var t = 0;
    var i;

    for (i = 0; i < ORDER_COUNT; i++) {
      t += 0.4 + expRand(rnd, 1.1);
      var order = {
        side: "L",
        stream: "orders",
        key: "ORD-" + (10247 + i),
        ts: t,
        region: REGIONS[(rnd() * REGIONS.length) | 0],
        units: 1 + ((rnd() * 9) | 0),
        ship: null
      };
      orders.push(order);

      /* 62% ship quickly, 20% ship late enough to fall outside a normal
         join window, 18% never ship at all. */
      var roll = rnd();
      var delay = -1;
      if (roll < 0.62) delay = 2.5 + expRand(rnd, 11);
      else if (roll < 0.82) delay = 46 + expRand(rnd, 55);

      if (delay > 0) {
        var ship = {
          side: "R",
          stream: "shipments",
          key: order.key,
          ts: order.ts + delay,
          carrier: CARRIERS[(rnd() * CARRIERS.length) | 0],
          order: order
        };
        order.ship = ship;
        shipments.push(ship);
      }
    }

    var events = orders.concat(shipments);
    for (i = 0; i < events.length; i++) {
      events[i].arrival = events[i].ts + rnd() * disorderSec;
    }
    events.sort(function (a, b) {
      if (a.arrival !== b.arrival) return a.arrival - b.arrival;
      if (a.ts !== b.ts) return a.ts - b.ts;
      return a.side < b.side ? -1 : 1;
    });
    for (i = 0; i < events.length; i++) events[i].idx = i;

    return { events: events, orders: orders, shipments: shipments };
  }

  /* Batch oracle: every (order, shipment) pair the query should produce,
     computed by a plain scan over the same data with no streaming involved.
     `completedAt[i]` counts the pairs whose *second* event arrives at ingest
     index i, so the UI can compare like with like at any point in the run. */
  function buildGroundTruth(ds, windowSec) {
    var completedAt = new Array(ds.events.length);
    for (var i = 0; i < completedAt.length; i++) completedAt[i] = 0;
    var total = 0;
    for (var j = 0; j < ds.orders.length; j++) {
      var o = ds.orders[j];
      var s = o.ship;
      if (!s) continue;
      var lag = s.ts - o.ts;
      if (lag >= 0 && lag <= windowSec) {
        total++;
        completedAt[Math.max(o.idx, s.idx)]++;
      }
    }
    return { total: total, completedAt: completedAt };
  }

  /* ------------------------------------------------------------------ *
   * 3. The engine: a symmetric hash join over two unbounded inputs
   *
   * Every arriving row probes the opposite side's hash table, emits the
   * pairs that satisfy the filter, then is inserted into its own table.
   * Without eviction both tables grow forever. The three strategies differ
   * only in which rows they are willing to drop:
   *
   *   none       keep everything (the correctness baseline)
   *   retention  drop rows older than max(ts on that side) - retention
   *   interval   solve the filter for each side against the other side's
   *              watermark:
   *                predicate:  s.ts >= o.ts AND s.ts <= o.ts + W
   *                future right rows have  s.ts >= wm(shipments)
   *                  => an order row can still match only if
   *                     o.ts + W >= wm(shipments)      -> keep o.ts >= wmR - W
   *                future left rows have   o.ts >= wm(orders)
   *                  => a shipment row can still match only if
   *                     s.ts >= wm(orders)             -> keep s.ts >= wmL
   * ------------------------------------------------------------------ */

  function Engine(opts) {
    this.strategy = opts.strategy;
    this.windowSec = opts.windowSec;
    this.lateness = opts.lateness;
    this.retention = opts.retention;

    this.left = new Map(); /* order_id -> [order rows]    */
    this.right = new Map(); /* order_id -> [shipment rows] */
    this.leftCount = 0;
    this.rightCount = 0;

    this.maxL = -Infinity;
    this.maxR = -Infinity;
    this.wmL = -Infinity;
    this.wmR = -Infinity;

    this.emitted = 0;
    this.evicted = 0;
    this.lateArrivals = 0;
    this.peak = 0;
    this.output = [];
  }

  Engine.prototype.size = function () {
    return this.leftCount + this.rightCount;
  };

  Engine.prototype.bounds = function () {
    if (this.strategy === "interval") {
      return { left: this.wmR - this.windowSec, right: this.wmL };
    }
    if (this.strategy === "retention") {
      return { left: this.maxL - this.retention, right: this.maxR - this.retention };
    }
    return { left: -Infinity, right: -Infinity };
  };

  Engine.prototype.rows = function (side) {
    var out = [];
    var m = side === "L" ? this.left : this.right;
    m.forEach(function (arr) {
      for (var i = 0; i < arr.length; i++) out.push(arr[i]);
    });
    out.sort(function (a, b) {
      return a.ts - b.ts;
    });
    return out;
  };

  Engine.prototype._evict = function (map, bound, isLeft) {
    if (!isFinite(bound)) return 0;
    var self = this;
    var dropped = 0;
    var empties = [];
    map.forEach(function (arr, key) {
      var kept = null;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].ts < bound) {
          dropped++;
        } else {
          if (kept === null) kept = [];
          kept.push(arr[i]);
        }
      }
      if (kept === null) empties.push(key);
      else if (kept.length !== arr.length) map.set(key, kept);
    });
    for (var e = 0; e < empties.length; e++) map.delete(empties[e]);
    if (dropped) {
      if (isLeft) self.leftCount -= dropped;
      else self.rightCount -= dropped;
      self.evicted += dropped;
    }
    return dropped;
  };

  Engine.prototype.prune = function () {
    if (this.strategy === "none") return { left: 0, right: 0 };
    var b = this.bounds();
    return {
      left: this._evict(this.left, b.left, true),
      right: this._evict(this.right, b.right, false)
    };
  };

  Engine.prototype.process = function (ev) {
    var isLeft = ev.side === "L";
    var wmBefore = isLeft ? this.wmL : this.wmR;
    var late = ev.ts < wmBefore;
    if (late) this.lateArrivals++;

    /* Watermark: bounded-out-of-orderness, monotonically non-decreasing. */
    if (isLeft) {
      if (ev.ts > this.maxL) this.maxL = ev.ts;
      var candL = this.maxL - this.lateness;
      if (candL > this.wmL) this.wmL = candL;
    } else {
      if (ev.ts > this.maxR) this.maxR = ev.ts;
      var candR = this.maxR - this.lateness;
      if (candR > this.wmR) this.wmR = candR;
    }

    /* Probe the opposite hash table. */
    var other = isLeft ? this.right : this.left;
    var bucket = other.get(ev.key);
    var matched = 0;
    var lastLag = null;
    if (bucket) {
      for (var i = 0; i < bucket.length; i++) {
        var o = isLeft ? ev : bucket[i];
        var s = isLeft ? bucket[i] : ev;
        var lag = s.ts - o.ts;
        if (lag >= 0 && lag <= this.windowSec) {
          matched++;
          lastLag = lag;
          this.emitted++;
          this.output.unshift({
            at: Math.max(o.ts, s.ts),
            key: o.key,
            region: o.region,
            units: o.units,
            carrier: s.carrier,
            lag: lag
          });
          if (this.output.length > OUT_KEEP) this.output.pop();
        }
      }
    }

    /* Insert into its own table. */
    var own = isLeft ? this.left : this.right;
    var ownBucket = own.get(ev.key);
    if (ownBucket) ownBucket.push(ev);
    else own.set(ev.key, [ev]);
    if (isLeft) this.leftCount++;
    else this.rightCount++;

    var pruned = this.prune();
    var sz = this.size();
    if (sz > this.peak) this.peak = sz;

    return {
      ev: ev,
      late: late,
      matched: matched,
      lag: lastLag,
      prunedLeft: pruned.left,
      prunedRight: pruned.right
    };
  };

  /* ------------------------------------------------------------------ *
   * 4. UI
   * ------------------------------------------------------------------ */

  function initUI() {
    var $ = function (id) {
      return document.getElementById(id);
    };

    var el = {
      sql: $("sql"),
      wmL: $("wm-left"),
      wmR: $("wm-right"),
      boundL: $("bound-left"),
      boundR: $("bound-right"),
      strategyName: $("strategy-name"),
      clock: $("clock"),
      progress: $("progress"),
      status: $("run-status"),
      summary: $("summary"),
      chart: $("chart"),
      chartNote: $("chart-note"),
      legendA: $("legend-a"),
      leftCount: $("left-count"),
      rightCount: $("right-count"),
      leftBody: $("left-body"),
      rightBody: $("right-body"),
      leftDue: $("left-due"),
      rightDue: $("right-due"),
      outBody: $("out-body"),
      log: $("log"),
      mBuffered: $("m-buffered"),
      mBaseline: $("m-baseline"),
      mPeak: $("m-peak"),
      mPeakBase: $("m-peak-base"),
      mEmitted: $("m-emitted"),
      mMissed: $("m-missed"),
      mRecall: $("m-recall"),
      mLate: $("m-late"),
      mEvicted: $("m-evicted"),
      window: $("window"),
      windowOut: $("window-out"),
      lateness: $("lateness"),
      latenessOut: $("lateness-out"),
      disorder: $("disorder"),
      disorderOut: $("disorder-out"),
      strategy: $("strategy"),
      retention: $("retention"),
      retentionOut: $("retention-out"),
      retentionField: $("retention-field"),
      speed: $("speed"),
      speedOut: $("speed-out"),
      seed: $("seed"),
      regen: $("regen"),
      run: $("run"),
      step: $("step"),
      runEnd: $("run-end"),
      reset: $("reset")
    };

    var cfg = {
      windowSec: +el.window.value,
      lateness: +el.lateness.value,
      disorder: +el.disorder.value,
      strategy: el.strategy.value,
      retention: +el.retention.value,
      speed: +el.speed.value,
      seed: +el.seed.value
    };

    var app = {
      ds: null,
      gt: null,
      engA: null,
      engB: null,
      idx: 0,
      gtArrived: 0,
      history: [],
      log: [],
      running: false,
      autoPaused: false
    };

    var STRATEGY_LABEL = {
      interval: "interval pruning",
      retention: "fixed retention",
      none: "no pruning"
    };

    /* -------- simulation control -------- */

    function makeEngine(strategy) {
      return new Engine({
        strategy: strategy,
        windowSec: cfg.windowSec,
        lateness: cfg.lateness,
        retention: cfg.retention
      });
    }

    function advance(recordLog) {
      if (!app.ds || app.idx >= app.ds.events.length) return false;
      var ev = app.ds.events[app.idx];
      var res = app.engA.process(ev);
      app.engB.process(ev);
      app.gtArrived += app.gt.completedAt[app.idx];
      app.idx++;
      app.history.push({ a: app.engA.size(), b: app.engB.size() });
      if (recordLog) {
        app.log.push(res);
        if (app.log.length > LOG_KEEP) app.log.shift();
      }
      return true;
    }

    function replayTo(n) {
      app.engA = makeEngine(cfg.strategy);
      app.engB = makeEngine("none");
      app.idx = 0;
      app.gtArrived = 0;
      app.history = [];
      app.log = [];
      for (var i = 0; i < n; i++) advance(i >= n - LOG_KEEP);
    }

    function reconfigure(rebuildData) {
      var at = app.idx;
      if (rebuildData || !app.ds) {
        app.ds = buildDataset(cfg.seed, cfg.disorder);
      }
      if (at > app.ds.events.length) at = app.ds.events.length;
      app.gt = buildGroundTruth(app.ds, cfg.windowSec);
      replayTo(at);
      render(true);
    }

    function atEnd() {
      return app.ds && app.idx >= app.ds.events.length;
    }

    function setRunning(on) {
      if (on && atEnd()) return;
      app.running = on;
      el.run.textContent = on ? "Pause" : "Run";
      el.run.setAttribute("aria-pressed", on ? "true" : "false");
      if (on) {
        lastFrame = 0;
        if (!rafId) rafId = requestAnimationFrame(frame);
      }
      /* keep the status pill honest even when nothing else re-renders
         (pausing, or the tab being hidden mid-run) */
      if (app.ds) render(true);
    }

    /* -------- animation loop -------- */

    var rafId = 0;
    var lastFrame = 0;
    var carry = 0;

    function frame(ts) {
      rafId = 0;
      if (!app.running) return;
      var dt = lastFrame ? Math.min(0.25, (ts - lastFrame) / 1000) : 0;
      lastFrame = ts;
      carry += dt * cfg.speed;
      var budget = Math.floor(carry);
      if (budget > 600) budget = 600;
      carry -= budget;
      if (carry > 5) carry = 5;
      for (var i = 0; i < budget; i++) {
        if (!advance(true)) break;
      }
      if (atEnd()) setRunning(false);
      render(false);
      if (app.running) rafId = requestAnimationFrame(frame);
    }

    /* -------- chart -------- */

    var ctx = el.chart.getContext("2d");
    var cssW = 0;
    var cssH = 0;

    function sizeCanvas() {
      var rect = el.chart.getBoundingClientRect();
      var w = Math.floor(rect.width);
      var h = Math.floor(rect.height);
      if (w <= 0 || h <= 0) return false;
      var dpr = window.devicePixelRatio || 1;
      var pw = Math.floor(w * dpr);
      var ph = Math.floor(h * dpr);
      if (el.chart.width !== pw || el.chart.height !== ph) {
        el.chart.width = pw;
        el.chart.height = ph;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cssW = w;
      cssH = h;
      return true;
    }

    function token(name, fallback) {
      var v = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
      return v || fallback;
    }

    function drawChart() {
      if (!sizeCanvas()) return;
      var cText = token("--text-faint", "#888");
      var cBorder = token("--border", "#ccc");
      var cAccent = token("--accent", "#0f6e60");
      var cMuted = token("--text-muted", "#666");

      ctx.clearRect(0, 0, cssW, cssH);

      var padL = 46;
      var padR = 10;
      var padT = 12;
      var padB = 24;
      var plotW = cssW - padL - padR;
      var plotH = cssH - padT - padB;
      if (plotW <= 10 || plotH <= 10) return;

      ctx.font =
        "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.textBaseline = "middle";

      /* frame */
      ctx.strokeStyle = cBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL + 0.5, padT);
      ctx.lineTo(padL + 0.5, padT + plotH + 0.5);
      ctx.lineTo(padL + plotW, padT + plotH + 0.5);
      ctx.stroke();

      if (app.history.length === 0) {
        ctx.fillStyle = cMuted;
        ctx.textAlign = "center";
        ctx.fillText(
          "No events ingested yet - press Run or Step",
          padL + plotW / 2,
          padT + plotH / 2
        );
        ctx.textAlign = "left";
        return;
      }

      var total = app.ds.events.length;
      var peakSeen = 8;
      for (var i = 0; i < app.history.length; i++) {
        if (app.history[i].b > peakSeen) peakSeen = app.history[i].b;
        if (app.history[i].a > peakSeen) peakSeen = app.history[i].a;
      }
      var step = niceStep(peakSeen / 6);
      var maxY = Math.ceil(peakSeen / step) * step;
      var ticks = Math.round(maxY / step);

      /* gridlines + y labels */
      ctx.fillStyle = cText;
      ctx.textAlign = "right";
      for (var g = 0; g <= ticks; g++) {
        var val = step * g;
        var y = padT + plotH - (val / maxY) * plotH;
        ctx.strokeStyle = cBorder;
        ctx.globalAlpha = g === 0 ? 1 : 0.45;
        ctx.beginPath();
        ctx.moveTo(padL, Math.round(y) + 0.5);
        ctx.lineTo(padL + plotW, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillText(String(Math.round(val)), padL - 6, y);
      }
      ctx.textAlign = "center";
      ctx.fillText("events ingested →", padL + plotW / 2, padT + plotH + 13);
      ctx.textAlign = "left";

      var xAt = function (i) {
        return total > 1 ? padL + (i / (total - 1)) * plotW : padL;
      };
      var yAt = function (v) {
        return padT + plotH - (v / maxY) * plotH;
      };

      var line = function (field, color, dashed) {
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = dashed ? 1.5 : 2;
        if (dashed) ctx.setLineDash([5, 4]);
        for (var k = 0; k < app.history.length; k++) {
          var x = xAt(k);
          var y = yAt(app.history[k][field]);
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      };

      line("b", cMuted, true);
      line("a", cAccent, false);
    }

    /* -------- rendering -------- */

    var lastRender = 0;
    var lastSummary = "";
    var lastSummaryAt = 0;

    function tr(cells, cls) {
      var row = document.createElement("tr");
      if (cls) row.className = cls;
      for (var i = 0; i < cells.length; i++) {
        var td = document.createElement("td");
        if (cells[i] && cells[i].mono) td.className = "mono";
        if (cells[i] && cells[i].num) td.className = "num";
        td.textContent = cells[i] && cells[i].t !== undefined ? cells[i].t : cells[i];
        row.appendChild(td);
      }
      return row;
    }

    function emptyRow(tbody, cols, text) {
      var row = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = cols;
      td.className = "muted";
      td.textContent = text;
      row.appendChild(td);
      tbody.appendChild(row);
    }

    function renderStateTable(tbody, side, rows) {
      tbody.textContent = "";
      if (rows.length === 0) {
        emptyRow(tbody, 3, "buffer empty");
        return;
      }
      var b = app.engA.bounds();
      var bound = side === "L" ? b.left : b.right;
      var shown = Math.min(rows.length, 7);
      for (var i = 0; i < shown; i++) {
        var r = rows[i];
        var due = "—";
        if (cfg.strategy === "interval") {
          due = side === "L" ? fmtClock(r.ts + cfg.windowSec) : fmtClock(r.ts);
        } else if (cfg.strategy === "retention") {
          due = fmtClock(r.ts + cfg.retention);
        }
        var doomed = isFinite(bound) && r.ts < bound + 1.0;
        tbody.appendChild(
          tr(
            [
              { t: fmtClock(r.ts), mono: true },
              { t: r.key, mono: true },
              { t: doomed ? due + " ◂" : due, mono: true }
            ],
            doomed ? "is-doomed" : ""
          )
        );
      }
      if (rows.length > shown) {
        var more = document.createElement("tr");
        var td = document.createElement("td");
        td.colSpan = 3;
        td.className = "muted";
        td.textContent =
          "+ " + (rows.length - shown) + " more buffered row(s) not shown";
        more.appendChild(td);
        tbody.appendChild(more);
      }
    }

    function renderLog() {
      el.log.textContent = "";
      if (app.log.length === 0) {
        var p = document.createElement("div");
        p.className = "log-row muted";
        p.textContent = "no events processed yet";
        el.log.appendChild(p);
        return;
      }
      var frag = document.createDocumentFragment();
      for (var i = app.log.length - 1; i >= 0; i--) {
        var r = app.log[i];
        var row = document.createElement("div");
        row.className = "log-row";

        var time = document.createElement("span");
        time.className = "log-time";
        time.textContent = fmtClock(r.ev.ts);
        row.appendChild(time);

        var tagEl = document.createElement("span");
        tagEl.className = "log-side";
        tagEl.textContent = r.ev.side === "L" ? "orders  " : "shipment";
        row.appendChild(tagEl);

        var key = document.createElement("span");
        key.textContent = r.ev.key;
        row.appendChild(key);

        var res = document.createElement("span");
        if (r.matched > 0) {
          res.className = "log-hit";
          res.textContent =
            "match ×" + r.matched + " (lag " + fmtSec(r.lag) + ")";
        } else {
          res.className = "log-dim";
          res.textContent = "no match";
        }
        row.appendChild(res);

        if (r.late) {
          var lateEl = document.createElement("span");
          lateEl.className = "log-late";
          lateEl.textContent = "LATE";
          row.appendChild(lateEl);
        }

        var ev = r.prunedLeft + r.prunedRight;
        if (ev > 0) {
          var evEl = document.createElement("span");
          evEl.className = "log-evict";
          evEl.textContent =
            "evict " + r.prunedLeft + "L/" + r.prunedRight + "R";
          row.appendChild(evEl);
        }
        frag.appendChild(row);
      }
      el.log.appendChild(frag);
    }

    function renderOutput() {
      el.outBody.textContent = "";
      var rows = app.engA.output;
      if (rows.length === 0) {
        emptyRow(el.outBody, 5, "no join rows emitted yet");
        return;
      }
      var shown = Math.min(rows.length, 8);
      for (var i = 0; i < shown; i++) {
        var r = rows[i];
        el.outBody.appendChild(
          tr([
            { t: fmtClock(r.at), mono: true },
            { t: r.key, mono: true },
            { t: r.region },
            { t: r.carrier },
            { t: fmtSec(r.lag), num: true }
          ])
        );
      }
    }

    function renderBounds() {
      var b = app.engA.bounds();
      el.wmL.textContent = fmtClock(app.engA.wmL);
      el.wmR.textContent = fmtClock(app.engA.wmR);

      if (cfg.strategy === "interval") {
        el.boundL.textContent =
          "keep o.ts ≥ wm(shipments) − " +
          cfg.windowSec +
          "s = " +
          fmtClock(b.left);
        el.boundR.textContent = "keep s.ts ≥ wm(orders) = " + fmtClock(b.right);
      } else if (cfg.strategy === "retention") {
        el.boundL.textContent =
          "keep o.ts ≥ max(o.ts) − " +
          cfg.retention +
          "s = " +
          fmtClock(b.left);
        el.boundR.textContent =
          "keep s.ts ≥ max(s.ts) − " +
          cfg.retention +
          "s = " +
          fmtClock(b.right);
      } else {
        el.boundL.textContent = "keep every order row for the life of the query";
        el.boundR.textContent = "keep every shipment row for the life of the query";
      }
    }

    function renderSQL() {
      el.sql.textContent =
        "SELECT o.order_id, o.region, s.carrier, s.ts - o.ts AS fulfil_lag\n" +
        "FROM orders o\n" +
        "JOIN shipments s\n" +
        "  ON o.order_id = s.order_id\n" +
        " AND s.ts BETWEEN o.ts AND o.ts + INTERVAL '" +
        cfg.windowSec +
        " seconds'";
    }

    function render(force) {
      var now = Date.now();
      if (!force && now - lastRender < 55) return;
      lastRender = now;

      var a = app.engA;
      var b = app.engB;
      var total = app.ds.events.length;
      var missed = app.gtArrived - a.emitted;
      if (missed < 0) missed = 0;
      var recall =
        app.gtArrived > 0 ? (a.emitted / app.gtArrived) * 100 : 100;

      var lastTs =
        app.idx > 0 ? app.ds.events[app.idx - 1].ts : null;
      el.clock.textContent = app.idx > 0 ? fmtClock(lastTs) : "--:--:--";
      el.progress.textContent = app.idx + " / " + total;

      var done = atEnd();
      el.step.disabled = done;
      el.runEnd.disabled = done;
      if (!app.running) el.run.textContent = done ? "Restart" : "Run";

      el.status.textContent = app.running
        ? "running"
        : done
        ? "stream exhausted"
        : app.idx === 0
        ? "idle"
        : "paused";
      el.status.setAttribute(
        "data-state",
        app.running ? "running" : missed > 0 ? "warn" : "idle"
      );

      el.mBuffered.textContent = a.size();
      el.mBaseline.textContent = b.size();
      el.mPeak.textContent = a.peak;
      el.mPeakBase.textContent = b.peak;
      el.mEmitted.textContent = a.emitted;
      el.mMissed.textContent = missed;
      el.mRecall.textContent =
        app.gtArrived > 0 ? recall.toFixed(1) + "%" : "—";
      el.mLate.textContent = a.lateArrivals;
      el.mEvicted.textContent = a.evicted;
      el.mMissed.className = "metric-value" + (missed > 0 ? " is-bad" : "");

      el.strategyName.textContent = STRATEGY_LABEL[cfg.strategy];
      el.legendA.textContent = "buffered rows · " + STRATEGY_LABEL[cfg.strategy];
      el.leftCount.textContent = a.leftCount;
      el.rightCount.textContent = a.rightCount;

      renderBounds();
      renderStateTable(el.leftBody, "L", a.rows("L"));
      renderStateTable(el.rightBody, "R", a.rows("R"));
      renderOutput();
      renderLog();
      drawChart();

      el.chartNote.textContent =
        "Simulated buffered-row counts. Solid line: " +
        STRATEGY_LABEL[cfg.strategy] +
        ", currently " +
        a.size() +
        " rows (peak " +
        a.peak +
        "). Dashed line: no pruning, currently " +
        b.size() +
        " rows (peak " +
        b.peak +
        ").";

      var summary =
        "Ingested " +
        app.idx +
        " of " +
        total +
        " events. " +
        a.size() +
        " rows buffered with " +
        STRATEGY_LABEL[cfg.strategy] +
        " versus " +
        b.size() +
        " with none. " +
        a.emitted +
        " join rows emitted, " +
        missed +
        " missed against the batch oracle, recall " +
        recall.toFixed(1) +
        "%.";
      if (summary !== lastSummary && (force || now - lastSummaryAt > 1200)) {
        el.summary.textContent = summary;
        lastSummary = summary;
        lastSummaryAt = now;
      }
    }

    /* -------- control wiring -------- */

    function syncOutputs() {
      el.windowOut.textContent = cfg.windowSec + " s";
      el.latenessOut.textContent = cfg.lateness + " s";
      el.disorderOut.textContent = cfg.disorder + " s";
      el.retentionOut.textContent = cfg.retention + " s";
      el.speedOut.textContent = cfg.speed + " /s";
      var off = cfg.strategy !== "retention";
      el.retention.disabled = off;
      el.retentionField.classList.toggle("is-off", off);
    }

    el.window.addEventListener("input", function () {
      cfg.windowSec = +el.window.value;
      syncOutputs();
      renderSQL();
      reconfigure(false);
    });

    el.lateness.addEventListener("input", function () {
      cfg.lateness = +el.lateness.value;
      syncOutputs();
      reconfigure(false);
    });

    el.disorder.addEventListener("input", function () {
      cfg.disorder = +el.disorder.value;
      syncOutputs();
      reconfigure(true);
    });

    el.strategy.addEventListener("change", function () {
      cfg.strategy = el.strategy.value;
      syncOutputs();
      reconfigure(false);
    });

    el.retention.addEventListener("input", function () {
      cfg.retention = +el.retention.value;
      syncOutputs();
      reconfigure(false);
    });

    el.speed.addEventListener("input", function () {
      cfg.speed = +el.speed.value;
      syncOutputs();
    });

    function applySeed() {
      var v = Math.round(+el.seed.value);
      if (!isFinite(v) || v < 1) v = 1;
      if (v > 999999) v = 999999;
      el.seed.value = v;
      cfg.seed = v;
      reconfigure(true);
    }
    el.seed.addEventListener("change", applySeed);
    el.regen.addEventListener("click", applySeed);

    el.run.addEventListener("click", function () {
      if (atEnd()) {
        /* the streams are drained — restart rather than sit there doing nothing */
        replayTo(0);
        setRunning(true);
        return;
      }
      setRunning(!app.running);
    });

    el.step.addEventListener("click", function () {
      setRunning(false);
      advance(true);
      render(true);
    });

    el.runEnd.addEventListener("click", function () {
      setRunning(false);
      var guard = 0;
      while (advance(true) && guard++ < 100000) {
        /* drain the streams */
      }
      render(true);
    });

    el.reset.addEventListener("click", function () {
      setRunning(false);
      replayTo(0);
      render(true);
    });

    /* pause while the tab is hidden, resume when it comes back */
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        if (app.running) {
          app.autoPaused = true;
          setRunning(false);
        }
      } else if (app.autoPaused) {
        app.autoPaused = false;
        setRunning(true);
      }
    });

    var redraw = function () {
      drawChart();
    };
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(redraw).observe(el.chart);
    }
    window.addEventListener("resize", redraw);
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      if (mq.addEventListener) mq.addEventListener("change", redraw);
      else if (mq.addListener) mq.addListener(redraw);
    }

    /* -------- boot -------- */

    syncOutputs();
    renderSQL();
    reconfigure(true);

    var reduced =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) setRunning(true);
  }

  if (typeof document !== "undefined" && typeof window !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initUI);
    } else {
      initUI();
    }
  }

  /* Exported only so the simulation core can be exercised outside a browser;
     harmless and unused in the page itself. */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      buildDataset: buildDataset,
      buildGroundTruth: buildGroundTruth,
      Engine: Engine
    };
  }
})();
