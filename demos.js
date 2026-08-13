/* ==========================================================================
   demos.js — the manifest that drives the landing page.
   Loaded by index.html with a plain <script src="demos.js"></script> tag.
   No fetch(), no JSON parsing, no build step.

   HOW TO ADD A DEMO
   -----------------
   Append one object to the array below, directly above the APPEND MARKER.
   Do not reformat, reorder, or rewrite existing entries. Do not delete the
   marker comment. One demo = one object = one commit-sized edit.

   Entry schema (all strings; `slug`, `company`, `title`, `what` required):

     slug    string   directory name under demos/  — lowercase, hyphens only.
                      The card links to ./demos/<slug>/
     company string   the company the demo was inspired by, e.g. "Synnada"
     title   string   the demo's own generic name, e.g. "Streaming Join
                      Playground". NEVER name it as if it were the company's
                      product. See TEMPLATE.md.
     what    string   one line, plain English, present tense, describing what
                      the demo DOES when you open it. Not what the company
                      does. Aim for 90–150 characters.
     tags    string[] optional, 1–3 short lowercase topic tags.

   Example (keep it commented out; it is documentation, not a live entry):

     {
       slug: "streaming-join-playground",
       company: "Synnada",
       title: "Streaming Join Playground",
       what: "Feeds two synthetic event streams into a windowed join and shows rows matching, buffering, and expiring live.",
       tags: ["streaming", "sql"]
     },

   A malformed entry can only ever hide itself: index.html validates each
   object and skips the bad ones. A syntax error in this file leaves
   window.DEMOS undefined and the page falls back to its empty state — it
   never white-screens.
   ========================================================================== */

window.DEMOS = [
  {
    slug: "celero-systems",
    company: "Celero Systems",
    title: "Closed-Loop Rescue-Dose Simulator",
    what: "Replays a rescue-dose detector over 40 synthetic capsule recordings and shows every dose it fires, misses, or false-alarms on.",
    tags: ["biosignals", "closed-loop"]
  },
  {
    slug: "ceryx-medical",
    company: "Ceryx Medical",
    title: "Respiratory-Coupled Pacing Bench",
    what: "Runs fixed-rate, rate-adaptive and breath-coupled pacing against one synthetic breathing signal and compares what each delivers.",
    tags: ["closed-loop", "cardiorespiratory", "simulation"]
  },
  {
    slug: "gray-swan-ai",
    company: "Gray Swan AI",
    title: "Inline Guardrail Cascade Lab",
    what: "Runs synthetic agent traffic through a two-stage prompt-injection guardrail and shows what a p99 latency budget makes it miss.",
    tags: ["guardrails", "latency", "injection"]
  },
  {
    slug: "lakesail",
    company: "LakeSail",
    title: "DataFrame Plan Optimizer Playground",
    what: "Parses a PySpark-style DataFrame program, optimizes the plan, then runs it vectorized and row-at-a-time over synthetic columnar data.",
    tags: ["sql", "columnar", "optimizer"]
  },
  {
    slug: "laminar",
    company: "Laminar",
    title: "Agent Trace Query Console",
    what: "Filters a synthetic agent-span store one column at a time, times the scan, and scores whole runs with tunable evaluators.",
    tags: ["observability", "columnar", "evals"]
  },
  {
    slug: "spiral-vortex",
    company: "Spiral (Vortex)",
    title: "Cascading Encoding Explorer",
    what: "Compresses a synthetic telemetry column with cascading encodings and compares its size and single-row lookup cost against a page-compressed baseline.",
    tags: ["columnar", "compression", "encodings"]
  },
  {
    slug: "synnada",
    company: "Synnada",
    title: "Symmetric Hash Join Playground",
    what: "Streams two synthetic event feeds through a symmetric hash join and evicts buffered rows using a bound derived from the predicate.",
    tags: ["streaming", "sql", "watermarks"]
  },
  {
    slug: "wearlinq",
    company: "Wearlinq",
    title: "Streaming 6-Lead QRS Detector",
    what: "Streams a synthetic 6-lead ECG through a live Pan-Tompkins detector and scores every beat against ground truth as you add noise and change rhythm.",
    tags: ["ecg", "dsp", "streaming"]
  },
  /* APPEND MARKER — new demo entries go directly above this line. */
];
