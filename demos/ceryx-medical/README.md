# Respiratory-Coupled Pacing Bench

Three pacing controllers — fixed rate, rate-adaptive, and a closed loop that
modulates every beat with the sensed breath — are integrated in parallel
against one synthetic breathing signal, so any difference between them is the
controller and not the scenario. Change the breathing rate, the metabolic
demand, the coupling depth or the sense-to-pace latency and watch the beat
raster, the tachogram and eight live metrics respond. The interesting knob is
latency: push it past a quarter of a breath and the breathing-locked component
of the paced rate decays, crosses zero, and inverts — the loop ends up pacing
fastest during expiration.

**Inspired by:** Ceryx Medical (ceryxmedical.com) — publicly describes a
closed-loop cardiac pacing device that paces in real time with the patient's
breathing, rather than at a fixed or activity-averaged rate. An independent
mini-demo built by Aarush Kandukoori, inspired by Ceryx Medical's public
product description. Not affiliated with Ceryx Medical.

## How it works

Everything runs on a 4 ms fixed-step integrator in `app.js`. One `stepOnce()`
advances the whole bench; the UI just calls it and draws.

**Breathing.** A zero-mean airflow-shaped wave: a sine hump over the first 40%
of the cycle (inspiration, amplitude 1) and a longer, shallower trough over the
remaining 60% (expiration, amplitude −2/3, chosen so the two areas cancel
exactly). Breath period is redrawn each cycle from a seeded PRNG with the
variability the slider asks for.

**Sensing.** The true waveform goes into a ring buffer, is read back at the
configured transport delay, has a slow wandering artefact added (a one-pole
shaped noise with a 300 ms correlation time — deliberately not white, so the
filter cannot simply average it away), then passes a 70 ms one-pole filter.
The controllers only ever see that estimate, so the loop's own latency is part
of the loop.

**Control.** Three controllers share the inputs:

| controller | commanded rate |
| --- | --- |
| fixed | `base` |
| rate-adaptive | `base + 46 · demand` (demand smoothed with a 16 s time constant) |
| respiratory-coupled | `base + 46 · demand + (swing / 1.667) · estimate` |

**Pacing** is integrate-and-fire, not scheduling: each controller advances a
phase by `dt / RR` and emits a beat when the phase wraps. Intervals are an
*output* of the command, which is why sensor noise shows up as interval
variability.

**Haemodynamics.** Stroke volume follows a filling curve,
`SV_max · (1 − e^(−RR/470 ms))`, times a ±14% respiratory preload swing and a
contractility term rising with demand. Preload and the tachogram sample are
both taken at the *midpoint* of the RR interval rather than at the beat — the
interval, not the instant, is what filled the ventricle, and sampling at the
beat introduces a half-interval phase error that is large when breathing is
fast.

**Metrics** are recomputed over a trailing 30 s of delivered beats. The two
phase metrics are least-squares fits against the breathing waveform: the slope
times the waveform's RMS gives the component of paced rate (in bpm) and of
per-beat pulmonary flow (as % of mean) that is genuinely in phase with
breathing. Both are signed, so anti-phase reads negative. That is the number
the latency slider moves.

## What's synthetic

All of it. There is no recorded, measured or clinical data anywhere on the
page, and no network request at runtime.

- **Breathing waveform, breath-to-breath jitter, sensor artefact** — generated
  in-browser from a seeded PRNG (`mulberry32`, fixed seed), so the page looks
  the same on every load until you touch a control.
- **Beats, intervals, stroke volumes, cardiac output** — outputs of the toy
  model above, not measurements.
- **The demand curve** (`4.8 + 6.2 · demand` L/min) and the rate-adaptive gain
  are plausible round numbers, not fitted to anything.

Simplifications a real system would not accept: no ECG or intracardiac
electrogram at all, so no sensing of intrinsic beats, no capture verification,
no refractory periods, no mode switching, no arrhythmia; the "respiration
sensor" is an abstract normalised signal rather than impedance or an
accelerometer, and calibration is assumed rather than tracked; the ventricle is
one filling curve with no afterload, no baroreflex and no autonomic tone.

The haemodynamic model deliberately does **not** produce a large cardiac-output
jump for respiratory coupling — the coupled and rate-adaptive rows land within
about 1% of each other. Any bigger number would be an artefact of constants I
chose, not evidence, and this simulation cannot support a clinical efficacy
claim. What it can show honestly is the phase relationship: which beats land in
inspiration, how much of the paced rate is locked to the breath, and how fast
that locking is destroyed by loop latency.

## Relation to the company's public description

Ceryx Medical publicly describes closed-loop cardiac pacing that follows the
patient's breathing in real time, in contrast with fixed-rate and
activity-sensor rate-adaptive pacing. This bench takes that single contrast and
makes it measurable: the same three strategies, the same breath, side by side,
with the respiratory locking quantified in bpm and the latency budget of the
sensing loop made into a slider you can push until the therapy inverts. It is
not their algorithm, their sensor, their hardware or their evidence — the
underlying idea of respiratory sinus arrhythmia is decades-old physiology, and
everything here is my own toy implementation of it.

## Run it

Open `index.html` in a browser. No build step, no dependencies, no network.
`app.js` also exports its model under `module.exports` when there is no
`document`, so the physiology can be exercised headlessly:

```js
var M = require('./app.js');
var s = M.createState(Object.assign({}, M.DEFAULTS), 20260813);
M.advance(s, 120000);
console.log(M.metrics(s, s.ctrls[2]));
```
