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
directory index).

**Each demo is a sealed, single-company page.** Every company receives a link
to their demo and only their demo. A demo page must contain no link, button,
breadcrumb, or sentence that leads to the site root, the demo index, or any
sibling demo. See §2 "It is sealed" — this is a hard rule, not a preference.

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

### It carries the attribution line

Every demo states, plainly and on the page, that it was built by Aarush
Kandukoori **with AI assistance**, and that it is not affiliated with the
company. One line, both facts. This is required — a demo that omits it, or
paraphrases it, does not ship.

**The exact required text.** Copy it verbatim and replace `[Company]` with the
company's name in both places. Change nothing else — not a word, not a comma,
not the semicolon:

> Built by Aarush Kandukoori with AI assistance. An independent mini-demo
> inspired by [Company]'s public product description; not affiliated with
> [Company].

Rendered for a real company it reads:

> Built by Aarush Kandukoori with AI assistance. An independent mini-demo
> inspired by Synnada's public product description; not affiliated with
> Synnada.

Rules for getting it exactly right:

- **Straight ASCII apostrophe** (`'`, U+0027) in `[Company]'s`. Never a curly
  `'` — the publish gate greps for the literal string and a smart quote fails
  the check. Same for the rest of the line: plain ASCII, no em dashes, no
  typographic quotes, no `&rsquo;`.
- **Always `'s`**, even when the name already ends in *s*: `Andon Labs's`,
  `Ceryx Medical's`. Consistency beats style-guide taste here, because the
  check is mechanical.
- Use the company's name exactly as they write it, in both slots.
- Line breaks and indentation inside the paragraph are free — the check
  collapses whitespace. Word order, punctuation and casing are not free.
- Do not append anything to it. No "for educational purposes", no "all
  trademarks belong to their owners", no second disclaimer sentence. One line.

**Placement.** In the page header, inside `.demo-header`, as the last element
of the header block:

```html
<p class="provenance">
  Built by Aarush Kandukoori with AI assistance. An independent mini-demo
  inspired by [Company]'s public product description; not affiliated with
  [Company].
</p>
```

It must be visible on load without scrolling on a desktop viewport
(1280×800), and visible without any interaction on mobile. Not behind a
toggle, not in a `<details>`, not in an HTML comment, not `title=` text, not
only in the footer, not only in `README.md`.

### It is sealed — no way out to any other demo

A demo is the only page its recipient can see. From the page there must be no
route to the site root, to the demo index, or to a sibling demo — not by
clicking, not by keyboard, not by reading.

**The one rule that covers it:** every `<a>` on the page has an `href` that
starts with `#`. In-page fragment links only (`#stage`, the skip link). There
are no other anchors on a demo page.

Concretely forbidden, in `index.html`, `app.js`, `style.css`, and `README.md`:

- `<a class="demo-back" href="../../">All demos</a>` — the old header link.
  The `demo-back` class no longer exists in `demo-shell.css`. Do not emit it,
  do not re-style it, do not rename it.
- `<a href="../../">Back to all demos</a>` — the old footer link. The footer
  keeps its synthetic-data sentence and nothing else.
- Any `<a>` whose `href` is or resolves to `../`, `../../`, `../<other-slug>/`,
  `./`, `/`, `/startup-demos/`, `index.html`, `../../index.html`, or the
  deployed site origin (`https://aarushkandukoori.github.io/...`).
- Scripted navigation to any of the above: `location.href = …`,
  `location.assign`, `location.replace`, `window.open`, `history.back()`,
  `history.go(-1)`, `<meta http-equiv="refresh">`, `<base href>`, or a click
  handler that sets `document.location`.
- Sibling-discovery metadata: `<link rel="canonical">`, `rel="index"`,
  `rel="up"`, `rel="prev"`, `rel="next"`, `<meta property="og:url">`, or a
  generated sitemap.
- Any visible text that tells the reader other demos exist: "all demos",
  "other demos", "back to demos", "the demo index", "the rest of the
  collection", "see my other work here", a count of demos, or a list of other
  company names. The recipient should have no idea there is a collection.

**Not forbidden:** the two `<link rel="stylesheet" href="../../assets/…">`
tags. Those are required, and they stay. The gate does not trip on them: C2
inspects `<a>` elements only, and C3 matches only hrefs whose **entire** value
is a root or index path, so `href="../../"` fails while
`href="../../assets/base.css"` passes. Shared CSS stays shared.

**Do not solve this with CSS.** `display: none` on a nav link is not
compliance — the markup must never be emitted in the first place. There is
deliberately no rule in `base.css` or `demo-shell.css` that hides a nav link,
so an orphaned one will look obviously broken. That is intentional.

