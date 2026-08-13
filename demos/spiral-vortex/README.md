# Cascading Encoding Explorer

Pick a column out of a synthetic telemetry table and watch a sampling compressor
build a *tree* of encodings for it — dictionary over run-length over bit-packing,
ALP over delta, FSST over frame-of-reference — then read a single row back out of
that tree and count the bytes it actually touched. A page-compressed,
Parquet-shaped baseline is compressed alongside it for comparison, so you can see
the two things that pull against each other in a file format: how small a column
gets, and how cheaply you can reach one row inside it.

Every byte on the page is measured, not estimated. The encodings really build
their buffers, every value is decoded back out and compared with the value that
went in, and each baseline page is decompressed and checked byte for byte on
every run.

**Inspired by:** Spiral (Vortex) ([spiraldb.com](https://spiraldb.com)) — "Vortex:
a Rust next-gen columnar file format positioned as Parquet's successor."
Built by Aarush Kandukoori with AI assistance. An independent mini-demo
inspired by Spiral (Vortex)'s public product description; not affiliated
with Spiral (Vortex).

## How it works

**Encodings.** Nine are implemented, each of which can encode an array, decode a
single row from it, and report the byte range it read to do so:

| Encoding | What it stores | Point lookup |
| --- | --- | --- |
| `Constant` | one value | the value |
| `BitPacked` | one global bit width | the 1–5 bytes spanning that row's bits |
| `BlockedBitPacked` | a width per 128-value block, FastLanes-style | block header + that row's bits |
| `FoR` | a min, plus offsets handed downward | whatever the child costs |
| `Delta` | a base per 128-row block, plus zig-zag deltas | base + every delta from the block start |
| `Dict` | codes + distinct values, both handed downward | code, then the value at that code |
| `RLE` | run ends + run values, both handed downward | binary search over run ends, then the value |
| `ALP` | a decimal exponent, integer significands, exception patches | patch, or the child significand |
| `FSST` | a trained symbol table + per-row offsets | two offsets + that row's compressed bytes |
| `Nullable` | a validity bitmap wrapping any of the above | one bitmap byte + the child |

**Cascading.** The buffers an encoding produces are themselves arrays, so they go
back through the compressor. `Dict` hands its codes down and they come back
bit-packed; `FSST` hands its offsets down and they come back delta-coded; `RLE`
hands its run ends down. The *Cascade depth* control caps how many times this can
happen, and the tree in panel 2 is the result — the byte figure on each node
includes everything below it.

**Choosing.** The compressor does not try every encoding on the whole column. It
takes eight evenly spaced contiguous chunks totalling *Sample rows*, fully
encodes the sample with each applicable candidate, and applies only the winner to
the real column — the same sample-then-commit shape a real format compressor
uses, and the reason contiguous chunks are used rather than random rows (runs and
sortedness have to survive sampling). The page then *also* runs an exhaustive
search over the full column and tells you when the sampled choice was wrong and
by how many bytes. Turn *Sample rows* down to 32 and most columns get misjudged;
turn it up and they converge.

**Point lookups.** `touch(i)` walks the same tree the decoder walks and sums the
byte ranges read at each level, so the number under "Cascaded" in panel 3 is
derived from the layout, not asserted. This is where the interesting losses show
up: `Delta` has to replay up to 127 deltas from its block base, and an `RLE` whose
run ends are themselves delta-coded can cost more than the baseline page it is
competing with. The demo says so when that happens rather than hiding it — the
compressor here optimises for size alone, and size and seekability are different
objectives.

**The baseline.** Each column is also written the way a row-group-and-page format
writes one: a dictionary page plus bit-packed codes when cardinality is low,
plain fixed-width or length-prefixed values otherwise, cut into pages of 1,024 /
4,096 / 8,192 rows, with each page compressed as a single LZ77 block. Because the
block is the unit of compression, reaching one row means pulling and inflating
the whole page — which is exactly the number shown against the cascaded lookup.

## What's synthetic

**The data.** Twelve columns of device telemetry — timestamps, device ids,
regions, firmware strings, request paths, status codes, payload sizes, retry
counts, battery and temperature readings, signal strength with nulls, and a
constant tenant slug — generated in-browser from a seeded PRNG (`mulberry32`), so
the page looks identical on every load until you press *New data*. Magnitudes,
cardinalities, run lengths and skew are chosen to be plausible for an ingest log;
none of it is measured from a real fleet, and none of it comes from any company.
The columns are deliberately varied so that different encodings win on different
ones.

**What is real.** The encoders, the decoders, the bit-level packing, the LZ77
codec, and every byte count on the page. The round-trip check and the baseline
page verification run on every recompression and would fail loudly.

**Simplifications, stated plainly.**

- **FSST** here is a re-implementation of the *idea*, not the paper: four
  training rounds over at most 48 sampled strings, symbols up to 8 bytes ranked
  by `count × (2·len − 1)`, greedy longest-match, 255 symbols plus an escape
  code. Real FSST trains harder and packs its symbol table differently.
- **ALP** searches only the decimal exponent `e` and patches the rows that do not
  round-trip through it; the published algorithm also searches a second factor
  and has a more careful exception scheme.
- **The baseline is not Parquet.** No Thrift metadata, no column statistics,
  bloom filters, or predicate pushdown; definition levels are approximated by a
  plain bitmap; and LZ77 stands in for Snappy or Zstd, which would compress
  better. Read the baseline as "a page-compressed columnar format", and read the
  ratios as illustrative of the tradeoff, never as a benchmark result.
- **Nulls** are stored as a validity bitmap over a fully materialised child whose
  null slots are filled with the previous valid value. That is cheap and correct
  here; a real system would use a masked or sparse array rather than materialising
  the holes.
- **Bytes-touched is an upper bound** for encodings without an exact range
  function (`Dict`, `RLE`): reads for neighbouring rows are summed and may double
  count a byte the two share.
- Dictionary pages and the FSST symbol table are treated as already resident in
  both models, so neither is charged to a lookup. Both models get the same
  courtesy.

## How it relates to the company's public description

Vortex is publicly described as a next-generation columnar file format — a
successor to Parquet — built around compressed, cascading encodings that stay
addressable, so a reader can get at a value without inflating a whole page. This
demo takes that single mechanic and makes it pokeable: the cascade is a real
tree you can reshape with the candidate toggles and the depth slider, and the
consequence of the cascade is measured on both axes that matter, in both
directions, including the cases where the older design wins.

## Run it

Open `index.html` in a browser. No build step, no dependencies, no network — the
page makes zero requests after it loads and behaves identically offline.

`app.js` also exports its internals under CommonJS, so the compressor can be
exercised headlessly:

```
node -e "var A=require('./app.js'); var v=A.buildColumn(A.COLUMNS[0],1,2000);
var n=A.compress(v,3,{enabled:{dict:1,rle:1,delta:1,for:1,blocked:1,alp:1,fsst:1},sampleRows:256});
console.log(A.treeText(n), n.total, 'roundtrip:', A.verify(n,v)?'FAIL':'ok');"
```
