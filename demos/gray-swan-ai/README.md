# Inline Guardrail Cascade Lab

A synthetic stream of agent traffic — user turns, tool output and retrieved
documents — runs through a two-stage prompt-injection guardrail sitting inline
in the request path. Stage A is a cheap lexical pass that runs on everything;
Stage B is an expensive deep check that only runs when Stage A is suspicious
**and** the rolling p99 latency budget still has room for it. Drag the budget
from 40 ms down to 6 ms and watch base64 and leetspeak attacks stop being
caught, because the only component that could read them no longer fits.

**Inspired by:** Gray Swan AI (grayswan.ai) — AI safety & security platform
(Cygnal, Shade, Arena) used by every major frontier lab. An independent
mini-demo built by Aarush Kandukoori, inspired by Gray Swan AI's public product
description. Not affiliated with Gray Swan AI.

## How it works

**Stage A — always runs, ~0.1–0.7 ms.** Eleven lexical and structural features
over the raw string: instruction-override phrasing, role/persona takeover, chat
template markers, system-prompt probes, exfiltration shape (a secret term plus
an outward move), secret literals (`sk-…`, `AKIA…`, `ghp_…`, `.env`), policy
bypass framing, encoded blobs, character obfuscation, urgency/false authority,
and — the one that matters most for indirect injection — *imperatives arriving
in a channel that is not the user*. Each firing feature adds its weight to a
logit with bias −3.1; the score is the sigmoid. Feature weights are hand-set,
not fitted.

**Stage B — conditional, ~6–19 ms.** Requested for any event Stage A scores at
or above the deep-check floor. It does four things Stage A cannot afford:

1. **Decode, then fold.** Zero-width characters are stripped, base64 and hex
   runs are decoded (with a printable-ratio guard), and leetspeak is folded back
   to letters. Stage A is re-run on the expanded text and only the *additional*
   logit is kept, so Stage B's contribution is exactly the evidence that
   normalisation revealed. Order matters: folding before decoding would rewrite
   characters inside the base64 run and destroy the payload — that bug was in
   the first draft of this demo and is why the decode step runs first.
2. **Instruction-target counting.** Clauses are split and tested for imperatives
   addressed at the model (+0.9 each, capped at three).
3. **Tool-invocation detection.** Content in a non-user channel asking for a
   tool call (+2.0).
4. **Two false-positive mitigations.** A trigger phrase inside quotation marks
   or after an attribution cue is discounted (−2.8) — that is what stops a
   red-team report *about* prompt injection from being blocked. And an
   exfiltration shape with no secret literal and no external destination is
   discounted (−2.4), because there is nothing to leak and nowhere to send it.

There is also a session-ledger check: a turn claiming a previously granted
exemption ("as we agreed earlier", "you already confirmed") adds +1.8 unless an
operator turn in the preceding history actually granted one. The lookup is real
and scans prior events; in this sample it always comes back unverified, because
the synthetic stream contains no operator channel at all.

**The admission controller.** Before each deep check, the projected latency is
added to a 100-event sliding window and the p99 is recomputed. If it would
breach the budget, the deep check does not run, and the configured policy
decides what happens: fail open (use the Stage A score), fail closed (block on
timeout), or ignore the budget entirely. Because p99 is a 99th percentile and
not a maximum, roughly one event in a hundred still slips through above the
budget — visible as the occasional tall bar in the latency chart even at a very
tight setting. That is what a p99 target actually means, and it is left in
rather than smoothed away.

Stage A and Stage B scores are computed once per event and memoised, so moving
the block threshold re-decides 240 events instantly, and the threshold sweep is
49 exact re-decisions rather than an approximation.

## What's synthetic

**All of it. Nothing here is measured from any real system or product.**

- **The traffic.** 240 events built by a seeded PRNG (mulberry32) from
  hand-written templates with slot substitution, so the page looks identical on
  every load until you press *New sample*. Company names, URLs, e-mail addresses
  and keys are invented and use RFC 2606 `.example` domains; the "secrets" are
  fake strings of the right shape. Six attack families (direct jailbreak,
  indirect injection, data exfiltration, encoded payload, obfuscated override,
  multi-turn priming) and five benign kinds, including deliberate hard
  negatives: a red-team report quoting an attack verbatim, a policy document
  about API-key rotation, and a request to send a rotation policy to a mailing
  list.
- **The latency.** A cost model, not a measurement: Stage A is
  `0.12 ms + 0.0016 ms/char`, Stage B is `5.8 ms + 0.028 ms/char` plus 3.5 ms
  when something was decoded. Real numbers would come from a profiler on real
  hardware. What *is* really measured is the in-browser scoring time shown in
  the sidebar — the wall-clock cost of scoring all 240 events with both stages.
- **The detector.** Deliberately shallow: hand-weighted regex features, not a
  trained classifier. It is good enough to show the shape of the tradeoff and
  bad enough to be honest about it — multi-turn priming and a politely worded
  system-prompt probe only get flagged at the default threshold, and the sweep
  chart shows exactly what raising recall costs in false blocks.

A real inline defense would replace Stage A with a small trained classifier,
Stage B with a model call, and would need canonicalisation for many more
encodings, per-tenant thresholds, and an actual session ledger fed by the
orchestrator. The ground-truth labels shown in the stream exist only because
this is a lab; the detector never sees them.

No network calls, no storage, no cookies. Text you type into the probe box is
scored in-page and never leaves it.

## Run it

Open `index.html` in a browser. No build step, no dependencies, no network.