**And do not reintroduce it in the shared assets.** `assets/base.css` and
`assets/demo-shell.css` must contain no `.demo-back`, no breadcrumb, no
`::before`/`::after` `content` that renders a "← All demos" affordance, and no
selector whose only purpose is styling a link back to the root.

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
- **No cross-demo navigation of any kind** — see §2 "It is sealed". No
  `.demo-back`, no "Back to all demos", no link to `../../` or the site root,
  no mention that other demos exist. Every `<a href>` starts with `#`.
- **No claim that the demo was written without AI.** Do not describe it as
  "hand-written", "written from scratch by hand", or "no AI involved". The
  attribution line in §2 is the whole and accurate statement of how it was
  built; nothing on the page may contradict it.
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
        <h1 class="demo-title">[Demo Title]</h1>
        <p class="demo-sub">[One sentence: what you can do on this page.]</p>
        <p class="demo-meta">
          <span class="tag">[topic]</span>
          <span class="tag">synthetic data</span>
        </p>
        <p class="provenance">
          Built by Aarush Kandukoori with AI assistance. An independent
          mini-demo inspired by [Company]'s public product description; not
          affiliated with [Company].
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
      </div>
    </footer>

    <script src="./app.js"></script>
  </body>
</html>
```

Note what the skeleton does **not** contain: there is no `.demo-back` link in
the header and no link in the footer. The skip link (`href="#stage"`) is the
only `<a>` on the page, and every `<a>` you add must likewise start with `#`.

---

## 5. The demo's README.md

Short, honest, four sections:

```markdown
# [Demo Title]

[Two or three sentences: what it does and what you can try.]

**Inspired by:** [Company] ([website]) — [their public one-liner].
Built by Aarush Kandukoori with AI assistance. An independent mini-demo
inspired by [Company]'s public product description; not affiliated with
[Company].

## How it works
[The actual technique: the algorithm, the data structure, the model. Be
specific — this is the part a founder reads.]

## What's synthetic
[Exactly which data is generated and how. State the simplifications and what
a real system would need instead. Do not oversell.]

## Run it
Open `index.html` in a browser. No build step, no dependencies, no network.
```

The same isolation rule applies here: the demo's `README.md` links to nothing
in this repository outside its own directory, and never mentions that other
demos exist.

---

## 6. Record it in the local inventory — **not** in a published manifest

**`/demos.js` is dead. Do not append to it.** It used to be the manifest that
rendered a card grid on the site root, and that quietly undid §2 "It is
sealed": GitHub Pages serves every file at the repository root, so any
recipient who trimmed their demo URL back to `/` — or fetched `/demos.js` —
read the name of every other company. A sealed demo page behind a published
index is not sealed. `demos.js` is now `window.DEMOS = []` and nothing loads
it; the site root enumerates nothing.

A demo does **not** need to be listed anywhere to be published. It is served
at `demos/<slug>/` because the directory exists. It is delivered as its own
direct link:

```
https://aarushkandukoori.github.io/startup-demos/demos/<slug>/
```

Record it instead in **`/local/INVENTORY.json`**, which is gitignored and
never published. Append one object to the `demos` array:

```json
{
  "slug": "streaming-join-playground",
  "company": "Synnada",
  "title": "Streaming Join Playground",
  "what": "Feeds two synthetic event streams into a windowed join and shows rows matching, buffering, and expiring live.",
  "tags": ["streaming", "sql"]
}
```

- `slug` must equal the directory name exactly.
- `what` describes what **the demo** does when opened — not what the company
  does. Present tense, 90–150 characters, no marketing adjectives.
- `title` follows the naming rule in §3.
- `tags` optional, at most 3, lowercase.

Nothing in `local/` is committed, and nothing in it reaches the web. That is
the point: the list of who received what is Aarush's, not the internet's.

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
- [ ] The exact attribution line from §2 is visible in the header, verbatim,
      with the company name substituted and a straight apostrophe.
- [ ] Every `<a href>` on the page starts with `#`. No `.demo-back`, no
      footer link, no route to the root or to a sibling demo.
- [ ] Nothing on the page hints that other demos exist.
- [ ] No logo, no brand colour, no affiliation claim, no company-product name.
- [ ] `README.md` written, including the "What's synthetic" section.
- [ ] One entry appended to `/local/INVENTORY.json` — **not** to `/demos.js`,
      which is dead and must stay empty (§6).
- [ ] No JavaScript errors in the console.

---

## 8. Compliance checklist — the publish gate

§7 is for the agent that builds the demo. **This section is for the agent that
lets it ship.** Every check below is mechanical: run it, read PASS or FAIL, do
not interpret. A FAIL blocks publication — send the demo back, do not fix it
by hiding the symptom.

