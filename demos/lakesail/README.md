# DataFrame Plan Optimizer Playground

Write a PySpark-style DataFrame program in the box. The page tokenizes it,
parses it into a logical plan, resolves every name against a synthetic catalog,
runs four optimizer rules over it, and then executes the resulting physical plan
twice in your browser — once with a vectorized batch-at-a-time engine and once
with a row-at-a-time Volcano interpreter — over the same synthetic columnar
data. Toggle a rule off and the plan, the bytes read, the row groups touched and
the wall time all change, while the answer stays byte-for-byte identical.

**Inspired by:** LakeSail (lakesail.com) — "Sail: Rust drop-in Spark replacement
built on Apache DataFusion (~4x faster)". An independent mini-demo built by
Aarush Kandukoori, inspired by LakeSail's public product description. Not
affiliated with LakeSail.

## How it works

**Front end.** A hand-written tokenizer feeds a recursive-descent parser for the
DataFrame chain (`spark.table`, `filter`/`where`, `select`, `join`, `groupBy`,
`agg`, `orderBy`, `limit`). The string inside `filter("…")` gets its own
recursive-descent expression parser with the usual precedence ladder — OR, AND,
NOT, comparison, `+ -`, `* /`, unary minus, parentheses. Errors carry a source
offset, so a bad program reports the line and column where parsing stopped, and
an unresolved column is matched against the catalog by Levenshtein distance to
suggest the name you probably meant.

**Analyzer.** Bottom-up walk that attaches an output schema to every node,
validates each referenced column against its input, and types the aggregate
outputs (`count` → int, `min`/`max` → the source type, `sum`/`avg` → double).

**Optimizer.** Four rules, each independently switchable:

- *Filter pushdown* splits conjunctions and pushes each predicate as far down as
  it is legal to go. It pushes through `Project` and `Sort`; it splits at a
  `Join` by which side's schema covers the predicate's columns and leaves the
  rest above the join; it refuses to push through a `Limit`; and it pushes
  through an `Aggregate` only when every referenced column is a grouping key —
  so a HAVING clause correctly stays above the aggregation. Predicates that
  reach a scan become pushed-down scan filters.
- *Projection pushdown* computes the required-column set top-down and has each
  scan read only those columns, plus any column a pushed-down predicate needs
  (those are labelled "read (filter)" in the Scan I/O panel). A query
  whose only aggregate is `count("*")` ends up reading zero columns.
- *Row-group statistics pruning* walks each scan's pushed-down predicates
  against per-row-group min/max statistics and skips a group only when the
  predicate is provably false over its whole range (`col > v` with `max <= v`,
  `col == v` outside `[min, max]`, and so on). Anything it cannot prove — an OR,
  an arithmetic expression, a `!=`, a type mismatch — prunes nothing, which is
  why one of the example queries deliberately skips zero groups.
- *Join strategy* builds a hash table from the small side and probes it once per
  batch when the build side is small; with the rule off it falls back to a real
  sort-merge join that materializes and sorts both inputs on the key.

A fifth rule, limit pushdown, is always on: a `LIMIT` lets the scan or filter
under it stop early, but only through operators that preserve row counts.

**Execution.** Two complete interpreters over the same physical plan:

- The *vectorized* engine passes `{len, cols}` batches of column arrays
  (`Int32Array` / `Float64Array` / string arrays). Predicates compile to
  selection masks with the operator branch hoisted out of the inner loop;
  filtering compacts a batch through a gather; joins gather from index arrays;
  aggregation is a hash map over typed-array reads.
- The *row-at-a-time* engine is a classic Volcano pipeline of `next()` closures.
  Each row is materialized as a JavaScript object and every predicate is walked
  as a tree per row, one dynamic dispatch at a time.

Both are timed with `performance.now()`, best-of over several repeats, and their
outputs are compared as multisets — the page tells you if they ever disagree.

## What's synthetic

Everything. Nothing here is scraped, measured on real hardware, or taken from
any company.

- **The data.** A two-table star schema generated in-browser by a seeded PRNG
  (`mulberry32`), so it is identical on every load: a `store_sales` fact table of
  6,000 / 24,000 / 60,000 rows and a 240-row `item` dimension. Column names echo
  the TPC-DS shape because that is the vocabulary; the values do not come from
  TPC-DS. Item popularity and store traffic are power-skewed, sales are laid out
  in date order with jitter (which is what makes min/max statistics useful), and
  brand labels are invented words.
- **The file layout.** "Row groups" are 1,000-row slices with real min/max
  statistics computed from the data. There is no Parquet file — no pages, no
  encodings, no compression, no dictionary pages, no I/O.
- **The byte counts.** Modelled, not measured: 4 B per int, 8 B per double, 2 B
  per dictionary-coded string, multiplied by the rows in the scanned row groups.
  They describe the planned scan, so they do not shrink when limit pushdown lets
  the scan stop early. A real reader's numbers would depend on encoding and
  compression.
- **The timings.** Real measurements of this page's own JavaScript, in your
  browser, on datasets that fit in a typed array. They say something about
  vectorized versus row-at-a-time evaluation and nothing about Rust, JVMs,
  clusters, or any product's benchmark. Read the ratio, ignore the absolutes.

Simplifications a real engine would not make: single-threaded and single-process
with no partitioning or shuffle; inner equi-joins only, on one key; no NULLs, no
type coercion, no subqueries or window functions; the cardinality estimator that
picks the join strategy is a fixed-fraction guess rather than histograms; sort
and aggregate materialize their whole input instead of spilling.

## Run it

Open `index.html` in a browser. No build step, no dependencies, no network
requests — it behaves identically with networking switched off.
