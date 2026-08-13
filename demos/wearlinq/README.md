# Streaming 6-Lead QRS Detector

A simulated two-channel chest patch streams at 250 Hz. Four more limb leads are
derived from the two measured ones, a streaming Pan–Tompkins detector picks QRS
complexes out of the noise sample by sample, and every beat is scored against
the ground truth the simulator wrote when it generated the beat. Turn up motion
artifact, switch the analysis lead to aVL, push the detection threshold to 0.70
with search-back off — sensitivity, PPV and the sensor-to-alert latency all move
because the pipeline actually re-ran.

**Inspired by:** Wearlinq (wearlinq.com) — "eWave: FDA-cleared wireless 6-lead
wearable ECG with near-real-time AI diagnosis." Built by Aarush Kandukoori with AI assistance. An independent mini-demo
inspired by Wearlinq's public product description; not affiliated with
Wearlinq.

## How it works

**Six leads from two channels.** Each wave component of a beat is a Gaussian in
time with a magnitude in mV and an axis in the frontal plane. A limb lead at
angle θ sees `magnitude · cos(θ − axis)`. Leads I (0°) and II (60°) are the
measured channels; III, aVR, aVL and aVF are computed from them exactly as a
two-electrode patch computes them — `III = II − I`, `aVR = −(I+II)/2`,
`aVL = I − II/2`, `aVF = II − I/2`. The page prints the residual of
`I + III − II` off the clean dipole, which stays at machine epsilon because the
projection model makes Einthoven's law an identity rather than an approximation.
The mean QRS axis is 58°, which is why aVL is nearly isoelectric: it is 88° off
the axis, so `cos 88° ≈ 0.035` and there is almost no R wave to detect. Selecting
it is the fastest way to watch the detector fall apart for a reason rather than
at random.

**Two filter bands off the same lead.** Detection runs on a 5–15 Hz band-pass
(cascaded RBJ high-pass and low-pass biquads, coefficients computed at load),
then the classic Pan–Tompkins chain: 5-point derivative → square → moving-window
integration. Beat *measurement* runs on a separate 0.5–40 Hz diagnostic band,
because baseline wander sits below 0.5 Hz, mains hum above 40 Hz, and the
detection band-pass throws the P wave away entirely.

**Adaptive thresholding, faithfully.** Two-second learning phase seeds
`SPKI = 0.33 · max` and `NPKI = 0.5 · mean` of the integrated signal. Every local
maximum of the integrator is a candidate: above `NPKI + k(SPKI − NPKI)` and past
the refractory window it becomes a beat and raises SPKI; below, it lowers NPKI.
T-wave discrimination rejects a peak within 360 ms of the last QRS whose steepest
slope is under half of that QRS's — measured on the derivative *around the
located R*, not around the integrator peak, which sits half an integration window
later. Search-back re-scans at half the threshold once 1.66 average-RR passes
with no beat. Both RR averages are seeded from the first observed interval and
resynchronise after eight intervals outside the acceptance band, so a rate far
from the default does not freeze the missed-beat limit.

**R-peak location is group-delay compensated.** The band-pass is causal, so its
output lags. At load the demo pushes a QRS-shaped Gaussian through a copy of the
cascade and measures how far the peak moves; that constant is subtracted from
every reported R location. Without it, every R is biased ~35 ms late — visible as
the "R-peak localisation error" row, which sits at 1–5 ms with the correction and
around 35 ms without it.

**Scoring is real.** The simulator records the sample index and type of every
beat it generates. A detection is a hit when its estimated R location lands
within ±150 ms of an unmatched true beat, the tolerance the standard
beat-by-beat benchmarks use. A true beat is only declared missed after enough
time has passed that no late search-back detection could still claim it. The
first 2.5 s are excluded as detector warm-up, and changing any detector control
clears the counters and re-warms, so the numbers always describe the settings on
screen.

**Beat typing** is a 3-class softmax over five features — QRS width, prematurity,
P-wave energy, R amplitude, and a bias — normalised against the *median* of the
last eight beats rather than a running average of beats already called normal.
That matters: an average fed by its own decisions can latch onto a wrong
reference after one long pause and never recover.

**Rhythm and alerts.** Rate from the median of recent RR. The AF test is
beat-to-beat irregularity (RMSSD / mean RR) computed only across intervals
between two beats both believed normal, so ectopy cannot masquerade as
irregularity. It is deliberately *not* a P-wave test — the page shows P-wave
energy next to it so you can see why: across sinus and AF it barely separates
once rate and motion are in play, which is why patch- and wrist-sized AF checks
are built on intervals.

**Latency budget.** The detection row is measured by the running simulation: the
mean delay between a true R peak and the sample at which the detector fired,
about 95 ms at a 150 ms integration window and about 48 ms at 60 ms. Inference
and uplink are modelled from sliders and labelled as such. The total is compared
against a fixed 250 ms sensor-to-alert budget.

## What's synthetic

Everything. There is no recorded data on this page and no network access at all.

- **Waveforms** are sums of Gaussian components (P, Q, R, S, T) with realistic
  magnitudes and durations, projected onto lead axes. PVCs get a bizarre
  ventricular axis, a ~2.5× wider complex and a discordant T wave; atrial
  prematures get an abnormal early P. Beat amplitude is modulated ±14% by a
  0.28 Hz respiratory term plus ±10% beat to beat — that variation is what makes
  the threshold coefficient matter.
- **Rhythms** are scheduling rules, not models of electrophysiology: trigeminy is
  every third beat at 0.60 coupling with a compensatory pause; AF is a lognormal
  RR (σ = 0.19) with the P wave replaced by three fixed-phase f-wave sinusoids;
  pauses are a 3.2 s interval every ninth beat.
- **Noise** is a sum of a baseline-wander term at 0.21 and 0.063 Hz, white
  Gaussian noise, scheduled motion-artifact bursts at 2.5–8.5 Hz with a raised
  envelope, and optional 60 Hz mains. Motion bursts are correlated across the two
  channels; the white noise is independent per channel, as it would be.
- **Ground-truth annotations** are exact by construction, which is the one thing
  a simulator can offer that a real recording cannot. Real annotations are
  human-made, disagree between annotators, and are what a real sensitivity number
  is measured against.
- **The beat classifier is not trained.** Its weights are hand-set. It is on the
  page to show where the classification stage sits in the stream, what features
  it needs from the signal, and how noise degrades it — not to claim an accuracy
  number. A real system uses a trained model on a real annotated corpus.
- **The inference and uplink rows of the latency budget are modelled**, not
  measured. Only the detection row is real.
- The simulated axis is fixed at 58° ± 8° per beat, there is no lead-off or
  saturation modelling, no electrode-contact dynamics, and no ST-segment
  behaviour. Everything the pipeline sees is frontal-plane limb leads.

Not a medical device. Nothing here is clinical advice, and none of these numbers
transfer to a real recording.

## Run it

Open `index.html` in a browser. No build step, no dependencies, no network.
The stream starts on load unless the browser reports a reduced-motion
preference, in which case it pre-rolls six seconds and waits for **Run** or
**Step 2 s**. Everything is reachable and operable from the keyboard.
