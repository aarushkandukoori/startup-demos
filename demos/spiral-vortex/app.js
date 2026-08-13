/* ==========================================================================
   Cascading Encoding Explorer — app.js

   A small, real columnar compressor. Nothing here is mocked:

     * synthetic telemetry columns are generated from a seeded PRNG
     * each encoding really builds its buffers, so every byte count is measured
     * every encoding can decode a single row on its own, so the point-lookup
       cost is counted from the byte ranges actually read
     * the Parquet-style baseline really serialises pages and really runs an
       LZ77 codec over them; each page is decompressed back and compared

   No network, no dependencies, no build step.
   ========================================================================== */

(function () {
  "use strict";

  /* ----------------------------------------------------------------------
     0. Primitives
     ---------------------------------------------------------------------- */

  var TE = new TextEncoder();
  var TD = new TextDecoder();

  var POW10 = [
    1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12
  ];

  var BLOCK = 128; /* delta + blocked bit-packing block size */

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function bitsNeeded(max) {
    var b = 0;
    while (max > 0) {
      b++;
      max = Math.floor(max / 2);
    }
    return b;
  }

  function packedBytes(n, w) {
    return Math.ceil((n * w) / 8);
  }

  /* Bit-level pack / unpack. Arithmetic rather than 32-bit bitwise ops so a
     width of 32 is safe. */
  function packBits(values, w) {
    var out = new Uint8Array(packedBytes(values.length, w) + 1);
    if (w === 0) return out.subarray(0, 0);
    var bit = 0;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      for (var b = 0; b < w; b++) {
        if (v % 2 === 1) out[bit >> 3] |= 1 << (bit & 7);
        v = Math.floor(v / 2);
        bit++;
      }
    }
    return out.subarray(0, packedBytes(values.length, w));
  }

  function unpackAt(buf, w, i, baseByte) {
    if (w === 0) return 0;
    var bit = (baseByte || 0) * 8 + i * w;
    var v = 0;
    var p = 1;
    for (var b = 0; b < w; b++) {
      if (buf[bit >> 3] & (1 << (bit & 7))) v += p;
      p *= 2;
      bit++;
    }
    return v;
  }

  /* Bytes covering elements a..b of a bit-packed buffer — the real read span. */
  function spanBytes(w, a, b, baseByte) {
    if (w === 0) return 0;
    var base = (baseByte || 0) * 8;
    var first = Math.floor((base + a * w) / 8);
    var last = Math.floor((base + (b + 1) * w - 1) / 8);
    return last - first + 1;
  }

  function zigzag(v) {
    return v >= 0 ? v * 2 : -v * 2 - 1;
  }
  function unzigzag(v) {
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }

  function fmtBytes(b) {
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(b / 1024 < 10 ? 2 : 1) + " KB";
    return (b / 1048576).toFixed(2) + " MB";
  }

  function fmtInt(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function ratio(a, b) {
    if (!b) return "—";
    return (a / b).toFixed(2) + "×";
  }

  /* ----------------------------------------------------------------------
     1. Vectors
     ---------------------------------------------------------------------- */

  function makeVec(type, values, valid, elemBytes) {
    return {
      type: type,
      values: values,
      valid: valid || null,
      n: values.length,
      elemBytes: elemBytes || 8
    };
  }

  function intVec(values) {
    var mn = 0;
    var mx = 0;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (i === 0 || v < mn) mn = v;
      if (i === 0 || v > mx) mx = v;
    }
    var wide = mn < -2147483648 || mx > 2147483647;
    return makeVec("int", values, null, wide ? 8 : 4);
  }

  function strBytes(vec) {
    if (!vec.__bytes) {
      var out = new Array(vec.n);
      for (var i = 0; i < vec.n; i++) out[i] = TE.encode(vec.values[i]);
      vec.__bytes = out;
    }
    return vec.__bytes;
  }

  function rawBytes(vec) {
    var b;
    if (vec.type === "str") {
      var bs = strBytes(vec);
      b = 4 * (vec.n + 1);
      for (var i = 0; i < vec.n; i++) b += bs[i].length;
    } else {
      b = vec.elemBytes * vec.n;
    }
    if (vec.valid) b += Math.ceil(vec.n / 8);
    return b;
  }

  function minMax(values) {
    var mn = Infinity;
    var mx = -Infinity;
    for (var i = 0; i < values.length; i++) {
      if (values[i] < mn) mn = values[i];
      if (values[i] > mx) mx = values[i];
    }
    return [mn, mx];
  }

  /* Eight evenly spaced contiguous chunks, so runs and sortedness survive. */
  function takeSample(vec, k) {
    if (k >= vec.n) return vec;
    var per = Math.max(1, Math.floor(k / 8));
    var chunks = Math.max(1, Math.min(8, Math.floor(vec.n / per)));
    var stride = chunks > 1 ? Math.floor((vec.n - per) / (chunks - 1)) : 0;
    var vals = [];
    var valid = vec.valid ? [] : null;
    for (var c = 0; c < chunks; c++) {
      var start = Math.min(vec.n - per, c * stride);
      for (var j = 0; j < per; j++) {
        vals.push(vec.values[start + j]);
        if (valid) valid.push(vec.valid[start + j]);
      }
    }
    return makeVec(vec.type, vals, valid, vec.elemBytes);
  }

  /* ----------------------------------------------------------------------
     2. Encoding nodes
     ---------------------------------------------------------------------- */

  /* A node owns some bytes, may own child arrays that were themselves
     encoded, and can decode / cost a single row.

       own        bytes stored directly by this node
       children   [{label, node}]
       get(i)     decoded value at row i
       touch(i,p) bytes read to answer get(i); pushes {kind,bytes,detail}
                  onto p when p is an array
       range(a,b) bytes read to decode the contiguous span a..b            */
  function mkNode(o) {
    o.children = o.children || [];
    o.total = o.own;
    for (var i = 0; i < o.children.length; i++) o.total += o.children[i].node.total;
    if (!o.range) {
      o.range = function (a, b) {
        var s = 0;
        for (var i = a; i <= b; i++) s += o.touch(i, null);
        return s;
      };
    }
    return o;
  }

  function plainNode(vec) {
    if (vec.type === "str") {
      var bs = strBytes(vec);
      var data = 0;
      for (var i = 0; i < vec.n; i++) data += bs[i].length;
      return mkNode({
        kind: "Plain utf8",
        detail: fmtInt(vec.n + 1) + " offsets + " + fmtBytes(data),
        own: 4 * (vec.n + 1) + data,
        get: function (i) {
          return vec.values[i];
        },
        touch: function (i, p) {
          var b = 8 + bs[i].length;
          if (p) p.push({ kind: "Plain utf8", bytes: b, detail: "2 offsets + the string" });
          return b;
        }
      });
    }
    var w = vec.elemBytes;
    var label = vec.type === "float" ? "Plain f64" : w === 8 ? "Plain i64" : "Plain i32";
    return mkNode({
      kind: label,
      detail: w + " B × " + fmtInt(vec.n),
      own: w * vec.n,
      get: function (i) {
        return vec.values[i];
      },
      touch: function (i, p) {
        if (p) p.push({ kind: label, bytes: w, detail: "one fixed-width slot" });
        return w;
      },
      range: function (a, b) {
        return w * (b - a + 1);
      }
    });
  }

  /* -- constant ---------------------------------------------------------- */

  var encConstant = {
    id: "constant",
    always: true,
    applies: function (vec) {
      if (vec.n === 0) return false;
      var v0 = vec.values[0];
      for (var i = 1; i < vec.n; i++) if (vec.values[i] !== v0) return false;
      return true;
    },
    encode: function (vec) {
      var v = vec.values[0];
      var vb = vec.type === "str" ? TE.encode(v).length + 4 : 8;
      return mkNode({
        kind: "Constant",
        detail: JSON.stringify(v),
        own: vb + 8,
        get: function () {
          return v;
        },
        touch: function (i, p) {
          if (p) p.push({ kind: "Constant", bytes: vb, detail: "the single stored value" });
          return vb;
        },
        range: function () {
          return vb;
        }
      });
    }
  };

  /* -- flat bit-packing (leaf) ------------------------------------------- */

  var encBitPacked = {
    id: "bitpacked",
    always: true,
    applies: function (vec) {
      if (vec.type !== "int" || vec.n === 0) return false;
      var mm = minMax(vec.values);
      return mm[0] >= 0 && mm[1] <= 4294967295;
    },
    encode: function (vec) {
      var mm = minMax(vec.values);
      var w = bitsNeeded(mm[1]);
      var buf = packBits(vec.values, w);
      return mkNode({
        kind: "BitPacked",
        detail: "w=" + w + " bit" + (w === 1 ? "" : "s"),
        own: buf.length + 8,
        get: function (i) {
          return unpackAt(buf, w, i, 0);
        },
        touch: function (i, p) {
          var b = spanBytes(w, i, i, 0);
          if (p) p.push({ kind: "BitPacked w=" + w, bytes: b, detail: "bits " + i * w + "–" + ((i + 1) * w - 1) });
          return b;
        },
        range: function (a, b) {
          return spanBytes(w, a, b, 0);
        }
      });
    }
  };

  /* -- blocked bit-packing (per-block widths, FastLanes style) ----------- */

  var encBlocked = {
    id: "blocked",
    applies: function (vec) {
      if (vec.type !== "int" || vec.n === 0) return false;
      var mm = minMax(vec.values);
      return mm[0] >= 0 && mm[1] <= 4294967295 && vec.n > BLOCK;
    },
    encode: function (vec) {
      var nb = Math.ceil(vec.n / BLOCK);
      var widths = new Uint8Array(nb);
      var starts = new Int32Array(nb);
      var parts = new Array(nb);
      var off = 0;
      var wsum = 0;
      for (var b = 0; b < nb; b++) {
        var a = b * BLOCK;
        var e = Math.min(vec.n, a + BLOCK);
        var mx = 0;
        for (var i = a; i < e; i++) if (vec.values[i] > mx) mx = vec.values[i];
        var w = bitsNeeded(mx);
        widths[b] = w;
        wsum += w;
        starts[b] = off;
        var packed = packBits(vec.values.slice(a, e), w);
        parts[b] = packed;
        off += packed.length;
      }
      var buf = new Uint8Array(off);
      for (var b2 = 0; b2 < nb; b2++) buf.set(parts[b2], starts[b2]);
      var header = 5 * nb; /* one width byte + one 4-byte offset per block */
      return mkNode({
        kind: "BlockedBitPacked",
        detail:
          fmtInt(nb) + " blocks × " + BLOCK + ", widths " +
          minMax(Array.prototype.slice.call(widths))[0] + "–" +
          minMax(Array.prototype.slice.call(widths))[1] +
          " (avg " + (wsum / nb).toFixed(1) + ")",
        own: buf.length + header + 8,
        get: function (i) {
          var b = Math.floor(i / BLOCK);
          return unpackAt(buf, widths[b], i - b * BLOCK, starts[b]);
        },
        touch: function (i, p) {
          var b = Math.floor(i / BLOCK);
          var local = i - b * BLOCK;
          var bytes = spanBytes(widths[b], local, local, starts[b]) + 5;
          if (p)
            p.push({
              kind: "BlockedBitPacked",
              bytes: bytes,
              detail: "block " + b + " header + w=" + widths[b] + " bits"
            });
          return bytes;
        },
        range: function (a, b) {
          var ba = Math.floor(a / BLOCK);
          var bb = Math.floor(b / BLOCK);
          var s = 5 * (bb - ba + 1);
          for (var k = ba; k <= bb; k++) {
            var lo = Math.max(a, k * BLOCK) - k * BLOCK;
            var hi = Math.min(b, k * BLOCK + BLOCK - 1) - k * BLOCK;
            s += spanBytes(widths[k], lo, hi, starts[k]);
          }
          return s;
        }
      });
    }
  };

  /* -- frame of reference ------------------------------------------------ */

  var encFoR = {
    id: "for",
    applies: function (vec) {
      if (vec.type !== "int" || vec.n === 0) return false;
      var mm = minMax(vec.values);
      return mm[1] - mm[0] <= 4294967295 && mm[0] !== 0;
    },
    encode: function (vec, depth, opts) {
      var mm = minMax(vec.values);
      var mn = mm[0];
      var off = new Array(vec.n);
      for (var i = 0; i < vec.n; i++) off[i] = vec.values[i] - mn;
      var child = compress(intVec(off), depth - 1, opts);
      return mkNode({
        kind: "FoR",
        detail: "min=" + mn + ", range=" + fmtInt(mm[1] - mn),
        own: 16,
        children: [{ label: "offsets", node: child }],
        get: function (i) {
          return mn + child.get(i);
        },
        touch: function (i, p) {
          if (p) p.push({ kind: "FoR", bytes: 0, detail: "min lives in the resident header" });
          return child.touch(i, p);
        },
        range: function (a, b) {
          return child.range(a, b);
        }
      });
    }
  };

  /* -- blocked delta ----------------------------------------------------- */

  var encDelta = {
    id: "delta",
    applies: function (vec) {
      return vec.type === "int" && vec.n >= 2;
    },
    encode: function (vec, depth, opts) {
      var nb = Math.ceil(vec.n / BLOCK);
      var bases = new Array(nb);
      var deltas = new Array(vec.n);
      for (var b = 0; b < nb; b++) {
        var a = b * BLOCK;
        var e = Math.min(vec.n, a + BLOCK);
        bases[b] = vec.values[a];
        deltas[a] = 0;
        for (var i = a + 1; i < e; i++) deltas[i] = zigzag(vec.values[i] - vec.values[i - 1]);
      }
      var baseNode = compress(intVec(bases), depth - 1, opts);
      var deltaNode = compress(intVec(deltas), depth - 1, opts);
      return mkNode({
        kind: "Delta",
        detail: fmtInt(nb) + " blocks × " + BLOCK,
        own: 12,
        children: [
          { label: "block bases", node: baseNode },
          { label: "deltas", node: deltaNode }
        ],
        get: function (i) {
          var b = Math.floor(i / BLOCK);
          var v = baseNode.get(b);
          for (var j = b * BLOCK + 1; j <= i; j++) v += unzigzag(deltaNode.get(j));
          return v;
        },
        touch: function (i, p) {
          var b = Math.floor(i / BLOCK);
          var bb = baseNode.touch(b, null);
          var start = b * BLOCK;
          var db = i > start ? deltaNode.range(start + 1, i) : 0;
          if (p) {
            p.push({ kind: "Delta → block base", bytes: bb, detail: "base of block " + b });
            p.push({
              kind: "Delta → deltas",
              bytes: db,
              detail: (i - start) + " delta" + (i - start === 1 ? "" : "s") + " replayed from the block start"
            });
          }
          return bb + db;
        }
      });
    }
  };

  /* -- dictionary -------------------------------------------------------- */

  var encDict = {
    id: "dict",
    applies: function (vec) {
      if (vec.n === 0) return false;
      var seen = Object.create(null);
      var k = 0;
      var limit = Math.max(1, Math.floor(vec.n * 0.6));
      for (var i = 0; i < vec.n; i++) {
        var key = vec.type === "str" ? "s" + vec.values[i] : "n" + vec.values[i];
        if (seen[key] === undefined) {
          seen[key] = k++;
          if (k > limit || k > 65535) return false;
        }
      }
      return true;
    },
    encode: function (vec, depth, opts) {
      var seen = Object.create(null);
      var vals = [];
      var codes = new Array(vec.n);
      for (var i = 0; i < vec.n; i++) {
        var v = vec.values[i];
        var key = vec.type === "str" ? "s" + v : "n" + v;
        var c = seen[key];
        if (c === undefined) {
          c = vals.length;
          seen[key] = c;
          vals.push(v);
        }
        codes[i] = c;
      }
      var codeNode = compress(intVec(codes), depth - 1, opts);
      var valVec =
        vec.type === "str"
          ? makeVec("str", vals, null, 8)
          : makeVec(vec.type, vals, null, vec.elemBytes);
      var valNode = compress(valVec, depth - 1, opts);
      return mkNode({
        kind: "Dict",
        detail: fmtInt(vals.length) + " distinct of " + fmtInt(vec.n),
        own: 12,
        children: [
          { label: "codes", node: codeNode },
          { label: "values", node: valNode }
        ],
        get: function (i) {
          return valNode.get(codeNode.get(i));
        },
        touch: function (i, p) {
          var a = codeNode.touch(i, p);
          var code = codeNode.get(i);
          return a + valNode.touch(code, p);
        }
      });
    }
  };

  /* -- run-length -------------------------------------------------------- */

  var encRLE = {
    id: "rle",
    applies: function (vec) {
      if (vec.n === 0) return false;
      var runs = 1;
      for (var i = 1; i < vec.n; i++) if (vec.values[i] !== vec.values[i - 1]) runs++;
      return runs <= Math.max(1, Math.floor(vec.n * 0.6));
    },
    encode: function (vec, depth, opts) {
      var vals = [vec.values[0]];
      var ends = [];
      for (var i = 1; i < vec.n; i++) {
        if (vec.values[i] !== vec.values[i - 1]) {
          ends.push(i);
          vals.push(vec.values[i]);
        }
      }
      ends.push(vec.n);
      var endNode = compress(intVec(ends), depth - 1, opts);
      var valVec =
        vec.type === "str"
          ? makeVec("str", vals, null, 8)
          : makeVec(vec.type, vals, null, vec.elemBytes);
      var valNode = compress(valVec, depth - 1, opts);
      var R = ends.length;

      /* Binary search over run ends — the probes are the real read cost. */
      function findRun(i, p) {
        var lo = 0;
        var hi = R - 1;
        var bytes = 0;
        while (lo < hi) {
          var mid = (lo + hi) >> 1;
          bytes += endNode.touch(mid, null);
          if (endNode.get(mid) > i) hi = mid;
          else lo = mid + 1;
        }
        bytes += endNode.touch(lo, null);
        if (p)
          p.push({
            kind: "RLE → run ends",
            bytes: bytes,
            detail: "binary search over " + fmtInt(R) + " runs"
          });
        return { run: lo, bytes: bytes };
      }

      return mkNode({
        kind: "RLE",
        detail: fmtInt(R) + " runs, longest " + fmtInt(longestRun(ends)),
        own: 12,
        children: [
          { label: "run ends", node: endNode },
          { label: "run values", node: valNode }
        ],
        get: function (i) {
          return valNode.get(findRun(i, null).run);
        },
        touch: function (i, p) {
          var f = findRun(i, p);
          return f.bytes + valNode.touch(f.run, p);
        }
      });
    }
  };

  function longestRun(ends) {
    var best = 0;
    var prev = 0;
    for (var i = 0; i < ends.length; i++) {
      if (ends[i] - prev > best) best = ends[i] - prev;
      prev = ends[i];
    }
    return best;
  }

  /* -- ALP (decimal floats) ---------------------------------------------- */

  var encALP = {
    id: "alp",
    applies: function (vec) {
      return vec.type === "float" && vec.n > 0;
    },
    encode: function (vec, depth, opts) {
      var best = null;
      for (var e = 0; e < POW10.length; e++) {
        var f = POW10[e];
        var ints = new Array(vec.n);
        var ex = [];
        var lastGood = 0;
        var ok = true;
        for (var i = 0; i < vec.n; i++) {
          var v = vec.values[i];
          var x = Math.round(v * f);
          if (!isFinite(x) || Math.abs(x) > 9007199254740991 || x / f !== v) {
            ex.push(i);
            ints[i] = lastGood;
            if (ex.length > Math.max(4, vec.n * 0.05)) {
              ok = false;
              break;
            }
          } else {
            ints[i] = x;
            lastGood = x;
          }
        }
        if (!ok) continue;
        var mm = minMax(ints);
        var est = packedBytes(vec.n, bitsNeeded(mm[1] - mm[0])) + 12 * ex.length;
        if (!best || est < best.est) best = { e: e, ints: ints, ex: ex, est: est };
        if (ex.length === 0) break; /* smallest lossless exponent wins */
      }
      if (!best) return null;
      var f2 = POW10[best.e];
      var patch = Object.create(null);
      for (var k = 0; k < best.ex.length; k++) patch[best.ex[k]] = vec.values[best.ex[k]];
      var child = compress(intVec(best.ints), depth - 1, opts);
      var exCount = best.ex.length;
      return mkNode({
        kind: "ALP",
        detail:
          "e=" + best.e + ", " + fmtInt(exCount) + " patch" + (exCount === 1 ? "" : "es"),
        own: 8 + 12 * exCount,
        children: [{ label: "significands", node: child }],
        get: function (i) {
          if (patch[i] !== undefined) return patch[i];
          return child.get(i) / f2;
        },
        touch: function (i, p) {
          if (patch[i] !== undefined) {
            if (p) p.push({ kind: "ALP patch", bytes: 12, detail: "row is an exception" });
            return 12;
          }
          if (p) p.push({ kind: "ALP", bytes: 0, detail: "exponent lives in the resident header" });
          return child.touch(i, p);
        }
      });
    }
  };

  /* -- FSST-style string compression ------------------------------------- */

  function longestSymbol(map, bytes, p, end) {
    var maxL = Math.min(8, end - p);
    var key = "";
    var best = null;
    for (var L = 1; L <= maxL; L++) {
      key += String.fromCharCode(bytes[p + L - 1]);
      if (map[key] !== undefined) best = key;
    }
    return best;
  }

  function fsstTrain(samples) {
    var table = [];
    var map = Object.create(null);
    for (var round = 0; round < 4; round++) {
      var counts = Object.create(null);
      for (var s = 0; s < samples.length; s++) {
        var b = samples[s];
        var p = 0;
        var prev = null;
        while (p < b.length) {
          var sym = longestSymbol(map, b, p, b.length);
          var cur = sym !== null ? sym : String.fromCharCode(b[p]);
          counts[cur] = (counts[cur] || 0) + 1;
          if (prev !== null && prev.length + cur.length <= 8) {
            var cat = prev + cur;
            counts[cat] = (counts[cat] || 0) + 1;
          }
          prev = cur;
          p += cur.length;
        }
      }
      var keys = Object.keys(counts);
      keys.sort(function (x, y) {
        return counts[y] * (2 * y.length - 1) - counts[x] * (2 * x.length - 1);
      });
      table = keys.slice(0, 255); /* code 255 is the escape */
      map = Object.create(null);
      for (var i = 0; i < table.length; i++) map[table[i]] = i;
    }
    return { table: table, map: map };
  }

  function fsstBuild(vec) {
    if (vec.__fsst) return vec.__fsst;
    var bs = strBytes(vec);
    var step = Math.max(1, Math.floor(vec.n / 48));
    var samples = [];
    for (var i = 0; i < vec.n && samples.length < 48; i += step) samples.push(bs[i]);
    var t = fsstTrain(samples);
    var out = [];
    var offsets = new Array(vec.n + 1);
    for (var r = 0; r < vec.n; r++) {
      offsets[r] = out.length;
      var b = bs[r];
      var p = 0;
      while (p < b.length) {
        var sym = longestSymbol(t.map, b, p, b.length);
        if (sym === null) {
          out.push(255, b[p]);
          p += 1;
        } else {
          out.push(t.map[sym]);
          p += sym.length;
        }
      }
    }
    offsets[vec.n] = out.length;
    var tableBytes = 0;
    for (var k = 0; k < t.table.length; k++) tableBytes += t.table[k].length + 1;
    vec.__fsst = {
      table: t.table,
      buf: new Uint8Array(out),
      offsets: offsets,
      tableBytes: tableBytes
    };
    return vec.__fsst;
  }

  var encFSST = {
    id: "fsst",
    applies: function (vec) {
      if (vec.type !== "str" || vec.n === 0) return false;
      var bs = strBytes(vec);
      var total = 0;
      for (var i = 0; i < vec.n; i++) total += bs[i].length;
      return total >= 16;
    },
    encode: function (vec, depth, opts) {
      var f = fsstBuild(vec);
      var offNode = compress(intVec(f.offsets), depth - 1, opts);
      return mkNode({
        kind: "FSST",
        detail:
          fmtInt(f.table.length) + " symbols, table " + fmtBytes(f.tableBytes),
        own: f.buf.length + f.tableBytes + 8,
        children: [{ label: "offsets", node: offNode }],
        get: function (i) {
          var start = offNode.get(i);
          var end = offNode.get(i + 1);
          var bytes = [];
          var p = start;
          while (p < end) {
            var c = f.buf[p++];
            if (c === 255) {
              bytes.push(f.buf[p++]);
            } else {
              var s = f.table[c];
              for (var k = 0; k < s.length; k++) bytes.push(s.charCodeAt(k));
            }
          }
          return TD.decode(new Uint8Array(bytes));
        },
        touch: function (i, p) {
          var ob = offNode.touch(i, null) + offNode.touch(i + 1, null);
          var body = offNode.get(i + 1) - offNode.get(i);
          if (p) {
            p.push({ kind: "FSST → offsets", bytes: ob, detail: "two offsets" });
            p.push({
              kind: "FSST → codes",
              bytes: body,
              detail: "compressed bytes for this row (symbol table is resident)"
            });
          }
          return ob + body;
        }
      });
    }
  };

  var ENCODINGS = [
    encConstant,
    encBitPacked,
    encBlocked,
    encFoR,
    encDelta,
    encDict,
    encRLE,
    encALP,
    encFSST
  ];

  /* ----------------------------------------------------------------------
     3. The compressor
     ---------------------------------------------------------------------- */

  function fillNulls(vec) {
    var vals = new Array(vec.n);
    var last = vec.type === "str" ? "" : 0;
    for (var i = 0; i < vec.n; i++) {
      if (vec.valid[i]) last = vec.values[i];
      vals[i] = last;
    }
    return makeVec(vec.type, vals, null, vec.elemBytes);
  }

  function compress(vec, depth, opts) {
    if (vec.valid) {
      var nulls = 0;
      for (var i = 0; i < vec.n; i++) if (!vec.valid[i]) nulls++;
      var valid = vec.valid;
      var child = compress(fillNulls(vec), depth, opts);
      var bitmap = Math.ceil(vec.n / 8);
      return mkNode({
        kind: "Nullable",
        detail: fmtInt(nulls) + " null" + (nulls === 1 ? "" : "s") + ", " + fmtBytes(bitmap) + " bitmap",
        own: bitmap + 8,
        children: [{ label: "values", node: child }],
        get: function (i) {
          return valid[i] ? child.get(i) : null;
        },
        touch: function (i, p) {
          if (p) p.push({ kind: "Validity bitmap", bytes: 1, detail: "one byte of the bitmap" });
          if (!valid[i]) return 1;
          return 1 + child.touch(i, p);
        }
      });
    }

    var plain = plainNode(vec);
    if (depth <= 0 || vec.n === 0) return plain;

    var cands = [];
    for (var c = 0; c < ENCODINGS.length; c++) {
      var e = ENCODINGS[c];
      if ((e.always || opts.enabled[e.id]) && e.applies(vec)) cands.push(e);
    }
    if (!cands.length) return plain;

    /* Decide on a sample, then apply the winner to the whole column. */
    var probe = takeSample(vec, opts.sampleRows);
    var bestId = null;
    var bestBytes = plainNode(probe).total;
    for (var k = 0; k < cands.length; k++) {
      var trial = cands[k].encode(probe, depth, opts);
      if (trial && trial.total < bestBytes) {
        bestBytes = trial.total;
        bestId = cands[k].id;
      }
    }
    if (bestId === null) return plain;

    var winner = null;
    for (var w = 0; w < cands.length; w++) if (cands[w].id === bestId) winner = cands[w];
    var full = winner.encode(vec, depth, opts);
    if (!full || full.total >= plain.total) return plain;
    return full;
  }

  /* Flatten a tree to one readable line. */
  function treeText(node) {
    if (!node.children.length) return node.kind;
    var parts = [];
    for (var i = 0; i < node.children.length; i++) {
      parts.push(node.children[i].label + ": " + treeText(node.children[i].node));
    }
    return node.kind + "(" + parts.join(", ") + ")";
  }

  function verify(node, vec) {
    var bad = null;
    for (var i = 0; i < vec.n; i++) {
      var want = vec.valid && !vec.valid[i] ? null : vec.values[i];
      var got = node.get(i);
      if (got !== want) {
        bad = { i: i, want: want, got: got };
        break;
      }
    }
    return bad;
  }

  /* ----------------------------------------------------------------------
     4. LZ77 codec + Parquet-style baseline
     ---------------------------------------------------------------------- */

  /* Token stream:
       0xxxxxxx  literal run of (x+1) bytes, then those bytes
       1xxxxxxx  match of (x+4) bytes, then a 2-byte little-endian offset   */
  function lzCompress(src) {
    var n = src.length;
    var out = [];
    var hash = new Int32Array(1 << 14);
    for (var h = 0; h < hash.length; h++) hash[h] = -1;

    function hashAt(p) {
      var v = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;
      return (Math.imul(v, 2654435761) >>> 18) & 16383;
    }
    function flush(a, b) {
      while (b > a) {
        var run = Math.min(128, b - a);
        out.push(run - 1);
        for (var i = 0; i < run; i++) out.push(src[a + i]);
        a += run;
      }
    }

    var i = 0;
    var lit = 0;
    while (i + 4 <= n) {
      var hh = hashAt(i);
      var ref = hash[hh];
      hash[hh] = i;
      if (
        ref >= 0 &&
        i - ref <= 65535 &&
        src[ref] === src[i] &&
        src[ref + 1] === src[i + 1] &&
        src[ref + 2] === src[i + 2] &&
        src[ref + 3] === src[i + 3]
      ) {
        var len = 4;
        while (len < 131 && i + len < n && src[ref + len] === src[i + len]) len++;
        flush(lit, i);
        out.push(128 | (len - 4));
        var off = i - ref;
        out.push(off & 255, (off >> 8) & 255);
        for (var k = i + 1; k < i + len && k + 4 <= n; k++) hash[hashAt(k)] = k;
        i += len;
        lit = i;
      } else {
        i++;
      }
    }
    flush(lit, n);
    return new Uint8Array(out);
  }

  function lzDecompress(buf, outLen) {
    var out = new Uint8Array(outLen);
    var o = 0;
    var i = 0;
    while (i < buf.length && o < outLen) {
      var c = buf[i++];
      if (c < 128) {
        var l = c + 1;
        for (var k = 0; k < l; k++) out[o++] = buf[i++];
      } else {
        var m = (c & 127) + 4;
        var off = buf[i] | (buf[i + 1] << 8);
        i += 2;
        var s = o - off;
        for (var j = 0; j < m; j++) out[o + j] = out[s + j];
        o += m;
      }
    }
    return out;
  }

  function Writer() {
    this.b = [];
    this.scratch = new DataView(new ArrayBuffer(8));
  }
  Writer.prototype.u8 = function (v) {
    this.b.push(v & 255);
  };
  Writer.prototype.u32 = function (v) {
    this.b.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  };
  Writer.prototype.i64 = function (v) {
    var hi, lo;
    if (v < 0) {
      var m = -v;
      hi = Math.floor(m / 4294967296);
      lo = m - hi * 4294967296;
      lo = ~lo >>> 0;
      hi = ~hi >>> 0;
      lo = lo + 1;
      if (lo > 4294967295) {
        lo = 0;
        hi = (hi + 1) >>> 0;
      }
    } else {
      hi = Math.floor(v / 4294967296);
      lo = v - hi * 4294967296;
    }
    this.u32(lo);
    this.u32(hi);
  };
  Writer.prototype.f64 = function (v) {
    this.scratch.setFloat64(0, v, true);
    for (var i = 0; i < 8; i++) this.b.push(this.scratch.getUint8(i));
  };
  Writer.prototype.bytes = function (arr) {
    for (var i = 0; i < arr.length; i++) this.b.push(arr[i]);
  };
  Writer.prototype.done = function () {
    return new Uint8Array(this.b);
  };

  function writeValue(w, vec, v) {
    if (vec.type === "str") {
      var b = TE.encode(v);
      w.u32(b.length);
      w.bytes(b);
    } else if (vec.type === "float") {
      w.f64(v);
    } else if (vec.elemBytes === 8) {
      w.i64(v);
    } else {
      w.u32(v | 0);
    }
  }

  function baseline(vec, pageRows) {
    var distinct = Object.create(null);
    var vals = [];
    for (var i = 0; i < vec.n; i++) {
      if (vec.valid && !vec.valid[i]) continue;
      var key = vec.type === "str" ? "s" + vec.values[i] : "n" + vec.values[i];
      if (distinct[key] === undefined) {
        distinct[key] = vals.length;
        vals.push(vec.values[i]);
      }
    }
    var useDict = vals.length <= vec.n / 2 && vals.length <= 65535;

    var dictComp = 0;
    var dictRaw = 0;
    var codeWidth = 0;
    if (useDict) {
      var dw = new Writer();
      for (var d = 0; d < vals.length; d++) writeValue(dw, vec, vals[d]);
      var dictBuf = dw.done();
      dictRaw = dictBuf.length;
      dictComp = lzCompress(dictBuf).length;
      codeWidth = bitsNeeded(Math.max(0, vals.length - 1));
    }

    var pages = [];
    var totalComp = dictComp;
    var totalRaw = dictRaw;
    var verified = true;
    for (var a = 0; a < vec.n; a += pageRows) {
      var e = Math.min(vec.n, a + pageRows);
      var pw = new Writer();
      if (vec.valid) {
        var bm = new Uint8Array(Math.ceil((e - a) / 8));
        for (var r = a; r < e; r++) if (vec.valid[r]) bm[(r - a) >> 3] |= 1 << ((r - a) & 7);
        pw.bytes(bm);
      }
      if (useDict) {
        var codes = [];
        for (var c = a; c < e; c++) {
          if (vec.valid && !vec.valid[c]) continue;
          codes.push(distinct[vec.type === "str" ? "s" + vec.values[c] : "n" + vec.values[c]]);
        }
        pw.u8(codeWidth);
        pw.bytes(packBits(codes, codeWidth));
      } else {
        for (var p2 = a; p2 < e; p2++) {
          if (vec.valid && !vec.valid[p2]) continue;
          writeValue(pw, vec, vec.values[p2]);
        }
      }
      var raw = pw.done();
      var comp = lzCompress(raw);
      var back = lzDecompress(comp, raw.length);
      for (var v2 = 0; v2 < raw.length; v2++) {
        if (back[v2] !== raw[v2]) {
          verified = false;
          break;
        }
      }
      pages.push({ from: a, to: e, raw: raw.length, comp: comp.length });
      totalComp += comp.length;
      totalRaw += raw.length;
    }

    return {
      scheme: useDict ? "RLE_DICTIONARY page + LZ77 block" : "PLAIN page + LZ77 block",
      pages: pages,
      dictComp: dictComp,
      totalComp: totalComp,
      totalRaw: totalRaw,
      verified: verified,
      pageOf: function (i) {
        return pages[Math.floor(i / pageRows)];
      }
    };
  }

  /* ----------------------------------------------------------------------
     5. Synthetic data
     ---------------------------------------------------------------------- */

  var HEX = "0123456789abcdef";
  var REGIONS = ["us-east-1", "us-west-2", "eu-central-1", "ap-southeast-2", "sa-east-1"];
  var FIRMWARE = ["3.9.14", "4.11.2", "4.11.3", "4.12.0", "5.0.1", "5.0.2"];
  var STATUS = [200, 200, 200, 200, 200, 200, 204, 206, 400, 404, 429, 500, 503];

  var COLUMNS = [
    {
      id: "event_ts",
      type: "int",
      desc: "Ingest timestamp, milliseconds since epoch, non-decreasing with occasional stalls.",
      gen: function (rnd, n) {
        var t = Date.UTC(2026, 0, 14, 9, 0, 0);
        var out = new Array(n);
        for (var i = 0; i < n; i++) {
          t += 12 + Math.floor(rnd() * 180);
          if (rnd() < 0.004) t += 1500 + Math.floor(rnd() * 900);
          out[i] = t;
        }
        return { values: out, valid: null, elemBytes: 8 };
      }
    },
    {
      id: "device_id",
      type: "str",
      desc: "Device identifier drawn from a fleet of 64, skewed towards the chattiest devices.",
      gen: function (rnd, n) {
        var pool = [];
        for (var d = 0; d < 64; d++) {
          var s = "dev-";
          for (var h = 0; h < 4; h++) s += HEX[Math.floor(rnd() * 16)];
          pool.push(s);
        }
        var out = new Array(n);
        for (var i = 0; i < n; i++) out[i] = pool[Math.floor(Math.pow(rnd(), 2) * 64)];
        return { values: out, valid: null };
      }
    },
    {
      id: "region",
      type: "str",
      desc: "Ingest region; changes rarely, so the column is mostly long runs.",
      gen: function (rnd, n) {
        var cur = REGIONS[0];
        var out = new Array(n);
        for (var i = 0; i < n; i++) {
          if (rnd() < 0.02) cur = REGIONS[Math.floor(rnd() * REGIONS.length)];
          out[i] = cur;
        }
        return { values: out, valid: null };
      }
    },
    {
      id: "fw_version",
      type: "str",
      desc: "Firmware string; six values, in very long runs as fleets roll forward.",
      gen: function (rnd, n) {
        var cur = FIRMWARE[1];
        var out = new Array(n);
        for (var i = 0; i < n; i++) {
          if (rnd() < 0.004) cur = FIRMWARE[Math.floor(rnd() * FIRMWARE.length)];
          out[i] = cur;
        }
        return { values: out, valid: null };
      }
    },
    {
      id: "request_path",
      type: "str",
      desc: "Request path and query string: near-unique per row, but heavily shared structure.",
      gen: function (rnd, n) {
        var out = new Array(n);
        for (var i = 0; i < n; i++) {
          var dev = "";
          for (var h = 0; h < 4; h++) dev += HEX[Math.floor(rnd() * 16)];
          out[i] =
            "/v3/ingest/dev-" + dev + "/batch?seq=" + (100000 + i) + "&codec=lz4&ack=1";
        }
        return { values: out, valid: null };
      }
    },
    {
      id: "status_code",
      type: "int",
      desc: "HTTP status of the ingest call; thirteen weighted outcomes.",
      gen: function (rnd, n) {
        var out = new Array(n);
        for (var i = 0; i < n; i++) out[i] = STATUS[Math.floor(rnd() * STATUS.length)];
        return { values: out, valid: null, elemBytes: 4 };
      }
    },
    {
      id: "payload_bytes",
      type: "int",
      desc: "Compressed batch size in bytes; heavily right-skewed.",
      gen: function (rnd, n) {
        var out = new Array(n);
        for (var i = 0; i < n; i++) out[i] = Math.floor(120 + Math.pow(rnd(), 3) * 8600);
        return { values: out, valid: null, elemBytes: 4 };
      }
    },
    {
      id: "retry_count",
      type: "int",
      desc: "Retries before the batch landed; zero for the overwhelming majority of rows.",
      gen: function (rnd, n) {
        var out = new Array(n);
        for (var i = 0; i < n; i++) {
          var r = rnd();
          out[i] = r < 0.958 ? 0 : r < 0.99 ? 1 : r < 0.998 ? 2 : 3;
        }
        return { values: out, valid: null, elemBytes: 4 };
      }
    },
    {
      id: "battery_pct",
      type: "float",
      desc: "Battery level, one decimal place, drifting down over the window.",
      gen: function (rnd, n) {
        var out = new Array(n);
        for (var i = 0; i < n; i++) {
          out[i] = Math.round((100 - (i / n) * 55 - rnd() * 6) * 10) / 10;
        }
        return { values: out, valid: null };
      }
    },
    {
      id: "temp_c",
      type: "float",
      desc: "Enclosure temperature, two decimals, with rare full-precision sensor spikes.",
      gen: function (rnd, n) {
        var out = new Array(n);
        for (var i = 0; i < n; i++) {
          var v = 22 + Math.sin(i / 420) * 4.5 + rnd() * 1.8;
          out[i] = rnd() < 0.004 ? v : Math.round(v * 100) / 100;
        }
        return { values: out, valid: null };
      }
    },
    {
      id: "signal_dbm",
      type: "int",
      desc: "Radio signal strength; null whenever the device reported over wired backhaul.",
      gen: function (rnd, n) {
        var out = new Array(n);
        var valid = new Array(n);
        for (var i = 0; i < n; i++) {
          var ok = rnd() > 0.12;
          valid[i] = ok;
          out[i] = ok ? -110 + Math.floor(rnd() * 71) : 0;
        }
        return { values: out, valid: valid, elemBytes: 4 };
      }
    },
    {
      id: "tenant",
      type: "str",
      desc: "Tenant slug: this extract holds a single tenant, so the column is constant.",
      gen: function (rnd, n) {
        var out = new Array(n);
        for (var i = 0; i < n; i++) out[i] = "acme-prod";
        return { values: out, valid: null };
      }
    }
  ];

  function buildColumn(spec, seed, n) {
    var rnd = mulberry32(seed);
    var g = spec.gen(rnd, n);
    return makeVec(spec.type, g.values, g.valid, g.elemBytes || 8);
  }

  /* ----------------------------------------------------------------------
     6. UI
     ---------------------------------------------------------------------- */

  var API = {
    compress: compress,
    baseline: baseline,
    buildColumn: buildColumn,
    COLUMNS: COLUMNS,
    verify: verify,
    treeText: treeText,
    rawBytes: rawBytes,
    lzCompress: lzCompress,
    lzDecompress: lzDecompress
  };

  if (typeof module === "object" && module.exports) module.exports = API;
  if (typeof document === "undefined") return;

  var $ = function (id) {
    return document.getElementById(id);
  };

  var ui = {
    col: $("col"),
    colDesc: $("col-desc"),
    rows: $("rows"),
    rowsOut: $("rows-out"),
    depth: $("depth"),
    depthOut: $("depth-out"),
    sample: $("sample"),
    sampleOut: $("sample-out"),
    page: $("page"),
    newData: $("new-data"),
    reset: $("reset"),
    status: $("status"),
    mRaw: $("m-raw"),
    mCasc: $("m-casc"),
    mBase: $("m-base"),
    mTime: $("m-time"),
    sRaw: $("s-raw"),
    sCasc: $("s-casc"),
    sBase: $("s-base"),
    barRaw: $("bar-raw"),
    barBase: $("bar-base"),
    barCasc: $("bar-casc"),
    vRaw: $("v-raw"),
    vBase: $("v-base"),
    vCasc: $("v-casc"),
    sizeVerdict: $("size-verdict"),
    touchVerdict: $("touch-verdict"),
    sampleNote: $("sample-note"),
    tree: $("tree"),
    treeText: $("tree-text"),
    treeDepth: $("tree-depth"),
    rowRange: $("row-range"),
    rowNum: $("row-num"),
    rowOut: $("row-out"),
    rowRandom: $("row-random"),
    lookupValue: $("lookup-value"),
    barTBase: $("bar-tbase"),
    barTCasc: $("bar-tcasc"),
    vTBase: $("v-tbase"),
    vTCasc: $("v-tcasc"),
    parts: $("parts"),
    touchNote: $("touch-note"),
    verify: $("verify"),
    preview: $("preview"),
    sweep: $("sweep"),
    sweepWrap: $("sweep-wrap"),
    sweepBody: $("sweep-body"),
    sweepFoot: $("sweep-foot"),
    sweepNote: $("sweep-note")
  };

  var CAND = {
    dict: $("c-dict"),
    rle: $("c-rle"),
    delta: $("c-delta"),
    for: $("c-for"),
    blocked: $("c-blocked"),
    alp: $("c-alp"),
    fsst: $("c-fsst")
  };

  var state = {
    seed: 20260813,
    colIndex: 0,
    row: 0,
    result: null,
    vec: null
  };

  for (var ci = 0; ci < COLUMNS.length; ci++) {
    var opt = document.createElement("option");
    opt.value = String(ci);
    opt.textContent = COLUMNS[ci].id + "  (" + COLUMNS[ci].type + ")";
    ui.col.appendChild(opt);
  }

  function readOpts() {
    var enabled = {};
    for (var k in CAND) if (Object.prototype.hasOwnProperty.call(CAND, k)) enabled[k] = CAND[k].checked;
    return {
      enabled: enabled,
      sampleRows: parseInt(ui.sample.value, 10),
      depth: parseInt(ui.depth.value, 10),
      rows: parseInt(ui.rows.value, 10),
      pageRows: parseInt(ui.page.value, 10)
    };
  }

  function recompute() {
    var o = readOpts();
    var spec = COLUMNS[state.colIndex];
    var vec = buildColumn(spec, state.seed + state.colIndex * 7919, o.rows);
    var t0 = (window.performance || Date).now();

    var sampled = compress(vec, o.depth, { enabled: o.enabled, sampleRows: o.sampleRows });
    var exhaustive = compress(vec, o.depth, { enabled: o.enabled, sampleRows: Infinity });
    var base = baseline(vec, o.pageRows);
    var t1 = (window.performance || Date).now();

    var bad = verify(sampled, vec);

    state.vec = vec;
    state.result = {
      spec: spec,
      raw: rawBytes(vec),
      node: sampled,
      exhaustive: exhaustive,
      base: base,
      ms: t1 - t0,
      bad: bad,
      opts: o
    };

    ui.rowRange.max = String(vec.n - 1);
    ui.rowNum.max = String(vec.n - 1);
    if (state.row > vec.n - 1) setRow(vec.n - 1);

    render();
  }

  function render() {
    var r = state.result;
    if (!r) return;

    ui.colDesc.textContent = r.spec.desc;
    ui.mRaw.textContent = fmtBytes(r.raw);
    ui.sRaw.textContent = fmtInt(state.vec.n) + " values";
    ui.mCasc.textContent = fmtBytes(r.node.total);
    ui.sCasc.textContent = ratio(r.raw, r.node.total) + " smaller";
    ui.mBase.textContent = fmtBytes(r.base.totalComp);
    ui.sBase.textContent = ratio(r.raw, r.base.totalComp) + " smaller";
    ui.mTime.textContent = r.ms.toFixed(1) + " ms";

    var max = Math.max(r.raw, r.base.totalComp, r.node.total, 1);
    ui.barRaw.style.width = (r.raw / max) * 100 + "%";
    ui.barBase.style.width = (r.base.totalComp / max) * 100 + "%";
    ui.barCasc.style.width = (r.node.total / max) * 100 + "%";
    ui.vRaw.textContent = fmtBytes(r.raw);
    ui.vBase.textContent = fmtBytes(r.base.totalComp);
    ui.vCasc.textContent = fmtBytes(r.node.total);

    if (r.node.total < r.base.totalComp) {
      ui.sizeVerdict.className = "note note-accent";
      ui.sizeVerdict.textContent =
        "Cascaded encodings store this column " + ratio(r.base.totalComp, r.node.total) +
        " smaller than the page-compressed baseline, and every buffer stays addressable — see the lookup below.";
    } else {
      ui.sizeVerdict.className = "note";
      ui.sizeVerdict.textContent =
        "The baseline stores this column " + ratio(r.node.total, r.base.totalComp) +
        " smaller here: a general-purpose block compressor finds redundancy across a whole page that per-array encodings cannot. What it gives up is addressability — see the lookup below.";
    }

    var d = r.exhaustive.total - r.node.total;
    var covered = r.opts.sampleRows >= r.opts.rows;
    if (covered) {
      ui.sampleNote.textContent =
        "The sample covers all " + fmtInt(r.opts.rows) +
        " rows, so the compressor's choice is already the exhaustive one.";
      ui.sampleNote.className = "note";
    } else if (d === 0) {
      ui.sampleNote.textContent =
        "Deciding from " + fmtInt(r.opts.sampleRows) + " sampled rows picked the same layout as an exhaustive search over all " +
        fmtInt(r.opts.rows) + " rows: " + treeText(r.exhaustive) + ".";
      ui.sampleNote.className = "note note-accent";
    } else if (d < 0) {
      ui.sampleNote.textContent =
        "Sampling misjudged this column. Deciding from " + fmtInt(r.opts.sampleRows) +
        " rows costs " + fmtBytes(-d) + " more than an exhaustive search, which would have chosen " +
        treeText(r.exhaustive) + ".";
      ui.sampleNote.className = "note note-warn";
    } else {
      ui.sampleNote.textContent =
        "Deciding from " + fmtInt(r.opts.sampleRows) + " sampled rows happened to beat the exhaustive search by " +
        fmtBytes(d) + " — the greedy exhaustive choice is not always the global optimum.";
      ui.sampleNote.className = "note note-accent";
    }

    ui.treeDepth.textContent = "depth " + r.opts.depth;
    ui.tree.innerHTML = "";
    ui.tree.appendChild(renderNode(r.node, null, r.node.total));
    ui.treeText.textContent = treeText(r.node);

    if (r.bad) {
      ui.verify.dataset.state = "error";
      ui.verify.textContent =
        "mismatch at row " + r.bad.i + ": expected " + JSON.stringify(r.bad.want) + ", got " + JSON.stringify(r.bad.got);
    } else if (!r.base.verified) {
      ui.verify.dataset.state = "error";
      ui.verify.textContent = "a baseline page failed to decompress to identical bytes";
    } else {
      ui.verify.dataset.state = "running";
      ui.verify.textContent =
        fmtInt(state.vec.n) + "/" + fmtInt(state.vec.n) + " values round-trip · " +
        r.base.pages.length + " baseline page" + (r.base.pages.length === 1 ? "" : "s") + " verified";
    }

    ui.preview.innerHTML = "";
    var lim = Math.min(8, state.vec.n);
    for (var i = 0; i < lim; i++) {
      var tr = document.createElement("tr");
      var want = state.vec.valid && !state.vec.valid[i] ? null : state.vec.values[i];
      var got = r.node.get(i);
      tr.appendChild(cell(String(i), "num"));
      tr.appendChild(cell(show(want), "mono"));
      tr.appendChild(cell(show(got), "mono"));
      tr.appendChild(cell(got === want ? "✓ match" : "✗ differs", ""));
      ui.preview.appendChild(tr);
    }

    ui.status.dataset.state = r.bad || !r.base.verified ? "error" : "running";
    ui.status.textContent = r.bad ? "round-trip failed" : "ready";

    renderLookup();
  }

  function cell(text, cls) {
    var td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }

  function show(v) {
    if (v === null) return "NULL";
    if (typeof v === "string") return v.length > 44 ? v.slice(0, 41) + "…" : v;
    return String(v);
  }

  function renderNode(node, label, rootTotal) {
    var wrap = document.createElement("div");
    wrap.className = "tnode";

    var head = document.createElement("div");
    head.className = "tnode-head";

    if (label) {
      var lab = document.createElement("span");
      lab.className = "tlabel";
      lab.textContent = label;
      head.appendChild(lab);
    }

    var kind = document.createElement("span");
    kind.className = "tkind";
    kind.textContent = node.kind;
    head.appendChild(kind);

    var det = document.createElement("span");
    det.className = "tdetail";
    det.textContent = node.detail || "";
    head.appendChild(det);

    var bytes = document.createElement("span");
    bytes.className = "tbytes tnum";
    bytes.textContent = fmtBytes(node.total);
    head.appendChild(bytes);

    wrap.appendChild(head);

    var meter = document.createElement("span");
    meter.className = "bar tmeter";
    var fill = document.createElement("span");
    fill.style.width = (node.total / Math.max(1, rootTotal)) * 100 + "%";
    meter.appendChild(fill);
    wrap.appendChild(meter);

    if (node.children.length) {
      var kids = document.createElement("div");
      kids.className = "tkids";
      for (var i = 0; i < node.children.length; i++) {
        kids.appendChild(renderNode(node.children[i].node, node.children[i].label, rootTotal));
      }
      wrap.appendChild(kids);
    }
    return wrap;
  }

  function renderLookup() {
    var r = state.result;
    if (!r) return;
    var i = state.row;

    var parts = [];
    var cascBytes = r.node.touch(i, parts);
    var page = r.base.pageOf(i);
    var baseBytes = page ? page.comp : 0;
    var value = r.node.get(i);

    ui.lookupValue.textContent = show(value);
    var max = Math.max(cascBytes, baseBytes, 1);
    ui.barTCasc.style.width = (cascBytes / max) * 100 + "%";
    ui.barTBase.style.width = (baseBytes / max) * 100 + "%";
    ui.vTCasc.textContent = fmtBytes(cascBytes);
    ui.vTBase.textContent = fmtBytes(baseBytes);

    ui.parts.innerHTML = "";
    for (var p = 0; p < parts.length; p++) {
      var li = document.createElement("li");
      var k = document.createElement("span");
      k.className = "part-kind";
      k.textContent = parts[p].kind;
      var b = document.createElement("span");
      b.className = "part-bytes tnum";
      b.textContent = fmtInt(parts[p].bytes) + " B";
      var dd = document.createElement("span");
      dd.className = "part-detail";
      dd.textContent = parts[p].detail;
      li.appendChild(k);
      li.appendChild(b);
      li.appendChild(dd);
      ui.parts.appendChild(li);
    }

    var dom = null;
    for (var q = 0; q < parts.length; q++) if (!dom || parts[q].bytes > dom.bytes) dom = parts[q];
    var domText = dom && dom.bytes > 0
      ? " The largest single read is " + dom.kind + " at " + fmtInt(dom.bytes) + " B."
      : "";
    if (cascBytes < baseBytes) {
      ui.touchVerdict.className = "note note-accent";
      ui.touchVerdict.textContent =
        "The cascaded layout reads " + ratio(baseBytes, cascBytes) + " fewer bytes for this row: " +
        fmtBytes(cascBytes) + " against " + fmtBytes(baseBytes) + "." + domText;
    } else {
      ui.touchVerdict.className = "note note-warn";
      ui.touchVerdict.textContent =
        "The cascaded layout reads more for this row: " + fmtBytes(cascBytes) + " against " +
        fmtBytes(baseBytes) + "." + domText +
        " Smallest and most seekable are different objectives, and this tree was chosen for size alone.";
    }

    var pi = r.base.pages.indexOf(page);
    ui.touchNote.textContent =
      "The baseline stores this column as " + r.base.scheme +
      ". Row " + fmtInt(i) + " sits in page " + (pi + 1) + " of " + r.base.pages.length +
      " (rows " + fmtInt(page.from) + "–" + fmtInt(page.to - 1) + "), so all " +
      fmtBytes(page.comp) + " of that page must be read and inflated to reach it. " +
      "Dictionary pages and the FSST symbol table are treated as already resident in both models.";
  }

  /* `src` is the control the change came from; it is left alone so typing in
     the number field is not fought by a write-back on every keystroke. */
  function setRow(v, src) {
    var n = state.vec ? state.vec.n : parseInt(ui.rows.value, 10);
    if (isNaN(v)) v = 0;
    v = Math.max(0, Math.min(n - 1, Math.round(v)));
    state.row = v;
    if (src !== ui.rowRange) ui.rowRange.value = String(v);
    if (src !== ui.rowNum) ui.rowNum.value = String(v);
    ui.rowOut.textContent = fmtInt(v);
    renderLookup();
  }

  function runSweep() {
    var o = readOpts();
    ui.sweepNote.textContent = "Compressing " + COLUMNS.length + " columns…";
    ui.sweep.disabled = true;
    var t0 = (window.performance || Date).now();
    var rowsRaw = 0;
    var rowsBase = 0;
    var rowsCasc = 0;
    var frag = document.createDocumentFragment();

    for (var c = 0; c < COLUMNS.length; c++) {
      var vec = buildColumn(COLUMNS[c], state.seed + c * 7919, o.rows);
      var node = compress(vec, o.depth, { enabled: o.enabled, sampleRows: o.sampleRows });
      var b = baseline(vec, o.pageRows);
      var raw = rawBytes(vec);
      rowsRaw += raw;
      rowsBase += b.totalComp;
      rowsCasc += node.total;

      var tr = document.createElement("tr");
      tr.appendChild(cell(COLUMNS[c].id, "mono"));
      tr.appendChild(cell(fmtBytes(raw), "num"));
      tr.appendChild(cell(fmtBytes(b.totalComp), "num"));
      tr.appendChild(cell(fmtBytes(node.total), "num"));
      tr.appendChild(cell(ratio(raw, node.total), "num"));
      tr.appendChild(cell(treeText(node), "mono"));
      frag.appendChild(tr);
    }

    ui.sweepBody.innerHTML = "";
    ui.sweepBody.appendChild(frag);
    ui.sweepFoot.innerHTML = "";
    var tf = document.createElement("tr");
    tf.appendChild(cell("all columns", "mono"));
    tf.appendChild(cell(fmtBytes(rowsRaw), "num"));
    tf.appendChild(cell(fmtBytes(rowsBase), "num"));
    tf.appendChild(cell(fmtBytes(rowsCasc), "num"));
    tf.appendChild(cell(ratio(rowsRaw, rowsCasc), "num"));
    tf.appendChild(cell("baseline " + ratio(rowsRaw, rowsBase) + " over the same table", ""));
    ui.sweepFoot.appendChild(tf);

    var t1 = (window.performance || Date).now();
    ui.sweepWrap.hidden = false;
    ui.sweep.disabled = false;
    ui.sweepNote.textContent =
      COLUMNS.length + " columns × " + fmtInt(o.rows) + " rows compressed in " +
      (t1 - t0).toFixed(0) + " ms, in this tab, from generated data.";
  }

  /* -- events ------------------------------------------------------------ */

  var pending = null;
  function schedule() {
    ui.status.dataset.state = "warn";
    ui.status.textContent = "recompressing…";
    if (pending) clearTimeout(pending);
    pending = setTimeout(function () {
      pending = null;
      recompute();
    }, 60);
  }

  ui.col.addEventListener("change", function () {
    state.colIndex = parseInt(ui.col.value, 10);
    recompute();
  });

  ui.rows.addEventListener("input", function () {
    ui.rowsOut.textContent = fmtInt(parseInt(ui.rows.value, 10));
    schedule();
  });

  ui.depth.addEventListener("input", function () {
    ui.depthOut.textContent = ui.depth.value;
    schedule();
  });

  ui.sample.addEventListener("input", function () {
    ui.sampleOut.textContent = fmtInt(parseInt(ui.sample.value, 10));
    schedule();
  });

  ui.page.addEventListener("change", recompute);

  for (var key in CAND) {
    if (Object.prototype.hasOwnProperty.call(CAND, key)) {
      CAND[key].addEventListener("change", recompute);
    }
  }

  ui.newData.addEventListener("click", function () {
    state.seed = (state.seed + 104729) % 2147483647;
    recompute();
  });

  ui.reset.addEventListener("click", function () {
    state.seed = 20260813;
    state.colIndex = 0;
    state.row = 0;
    ui.col.value = "0";
    ui.rows.value = "2000";
    ui.rowsOut.textContent = "2,000";
    ui.depth.value = "3";
    ui.depthOut.textContent = "3";
    ui.sample.value = "256";
    ui.sampleOut.textContent = "256";
    ui.page.value = "4096";
    for (var k in CAND) if (Object.prototype.hasOwnProperty.call(CAND, k)) CAND[k].checked = true;
    ui.sweepWrap.hidden = true;
    ui.sweepNote.textContent = "";
    recompute();
    setRow(0);
  });

  ui.rowRange.addEventListener("input", function () {
    setRow(parseInt(ui.rowRange.value, 10), ui.rowRange);
  });

  ui.rowNum.addEventListener("input", function () {
    var raw = ui.rowNum.value.trim();
    if (raw === "" || raw === "-") return; /* mid-edit, leave it alone */
    var v = parseInt(raw, 10);
    if (isNaN(v)) return;
    var n = state.vec ? state.vec.n : 1;
    var clamped = Math.max(0, Math.min(n - 1, v));
    setRow(clamped, clamped === v ? ui.rowNum : null);
  });

  ui.rowRandom.addEventListener("click", function () {
    setRow(Math.floor(Math.random() * state.vec.n));
  });

  ui.sweep.addEventListener("click", runSweep);

  recompute();
  setRow(0);
})();