Run from the repository root, with the slug and the company name as written on
the page:

```sh
SLUG="streaming-join-playground"   # the demo directory name
CO="Synnada"                       # company name, exactly as it appears on the page
D="demos/$SLUG"
```

### C1 — the attribution line is present, verbatim

```sh
ATTR="Built by Aarush Kandukoori with AI assistance. An independent mini-demo inspired by $CO's public product description; not affiliated with $CO."
tr '\n' ' ' < "$D/index.html" | tr -s ' ' | grep -qF "$ATTR" \
  && echo "C1 PASS" || echo "C1 FAIL — attribution line missing or altered"
```

Whitespace is collapsed before matching, so line breaks and indentation in the
HTML are fine. Nothing else is: a curly apostrophe, a comma instead of the
semicolon, "and AI assistance", a reordered clause, or a missing company name
all FAIL. If C1 fails, diff the page text against the line in §2 character by
character.

### C2 — no anchor leaves the page

```sh
tr '\n' ' ' < "$D/index.html" \
  | grep -oiE "<a [^>]*href=[\"'][^\"']*[\"']" | grep -viE "href=[\"']#" \
  && echo "C2 FAIL — anchor with a non-fragment href (printed above)" \
  || echo "C2 PASS"
```

Every `<a>` must have an `href` starting with `#`. This inspects `<a>`
elements only — the two `<link rel="stylesheet" href="../../assets/…">` tags
are required and are not anchors, so they never trip this check.

### C3 — no href resolves to the root, the index, or a sibling

```sh
grep -rnE "href=[\"'](\.\./|\.\./\.\./|\.\./[a-z0-9-]+/|/startup-demos/?|/|\./|index\.html|\.\./\.\./index\.html|https?://[^\"']*github\.io[^\"']*)[\"']" "$D" \
  && echo "C3 FAIL — root/index/sibling href (printed above)" \
  || echo "C3 PASS"
```

Covers `../`, `../../`, `../<other-slug>/`, `/startup-demos/`, `/`, `./`,
`index.html`, and the deployed site origin.

### C4 — no text reveals that other demos exist

```sh
grep -rinE "all demos|other demos|back to (all|demos)|demo index" "$D" \
  && echo "C4 FAIL — cross-demo text (printed above)" \
  || echo "C4 PASS"
```

### C5 — no nav markup, scripted navigation, or sibling metadata

```sh
grep -rnE "demo-back|location\.(href|assign|replace)|window\.open|history\.(back|go)|http-equiv=[\"']refresh|<base |rel=[\"'](canonical|index|up|prev|next)[\"']|og:url" "$D" \
  && echo "C5 FAIL — navigation escape hatch (printed above)" \
  || echo "C5 PASS"
```

### C6 — the shared assets do not reintroduce navigation

```sh
grep -nE "demo-back|All demos|Back to all|breadcrumb" assets/base.css assets/demo-shell.css \
  && echo "C6 FAIL — nav styling is back in the shared assets" \
  || echo "C6 PASS"
```

### C7 — the attribution is not visually suppressed

```sh
grep -nE "provenance[^>]*(hidden|aria-hidden)|<details" "$D/index.html" \
  && echo "C7 FAIL — attribution hidden or inside a disclosure" \
  || echo "C7 PASS"
grep -n "\.provenance" "$D/style.css" 2>/dev/null \
  && echo "C7 REVIEW — demo CSS touches .provenance; confirm it is still legible" \
  || echo "C7 PASS"
```

A demo-specific rule that sets `.provenance` to `display: none`,
`visibility: hidden`, `opacity: 0`, `font-size: 0`, or the background colour
is a FAIL, however it is spelled.

### C8 — the published site enumerates nothing

Sealing each demo page is pointless if the site root, or any other published
file, lists them. Run this once per publish, from the repository root:

```sh
grep -rlnE "$(ls -d demos/*/ | xargs -n1 basename | paste -sd'|' -)" \
  index.html demos.js 2>/dev/null \
  && echo "C8 FAIL — a published root file names a demo slug (printed above)" \
  || echo "C8 PASS"
grep -q "window.DEMOS = \[\]" demos.js \
  && echo "C8b PASS" || echo "C8b FAIL — demos.js is not empty"
```

The inventory lives in `local/INVENTORY.json`, which is gitignored. If a slug
or company name ever appears in a file that GitHub Pages serves, the demo is
no longer sealed no matter how clean its own page is.

### Gate result

All of C1–C8 PASS → publishable. Any FAIL → not publishable. There is no
partial credit and no override: the attribution line and the sealed page are
the two promises this site makes to the people receiving these links.
