# Closed-Loop Rescue-Dose Simulator

A working bench for the *decide* stage of a sense → decide → dose loop. Forty
synthetic ten-minute recordings from a simulated ingestible sensor (breathing
rate, heart rate, signal quality) are replayed through a causal detector state
machine; you tune the trigger condition, the timing, and the sensor duty cycle,
and the page recomputes what the device would have done on every recording.
Scrub one recording second by second to watch the detector arm, confirm, abort,
or release a dose — then look at the cohort scoreboard to see what that setting
costs in false doses, missed overdoses, and seconds to rescue.

**Inspired by:** Celero Systems (celerosystems.com) — an ingestible capsule that
detects opioid overdose and autonomously delivers an antagonist.
Built by Aarush Kandukoori with AI assistance. An independent mini-demo
inspired by Celero Systems's public product description; not affiliated with
Celero Systems.

## How it works

**The detector.** One causal pass over each recording at 1 Hz, no lookahead.
Four states: `monitoring → armed → confirm hold → dosed`.

- A sample is *usable* only if the sensor was awake for it (`t % duty == 0`) and
  its signal quality clears the artifact gate.
- A usable sample is *depressed* if breathing rate ≤ the trigger threshold and —
  when corroboration is on — heart rate ≤ the bradycardia threshold.
- Depressed samples accrue **evidence in seconds**. Reaching the sustain window
  promotes to the confirm hold; any recovery below the bar resets to monitoring
  and is logged as an abort. Surviving the confirm hold releases the dose, which
  latches for the rest of the recording.
- More than 20 s of consecutive gated samples clears accrued evidence, so
  artifact cannot silently carry a partial trigger forward.

**Why the cohort matters.** Five scenarios are generated: opioid respiratory
depression (12, dose required) and four confounders that must *not* be dosed —
obstructive sleep apnea (9, ~45 % of them severe, with 30–46 s apneas and real
bradycardia), quiet sleep (8), motion artifact (7), and sensor coupling loss (4).
Each confounder is defeated by a different knob, which is the actual design
lesson: the sustain window rejects sleep apnea, the quality gate rejects motion
artifact, and heart-rate corroboration rejects coupling loss, where the
breathing channel flatlines while the heart-rate channel stays perfectly normal.

**The sweep.** The sustain window is swept from 10 s to 90 s with every other
setting fixed, re-running the detector over all 40 recordings at each step
(~680 replays, recomputed whenever another knob changes). False doses fall and
late rescues rise, so the usable operating window is visible rather than
asserted.

Two effects worth poking at:

- With corroboration on, **heart rate usually sets the latency**, not breathing —
  it lags the respiratory collapse by tens of seconds. The decision line names
  which channel held the arm back and by how long, which is why the breathing
  threshold looks inert between 4 and 9 br/min until you switch corroboration off.
- A coarse duty cycle **over-counts evidence**: each accepted sample credits a
  whole sleep interval, so a 30 s apnea can look like 35 s of evidence at a 5 s
  duty cycle. It buys battery life (hours → days on the modelled cell) and pays
  for it in decision resolution.

## What's synthetic

All of it. Nothing here is a measurement, and no real, public, or patient data
is used.

- **The physiology** is parametric, generated in-browser by a seeded PRNG
  (mulberry32) so every load is identical until you press *New cohort*.
  Overdoses are logistic decay ramps in breathing rate with a lagged heart-rate
  fall; apneas, artifact bouts, and coupling loss are scripted segments with
  bounded noise. Magnitudes are chosen to be plausible (breathing 0–30 br/min,
  heart rate 20–190 bpm), not to reproduce any published cohort.
- **The sensor** is idealised: the page starts from clean 1 Hz *rate estimates*
  plus a scalar quality index. A real capsule starts from raw motion/acoustic
  signal and must derive both, so its real failure modes — beat and breath
  detection errors, orientation changes, gastric noise — appear here only as
  the artifact and coupling-loss scenarios.
- **Ground-truth apnea onset** is defined as the first second the noiseless
  breathing rate crosses 6 br/min; time-to-dose is measured from there.
- **The 120 s budget** is an engineering target picked for this demo, not a
  clinical standard.
- **The cell-life figure** is order-of-magnitude arithmetic (2.4 mA for 0.9 s per
  wake, 14 µA asleep, 24 mAh cell), labelled "modelled" in the UI. It ignores
  actuation energy, temperature, and self-discharge.
- **Dosing is an instant event.** There is no pharmacokinetic model: no
  absorption delay, no onset curve, no re-narcotization, no redosing logic. A
  real closed-loop system needs all of them, plus a hardware interlock, a
  confirmed-delivery signal, and a manual override path.
- No claim is made that these thresholds are safe or clinically appropriate.
  This is an engineering toy for reasoning about detection latency and false
  alarms, not a medical device or medical advice.

## Run it

Open `index.html` in a browser. No build step, no dependencies, no network —
the page makes exactly four requests, all for its own local files, and works
identically with networking switched off.
