# TEMPLATE.md — the contract every demo must follow

One demo = one directory = one self-contained page that **actually works**.
If you are an agent building a demo in this repo, this file is the spec. Read
all of it before writing code. Anything not permitted here is not permitted.

---

## 1. Where it goes

```
demos/<slug>/
├── index.html      required — self-contained page
├── app.js          optional — logic, if it does not belong inline
├── style.css       optional — demo-specific styles only
└── README.md       required — what it does, how it works, what is synthetic
```

`<slug>` is lowercase ASCII, hyphen-separated, no leading/trailing hyphen:
`^[a-z0-9]+(-[a-z0-9]+)*$`. It names the **demo**, not the company —
`streaming-join-playground`, not `synnada`.

The page must be reachable at `./demos/<slug>/` (i.e. `index.html` is the
directory index). Never link between demos; each stands alone.

---

## 2. Hard requirements

### It works

- **Real logic, real interactivity.** The demo computes something. A user
  changes an input and the output genuinely changes because the code ran.
- **Never a mockup.** No screenshots of a UI, no static "result" panels, no
  fake loading spinners that resolve to a hard-coded answer, no `alert()`
  stubs, no dead buttons.
- **Never lorem ipsum.** Every string a user can see is real, specific and
  written for this demo.
- **Plausible synthetic data, baked in.** Generate it in code (a seeded PRNG
  is ideal — the demo should look the same on every load unless the user
  randomises) or inline it as a literal. It must be *plausible*: realistic
  magnitudes, units, names, timestamps, distributions. Never scraped from a
  company, never real patient/customer data, never presented as real.
- **Honest about being synthetic.** If numbers look like measurements, say in
  the UI that they are simulated.

### It is self-contained

- **Zero network calls at runtime.** No CDN links, no webfonts, no `fetch()`,
  no XHR, no WebSocket, no analytics, no external images, no iframes to other
  origins. Open the page with the network off — it must be identical.
- **No build step.** Plain HTML, CSS and ES5/ES2015-era JavaScript that runs
  directly from the file. No bundler, no npm, no TypeScript, no JSX, no
  transpile.
- **No dependencies.** No React, no D3, no Chart.js, no Tailwind. Draw with
  inline SVG, `<canvas>`, or DOM elements. If a demo seems to need a library,
  it is scoped too large — shrink it.
- Images, if any, must be inline SVG or a `data:` URI, and small.

### It imports the shared design system

```html
<link rel="stylesheet" href="../../assets/base.css" />
<link rel="stylesheet" href="../../assets/demo-shell.css" />
```

Exactly those relative paths — the demo lives two levels down.
`demo-shell.css` is optional; `base.css` is not.

Use the tokens and classes in `assets/base.css` (`.card`, `.panel`, `.btn`,
`.field`, `.metric`, `.tag`, `.note`, `var(--accent)`, `var(--s-4)`, …).
Demo-specific CSS is fine for the parts that are genuinely unique to this
demo; do not restate the design system, and do not introduce a second accent
colour. Light and dark both come free from `base.css` — do not hard-code
colours that only work in one of them.

### It is fast

- Loads and becomes interactive in **under one second** on a laptop.
- Total page weight under ~150 KB.
- No blocking work on load beyond generating the synthetic dataset. Keep
  datasets to what the UI actually shows (hundreds of rows, not millions).
- Any animation loop uses `requestAnimationFrame`, pauses when the tab is
  hidden or the demo is stopped, and respects
  `@media (prefers-reduced-motion: reduce)`.

### It is keyboard accessible

- Every control is a real, focusable element: `<button>`, `<input>`,
  `<select>`, `<a href>`. Never a clickable `<div>`.
- Full task completable with keyboard alone; visible focus ring everywhere
  (`base.css` provides it — never `outline: none` without a replacement).
- Every input has a `<label>` (or `aria-label`). Every SVG/canvas conveying
  information has a text equivalent nearby or `aria-label`.
- Live-updating regions that matter use `role="status"` /
  `aria-live="polite"`.
- Colour is never the only signal — pair it with text, shape, or position.
- Text contrast at least 4.5:1 in both themes (the tokens already satisfy
  this; keep it true for anything custom).

### It works on mobile

- `<meta name="viewport" content="width=device-width, initial-scale=1" />`.
- No horizontal page scroll at 360 px wide. Wide tables, canvases and code
  blocks scroll **inside** their own container (`.scroll-x`, `.table-scroll`).
- Touch targets at least 40 px tall. No hover-only affordances.

### It carries the provenance note

Visible on the page — in the header, not behind a toggle, not only in the
footer, not in a comment — exactly this sentence with `<Company>` replaced:

> An independent mini-demo built by Aarush Kandukoori, inspired by
> `<Company>`'s public product description. Not affiliated with `<Company>`.

Use `<p class="provenance">` inside `.demo-header`.

---

## 3. Forbidden

- **No company logos**, wordmarks, icons, or trade dress — not as images, not
  redrawn as SVG, not as favicons.
- **No brand colours lifted from a company's site.** The palette is
  `base.css`'s single accent, for every demo. This is the point: 100 demos,
  one visual signature.
- **No claim of affiliation, endorsement, partnership, employment, trial,
  pilot, or customer relationship.** No "built for X", "powered by X",
  "X integration", "official", or a company's own product name as the page
  title.
