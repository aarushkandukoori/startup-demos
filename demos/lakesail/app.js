/* ==========================================================================
   DataFrame Plan Optimizer Playground
   An independent mini-demo by Aarush Kandukoori. No dependencies, no network,
   no build step. Everything below runs in the browser from this one file.

   Pipeline:  text  ->  tokens  ->  logical plan  ->  analyzed plan
                    ->  optimized physical plan
                    ->  executed twice (vectorized batches / row-at-a-time)

   All data is synthetic and generated in-browser by a seeded PRNG.
   ========================================================================== */

(function () {
  "use strict";

  /* ======================================================================
     0. Small utilities
     ====================================================================== */

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var nowMs =
    window.performance && window.performance.now
      ? function () {
          return window.performance.now();
        }
      : function () {
          return Date.now();
        };

  function fmtInt(n) {
    return Math.round(n).toLocaleString("en-US");
  }

  function fmtBytes(b) {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / (1024 * 1024)).toFixed(2) + " MB";
  }

  function fmtMs(ms) {
    if (ms >= 100) return ms.toFixed(0) + " ms";
    if (ms >= 10) return ms.toFixed(1) + " ms";
    if (ms >= 0.1) return ms.toFixed(2) + " ms";
    return Math.round(ms * 1000) + " µs";
  }

  function round2(x) {
    return Math.round(x * 100) / 100;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function levenshtein(a, b) {
    var m = a.length,
      n = b.length,
      i,
      j;
    if (!m) return n;
    if (!n) return m;
    var prev = new Array(n + 1),
      cur = new Array(n + 1);
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      for (j = 0; j <= n; j++) prev[j] = cur[j];
    }
    return prev[n];
  }

  function nearest(name, candidates) {
    var best = null,
      bestD = Infinity;
    for (var i = 0; i < candidates.length; i++) {
      var d = levenshtein(name.toLowerCase(), candidates[i].toLowerCase());
      if (d < bestD) {
        bestD = d;
        best = candidates[i];
      }
    }
    return bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
  }

  function qerr(msg, pos) {
    var e = new Error(msg);
    e.isQuery = true;
    e.qpos = typeof pos === "number" ? pos : -1;
    return e;
  }

  function posToLineCol(src, pos) {
    if (pos < 0) return null;
    var line = 1,
      col = 1;
    for (var i = 0; i < pos && i < src.length; i++) {
      if (src.charAt(i) === "\n") {
        line++;
        col = 1;
      } else col++;
    }
    return { line: line, col: col };
  }

  /* ======================================================================
     1. Synthetic dataset — a small star schema with Parquet-shaped metadata
     ====================================================================== */

  var ROW_GROUP = 1000; // rows per row group in the fact table
  var ITEM_COUNT = 240;
  var DATE_BASE = 2451000; // surrogate date keys, one synthetic year
  var DATE_SPAN = 365;

  // Modelled encoded width per value, in bytes: plain ints/doubles, and
  // dictionary codes for the low-cardinality string columns.
  var TYPE_BYTES = { int: 4, double: 8, string: 2 };

  var CATEGORIES = [
    "Electronics",
    "Home",
    "Sports",
    "Books",
    "Apparel",
    "Grocery"
  ];

  // Invented brand labels — not real trademarks.
  var BRANDS = [
    "Vantera",
    "Northline",
    "Cobblewood",
    "Harborlight",
    "Meridiel",
    "Palewood",
    "Quartzly",
    "Sablefin",
    "Tindermark",
    "Umberline",
    "Vireo",
    "Zephyrine"
  ];

  function allocCol(type, n) {
    if (type === "int") return new Int32Array(n);
    if (type === "double") return new Float64Array(n);
    return new Array(n);
  }

  function finishTable(name, colDefs, nRows, data, rowGroupSize) {
    var t = {
      name: name,
      columns: colDefs,
      nRows: nRows,
      rowGroupSize: rowGroupSize,
      data: data,
      byName: {},
      bytesPerRow: 0,
      rowGroups: []
    };
    var i, c;
    for (c = 0; c < colDefs.length; c++) {
      t.byName[colDefs[c].name] = colDefs[c];
      t.bytesPerRow += TYPE_BYTES[colDefs[c].type];
    }
    for (var start = 0; start < nRows; start += rowGroupSize) {
      var end = Math.min(start + rowGroupSize, nRows);
      var stats = {};
      for (c = 0; c < colDefs.length; c++) {
        var col = colDefs[c].name;
        var arr = data[col];
        var mn = arr[start],
          mx = arr[start];
        for (i = start + 1; i < end; i++) {
          var v = arr[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        stats[col] = { min: mn, max: mx };
      }
      t.rowGroups.push({
        start: start,
        end: end,
        len: end - start,
        stats: stats
      });
    }
    return t;
  }

  function buildItemTable() {
    var defs = [
      { name: "i_item_sk", type: "int" },
      { name: "i_brand", type: "string" },
      { name: "i_category", type: "string" },
      { name: "i_current_price", type: "double" }
    ];
    var data = {
      i_item_sk: allocCol("int", ITEM_COUNT),
      i_brand: allocCol("string", ITEM_COUNT),
      i_category: allocCol("string", ITEM_COUNT),
      i_current_price: allocCol("double", ITEM_COUNT)
    };
    var rng = mulberry32(20260811);
    for (var i = 0; i < ITEM_COUNT; i++) {
      data.i_item_sk[i] = i + 1;
      data.i_category[i] = CATEGORIES[Math.floor(rng() * CATEGORIES.length)];
      data.i_brand[i] = BRANDS[Math.floor(rng() * BRANDS.length)];
      data.i_current_price[i] = round2(4.5 + rng() * 215);
    }
    return finishTable("item", defs, ITEM_COUNT, data, 1024);
  }

  function buildStoreSales(nRows, itemTable) {
    var defs = [
      { name: "ss_sold_date_sk", type: "int" },
      { name: "ss_item_sk", type: "int" },
      { name: "ss_store_sk", type: "int" },
      { name: "ss_customer_sk", type: "int" },
      { name: "ss_quantity", type: "int" },
      { name: "ss_sales_price", type: "double" },
      { name: "ss_ext_discount_amt", type: "double" },
      { name: "ss_net_profit", type: "double" }
    ];
    var data = {};
    for (var d = 0; d < defs.length; d++) {
      data[defs[d].name] = allocCol(defs[d].type, nRows);
    }
    var rng = mulberry32(987654321);
    var prices = itemTable.data.i_current_price;
    for (var i = 0; i < nRows; i++) {
      // Sales arrive in date order with a little jitter, the way a
      // date-partitioned fact table usually lands on disk. That clustering is
      // exactly what makes min/max statistics useful.
      var day = Math.floor((i * DATE_SPAN) / nRows);
      if (rng() < 0.22) day += Math.floor(rng() * 3);
      if (day >= DATE_SPAN) day = DATE_SPAN - 1;
      data.ss_sold_date_sk[i] = DATE_BASE + day;

      // Item popularity is skewed, as it is in any real catalog.
      var item = 1 + Math.floor(Math.pow(rng(), 1.7) * ITEM_COUNT);
      if (item > ITEM_COUNT) item = ITEM_COUNT;
      data.ss_item_sk[i] = item;

      var store = 1 + Math.floor(Math.pow(rng(), 1.25) * 14);
      if (store > 14) store = 14;
      data.ss_store_sk[i] = store;

      data.ss_customer_sk[i] = 1 + Math.floor(rng() * 4000);

      var qty = 1 + Math.floor(rng() * 24);
      data.ss_quantity[i] = qty;

      var price = round2(prices[item - 1] * (0.85 + rng() * 0.32));
      data.ss_sales_price[i] = price;

      var disc = rng() < 0.34 ? round2(price * qty * rng() * 0.3) : 0;
      data.ss_ext_discount_amt[i] = disc;

      var margin = rng() * 0.36 - 0.09;
      data.ss_net_profit[i] = round2(price * qty * margin - disc * 0.25);
    }
    return finishTable("store_sales", defs, nRows, data, ROW_GROUP);
  }

  function buildDataset(nRows) {
    var item = buildItemTable();
    return { store_sales: buildStoreSales(nRows, item), item: item };
  }

  /* ======================================================================
     2. Tokenizer
     ====================================================================== */

  var TWO_CHAR = ["==", "!=", "<=", ">=", "&&", "||", "<>"];

  function isDigit(c) {
    return c >= "0" && c <= "9";
  }
  function isIdentStart(c) {
    return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
  }
  function isIdentPart(c) {
    return isIdentStart(c) || isDigit(c);
  }

  function tokenize(src, base) {
    base = base || 0;
    var toks = [],
      i = 0,
      n = src.length;
    while (i < n) {
      var c = src.charAt(i);
      if (c === " " || c === "\n" || c === "\t" || c === "\r") {
        i++;
        continue;
      }
      if (c === "#") {
        while (i < n && src.charAt(i) !== "\n") i++;
        continue;
      }
      if (c === '"' || c === "'") {
        var q = c,
          j = i + 1,
          buf = "";
        while (j < n && src.charAt(j) !== q) {
          buf += src.charAt(j);
          j++;
        }
        if (j >= n) throw qerr("Unterminated string literal", base + i);
        toks.push({ t: "str", v: buf, p: base + i });
        i = j + 1;
        continue;
      }
      if (isDigit(c) || (c === "." && isDigit(src.charAt(i + 1)))) {
        var k = i;
        while (k < n && (isDigit(src.charAt(k)) || src.charAt(k) === ".")) k++;
        var text = src.slice(i, k);
        var num = Number(text);
        if (isNaN(num)) throw qerr('"' + text + '" is not a number', base + i);
        toks.push({ t: "num", v: num, p: base + i });
        i = k;
        continue;
      }
      if (isIdentStart(c)) {
        var m = i;
        while (m < n && isIdentPart(src.charAt(m))) m++;
        toks.push({ t: "id", v: src.slice(i, m), p: base + i });
        i = m;
        continue;
      }
      var two = src.substr(i, 2);
      if (TWO_CHAR.indexOf(two) >= 0) {
        toks.push({ t: "op", v: two, p: base + i });
        i += 2;
        continue;
      }
      if ("().,+-*/<>=!".indexOf(c) >= 0) {
        toks.push({ t: "op", v: c, p: base + i });
        i++;
        continue;
      }
      throw qerr('Unexpected character "' + c + '"', base + i);
    }
    toks.push({ t: "eof", v: "", p: base + n });
    return toks;
  }

  /* ======================================================================
     3. Expression parser (the string inside filter("…"))
     ====================================================================== */

  function makeCursor(toks) {
    var pos = 0;
    return {
      peek: function () {
        return toks[pos];
      },
      next: function () {
        return toks[pos++];
      },
      at: function (t, v) {
        var tk = toks[pos];
        return tk.t === t && (v === undefined || tk.v === v);
      },
      atId: function (word) {
        var tk = toks[pos];
        return tk.t === "id" && tk.v.toLowerCase() === word;
      },
      eat: function (t, v) {
        if (this.at(t, v)) {
          pos++;
          return true;
        }
        return false;
      },
      expect: function (t, v, what) {
        var tk = toks[pos];
        if (tk.t === t && (v === undefined || tk.v === v)) {
          pos++;
          return tk;
        }
        throw qerr(
          "Expected " + (what || (v ? '"' + v + '"' : t)) + ', found "' +
            (tk.t === "eof" ? "end of program" : tk.v) + '"',
          tk.p
        );
      }
    };
  }

  var CMP_OPS = ["==", "=", "!=", "<>", "<", "<=", ">", ">="];

  function normCmp(op) {
    if (op === "=") return "==";
    if (op === "<>") return "!=";
    return op;
  }

  function parseExpression(text, base) {
    var cur = makeCursor(tokenize(text, base));
    var e = parseOr(cur);
    if (!cur.at("eof")) {
      var tk = cur.peek();
      throw qerr('Unexpected "' + tk.v + '" in predicate', tk.p);
    }
    return e;
  }

  function parseOr(cur) {
    var left = parseAnd(cur);
    for (;;) {
      if (cur.atId("or")) cur.next();
      else if (cur.at("op", "||")) cur.next();
      else break;
      left = { k: "bin", op: "or", l: left, r: parseAnd(cur) };
    }
    return left;
  }

  function parseAnd(cur) {
    var left = parseNot(cur);
    for (;;) {
      if (cur.atId("and")) cur.next();
      else if (cur.at("op", "&&")) cur.next();
      else break;
      left = { k: "bin", op: "and", l: left, r: parseNot(cur) };
    }
    return left;
  }

  function parseNot(cur) {
    if (cur.atId("not") || cur.at("op", "!")) {
      cur.next();
      return { k: "not", e: parseNot(cur) };
    }
    return parseCompare(cur);
  }

  function parseCompare(cur) {
    var left = parseAdd(cur);
    var tk = cur.peek();
    if (tk.t === "op" && CMP_OPS.indexOf(tk.v) >= 0) {
      cur.next();
      return {
        k: "bin",
        op: normCmp(tk.v),
        l: left,
        r: parseAdd(cur),
        pos: tk.p
      };
    }
    return left;
  }

  function parseAdd(cur) {
    var left = parseMul(cur);
    for (;;) {
      if (cur.at("op", "+")) {
        cur.next();
        left = { k: "bin", op: "+", l: left, r: parseMul(cur) };
      } else if (cur.at("op", "-")) {
        cur.next();
        left = { k: "bin", op: "-", l: left, r: parseMul(cur) };
      } else break;
    }
    return left;
  }

  function parseMul(cur) {
    var left = parsePrimary(cur);
    for (;;) {
      if (cur.at("op", "*")) {
        cur.next();
        left = { k: "bin", op: "*", l: left, r: parsePrimary(cur) };
      } else if (cur.at("op", "/")) {
        cur.next();
        left = { k: "bin", op: "/", l: left, r: parsePrimary(cur) };
      } else break;
    }
    return left;
  }

  function parsePrimary(cur) {
    var tk = cur.peek();
    if (tk.t === "op" && tk.v === "-") {
      cur.next();
      return { k: "neg", e: parsePrimary(cur) };
    }
    if (tk.t === "op" && tk.v === "(") {
      cur.next();
      var inner = parseOr(cur);
      cur.expect("op", ")", 'a closing ")"');
      return inner;
    }
    if (tk.t === "num") {
      cur.next();
      return { k: "lit", v: tk.v, pos: tk.p };
    }
    if (tk.t === "str") {
      cur.next();
      return { k: "lit", v: tk.v, pos: tk.p };
    }
    if (tk.t === "id") {
      cur.next();
      var low = tk.v.toLowerCase();
      if (low === "true") return { k: "lit", v: 1, pos: tk.p };
      if (low === "false") return { k: "lit", v: 0, pos: tk.p };
      return { k: "col", name: tk.v, pos: tk.p };
    }
    throw qerr(
      "Expected a column, number or string, found " +
        (tk.t === "eof" ? "the end of the predicate" : '"' + tk.v + '"'),
      tk.p
    );
  }

  function exprCols(e, out) {
    out = out || [];
    if (!e) return out;
    if (e.k === "col") {
      if (out.indexOf(e.name) < 0) out.push(e.name);
    } else if (e.k === "bin") {
      exprCols(e.l, out);
      exprCols(e.r, out);
    } else if (e.k === "not" || e.k === "neg") {
      exprCols(e.e, out);
    }
    return out;
  }

  function exprToString(e) {
    switch (e.k) {
      case "lit":
        return typeof e.v === "string" ? "'" + e.v + "'" : String(e.v);
      case "col":
        return e.name;
      case "neg":
        return "-" + exprToString(e.e);
      case "not":
        return "NOT " + exprToString(e.e);
      case "bin": {
        var op = e.op === "and" ? "AND" : e.op === "or" ? "OR" : e.op;
        var s = exprToString(e.l) + " " + op + " " + exprToString(e.r);
        return e.op === "and" || e.op === "or" ? "(" + s + ")" : s;
      }
      default:
        return "?";
    }
  }

  function splitConj(e, out) {
    out = out || [];
    if (e.k === "bin" && e.op === "and") {
      splitConj(e.l, out);
      splitConj(e.r, out);
    } else out.push(e);
    return out;
  }

  function conjoin(preds) {
    var e = preds[0];
    for (var i = 1; i < preds.length; i++)
      e = { k: "bin", op: "and", l: e, r: preds[i] };
    return e;
  }

  /* ======================================================================
     4. Program parser — the DataFrame chain
     ====================================================================== */

  var METHODS = [
    "filter",
    "where",
    "select",
    "join",
    "groupby",
    "agg",
    "orderby",
    "sort",
    "limit"
  ];
  var AGG_FNS = ["sum", "count", "avg", "min", "max"];

  function parseSource(cur) {
    var sparkTok = cur.expect("id", undefined, '"spark"');
    if (sparkTok.v !== "spark")
      throw qerr('A program starts with spark.table("…")', sparkTok.p);
    cur.expect("op", ".", 'a "." after spark');
    var m = cur.expect("id", undefined, '"table"');
    if (m.v !== "table")
      throw qerr('Only spark.table("…") can start a program', m.p);
    cur.expect("op", "(", 'a "(" after table');
    var nameTok = cur.expect("str", undefined, "a quoted table name");
    cur.expect("op", ")", 'a ")"');
    return {
      op: "Scan",
      table: nameTok.v,
      pos: nameTok.p,
      filters: []
    };
  }

  function parseStringList(cur, what) {
    var names = [];
    if (cur.at("op", ")")) throw qerr(what + " needs at least one column", cur.peek().p);
    for (;;) {
      var tk = cur.expect("str", undefined, "a quoted column name");
      names.push(tk.v);
      if (!cur.eat("op", ",")) break;
    }
    return names;
  }

  function parseAggItem(cur) {
    var fnTok = cur.expect("id", undefined, "an aggregate function");
    var fn = fnTok.v.toLowerCase();
    if (AGG_FNS.indexOf(fn) < 0)
      throw qerr(
        'Unknown aggregate "' + fnTok.v + '" — use ' + AGG_FNS.join(", "),
        fnTok.p
      );
    cur.expect("op", "(", 'a "(" after ' + fn);
    var colTok = cur.expect("str", undefined, "a quoted column name");
    cur.expect("op", ")", 'a ")"');
    var alias = fn + "(" + colTok.v + ")";
    if (cur.atId("as")) {
      cur.next();
      var aliasTok = cur.peek();
      if (aliasTok.t === "id" || aliasTok.t === "str") {
        cur.next();
        alias = String(aliasTok.v);
      } else {
        throw qerr("Expected a name after AS", aliasTok.p);
      }
    }
    if (fn !== "count" && colTok.v === "*")
      throw qerr('Only count("*") may use "*"', colTok.p);
    return { fn: fn, col: colTok.v, alias: alias, pos: colTok.p };
  }

  function parseSortItem(cur) {
    var tk = cur.peek();
    if (tk.t === "str") {
      cur.next();
      return { col: tk.v, dir: "asc", pos: tk.p };
    }
    var fnTok = cur.expect("id", undefined, 'asc(…), desc(…) or a quoted name');
    var fn = fnTok.v.toLowerCase();
    if (fn !== "asc" && fn !== "desc")
      throw qerr('Sort keys use asc("col"), desc("col") or "col"', fnTok.p);
    cur.expect("op", "(", 'a "(" after ' + fn);
    var colTok = cur.expect("str", undefined, "a quoted column name");
    cur.expect("op", ")", 'a ")"');
    return { col: colTok.v, dir: fn, pos: colTok.p };
  }

  function parseProgram(src) {
    var cur = makeCursor(tokenize(src, 0));
    var plan = parseSource(cur);

    while (cur.at("op", ".")) {
      cur.next();
      var mTok = cur.expect("id", undefined, "a method name");
      var name = mTok.v.toLowerCase();
      if (METHODS.indexOf(name) < 0)
        throw qerr(
          'Unknown method "' + mTok.v + '" — supported: ' + METHODS.join(", "),
          mTok.p
        );
      cur.expect("op", "(", 'a "(" after ' + mTok.v);

      if (name === "filter" || name === "where") {
        var pTok = cur.expect(
          "str",
          undefined,
          'a quoted predicate, e.g. filter("ss_quantity > 4")'
        );
        plan = {
          op: "Filter",
          input: plan,
          predicate: parseExpression(pTok.v, pTok.p + 1),
          pos: pTok.p
        };
      } else if (name === "select") {
        plan = {
          op: "Project",
          input: plan,
          columns: parseStringList(cur, "select()"),
          pos: mTok.p
        };
      } else if (name === "groupby") {
        plan = {
          op: "_Group",
          input: plan,
          groupBy: parseStringList(cur, "groupBy()"),
          pos: mTok.p
        };
      } else if (name === "agg") {
        var aggs = [];
        if (cur.at("op", ")"))
          throw qerr("agg() needs at least one aggregate", cur.peek().p);
        for (;;) {
          aggs.push(parseAggItem(cur));
          if (!cur.eat("op", ",")) break;
        }
        var keys = plan.op === "_Group" ? plan.groupBy : [];
        var input = plan.op === "_Group" ? plan.input : plan;
        plan = {
          op: "Aggregate",
          input: input,
          groupBy: keys,
          aggs: aggs,
          pos: mTok.p
        };
      } else if (name === "orderby" || name === "sort") {
        var keys2 = [];
        if (cur.at("op", ")"))
          throw qerr("orderBy() needs at least one key", cur.peek().p);
        for (;;) {
          keys2.push(parseSortItem(cur));
          if (!cur.eat("op", ",")) break;
        }
        plan = { op: "Sort", input: plan, keys: keys2, pos: mTok.p };
      } else if (name === "limit") {
        var nTok = cur.expect("num", undefined, "a row count");
        if (nTok.v <= 0 || Math.floor(nTok.v) !== nTok.v)
          throw qerr("limit() needs a positive whole number", nTok.p);
        plan = { op: "Limit", input: plan, n: nTok.v, pos: mTok.p };
      } else if (name === "join") {
        var right = parseSource(cur);
        cur.expect("op", ",", 'a "," then the join condition');
        var cTok = cur.expect(
          "str",
          undefined,
          'a quoted join condition, e.g. "ss_item_sk == i_item_sk"'
        );
        var cond = parseExpression(cTok.v, cTok.p + 1);
        if (
          cond.k !== "bin" ||
          cond.op !== "==" ||
          cond.l.k !== "col" ||
          cond.r.k !== "col"
        )
          throw qerr(
            'join() supports one equality of two columns, e.g. "ss_item_sk == i_item_sk"',
            cTok.p
          );
        plan = {
          op: "Join",
          left: plan,
          right: right,
          leftKey: cond.l.name,
          rightKey: cond.r.name,
          pos: cTok.p
        };
      }
      cur.expect("op", ")", 'a ")" to close ' + mTok.v + "()");
    }

    if (plan.op === "_Group")
      throw qerr("groupBy() must be followed by agg(…)", plan.pos);
    if (!cur.at("eof")) {
      var extra = cur.peek();
      throw qerr('Unexpected "' + extra.v + '" after the program', extra.p);
    }
    return plan;
  }

  /* ======================================================================
     5. Analyzer — resolve names against the catalog, compute schemas
     ====================================================================== */

  function schemaNames(schema) {
    var out = [];
    for (var i = 0; i < schema.length; i++) out.push(schema[i].name);
    return out;
  }

  function findField(schema, name) {
    for (var i = 0; i < schema.length; i++)
      if (schema[i].name === name) return schema[i];
    return null;
  }

  function unknownColumn(name, schema, pos, where) {
    var names = schemaNames(schema);
    var hint = nearest(name, names);
    return qerr(
      'Unresolved column "' + name + '" in ' + where +
        (hint ? ' — did you mean "' + hint + '"?' : "") +
        ". Available: " + names.join(", "),
      pos
    );
  }

  function analyze(node, ds) {
    switch (node.op) {
      case "Scan": {
        var t = ds[node.table];
        if (!t) {
          var tables = Object.keys(ds);
          var hint = nearest(node.table, tables);
          throw qerr(
            'Unknown table "' + node.table + '"' +
              (hint ? ' — did you mean "' + hint + '"?' : "") +
              ". Catalog: " + tables.join(", "),
            node.pos
          );
        }
        node.schema = t.columns.slice();
        return node;
      }
      case "Filter": {
        analyze(node.input, ds);
        var cols = exprCols(node.predicate);
        for (var i = 0; i < cols.length; i++)
          if (!findField(node.input.schema, cols[i]))
            throw unknownColumn(cols[i], node.input.schema, node.pos, "filter()");
        node.schema = node.input.schema;
        return node;
      }
      case "Project": {
        analyze(node.input, ds);
        var out = [];
        for (var j = 0; j < node.columns.length; j++) {
          var f = findField(node.input.schema, node.columns[j]);
          if (!f)
            throw unknownColumn(
              node.columns[j],
              node.input.schema,
              node.pos,
              "select()"
            );
          out.push(f);
        }
        node.schema = out;
        return node;
      }
      case "Join": {
        analyze(node.left, ds);
        analyze(node.right, ds);
        var lf = findField(node.left.schema, node.leftKey);
        var rf = findField(node.right.schema, node.rightKey);
        if (!lf || !rf) {
          // Accept the condition written the other way round.
          var lf2 = findField(node.left.schema, node.rightKey);
          var rf2 = findField(node.right.schema, node.leftKey);
          if (lf2 && rf2) {
            var swap = node.leftKey;
            node.leftKey = node.rightKey;
            node.rightKey = swap;
            lf = lf2;
            rf = rf2;
          }
        }
        if (!lf)
          throw unknownColumn(
            node.leftKey,
            node.left.schema,
            node.pos,
            "the join condition (left side)"
          );
        if (!rf)
          throw unknownColumn(
            node.rightKey,
            node.right.schema,
            node.pos,
            "the join condition (right side)"
          );
        node.schema = node.left.schema.concat(node.right.schema);
        return node;
      }
      case "Aggregate": {
        analyze(node.input, ds);
        var schema = [];
        var k;
        for (k = 0; k < node.groupBy.length; k++) {
          var gf = findField(node.input.schema, node.groupBy[k]);
          if (!gf)
            throw unknownColumn(
              node.groupBy[k],
              node.input.schema,
              node.pos,
              "groupBy()"
            );
          schema.push(gf);
        }
        for (k = 0; k < node.aggs.length; k++) {
          var a = node.aggs[k];
          var type = "double";
          if (a.col === "*") {
            if (a.fn !== "count")
              throw qerr('Only count("*") may use "*"', a.pos);
            type = "int";
          } else {
            var af = findField(node.input.schema, a.col);
            if (!af)
              throw unknownColumn(a.col, node.input.schema, a.pos, "agg()");
            if (a.fn === "count") type = "int";
            else if (a.fn === "min" || a.fn === "max") type = af.type;
            else type = "double";
          }
          if (findField(schema, a.alias))
            throw qerr('Duplicate output column "' + a.alias + '"', a.pos);
          schema.push({ name: a.alias, type: type });
        }
        node.schema = schema;
        return node;
      }
      case "Sort": {
        analyze(node.input, ds);
        for (var s = 0; s < node.keys.length; s++)
          if (!findField(node.input.schema, node.keys[s].col))
            throw unknownColumn(
              node.keys[s].col,
              node.input.schema,
              node.keys[s].pos,
              "orderBy()"
            );
        node.schema = node.input.schema;
        return node;
      }
      case "Limit": {
        analyze(node.input, ds);
        node.schema = node.input.schema;
        return node;
      }
      case "_Group":
        throw qerr("groupBy() must be followed by agg(…)", node.pos);
      default:
        throw qerr("Cannot analyze node " + node.op, -1);
    }
  }

  /* ======================================================================
     6. Optimizer
     ====================================================================== */

  function clonePlan(n) {
    var c = {};
    for (var k in n)
      if (Object.prototype.hasOwnProperty.call(n, k)) c[k] = n[k];
    if (n.input) c.input = clonePlan(n.input);
    if (n.left) c.left = clonePlan(n.left);
    if (n.right) c.right = clonePlan(n.right);
    if (n.filters) c.filters = n.filters.slice();
    return c;
  }

  function subset(cols, schema) {
    for (var i = 0; i < cols.length; i++)
      if (!findField(schema, cols[i])) return false;
    return true;
  }

  function wrapFilter(node, preds) {
    if (!preds.length) return node;
    return {
      op: "Filter",
      input: node,
      predicate: conjoin(preds),
      schema: node.schema
    };
  }

  /* Push `preds` as far down as each operator allows. Every predicate is
     applied exactly once in the returned plan. */
  function pushFilters(node, preds, notes) {
    switch (node.op) {
      case "Scan":
        if (preds.length) {
          node.filters = node.filters.concat(preds);
          notes.pushed = notes.pushed || {};
          notes.pushed[node.table] =
            (notes.pushed[node.table] || 0) + preds.length;
        }
        return node;

      case "Filter": {
        var all = preds.concat(splitConj(node.predicate));
        return pushFilters(node.input, all, notes);
      }

      case "Project":
      case "Sort":
        node.input = pushFilters(node.input, preds, notes);
        return node;

      case "Limit":
        // A filter above a LIMIT cannot move below it: LIMIT 10 then filter
        // is not the same query as filter then LIMIT 10.
        node.input = pushFilters(node.input, [], notes);
        if (preds.length) notes.heldLimit = (notes.heldLimit || 0) + preds.length;
        return wrapFilter(node, preds);

      case "Aggregate": {
        var down = [],
          keep = [];
        for (var i = 0; i < preds.length; i++) {
          var cols = exprCols(preds[i]);
          var ok = true;
          for (var c = 0; c < cols.length; c++)
            if (node.groupBy.indexOf(cols[c]) < 0) ok = false;
          if (ok) down.push(preds[i]);
          else keep.push(preds[i]);
        }
        node.input = pushFilters(node.input, down, notes);
        if (keep.length)
          notes.heldAgg = (notes.heldAgg || []).concat(
            keep.map(function (p) {
              return exprToString(p);
            })
          );
        return wrapFilter(node, keep);
      }

      case "Join": {
        var toLeft = [],
          toRight = [],
          stay = [];
        for (var j = 0; j < preds.length; j++) {
          var pc = exprCols(preds[j]);
          if (subset(pc, node.left.schema)) toLeft.push(preds[j]);
          else if (subset(pc, node.right.schema)) toRight.push(preds[j]);
          else stay.push(preds[j]);
        }
        node.left = pushFilters(node.left, toLeft, notes);
        node.right = pushFilters(node.right, toRight, notes);
        if (stay.length) notes.heldJoin = (notes.heldJoin || 0) + stay.length;
        return wrapFilter(node, stay);
      }

      default:
        return node;
    }
  }

  /* Which columns does each operator actually have to read? */
  function computeRequired(node, needed, prune, ds) {
    var i;
    switch (node.op) {
      case "Scan": {
        var t = ds[node.table];
        var want = {};
        if (prune) {
          for (i = 0; i < needed.length; i++) want[needed[i]] = true;
          for (i = 0; i < node.filters.length; i++) {
            var fc = exprCols(node.filters[i]);
            for (var f = 0; f < fc.length; f++) want[fc[f]] = "filter";
          }
        } else {
          for (i = 0; i < t.columns.length; i++) want[t.columns[i].name] = true;
        }
        node.readCols = [];
        node.filterOnly = {};
        for (i = 0; i < t.columns.length; i++) {
          var nm = t.columns[i].name;
          if (want[nm]) {
            node.readCols.push(nm);
            if (want[nm] === "filter" && needed.indexOf(nm) < 0)
              node.filterOnly[nm] = true;
          }
        }
        node.outCols = node.readCols.slice();
        return;
      }
      case "Filter": {
        var n2 = needed.slice();
        var pc = exprCols(node.predicate);
        for (i = 0; i < pc.length; i++)
          if (n2.indexOf(pc[i]) < 0) n2.push(pc[i]);
        computeRequired(node.input, n2, prune, ds);
        node.outCols = node.input.outCols.slice();
        return;
      }
      case "Project":
        computeRequired(node.input, node.columns.slice(), prune, ds);
        node.outCols = node.columns.slice();
        return;
      case "Sort": {
        var n3 = needed.slice();
        for (i = 0; i < node.keys.length; i++)
          if (n3.indexOf(node.keys[i].col) < 0) n3.push(node.keys[i].col);
        computeRequired(node.input, n3, prune, ds);
        node.outCols = node.input.outCols.slice();
        return;
      }
      case "Limit":
        computeRequired(node.input, needed.slice(), prune, ds);
        node.outCols = node.input.outCols.slice();
        return;
      case "Aggregate": {
        var n4 = node.groupBy.slice();
        for (i = 0; i < node.aggs.length; i++) {
          var a = node.aggs[i];
          if (a.col !== "*" && n4.indexOf(a.col) < 0) n4.push(a.col);
        }
        computeRequired(node.input, n4, prune, ds);
        node.outCols = node.groupBy.slice();
        for (i = 0; i < node.aggs.length; i++)
          node.outCols.push(node.aggs[i].alias);
        return;
      }
      case "Join": {
        var want2 = needed.slice();
        if (want2.indexOf(node.leftKey) < 0) want2.push(node.leftKey);
        if (want2.indexOf(node.rightKey) < 0) want2.push(node.rightKey);
        var ln = [],
          rn = [];
        for (i = 0; i < want2.length; i++) {
          if (findField(node.left.schema, want2[i])) ln.push(want2[i]);
          else if (findField(node.right.schema, want2[i])) rn.push(want2[i]);
        }
        computeRequired(node.left, ln, prune, ds);
        computeRequired(node.right, rn, prune, ds);
        node.outCols = node.left.outCols.concat(node.right.outCols);
        return;
      }
      default:
        return;
    }
  }

  /* Can this row group be skipped outright, given one predicate and the
     group's min/max statistics? Only says yes when it is provable. */
  function predCanSkip(pred, stats) {
    if (pred.k !== "bin") return false;
    var col = null,
      lit = null,
      flipped = false;
    if (pred.l.k === "col" && pred.r.k === "lit") {
      col = pred.l.name;
      lit = pred.r.v;
    } else if (pred.l.k === "lit" && pred.r.k === "col") {
      col = pred.r.name;
      lit = pred.l.v;
      flipped = true;
    } else return false;

    var s = stats[col];
    if (!s) return false;
    if (typeof lit !== typeof s.min) return false;

    var op = pred.op;
    if (flipped) {
      var mirror = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };
      if (mirror[op]) op = mirror[op];
    }
    switch (op) {
      case ">":
        return s.max <= lit;
      case ">=":
        return s.max < lit;
      case "<":
        return s.min >= lit;
      case "<=":
        return s.min > lit;
      case "==":
        return lit < s.min || lit > s.max;
      default:
        return false; // !=, OR, arithmetic … stay conservative
    }
  }

  function planScans(node, out) {
    out = out || [];
    if (node.op === "Scan") out.push(node);
    if (node.input) planScans(node.input, out);
    if (node.left) planScans(node.left, out);
    if (node.right) planScans(node.right, out);
    return out;
  }

  function estimateRows(node, ds) {
    switch (node.op) {
      case "Scan":
        return ds[node.table].nRows;
      case "Filter":
        return Math.max(1, Math.round(estimateRows(node.input, ds) * 0.3));
      case "Project":
      case "Sort":
        return estimateRows(node.input, ds);
      case "Limit":
        return Math.min(node.n, estimateRows(node.input, ds));
      case "Aggregate":
        return Math.max(1, Math.round(estimateRows(node.input, ds) * 0.05));
      case "Join":
        return estimateRows(node.left, ds);
      default:
        return 1;
    }
  }

  var BROADCAST_LIMIT = 4096; // rows on the build side

  function choosePhysical(node, opts, ds, notes) {
    switch (node.op) {
      case "Scan":
        node.phys = "ParquetScan";
        return;
      case "Filter":
        node.phys = "FilterExec";
        choosePhysical(node.input, opts, ds, notes);
        return;
      case "Project":
        node.phys = "ProjectionExec";
        choosePhysical(node.input, opts, ds, notes);
        return;
      case "Sort":
        node.phys = "SortExec";
        choosePhysical(node.input, opts, ds, notes);
        return;
      case "Limit":
        node.phys = "LimitExec";
        choosePhysical(node.input, opts, ds, notes);
        return;
      case "Aggregate":
        node.phys = "HashAggregate";
        choosePhysical(node.input, opts, ds, notes);
        return;
      case "Join": {
        var buildRows = estimateRows(node.right, ds);
        node.buildRows = buildRows;
        if (opts.broadcast && buildRows <= BROADCAST_LIMIT) {
          node.phys = "BroadcastHashJoin";
          notes.broadcast = { rows: buildRows, side: rightTableName(node) };
        } else {
          node.phys = "SortMergeJoin";
          notes.sortMerge = {
            rows: buildRows,
            why: opts.broadcast ? "build side too large" : "rule off"
          };
        }
        choosePhysical(node.left, opts, ds, notes);
        choosePhysical(node.right, opts, ds, notes);
        return;
      }
      default:
        node.phys = node.op;
        return;
    }
  }

  /* A LIMIT can also stop the operators below it early, but only through
     operators that keep the row count intact. A Filter may stop once it has
     emitted enough rows; its child may not, because the filter discards. */
  function propagateLimit(node, n, notes) {
    switch (node.op) {
      case "Project":
        node.fetchLimit = n;
        propagateLimit(node.input, n, notes);
        return;
      case "Filter":
      case "Scan":
        node.fetchLimit = n;
        notes.limitPush = { n: n, op: node.op === "Scan" ? "scan" : "filter" };
        return;
      default:
        return; // Sort, Aggregate and Join all need their whole input
    }
  }

  function applyLimitPushdown(node, notes) {
    if (node.op === "Limit") propagateLimit(node.input, node.n, notes);
    if (node.input) applyLimitPushdown(node.input, notes);
    if (node.left) applyLimitPushdown(node.left, notes);
    if (node.right) applyLimitPushdown(node.right, notes);
  }

  function rightTableName(joinNode) {
    var s = planScans(joinNode.right);
    return s.length ? s[0].table : "right side";
  }

  function optimize(analyzed, ds, opts) {
    var plan = clonePlan(analyzed);
    var notes = {};

    if (opts.filterPushdown) plan = pushFilters(plan, [], notes);

    computeRequired(plan, schemaNames(plan.schema), opts.projection, ds);
    choosePhysical(plan, opts, ds, notes);
    applyLimitPushdown(plan, notes);

    // Row-group selection + the byte cost of the scan.
    var scans = planScans(plan);
    var totalBytes = 0,
      readBytes = 0,
      groupsTotal = 0,
      groupsScanned = 0;
    for (var i = 0; i < scans.length; i++) {
      var sc = scans[i];
      var t = ds[sc.table];
      var keep = [];
      var prunedBy = null;
      for (var g = 0; g < t.rowGroups.length; g++) {
        var skip = false;
        if (opts.stats) {
          for (var f = 0; f < sc.filters.length; f++) {
            if (predCanSkip(sc.filters[f], t.rowGroups[g].stats)) {
              skip = true;
              if (!prunedBy) prunedBy = exprCols(sc.filters[f])[0] || null;
              break;
            }
          }
        }
        if (!skip) keep.push(g);
      }
      sc.scanGroups = keep;
      sc.groupsTotal = t.rowGroups.length;
      sc.prunedBy = prunedBy;

      var widthRead = 0;
      for (var c = 0; c < sc.readCols.length; c++)
        widthRead += TYPE_BYTES[t.byName[sc.readCols[c]].type];
      sc.bytesPerRowRead = widthRead;

      var rowsKept = 0;
      for (var k = 0; k < keep.length; k++) rowsKept += t.rowGroups[keep[k]].len;
      sc.rowsInScannedGroups = rowsKept;
      sc.bytesRead = rowsKept * widthRead;
      sc.bytesTotal = t.nRows * t.bytesPerRow;

      readBytes += sc.bytesRead;
      totalBytes += sc.bytesTotal;
      groupsTotal += sc.groupsTotal;
      groupsScanned += keep.length;
    }

    return {
      plan: plan,
      scans: scans,
      notes: notes,
      bytesRead: readBytes,
      bytesTotal: totalBytes,
      groupsTotal: groupsTotal,
      groupsScanned: groupsScanned
    };
  }

  /* ======================================================================
     7. Shared execution helpers
     ====================================================================== */

  function coalesceRanges(groupIdx, t) {
    var ranges = [];
    for (var i = 0; i < groupIdx.length; i++) {
      var rg = t.rowGroups[groupIdx[i]];
      var last = ranges.length ? ranges[ranges.length - 1] : null;
      if (last && last.end === rg.start) last.end = rg.end;
      else ranges.push({ start: rg.start, end: rg.end });
    }
    return ranges;
  }

  function truthy(v) {
    return !!v;
  }

  function cmpVals(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  function newAccs(aggs) {
    var a = new Array(aggs.length);
    for (var i = 0; i < aggs.length; i++)
      a[i] = { s: 0, c: 0, mn: null, mx: null };
    return a;
  }

  function finishAgg(def, slot) {
    switch (def.fn) {
      case "count":
        return slot.c;
      case "sum":
        return slot.c ? round2(slot.s) : 0;
      case "avg":
        return slot.c ? round2(slot.s / slot.c) : null;
      case "min":
        return slot.mn;
      case "max":
        return slot.mx;
      default:
        return null;
    }
  }

  function updateAcc(def, slot, v) {
    if (def.fn === "count") {
      if (def.col === "*" || (v !== null && v !== undefined)) slot.c++;
      return;
    }
    if (v === null || v === undefined) return;
    slot.c++;
    if (def.fn === "sum" || def.fn === "avg") slot.s += v;
    if (def.fn === "min") slot.mn = slot.mn === null || v < slot.mn ? v : slot.mn;
    if (def.fn === "max") slot.mx = slot.mx === null || v > slot.mx ? v : slot.mx;
  }

  /* ======================================================================
     8. Vectorized engine — batch at a time over column arrays
     ====================================================================== */

  function gatherCol(arr, idx, count) {
    var out;
    if (arr instanceof Int32Array) out = new Int32Array(count);
    else if (arr instanceof Float64Array) out = new Float64Array(count);
    else out = new Array(count);
    for (var i = 0; i < count; i++) out[i] = arr[idx[i]];
    return out;
  }

  function evalVec(expr, batch) {
    var len = batch.len,
      i,
      out;
    switch (expr.k) {
      case "lit":
        return { scalar: true, v: expr.v };
      case "col": {
        var a = batch.cols[expr.name];
        if (a === undefined)
          throw new Error('column "' + expr.name + '" missing from batch');
        return { scalar: false, v: a };
      }
      case "neg": {
        var e = evalVec(expr.e, batch);
        if (e.scalar) return { scalar: true, v: -e.v };
        out = new Float64Array(len);
        for (i = 0; i < len; i++) out[i] = -e.v[i];
        return { scalar: false, v: out };
      }
      case "not": {
        var m = toMask(evalVec(expr.e, batch), len);
        out = new Uint8Array(len);
        for (i = 0; i < len; i++) out[i] = m[i] ? 0 : 1;
        return { scalar: false, v: out };
      }
      case "bin": {
        if (expr.op === "and" || expr.op === "or") {
          var lm = toMask(evalVec(expr.l, batch), len);
          var rm = toMask(evalVec(expr.r, batch), len);
          out = new Uint8Array(len);
          if (expr.op === "and")
            for (i = 0; i < len; i++) out[i] = lm[i] && rm[i] ? 1 : 0;
          else for (i = 0; i < len; i++) out[i] = lm[i] || rm[i] ? 1 : 0;
          return { scalar: false, v: out };
        }
        var l = evalVec(expr.l, batch);
        var r = evalVec(expr.r, batch);
        if (CMP_OPS.indexOf(expr.op) >= 0)
          return { scalar: false, v: vecCompare(expr.op, l, r, len) };
        return { scalar: false, v: vecArith(expr.op, l, r, len) };
      }
      default:
        throw new Error("cannot evaluate node " + expr.k);
    }
  }

  /* One branch outside the loop, a tight typed loop inside — the whole
     point of batch-at-a-time evaluation. */
  function vecCompare(op, a, b, len) {
    var out = new Uint8Array(len),
      i,
      x,
      y;
    var as = a.scalar,
      bs = b.scalar,
      av = a.v,
      bv = b.v;
    switch (op) {
      case "==":
        for (i = 0; i < len; i++) {
          x = as ? av : av[i];
          y = bs ? bv : bv[i];
          out[i] = x === y ? 1 : 0;
        }
        break;
      case "!=":
        for (i = 0; i < len; i++) {
          x = as ? av : av[i];
          y = bs ? bv : bv[i];
          out[i] = x !== y ? 1 : 0;
        }
        break;
      case "<":
        for (i = 0; i < len; i++) {
          x = as ? av : av[i];
          y = bs ? bv : bv[i];
          out[i] = x < y ? 1 : 0;
        }
        break;
      case "<=":
        for (i = 0; i < len; i++) {
          x = as ? av : av[i];
          y = bs ? bv : bv[i];
          out[i] = x <= y ? 1 : 0;
        }
        break;
      case ">":
        for (i = 0; i < len; i++) {
          x = as ? av : av[i];
          y = bs ? bv : bv[i];
          out[i] = x > y ? 1 : 0;
        }
        break;
      case ">=":
        for (i = 0; i < len; i++) {
          x = as ? av : av[i];
          y = bs ? bv : bv[i];
          out[i] = x >= y ? 1 : 0;
        }
        break;
      default:
        throw new Error("unknown comparison " + op);
    }
    return out;
  }

  function vecArith(op, a, b, len) {
    var out = new Float64Array(len),
      i,
      x,
      y;
    var as = a.scalar,
      bs = b.scalar,
      av = a.v,
      bv = b.v;
    switch (op) {
      case "+":
        for (i = 0; i < len; i++) {
          x = as ? av : av[i];
          y = bs ? bv : bv[i];
          out[i] = x + y;
        }
        break;
      case "-":
        for (i = 0; i < len; i++) {
          x = as ? av : av[i];
          y = bs ? bv : bv[i];
          out[i] = x - y;
        }
        break;
      case "*":
        for (i = 0; i < len; i++) {
          x = as ? av : av[i];
          y = bs ? bv : bv[i];
          out[i] = x * y;
        }
        break;
      case "/":
        for (i = 0; i < len; i++) {
          x = as ? av : av[i];
          y = bs ? bv : bv[i];
          out[i] = x / y;
        }
        break;
      default:
        throw new Error("unknown operator " + op);
    }
    return out;
  }

  function toMask(res, len) {
    if (!res.scalar) return res.v;
    var out = new Uint8Array(len);
    if (res.v) for (var i = 0; i < len; i++) out[i] = 1;
    return out;
  }

  function compact(batch, mask) {
    var len = batch.len,
      i,
      count = 0;
    for (i = 0; i < len; i++) if (mask[i]) count++;
    if (count === len) return batch;
    var idx = new Int32Array(count),
      k = 0;
    for (i = 0; i < len; i++) if (mask[i]) idx[k++] = i;
    var cols = {};
    for (var name in batch.cols)
      if (Object.prototype.hasOwnProperty.call(batch.cols, name))
        cols[name] = gatherCol(batch.cols[name], idx, count);
    return { len: count, cols: cols };
  }

  function applyPreds(batch, preds) {
    var b = batch;
    for (var i = 0; i < preds.length && b.len > 0; i++) {
      var mask = toMask(evalVec(preds[i], b), b.len);
      b = compact(b, mask);
    }
    return b;
  }

  function concatBatches(batches, colNames) {
    if (batches.length === 1) return batches[0];
    var total = 0,
      i,
      c;
    for (i = 0; i < batches.length; i++) total += batches[i].len;
    var cols = {};
    for (c = 0; c < colNames.length; c++) {
      var name = colNames[c];
      var proto = null;
      for (i = 0; i < batches.length; i++)
        if (batches[i].cols[name] !== undefined) {
          proto = batches[i].cols[name];
          break;
        }
      var out;
      if (proto instanceof Int32Array) out = new Int32Array(total);
      else if (proto instanceof Float64Array) out = new Float64Array(total);
      else out = new Array(total);
      var off = 0;
      for (i = 0; i < batches.length; i++) {
        var src = batches[i].cols[name];
        for (var j = 0; j < batches[i].len; j++) out[off + j] = src[j];
        off += batches[i].len;
      }
      cols[name] = out;
    }
    return { len: total, cols: cols };
  }

  function meter(node, rin, rout) {
    node._m = { rin: rin, rout: rout };
  }

  function execVec(node, ctx) {
    switch (node.op) {
      case "Scan":
        return vecScan(node, ctx);
      case "Filter":
        return vecFilter(node, ctx);
      case "Project":
        return vecProject(node, ctx);
      case "Sort":
        return vecSort(node, ctx);
      case "Limit":
        return vecLimit(node, ctx);
      case "Aggregate":
        return vecAggregate(node, ctx);
      case "Join":
        return node.phys === "SortMergeJoin"
          ? vecSortMergeJoin(node, ctx)
          : vecBroadcastJoin(node, ctx);
      default:
        throw new Error("cannot execute " + node.op);
    }
  }

  function vecScan(node, ctx) {
    var t = ctx.ds[node.table];
    var cols = node.readCols;
    var ranges = coalesceRanges(node.scanGroups, t);
    var out = [];
    var rin = 0,
      rout = 0;
    var fetch = node.fetchLimit || 0;
    for (var r = 0; r < ranges.length; r++) {
      if (fetch && rout >= fetch) break;
      for (var s = ranges[r].start; s < ranges[r].end; s += ctx.batchSize) {
        if (fetch && rout >= fetch) break;
        var e = Math.min(s + ctx.batchSize, ranges[r].end);
        var len = e - s;
        var bcols = {};
        for (var c = 0; c < cols.length; c++) {
          var src = t.data[cols[c]];
          bcols[cols[c]] = src.subarray ? src.subarray(s, e) : src.slice(s, e);
        }
        var b = { len: len, cols: bcols };
        rin += len;
        ctx.st.rowsScanned += len;
        ctx.st.batches++;
        if (node.filters.length) b = applyPreds(b, node.filters);
        if (b.len > 0) {
          out.push(b);
          rout += b.len;
        }
      }
    }
    meter(node, rin, rout);
    return out;
  }

  function vecFilter(node, ctx) {
    var ins = execVec(node.input, ctx);
    var preds = splitConj(node.predicate);
    var out = [],
      rin = 0,
      rout = 0;
    var fetch = node.fetchLimit || 0;
    for (var i = 0; i < ins.length; i++) {
      rin += ins[i].len;
      var b = applyPreds(ins[i], preds);
      if (b.len > 0) {
        out.push(b);
        rout += b.len;
      }
      if (fetch && rout >= fetch) break;
    }
    meter(node, rin, rout);
    return out;
  }

  function vecProject(node, ctx) {
    var ins = execVec(node.input, ctx);
    var out = [],
      rin = 0;
    for (var i = 0; i < ins.length; i++) {
      rin += ins[i].len;
      var cols = {};
      for (var c = 0; c < node.columns.length; c++)
        cols[node.columns[c]] = ins[i].cols[node.columns[c]];
      out.push({ len: ins[i].len, cols: cols });
    }
    meter(node, rin, rin);
    return out;
  }

  function vecLimit(node, ctx) {
    var ins = execVec(node.input, ctx);
    var out = [],
      taken = 0,
      rin = 0;
    for (var i = 0; i < ins.length; i++) {
      rin += ins[i].len;
      if (taken >= node.n) continue;
      var room = node.n - taken;
      if (ins[i].len <= room) {
        out.push(ins[i]);
        taken += ins[i].len;
      } else {
        var idx = new Int32Array(room);
        for (var j = 0; j < room; j++) idx[j] = j;
        var cols = {};
        for (var name in ins[i].cols)
          if (Object.prototype.hasOwnProperty.call(ins[i].cols, name))
            cols[name] = gatherCol(ins[i].cols[name], idx, room);
        out.push({ len: room, cols: cols });
        taken = node.n;
      }
    }
    meter(node, rin, taken);
    return out;
  }

  function vecSort(node, ctx) {
    var ins = execVec(node.input, ctx);
    if (!ins.length) {
      meter(node, 0, 0);
      return [];
    }
    var all = concatBatches(ins, node.input.outCols);
    var len = all.len;
    var keys = node.keys;
    var keyCols = [];
    for (var k = 0; k < keys.length; k++) keyCols.push(all.cols[keys[k].col]);
    var sorted = new Array(len);
    for (var i = 0; i < len; i++) sorted[i] = i;
    sorted.sort(function (x, y) {
      for (var q = 0; q < keyCols.length; q++) {
        var c = cmpVals(keyCols[q][x], keyCols[q][y]);
        if (c !== 0) return keys[q].dir === "desc" ? -c : c;
      }
      return x - y;
    });
    var cols = {};
    for (var name in all.cols)
      if (Object.prototype.hasOwnProperty.call(all.cols, name))
        cols[name] = gatherCol(all.cols[name], sorted, len);
    meter(node, len, len);
    return splitBatch({ len: len, cols: cols }, ctx.batchSize);
  }

  function splitBatch(batch, size) {
    if (batch.len <= size) return batch.len ? [batch] : [];
    var out = [];
    for (var s = 0; s < batch.len; s += size) {
      var e = Math.min(s + size, batch.len);
      var idx = new Int32Array(e - s);
      for (var i = 0; i < e - s; i++) idx[i] = s + i;
      var cols = {};
      for (var name in batch.cols)
        if (Object.prototype.hasOwnProperty.call(batch.cols, name))
          cols[name] = gatherCol(batch.cols[name], idx, e - s);
      out.push({ len: e - s, cols: cols });
    }
    return out;
  }

  function vecAggregate(node, ctx) {
    var ins = execVec(node.input, ctx);
    var groups = new Map();
    var order = [];
    var nk = node.groupBy.length;
    var aggs = node.aggs;
    var rin = 0,
      i,
      g,
      a;

    if (nk === 0) {
      var globalAcc = { gv: [], a: newAccs(aggs) };
      groups.set(0, globalAcc);
      order.push(globalAcc);
    }

    for (var bI = 0; bI < ins.length; bI++) {
      var b = ins[bI];
      rin += b.len;
      var gcols = [];
      for (g = 0; g < nk; g++) gcols.push(b.cols[node.groupBy[g]]);
      var acols = [];
      for (a = 0; a < aggs.length; a++)
        acols.push(aggs[a].col === "*" ? null : b.cols[aggs[a].col]);

      for (i = 0; i < b.len; i++) {
        var key;
        if (nk === 0) key = 0;
        else if (nk === 1) key = gcols[0][i];
        else {
          // The separator is load-bearing: without it the composite keys
          // (1, 23) and (12, 3) would both hash to "123" and merge.
          key = String(gcols[0][i]);
          for (g = 1; g < nk; g++) key += "\u0001" + gcols[g][i];
        }
        var acc = groups.get(key);
        if (acc === undefined) {
          var gv = new Array(nk);
          for (g = 0; g < nk; g++) gv[g] = gcols[g][i];
          acc = { gv: gv, a: newAccs(aggs) };
          groups.set(key, acc);
          order.push(acc);
        }
        for (a = 0; a < aggs.length; a++)
          updateAcc(aggs[a], acc.a[a], acols[a] ? acols[a][i] : null);
      }
    }

    var n = order.length;
    var cols = {};
    for (g = 0; g < nk; g++) cols[node.groupBy[g]] = new Array(n);
    for (a = 0; a < aggs.length; a++) cols[aggs[a].alias] = new Array(n);
    for (i = 0; i < n; i++) {
      for (g = 0; g < nk; g++) cols[node.groupBy[g]][i] = order[i].gv[g];
      for (a = 0; a < aggs.length; a++)
        cols[aggs[a].alias][i] = finishAgg(aggs[a], order[i].a[a]);
    }
    meter(node, rin, n);
    return splitBatch({ len: n, cols: cols }, ctx.batchSize);
  }

  function vecBroadcastJoin(node, ctx) {
    var rightBatches = execVec(node.right, ctx);
    var R = concatBatches(rightBatches, node.right.outCols);
    if (!rightBatches.length) R = { len: 0, cols: {} };
    var map = new Map();
    var rkey = R.cols[node.rightKey];
    var i, arr;
    for (i = 0; i < R.len; i++) {
      arr = map.get(rkey[i]);
      if (arr === undefined) map.set(rkey[i], [i]);
      else arr.push(i);
    }

    var leftBatches = execVec(node.left, ctx);
    var out = [],
      rin = 0,
      rout = 0;
    var lcols = node.left.outCols,
      rcols = node.right.outCols;

    for (var bI = 0; bI < leftBatches.length; bI++) {
      var b = leftBatches[bI];
      rin += b.len;
      var lkey = b.cols[node.leftKey];
      var li = [],
        ri = [];
      for (i = 0; i < b.len; i++) {
        arr = map.get(lkey[i]);
        if (arr === undefined) continue;
        for (var j = 0; j < arr.length; j++) {
          li.push(i);
          ri.push(arr[j]);
        }
      }
      if (li.length) {
        var joined = buildJoinBatches(b, R, li, ri, lcols, rcols, ctx.batchSize);
        for (var q = 0; q < joined.length; q++) {
          out.push(joined[q]);
          rout += joined[q].len;
        }
      }
    }
    meter(node, rin + R.len, rout);
    return out;
  }

  function buildJoinBatches(L, R, li, ri, lcols, rcols, batchSize) {
    var out = [];
    for (var s = 0; s < li.length; s += batchSize) {
      var e = Math.min(s + batchSize, li.length);
      var n = e - s;
      var lidx = new Int32Array(n),
        ridx = new Int32Array(n);
      for (var i = 0; i < n; i++) {
        lidx[i] = li[s + i];
        ridx[i] = ri[s + i];
      }
      var cols = {};
      for (var c = 0; c < lcols.length; c++)
        cols[lcols[c]] = gatherCol(L.cols[lcols[c]], lidx, n);
      for (var d = 0; d < rcols.length; d++)
        cols[rcols[d]] = gatherCol(R.cols[rcols[d]], ridx, n);
      out.push({ len: n, cols: cols });
    }
    return out;
  }

  /* No broadcast: sort both sides on the join key and merge them. Same
     answer, more work — which is exactly what the toggle is for. */
  function vecSortMergeJoin(node, ctx) {
    var leftBatches = execVec(node.left, ctx);
    var rightBatches = execVec(node.right, ctx);
    var L = leftBatches.length
      ? concatBatches(leftBatches, node.left.outCols)
      : { len: 0, cols: {} };
    var R = rightBatches.length
      ? concatBatches(rightBatches, node.right.outCols)
      : { len: 0, cols: {} };
    if (!L.len || !R.len) {
      meter(node, L.len + R.len, 0);
      return [];
    }

    var lkey = L.cols[node.leftKey],
      rkey = R.cols[node.rightKey];
    var lo = new Array(L.len),
      ro = new Array(R.len),
      i;
    for (i = 0; i < L.len; i++) lo[i] = i;
    for (i = 0; i < R.len; i++) ro[i] = i;
    lo.sort(function (a, b) {
      return cmpVals(lkey[a], lkey[b]) || a - b;
    });
    ro.sort(function (a, b) {
      return cmpVals(rkey[a], rkey[b]) || a - b;
    });

    var li = [],
      ri = [],
      p = 0,
      q = 0;
    while (p < lo.length && q < ro.length) {
      var c = cmpVals(lkey[lo[p]], rkey[ro[q]]);
      if (c < 0) p++;
      else if (c > 0) q++;
      else {
        var pEnd = p;
        while (pEnd < lo.length && lkey[lo[pEnd]] === lkey[lo[p]]) pEnd++;
        var qEnd = q;
        while (qEnd < ro.length && rkey[ro[qEnd]] === rkey[ro[q]]) qEnd++;
        for (var a = p; a < pEnd; a++)
          for (var b2 = q; b2 < qEnd; b2++) {
            li.push(lo[a]);
            ri.push(ro[b2]);
          }
        p = pEnd;
        q = qEnd;
      }
    }

    var out = buildJoinBatches(
      L,
      R,
      li,
      ri,
      node.left.outCols,
      node.right.outCols,
      ctx.batchSize
    );
    meter(node, L.len + R.len, li.length);
    return out;
  }

  function runVectorized(plan, ds, batchSize) {
    var ctx = {
      ds: ds,
      batchSize: batchSize,
      st: { rowsScanned: 0, batches: 0 }
    };
    var batches = execVec(plan, ctx);
    var rows = 0;
    for (var i = 0; i < batches.length; i++) rows += batches[i].len;
    return { batches: batches, rows: rows, st: ctx.st };
  }

  /* ======================================================================
     9. Row-at-a-time engine — the Volcano model, one JS object per row
     ====================================================================== */

  function evalRow(expr, row) {
    switch (expr.k) {
      case "lit":
        return expr.v;
      case "col":
        return row[expr.name];
      case "neg":
        return -evalRow(expr.e, row);
      case "not":
        return !truthy(evalRow(expr.e, row));
      case "bin": {
        var op = expr.op;
        if (op === "and")
          return truthy(evalRow(expr.l, row)) && truthy(evalRow(expr.r, row));
        if (op === "or")
          return truthy(evalRow(expr.l, row)) || truthy(evalRow(expr.r, row));
        var a = evalRow(expr.l, row),
          b = evalRow(expr.r, row);
        switch (op) {
          case "==":
            return a === b;
          case "!=":
            return a !== b;
          case "<":
            return a < b;
          case "<=":
            return a <= b;
          case ">":
            return a > b;
          case ">=":
            return a >= b;
          case "+":
            return a + b;
          case "-":
            return a - b;
          case "*":
            return a * b;
          case "/":
            return a / b;
          default:
            throw new Error("unknown operator " + op);
        }
      }
      default:
        throw new Error("cannot evaluate node " + expr.k);
    }
  }

  function rowIter(node, ctx) {
    switch (node.op) {
      case "Scan":
        return rowScan(node, ctx);
      case "Filter":
        return rowFilter(node, ctx);
      case "Project":
        return rowProject(node, ctx);
      case "Sort":
        return rowSort(node, ctx);
      case "Limit":
        return rowLimit(node, ctx);
      case "Aggregate":
        return rowAggregate(node, ctx);
      case "Join":
        return node.phys === "SortMergeJoin"
          ? rowSortMergeJoin(node, ctx)
          : rowBroadcastJoin(node, ctx);
      default:
        throw new Error("cannot execute " + node.op);
    }
  }

  function rowScan(node, ctx) {
    var t = ctx.ds[node.table];
    var cols = node.readCols,
      ncols = cols.length;
    var arrays = new Array(ncols);
    for (var c = 0; c < ncols; c++) arrays[c] = t.data[cols[c]];
    var ranges = coalesceRanges(node.scanGroups, t);
    var ri = 0;
    var i = ranges.length ? ranges[0].start : 0;
    var filters = node.filters,
      nf = filters.length;

    return function next() {
      while (ri < ranges.length) {
        if (i >= ranges[ri].end) {
          ri++;
          if (ri < ranges.length) i = ranges[ri].start;
          continue;
        }
        var row = {};
        for (var c2 = 0; c2 < ncols; c2++) row[cols[c2]] = arrays[c2][i];
        i++;
        ctx.st.rowsScanned++;
        var ok = true;
        for (var f = 0; f < nf; f++)
          if (!truthy(evalRow(filters[f], row))) {
            ok = false;
            break;
          }
        if (ok) return row;
      }
      return null;
    };
  }

  function rowFilter(node, ctx) {
    var child = rowIter(node.input, ctx);
    var pred = node.predicate;
    return function next() {
      for (;;) {
        var r = child();
        if (r === null) return null;
        if (truthy(evalRow(pred, r))) return r;
      }
    };
  }

  function rowProject(node, ctx) {
    var child = rowIter(node.input, ctx);
    var cols = node.columns;
    return function next() {
      var r = child();
      if (r === null) return null;
      var o = {};
      for (var c = 0; c < cols.length; c++) o[cols[c]] = r[cols[c]];
      return o;
    };
  }

  function rowLimit(node, ctx) {
    var child = rowIter(node.input, ctx);
    var seen = 0;
    return function next() {
      if (seen >= node.n) return null;
      var r = child();
      if (r === null) return null;
      seen++;
      return r;
    };
  }

  function drain(iter) {
    var rows = [],
      r;
    while ((r = iter()) !== null) rows.push(r);
    return rows;
  }

  function rowSort(node, ctx) {
    var child = rowIter(node.input, ctx);
    var rows = null,
      i = 0;
    var keys = node.keys;
    return function next() {
      if (rows === null) {
        rows = drain(child);
        rows.sort(function (x, y) {
          for (var q = 0; q < keys.length; q++) {
            var c = cmpVals(x[keys[q].col], y[keys[q].col]);
            if (c !== 0) return keys[q].dir === "desc" ? -c : c;
          }
          return 0;
        });
      }
      return i < rows.length ? rows[i++] : null;
    };
  }

  function rowAggregate(node, ctx) {
    var child = rowIter(node.input, ctx);
    var outRows = null,
      i = 0;
    var nk = node.groupBy.length,
      aggs = node.aggs;

    return function next() {
      if (outRows === null) {
        var groups = new Map(),
          order = [],
          r,
          g,
          a;
        if (nk === 0) {
          var globalAcc = { gv: [], a: newAccs(aggs) };
          groups.set(0, globalAcc);
          order.push(globalAcc);
        }
        while ((r = child()) !== null) {
          var key;
          if (nk === 0) key = 0;
          else if (nk === 1) key = r[node.groupBy[0]];
          else {
            key = String(r[node.groupBy[0]]);
            for (g = 1; g < nk; g++) key += "\u0001" + r[node.groupBy[g]];
          }
          var acc = groups.get(key);
          if (acc === undefined) {
            var gv = new Array(nk);
            for (g = 0; g < nk; g++) gv[g] = r[node.groupBy[g]];
            acc = { gv: gv, a: newAccs(aggs) };
            groups.set(key, acc);
            order.push(acc);
          }
          for (a = 0; a < aggs.length; a++)
            updateAcc(
              aggs[a],
              acc.a[a],
              aggs[a].col === "*" ? null : r[aggs[a].col]
            );
        }
        outRows = [];
        for (var o = 0; o < order.length; o++) {
          var row = {};
          for (g = 0; g < nk; g++) row[node.groupBy[g]] = order[o].gv[g];
          for (a = 0; a < aggs.length; a++)
            row[aggs[a].alias] = finishAgg(aggs[a], order[o].a[a]);
          outRows.push(row);
        }
      }
      return i < outRows.length ? outRows[i++] : null;
    };
  }

  function mergeRow(l, r, lcols, rcols) {
    var o = {},
      c;
    for (c = 0; c < lcols.length; c++) o[lcols[c]] = l[lcols[c]];
    for (c = 0; c < rcols.length; c++) o[rcols[c]] = r[rcols[c]];
    return o;
  }

  function rowBroadcastJoin(node, ctx) {
    var left = rowIter(node.left, ctx);
    var right = rowIter(node.right, ctx);
    var lcols = node.left.outCols,
      rcols = node.right.outCols;
    var map = null,
      cur = null,
      matches = null,
      mi = 0;

    return function next() {
      if (map === null) {
        map = new Map();
        var r;
        while ((r = right()) !== null) {
          var k = r[node.rightKey];
          var arr = map.get(k);
          if (arr === undefined) map.set(k, [r]);
          else arr.push(r);
        }
      }
      for (;;) {
        if (matches !== null && mi < matches.length)
          return mergeRow(cur, matches[mi++], lcols, rcols);
        cur = left();
        if (cur === null) return null;
        matches = map.get(cur[node.leftKey]) || null;
        mi = 0;
      }
    };
  }

  function rowSortMergeJoin(node, ctx) {
    var lcols = node.left.outCols,
      rcols = node.right.outCols;
    var rows = null,
      i = 0;
    return function next() {
      if (rows === null) {
        var L = drain(rowIter(node.left, ctx));
        var R = drain(rowIter(node.right, ctx));
        var lk = node.leftKey,
          rk = node.rightKey;
        L.sort(function (a, b) {
          return cmpVals(a[lk], b[lk]);
        });
        R.sort(function (a, b) {
          return cmpVals(a[rk], b[rk]);
        });
        rows = [];
        var p = 0,
          q = 0;
        while (p < L.length && q < R.length) {
          var c = cmpVals(L[p][lk], R[q][rk]);
          if (c < 0) p++;
          else if (c > 0) q++;
          else {
            var pEnd = p;
            while (pEnd < L.length && L[pEnd][lk] === L[p][lk]) pEnd++;
            var qEnd = q;
            while (qEnd < R.length && R[qEnd][rk] === R[q][rk]) qEnd++;
            for (var a = p; a < pEnd; a++)
              for (var b = q; b < qEnd; b++)
                rows.push(mergeRow(L[a], R[b], lcols, rcols));
            p = pEnd;
            q = qEnd;
          }
        }
      }
      return i < rows.length ? rows[i++] : null;
    };
  }

  function runRowAtATime(plan, ds) {
    var ctx = { ds: ds, st: { rowsScanned: 0 } };
    var rows = drain(rowIter(plan, ctx));
    return { rows: rows, st: ctx.st };
  }

  /* ======================================================================
     10. Plan printing
     ====================================================================== */

  function keyList(keys) {
    var parts = [];
    for (var i = 0; i < keys.length; i++)
      parts.push(keys[i].col + " " + keys[i].dir.toUpperCase());
    return parts.join(", ");
  }

  function aggList(aggs) {
    var parts = [];
    for (var i = 0; i < aggs.length; i++)
      parts.push(aggs[i].fn + "(" + aggs[i].col + ") AS " + aggs[i].alias);
    return parts.join(", ");
  }

  function predList(filters) {
    var parts = [];
    for (var i = 0; i < filters.length; i++)
      parts.push(exprToString(filters[i]));
    return parts.join(", ");
  }

  function printLogical(node, depth, lines, ds) {
    var pad = new Array(depth + 1).join("  ");
    switch (node.op) {
      case "Scan":
        lines.push(
          pad + "Relation " + node.table + " [" + node.schema.length +
            " cols, " + fmtInt(ds[node.table].nRows) + " rows]"
        );
        return;
      case "Filter":
        lines.push(pad + "Filter " + exprToString(node.predicate));
        break;
      case "Project":
        lines.push(pad + "Project [" + node.columns.join(", ") + "]");
        break;
      case "Aggregate":
        lines.push(
          pad + "Aggregate keys=[" + node.groupBy.join(", ") + "] aggs=[" +
            aggList(node.aggs) + "]"
        );
        break;
      case "Sort":
        lines.push(pad + "Sort [" + keyList(node.keys) + "]");
        break;
      case "Limit":
        lines.push(pad + "Limit " + node.n);
        break;
      case "Join":
        lines.push(
          pad + "Join Inner " + node.leftKey + " = " + node.rightKey
        );
        printLogical(node.left, depth + 1, lines, ds);
        printLogical(node.right, depth + 1, lines, ds);
        return;
      default:
        lines.push(pad + node.op);
    }
    if (node.input) printLogical(node.input, depth + 1, lines, ds);
  }

  function printPhysical(node, depth, lines, ds) {
    var pad = new Array(depth + 1).join("  ");
    var sub = pad + "  ";
    switch (node.op) {
      case "Scan": {
        var t = ds[node.table];
        lines.push(
          pad + "ParquetScan " + node.table + " cols=[" +
            node.readCols.join(", ") + "] (" + node.readCols.length + "/" +
            t.columns.length + ")"
        );
        if (node.filters.length)
          lines.push(sub + "pushed_filters=[" + predList(node.filters) + "]");
        lines.push(
          sub + "row_groups=" + node.scanGroups.length + "/" + node.groupsTotal +
            " scanned, " + (node.groupsTotal - node.scanGroups.length) +
            " skipped, " + fmtBytes(node.bytesRead) + " read" +
            (node.fetchLimit ? ", stops after " + node.fetchLimit + " rows" : "")
        );
        return;
      }
      case "Filter":
        lines.push(
          pad + "FilterExec " + exprToString(node.predicate) +
            (node.fetchLimit ? " (stops after " + node.fetchLimit + " rows)" : "")
        );
        break;
      case "Project":
        lines.push(pad + "ProjectionExec [" + node.columns.join(", ") + "]");
        break;
      case "Aggregate":
        lines.push(
          pad + "HashAggregate keys=[" + node.groupBy.join(", ") +
            "] aggs=[" + aggList(node.aggs) + "]"
        );
        break;
      case "Sort":
        lines.push(pad + "SortExec [" + keyList(node.keys) + "]");
        break;
      case "Limit":
        lines.push(pad + "LimitExec fetch=" + node.n);
        break;
      case "Join":
        lines.push(
          pad + node.phys + " " + node.leftKey + " = " + node.rightKey +
            (node.phys === "BroadcastHashJoin"
              ? " (build side ~" + fmtInt(node.buildRows) + " rows)"
              : " (both sides sorted on the key)")
        );
        printPhysical(node.left, depth + 1, lines, ds);
        printPhysical(node.right, depth + 1, lines, ds);
        return;
      default:
        lines.push(pad + node.op);
    }
    if (node.input) printPhysical(node.input, depth + 1, lines, ds);
  }

  function collectOps(node, depth, out) {
    var pad = new Array(depth + 1).join("  ");
    var label = pad + (node.phys || node.op);
    if (node.op === "Scan") label += " " + node.table;
    out.push({ label: label, m: node._m || null });
    if (node.op === "Join") {
      collectOps(node.left, depth + 1, out);
      collectOps(node.right, depth + 1, out);
    } else if (node.input) collectOps(node.input, depth + 1, out);
    return out;
  }

  /* ======================================================================
     11. Result materialization + comparison
     ====================================================================== */

  var COMPARE_CAP = 5000;

  function batchesToRows(batches, cols, cap) {
    var rows = [];
    for (var b = 0; b < batches.length && rows.length < cap; b++) {
      var batch = batches[b];
      for (var i = 0; i < batch.len && rows.length < cap; i++) {
        var r = new Array(cols.length);
        for (var c = 0; c < cols.length; c++) r[c] = batch.cols[cols[c]][i];
        rows.push(r);
      }
    }
    return rows;
  }

  function objRowsToRows(objRows, cols, cap) {
    var rows = [];
    for (var i = 0; i < objRows.length && i < cap; i++) {
      var r = new Array(cols.length);
      for (var c = 0; c < cols.length; c++) r[c] = objRows[i][cols[c]];
      rows.push(r);
    }
    return rows;
  }

  function canonical(rows) {
    var lines = new Array(rows.length);
    for (var i = 0; i < rows.length; i++) {
      var parts = new Array(rows[i].length);
      for (var c = 0; c < rows[i].length; c++) {
        var v = rows[i][c];
        parts[c] =
          typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : String(v);
      }
      lines[i] = parts.join("\u0001");
    }
    lines.sort();
    return lines.join("\n");
  }

  function fmtCell(v, name) {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") {
      if (!Number.isInteger(v)) return v.toFixed(2);
      // Surrogate keys are identifiers, not quantities: no thousands
      // separators on them.
      return name && /_sk$/.test(name) ? String(v) : fmtInt(v);
    }
    return String(v);
  }

  /* ======================================================================
     12. Presets
     ====================================================================== */

  var PRESETS = [
    'spark.table("store_sales")\n' +
      '  .join(spark.table("item"), "ss_item_sk == i_item_sk")\n' +
      '  .filter("ss_sold_date_sk >= 2451250 and ss_sold_date_sk <= 2451300")\n' +
      '  .filter("i_category == \'Electronics\'")\n' +
      '  .groupBy("i_brand")\n' +
      '  .agg(sum("ss_net_profit") as net_profit,\n' +
      '       count("*") as tickets,\n' +
      '       avg("ss_sales_price") as avg_price)\n' +
      '  .orderBy(desc("net_profit"))\n' +
      "  .limit(10)",

    "# A tight date range on a date-clustered column:\n" +
      "# most row groups can be skipped from their min/max alone.\n" +
      'spark.table("store_sales")\n' +
      '  .filter("ss_sold_date_sk >= 2451300 and ss_sold_date_sk < 2451320")\n' +
      '  .groupBy("ss_sold_date_sk")\n' +
      '  .agg(sum("ss_sales_price") as revenue, count("*") as tickets)\n' +
      '  .orderBy("ss_sold_date_sk")',

    "# An OR over two unclustered columns. Statistics cannot rule any row\n" +
      "# group out, so every group is read — pruning is a property of the\n" +
      "# data layout, not of the predicate alone.\n" +
      'spark.table("store_sales")\n' +
      '  .filter("ss_net_profit < -40 or ss_quantity > 22")\n' +
      '  .groupBy("ss_store_sk")\n' +
      '  .agg(count("*") as bad_tickets, sum("ss_net_profit") as profit)\n' +
      '  .orderBy(desc("bad_tickets"))',

    "# The filter here is a HAVING: it reads an aggregate output, so it\n" +
      "# must stay above the aggregation. Watch the optimizer refuse to\n" +
      "# push it down.\n" +
      'spark.table("store_sales")\n' +
      '  .groupBy("ss_store_sk")\n' +
      '  .agg(sum("ss_net_profit") as profit, count("*") as tickets)\n' +
      '  .filter("profit > 0")\n' +
      '  .orderBy(desc("profit"))',

    "# No aggregate: an arithmetic predicate, a narrow projection and a\n" +
      "# limit. Projection pushdown does most of the work here.\n" +
      'spark.table("store_sales")\n' +
      '  .filter("ss_sales_price * ss_quantity > 3000")\n' +
      '  .select("ss_sold_date_sk", "ss_item_sk", "ss_quantity", "ss_sales_price")\n' +
      '  .orderBy(desc("ss_sales_price"))\n' +
      "  .limit(15)"
  ];

  /* ======================================================================
     13. UI
     ====================================================================== */

  var $ = function (id) {
    return document.getElementById(id);
  };

  var ui = {
    program: $("program"),
    preset: $("preset"),
    run: $("run"),
    reset: $("reset"),
    error: $("error"),
    status: $("status"),
    summary: $("run-summary"),
    planA: $("plan-analyzed"),
    planO: $("plan-optimized"),
    rules: $("rules"),
    scans: $("scans"),
    mVec: $("m-vec"),
    mRow: $("m-row"),
    mSpeed: $("m-speedup"),
    mBytes: $("m-bytes"),
    mScanned: $("m-scanned"),
    mOut: $("m-out"),
    barVec: $("bar-vec"),
    barRow: $("bar-row"),
    barVecV: $("bar-vec-v"),
    barRowV: $("bar-row-v"),
    ops: $("ops").getElementsByTagName("tbody")[0],
    result: $("result"),
    resultWrap: $("result-wrap"),
    resultEmpty: $("result-empty"),
    resultCount: $("result-count"),
    resultCheck: $("result-check"),
    catalog: $("catalog"),
    ruleFilter: $("rule-filter"),
    ruleProjection: $("rule-projection"),
    ruleStats: $("rule-stats"),
    ruleBroadcast: $("rule-broadcast"),
    batch: $("batch"),
    scale: $("scale")
  };

  var DS = null;
  var dsRows = 0;

  function ensureDataset() {
    var want = parseInt(ui.scale.value, 10);
    if (!DS || dsRows !== want) {
      DS = buildDataset(want);
      dsRows = want;
      renderCatalog();
    }
    return DS;
  }

  function renderCatalog() {
    clear(ui.catalog);
    var names = ["store_sales", "item"];
    for (var i = 0; i < names.length; i++) {
      var t = DS[names[i]];
      var box = el("div", "catalog-table");
      var head = el(
        "b",
        null,
        t.name + " — " + fmtInt(t.nRows) + " rows, " +
          t.rowGroups.length + " row group" + (t.rowGroups.length === 1 ? "" : "s")
      );
      box.appendChild(head);
      for (var c = 0; c < t.columns.length; c++)
        box.appendChild(
          el("div", null, t.columns[c].name + " : " + t.columns[c].type)
        );
      ui.catalog.appendChild(box);
    }
  }

  function setStatus(state, text) {
    ui.status.setAttribute("data-state", state);
    ui.status.textContent = text;
  }

  function showError(e, src) {
    var msg = e.message;
    if (e.isQuery && e.qpos >= 0) {
      var lc = posToLineCol(src, e.qpos);
      if (lc) msg = "Line " + lc.line + ", column " + lc.col + ": " + msg;
    }
    ui.error.textContent = msg;
    ui.error.hidden = false;
    setStatus("error", "Query error");
    ui.summary.textContent = "Query error. " + msg;
  }

  function clearError() {
    ui.error.hidden = true;
    ui.error.textContent = "";
  }

  function ruleLine(kind, name, text) {
    var li = el("li");
    li.setAttribute("data-kind", kind);
    li.appendChild(el("span", "rule-name", name + ": "));
    li.appendChild(document.createTextNode(text));
    return li;
  }

  function renderRules(opt, opts, ds) {
    clear(ui.rules);
    var n = opt.notes;

    // Filter pushdown
    if (!opts.filterPushdown) {
      ui.rules.appendChild(
        ruleLine(
          "off",
          "Filter pushdown",
          "off — every predicate is evaluated where it was written, after the rows have already been read and joined."
        )
      );
    } else {
      var parts = [];
      if (n.pushed)
        for (var tbl in n.pushed)
          if (Object.prototype.hasOwnProperty.call(n.pushed, tbl))
            parts.push(
              n.pushed[tbl] + " into the " + tbl + " scan"
            );
      ui.rules.appendChild(
        ruleLine(
          "on",
          "Filter pushdown",
          parts.length
            ? "pushed " + parts.join(", ") + "."
            : "no predicate could move any further down."
        )
      );
      if (n.heldAgg && n.heldAgg.length)
        ui.rules.appendChild(
          ruleLine(
            "hold",
            "Held above the aggregate",
            n.heldAgg.join("; ") +
              " — it reads an aggregate output, so pushing it below the grouping would change the answer."
          )
        );
      if (n.heldJoin)
        ui.rules.appendChild(
          ruleLine(
            "hold",
            "Held at the join",
            n.heldJoin +
              " predicate(s) reference both sides, so they can only be evaluated after the join."
          )
        );
      if (n.heldLimit)
        ui.rules.appendChild(
          ruleLine(
            "hold",
            "Held above the limit",
            n.heldLimit +
              " predicate(s) sit above a LIMIT and cannot move below it."
          )
        );
    }

    // Projection pushdown
    var scans = opt.scans;
    var projParts = [];
    for (var i = 0; i < scans.length; i++) {
      var t = ds[scans[i].table];
      projParts.push(
        scans[i].table + " reads " + scans[i].readCols.length + " of " +
          t.columns.length + " columns"
      );
    }
    ui.rules.appendChild(
      ruleLine(
        opts.projection ? "on" : "off",
        "Projection pushdown",
        opts.projection
          ? projParts.join("; ") + "."
          : "off — " + projParts.join("; ") + " (the whole row is decoded)."
      )
    );

    // Statistics pruning
    if (!opts.stats) {
      ui.rules.appendChild(
        ruleLine("off", "Statistics pruning", "off — every row group is read.")
      );
    } else {
      var statParts = [];
      for (var s = 0; s < scans.length; s++) {
        var sc = scans[s];
        var skipped = sc.groupsTotal - sc.scanGroups.length;
        if (!sc.filters.length)
          statParts.push(
            sc.table + ": no predicate reached the scan, nothing to prune"
          );
        else if (skipped === 0)
          statParts.push(
            sc.table + ": 0 of " + sc.groupsTotal +
              " row groups skipped — the predicate is not provably false for any group"
          );
        else
          statParts.push(
            sc.table + ": " + skipped + " of " + sc.groupsTotal +
              " row groups skipped on " + (sc.prunedBy || "min/max")
          );
      }
      ui.rules.appendChild(
        ruleLine("on", "Statistics pruning", statParts.join("; ") + ".")
      );
    }

    // Join strategy
    if (n.broadcast)
      ui.rules.appendChild(
        ruleLine(
          "on",
          "Join strategy",
          "the " + n.broadcast.side + " side is small (~" +
            fmtInt(n.broadcast.rows) +
            " rows), so it is built into a hash table once and probed by every batch."
        )
      );
    else if (n.sortMerge)
      ui.rules.appendChild(
        ruleLine(
          "off",
          "Join strategy",
          "sort-merge join (" + n.sortMerge.why +
            ") — both inputs are fully materialized and sorted on the key first."
        )
      );
    else
      ui.rules.appendChild(
        ruleLine("off", "Join strategy", "no join in this query.")
      );

    if (n.limitPush)
      ui.rules.appendChild(
        ruleLine(
          "on",
          "Limit pushdown",
          "the " + n.limitPush.op + " stops as soon as " + n.limitPush.n +
            " rows have come out — nothing above it can ask for more."
        )
      );
  }

  function renderScans(opt, ds) {
    clear(ui.scans);
    var scans = opt.scans;
    for (var i = 0; i < scans.length; i++) {
      var sc = scans[i];
      var t = ds[sc.table];
      var box = el("div", "scan-block");
      box.appendChild(
        el(
          "p",
          "scan-title",
          "ParquetScan " + sc.table + " — " + fmtInt(t.nRows) + " rows in " +
            t.rowGroups.length + " row group" +
            (t.rowGroups.length === 1 ? "" : "s")
        )
      );

      // Column chips
      var chips = el("div", "cols-strip");
      for (var c = 0; c < t.columns.length; c++) {
        var name = t.columns[c].name;
        var read = sc.readCols.indexOf(name) >= 0;
        var chip = el("span", "col-chip");
        chip.setAttribute("data-state", read ? "read" : "pruned");
        chip.appendChild(document.createTextNode(name));
        chip.appendChild(
          el(
            "span",
            "col-state",
            read
              ? sc.filterOnly && sc.filterOnly[name]
                ? "read (filter)"
                : "read"
              : "not read"
          )
        );
        chips.appendChild(chip);
      }
      box.appendChild(chips);
      box.appendChild(
        el(
          "p",
          "scan-line",
          fmtBytes(sc.bytesRead) + " decoded of " + fmtBytes(sc.bytesTotal) +
            " in the file (" +
            Math.round((100 * sc.bytesRead) / Math.max(1, sc.bytesTotal)) +
            "%), at a modelled " + sc.bytesPerRowRead +
            " B per row over the " + fmtInt(sc.rowsInScannedGroups) +
            " rows in the groups it plans to read."
        )
      );

      // Row-group strip
      var skipped = sc.groupsTotal - sc.scanGroups.length;
      var strip = el("div", "rg-strip");
      strip.setAttribute("role", "img");
      strip.setAttribute(
        "aria-label",
        sc.scanGroups.length + " of " + sc.groupsTotal +
          " row groups scanned, " + skipped + " skipped by statistics"
      );
      var keep = {};
      for (var k = 0; k < sc.scanGroups.length; k++) keep[sc.scanGroups[k]] = 1;
      for (var g = 0; g < t.rowGroups.length; g++) {
        var cell = el("span", "rg");
        var state = keep[g] ? "scanned" : "skipped";
        cell.setAttribute("data-state", state);
        var firstCol = t.columns[0].name;
        cell.title =
          "row group " + g + " — " + state + " — " + firstCol + " " +
          t.rowGroups[g].stats[firstCol].min + ".." +
          t.rowGroups[g].stats[firstCol].max;
        strip.appendChild(cell);
      }
      box.appendChild(strip);
      box.appendChild(
        el(
          "p",
          "scan-line",
          sc.scanGroups.length + " of " + sc.groupsTotal +
            " row groups scanned, " + skipped + " skipped" +
            (sc.prunedBy ? " on " + sc.prunedBy + " min/max" : "") + "."
        )
      );
      ui.scans.appendChild(box);
    }
  }

  function renderOps(plan) {
    clear(ui.ops);
    var ops = collectOps(plan, 0, []);
    for (var i = 0; i < ops.length; i++) {
      var tr = el("tr");
      tr.appendChild(el("td", "mono", ops[i].label));
      tr.appendChild(el("td", "num", ops[i].m ? fmtInt(ops[i].m.rin) : "—"));
      tr.appendChild(el("td", "num", ops[i].m ? fmtInt(ops[i].m.rout) : "—"));
      ui.ops.appendChild(tr);
    }
  }

  function renderResult(cols, rows, totalRows, types, empty) {
    var head = ui.result.getElementsByTagName("thead")[0].rows[0];
    var body = ui.result.getElementsByTagName("tbody")[0];
    clear(head);
    clear(body);
    if (!totalRows) {
      ui.resultWrap.hidden = true;
      ui.resultEmpty.hidden = false;
      clear(ui.resultEmpty);
      ui.resultEmpty.appendChild(
        el("h3", null, empty ? empty.title : "No rows matched")
      );
      ui.resultEmpty.appendChild(
        el(
          "p",
          null,
          empty
            ? empty.text
            : "The plan ran and produced an empty result. Loosen a predicate — the date keys run from " +
              DATE_BASE + " to " + (DATE_BASE + DATE_SPAN - 1) + "."
        )
      );
      ui.resultCount.textContent = "";
      return;
    }
    ui.resultEmpty.hidden = true;
    ui.resultWrap.hidden = false;
    var c;
    for (c = 0; c < cols.length; c++) {
      var th = el("th", null, cols[c]);
      th.setAttribute("scope", "col");
      head.appendChild(th);
    }
    var shown = Math.min(rows.length, 20);
    for (var i = 0; i < shown; i++) {
      var tr = el("tr");
      for (c = 0; c < cols.length; c++) {
        var td = el(
          "td",
          types[c] === "string" ? null : "num",
          fmtCell(rows[i][c], cols[c])
        );
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    ui.resultCount.textContent =
      totalRows === shown
        ? fmtInt(totalRows) + " row" + (totalRows === 1 ? "" : "s") + "."
        : "Showing the first " + shown + " of " + fmtInt(totalRows) + " rows.";
  }

  /* A single run of a small query can finish well below the clock's
     resolution, so time a whole round of N runs and divide. N is calibrated
     upward until a round is long enough to measure, then the fastest
     per-run time across several rounds is reported. */
  function bench(fn, budgetMs) {
    var res = fn(); // warm-up, and the result we keep
    var reps = 1,
      best,
      s,
      e,
      i;
    for (;;) {
      s = nowMs();
      for (i = 0; i < reps; i++) res = fn();
      e = nowMs() - s;
      if (e >= 1 || reps >= 4096) {
        best = e / reps;
        break;
      }
      reps *= 4;
    }
    var t0 = nowMs(),
      rounds = 1,
      total = reps;
    while (nowMs() - t0 < budgetMs && rounds < 8) {
      s = nowMs();
      for (i = 0; i < reps; i++) res = fn();
      e = (nowMs() - s) / reps;
      if (e < best) best = e;
      rounds++;
      total += reps;
    }
    return { ms: best, iters: total, result: res };
  }

  function currentOpts() {
    return {
      filterPushdown: ui.ruleFilter.checked,
      projection: ui.ruleProjection.checked,
      stats: ui.ruleStats.checked,
      broadcast: ui.ruleBroadcast.checked
    };
  }

  var lastRunText = null;

  function run() {
    var src = ui.program.value;
    var ds = ensureDataset();
    var batchSize = parseInt(ui.batch.value, 10);
    var opts = currentOpts();
    lastRunText = src;

    var analyzed, opt;
    try {
      analyzed = analyze(parseProgram(src), ds);
      opt = optimize(analyzed, ds, opts);
    } catch (e) {
      showError(e, src);
      clear(ui.rules);
      clear(ui.scans);
      clear(ui.ops);
      ui.planA.textContent = "";
      ui.planO.textContent = "";
      renderResult([], [], 0, [], {
        title: "Nothing ran",
        text: "The program could not be planned. The note under the Run button says exactly where parsing or name resolution stopped."
      });
      ui.resultCheck.textContent = "not run";
      return;
    }
    clearError();

    var linesA = [];
    printLogical(analyzed, 0, linesA, ds);
    ui.planA.textContent = linesA.join("\n");
    var linesO = [];
    printPhysical(opt.plan, 0, linesO, ds);
    ui.planO.textContent = linesO.join("\n");

    renderRules(opt, opts, ds);
    renderScans(opt, ds);

    var outCols = opt.plan.outCols;
    var types = [];
    for (var c = 0; c < outCols.length; c++) {
      var f = findField(analyzed.schema, outCols[c]);
      types.push(f ? f.type : "double");
    }

    var vecRun, rowRun;
    try {
      vecRun = bench(function () {
        return runVectorized(opt.plan, ds, batchSize);
      }, 40);
      rowRun = bench(function () {
        return runRowAtATime(opt.plan, ds);
      }, 40);
    } catch (e2) {
      showError(e2, src);
      return;
    }

    var vecRows = batchesToRows(vecRun.result.batches, outCols, COMPARE_CAP);
    var rowRows = objRowsToRows(rowRun.result.rows, outCols, COMPARE_CAP);
    var totalVec = vecRun.result.rows;
    var totalRow = rowRun.result.rows.length;
    var identical =
      totalVec === totalRow && canonical(vecRows) === canonical(rowRows);

    // Metrics
    ui.mVec.textContent = fmtMs(vecRun.ms);
    ui.mRow.textContent = fmtMs(rowRun.ms);
    var ratio = vecRun.ms > 0 ? rowRun.ms / vecRun.ms : 0;
    ui.mSpeed.textContent = ratio ? ratio.toFixed(1) + "x" : "—";
    ui.mBytes.textContent = fmtBytes(opt.bytesRead);
    ui.mScanned.textContent = fmtInt(vecRun.result.st.rowsScanned);
    ui.mOut.textContent = fmtInt(totalVec);

    var worst = Math.max(vecRun.ms, rowRun.ms) || 1;
    ui.barVec.style.width = Math.max(2, (100 * vecRun.ms) / worst) + "%";
    ui.barRow.style.width = Math.max(2, (100 * rowRun.ms) / worst) + "%";
    ui.barVecV.textContent = fmtMs(vecRun.ms);
    ui.barRowV.textContent = fmtMs(rowRun.ms);

    renderOps(opt.plan);
    renderResult(outCols, vecRows, totalVec, types);

    ui.resultCheck.textContent = identical
      ? "both engines agree" + (totalVec > COMPARE_CAP
          ? " (first " + fmtInt(COMPARE_CAP) + " rows compared)"
          : "")
      : "engines disagree — please report";

    setStatus(
      "running",
      "Ran " + fmtInt(vecRun.iters + rowRun.iters) + " timed passes, best " +
        fmtMs(vecRun.ms)
    );
    ui.summary.textContent =
      "Query ran. Vectorized " + fmtMs(vecRun.ms) + ", row-at-a-time " +
      fmtMs(rowRun.ms) + ", ratio " + (ratio ? ratio.toFixed(1) : "0") +
      " times. " + opt.groupsScanned + " of " + opt.groupsTotal +
      " row groups scanned, " + fmtBytes(opt.bytesRead) + " read, " +
      fmtInt(totalVec) + " rows returned. Both engines " +
      (identical ? "returned the same rows." : "disagreed.");
  }

  /* ---------- wiring ---------- */

  function loadPreset() {
    ui.program.value = PRESETS[parseInt(ui.preset.value, 10)] || PRESETS[0];
  }

  ui.preset.addEventListener("change", function () {
    loadPreset();
    run();
  });

  ui.reset.addEventListener("click", function () {
    loadPreset();
    run();
  });

  ui.run.addEventListener("click", run);

  ui.program.addEventListener("input", function () {
    if (ui.program.value !== lastRunText)
      setStatus("warn", "Edited — press Run query");
  });

  ui.program.addEventListener("change", function () {
    if (ui.program.value !== lastRunText) run();
  });

  ui.program.addEventListener("keydown", function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
      ev.preventDefault();
      run();
    }
  });

  var reRunners = [
    ui.ruleFilter,
    ui.ruleProjection,
    ui.ruleStats,
    ui.ruleBroadcast,
    ui.batch,
    ui.scale
  ];
  for (var r = 0; r < reRunners.length; r++)
    reRunners[r].addEventListener("change", run);

  loadPreset();
  run();
})();
