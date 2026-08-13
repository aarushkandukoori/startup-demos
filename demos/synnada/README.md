# Symmetric Hash Join Playground

An in-browser streaming join. Two unbounded, out-of-order synthetic streams —
`orders` and `shipments` — are ingested one event at a time into a symmetric
hash join with a temporal filter, and the page shows the join state being
evicted by a bound solved out of the join predicate itself. Widen the join
window, move the watermark delay under the stream's disorder, or swap the
pruning strategy for a naive fixed retention age, and watch buffered rows,
emitted rows and recall move together.

**Inspired by:** Synnada (synnada.ai) — "AI-native real-time data processing
built by core Apache DataFusion committers".
Built by Aarush Kandukoori with AI assistance. An independent mini-demo
inspired by Synnada's public product description; not affiliated with
Synnada.

## How it works

The query is a temporal equi-join over two unbounded inputs:

```sql
SELECT o.order_id, o.region, s.carrier, s.ts - o.ts AS fulfil_lag
FROM orders o
JOIN shipments s
  ON o.order_id = s.order_id
 AND s.ts BETWEEN o.ts AND o.ts + INTERVAL 'W seconds'
```

**The join.** A symmetric hash join keeps a hash table per side. Each arriving
row probes the *opposite* table, emits every buffered partner that satisfies the
filter, then inserts itself into its *own* table. It is order-agnostic: neither
side is the build side, so results appear as soon as the second half of a pair
lands, in whichever order that happens.

**The watermark.** Each side carries `watermark = max(event time seen on that
side) − watermark delay`, monotonically non-decreasing — the standard
bounded-out-of-orderness watermark. A row whose event time is already behind its
side's watermark when it arrives is counted as a late arrival.

**The pruning bound.** Without eviction both hash tables grow for the lifetime
of the query. The `interval` strategy solves the ON clause for each side against
the other side's watermark, propagating the constraint the way interval
arithmetic over the filter expression would:

- Every future shipment row has `s.ts >= wm(shipments)`. The filter needs
  `s.ts <= o.ts + W`, so an order row can still match only if
  `o.ts + W >= wm(shipments)`. **Keep `o.ts >= wm(shipments) − W`.**
- Every future order row has `o.ts >= wm(orders)`. The filter needs
  `s.ts >= o.ts`, so a shipment row can still match only if
  `s.ts >= wm(orders)`. **Keep `s.ts >= wm(orders)`** — a bound that does not
  involve `W` at all.

Everything below those bounds is provably dead and is dropped. Both live bounds
are printed on the page with their current values, and rows within one second of
being dropped are flagged in the buffer tables. The same idea — deriving state
bounds from the join filter plus watermarks, rather than from a user-guessed
retention time — is what makes a bounded-memory stream-stream join possible in
open-source engines such as Apache DataFusion.

**The comparison.** Every event is fed to two engines at once: the selected
strategy, and an unpruned baseline that keeps everything. The chart plots both
buffered-row counts. A third, non-streaming reference — a plain batch scan of the
same rows — supplies the set of pairs the query *should* produce, so "missed vs
batch" and recall are measured against a real oracle rather than asserted. Pairs
count toward the oracle only once both of their events have been ingested, so the
comparison is fair at every point in the run.

Three strategies are selectable:

| strategy | bound | behaviour at the defaults |
| --- | --- | --- |
| interval | derived from predicate + watermark | 147 rows out, peak 61 buffered |
| fixed retention (60 s) | `ts >= max(ts) − retention` | 145 rows out, peak 87 buffered |
| none | — | 147 rows out, peak 439 buffered |

The point of the middle row: a hand-tuned retention age costs more memory *and*
loses results, because it does not know what the predicate implies. Set the
watermark delay at or above the stream disorder and interval pruning is exactly
lossless — same 147 rows as the batch scan, one seventh of the state. Set it
below, and the watermark starts making a promise the data does not keep: rows are
evicted before their partner arrives and recall drops.

## What's synthetic

Everything on the page. Nothing is measured, scraped, or taken from any company.

- **The data.** 240 orders and their shipments, generated in-browser from a
  seeded PRNG (mulberry32) — same seed, same stream, every load. Order gaps are
  exponential (~1.5 s mean). 62% of orders ship quickly (2.5 s + Exp(11 s)), 20%
  ship late (46 s + Exp(55 s)) so that they genuinely fall outside a normal
  window, and 18% never ship, giving the join a realistic mix of matches, misses
  and out-of-window pairs. Order ids, regions and carrier names are invented.
- **Event time vs arrival.** Ingest order is event time plus a uniform jitter up
  to the "stream disorder" setting, which is what makes watermarks necessary.
  Time is compressed: the whole run is about nine minutes of event time.
- **Buffered rows** count rows, not bytes; a real engine would care about the
  row layout and the hash table's own overhead, and would report memory.

Simplifications a production system would not make: one shipment per order at
most, so the join is effectively one-to-one; state is a `Map` of arrays, pruned
by a linear scan on every event rather than by an ordered index or a
time-bucketed structure; there is no spill-to-disk, no checkpointing, no
watermark propagation across operators, no retraction or update handling, and no
distribution or partitioning. Late data is handled only in the sense that it is
counted and processed if its partner still exists — there is no side output.

## Run it

Open `index.html` in a browser. No build step, no dependencies, no network — the
only requests are for the two shared stylesheets in `assets/` and this demo's own
`style.css` and `app.js`.