- **Do not name the demo as if it *is* the company's product.**
  - Good: `Streaming Join Playground`, `Columnar Layout Explorer`,
    `Prompt Injection Gauntlet`, `12-Lead Waveform Annotator`,
    `KV-Cache Reuse Simulator`, `Agent Memory Inspector`.
  - Bad: `Synnada`, `Vortex Demo`, `Gray Swan Cygnal`, `My LanceDB Clone`,
    `Turso Lite`.
- No scraped copy, screenshots, marketing text, or private/unpublished
  information about a company. Inspiration comes from the **public** one-line
  product description only.
- No real personal or patient data. Synthetic only, in every demo,
  especially the medical-device ones.
- No forms that collect anything, no credential or payment fields, no
  `mailto:` capture, no storage of user input beyond the page session.
- No tracking, cookies, or `localStorage` used for anything but the demo's own
  state (and prefer not to use it at all).

---

## 4. Starter skeleton

Copy this, replace the bracketed parts, delete what you do not use.

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>[Demo Title] — mini-demo</title>
    <meta name="description" content="[One line: what this demo does.]" />
    <meta name="color-scheme" content="light dark" />
    <link rel="stylesheet" href="../../assets/base.css" />
    <link rel="stylesheet" href="../../assets/demo-shell.css" />
  </head>
  <body>
    <a class="skip-link" href="#stage">Skip to the demo</a>

    <header class="demo-header">
      <div class="wrap">
        <a class="demo-back" href="../../">All demos</a>
        <h1 class="demo-title">[Demo Title]</h1>
        <p class="demo-sub">[One sentence: what you can do on this page.]</p>
        <p class="demo-meta">
          <span class="tag">[topic]</span>
          <span class="tag">synthetic data</span>
        </p>
        <p class="provenance">
          An independent mini-demo built by Aarush Kandukoori, inspired by
          [Company]'s public product description. Not affiliated with
          [Company].
        </p>
      </div>
    </header>

    <main class="demo-main">
      <div class="wrap">
        <section id="stage" class="demo-stage" tabindex="-1">
          <div class="panel">
            <!-- The working area. -->
          </div>
        </section>

        <aside class="demo-controls" aria-label="Controls">
          <div class="control-group">
            <p class="eyebrow">Parameters</p>
            <div class="field">
              <label class="control-readout" for="rate">
                <span>Events / second</span>
                <output id="rate-out" for="rate">120</output>
              </label>
              <input id="rate" type="range" min="10" max="500" value="120" />
            </div>
          </div>
          <div class="control-actions">
            <button class="btn btn-primary" type="button" id="run">Run</button>
            <button class="btn" type="button" id="reset">Reset</button>
          </div>
        </aside>
      </div>
    </main>

    <footer class="demo-footer">
      <div class="wrap">
        <span>All data on this page is synthetic and generated in-browser.</span>
        <a href="../../">Back to all demos</a>
      </div>
    </footer>

    <script src="./app.js"></script>
  </body>
</html>
```

---

## 5. The demo's README.md

Short, honest, four sections:

```markdown
# [Demo Title]

[Two or three sentences: what it does and what you can try.]

**Inspired by:** [Company] ([website]) — [their public one-liner].
An independent mini-demo built by Aarush Kandukoori, inspired by [Company]'s
public product description. Not affiliated with [Company].

## How it works
[The actual technique: the algorithm, the data structure, the model. Be
specific — this is the part a founder reads.]

## What's synthetic
[Exactly which data is generated and how. State the simplifications and what
a real system would need instead. Do not oversell.]

## Run it
Open `index.html` in a browser. No build step, no dependencies, no network.
```

---

## 6. Register it in the manifest

A demo is not published until it is listed. Append **one** object to the array
in `/demos.js`, immediately above the `APPEND MARKER` comment, without
touching existing entries:

```js
{
  slug: "streaming-join-playground",
  company: "Synnada",
  title: "Streaming Join Playground",
  what: "Feeds two synthetic event streams into a windowed join and shows rows matching, buffering, and expiring live.",
  tags: ["streaming", "sql"]
},
```

- `slug` must equal the directory name exactly.
- `what` describes what **the demo** does when opened — not what the company
  does. Present tense, 90–150 characters, no marketing adjectives.
- `title` follows the naming rule in §3.
- `tags` optional, at most 3, lowercase.

Entries are validated at render time: a malformed one is silently skipped, so
a typo costs you a missing card, not a broken site.

---

## 7. Pre-flight checklist

Do not consider a demo done until all of these are true.

- [ ] `demos/<slug>/index.html` opens straight from the filesystem and works.
- [ ] It still works with the network disabled — no request is ever made.
- [ ] `../../assets/base.css` is linked and the page uses its tokens.
- [ ] Interactive: changing an input visibly changes real computed output.
- [ ] Data is synthetic, plausible, generated or inlined, and labelled as
      synthetic.
- [ ] No lorem ipsum, no placeholder text, no dead controls.
- [ ] Interactive in under a second; page under ~150 KB.
- [ ] Tab through the whole page: every control reachable, focus always
      visible, task completable without a mouse.
- [ ] At 360 px wide there is no horizontal page scroll.
- [ ] Looks correct in both light and dark (toggle the OS setting).
- [ ] The exact provenance sentence is visible in the header.
- [ ] No logo, no brand colour, no affiliation claim, no company-product name.
- [ ] `README.md` written, including the "What's synthetic" section.
- [ ] One entry appended to `/demos.js` above the `APPEND MARKER`.
- [ ] No JavaScript errors in the console.
