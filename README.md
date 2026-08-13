# startup-demos

A collection of small, self-contained, **working** mini-demos — built by
[Aarush Kandukoori](https://aarushkandukoori.com) while researching companies
whose work he finds interesting and is reaching out to.

Each demo is a single page with real logic and real interactivity, running on
plausible synthetic data generated in the browser. No build step, no
dependencies, no network calls. Open the page and it works.

Published with GitHub Pages from the repository root.

---

## Not affiliated with anyone

Every demo here is an **independent** project, built by Aarush Kandukoori and
inspired by a company's **public** product description — the kind of one-line
summary anyone can read on a company's homepage.

- No demo is affiliated with, endorsed by, sponsored by, or produced in
  cooperation with any company named in it.
- No demo uses any private, confidential, or unpublished information about any
  company, nor any of their code, data, assets, logos, or brand colours.
- Company names appear only to credit what inspired a demo. All trademarks
  belong to their respective owners.
- Every demo carries this line, visibly, on its own page:

  > An independent mini-demo built by Aarush Kandukoori, inspired by
  > `<Company>`'s public product description. Not affiliated with `<Company>`.

All data shown in every demo is synthetic and generated in-browser. Nothing
here is real measurement data, and nothing here — least of all the
medical-device-inspired demos — is a medical device, a diagnostic, or advice
of any kind.

---

## Layout

```
.
├── index.html            landing page — renders the card grid
├── demos.js              the manifest that drives the landing page
├── assets/
│   ├── base.css          shared design system (every demo imports this)
│   └── demo-shell.css    optional layout primitives for a demo page
├── demos/
│   └── <slug>/           one directory per demo
│       ├── index.html    self-contained; links ../../assets/base.css
│       ├── app.js        optional
│       ├── style.css     optional
│       └── README.md
├── TEMPLATE.md           the contract every demo must follow
├── .nojekyll             serve files as-is; allow paths starting with "_"
└── README.md
```

---

## How the landing page gets its list

`index.html` renders its cards from `window.DEMOS`, an array defined in
`demos.js` and loaded with a **plain `<script src="./demos.js">` tag**.

### Why a script tag and not `fetch('demos.json')`

The brief was to pick the approach that cannot break on GitHub Pages. A fetch
of a JSON manifest has several ways to fail, and every one of them produces a
blank page unless you also maintain a duplicated fallback list:

| Failure mode | `fetch('demos.json')` | `<script src="demos.js">` |
| --- | --- | --- |
| Opened from `file://` (local check, someone's download) | Blocked by CORS — fetch rejects | Works |
| File missing or 404 (bad path, not yet committed) | Rejects / parses HTML 404 page as JSON | `window.DEMOS` stays undefined |
| Stale CDN cache serving old JSON | Silent wrong content | Same cache rules, but no parse step |
| Trailing comma / bad quote from an appending agent | `JSON.parse` throws, whole list lost | JS tolerates trailing commas; the array still loads |
| Manifest genuinely broken | Blank grid | Empty state renders, page intact |

The script tag has no request that can be blocked, no parse step that can
throw asynchronously, and no need for a duplicated hard-coded fallback list
that would immediately drift out of date. Failure degrades to *exactly* the
zero-demo state, which is a state the page is designed to render anyway.

Three defences make it safe for ~100 appends by ~100 different agents:

1. **The list is optional.** `index.html` reads
   `Array.isArray(window.DEMOS) ? window.DEMOS : []`. If `demos.js` is
   missing, or throws while parsing, the page renders its empty state instead
   of white-screening — a script error in `demos.js` cannot stop the inline
   render script that follows it.
2. **Each entry is validated independently.** Every object must have a valid
   `slug`, `company`, `title`, and `what`; anything else is skipped. One
   malformed entry costs one missing card, never the grid.
3. **Nothing is rendered as HTML.** Cards are built with `createElement` and
   `textContent`, so manifest content cannot inject markup.

The page is also correct with **zero** demos present: the toolbar hides, and
the empty state explains that demos are on the way. It grows simply by
appending entries.

### Adding a demo to the list

Append one object to the array in `demos.js`, directly above the
`APPEND MARKER` comment — see [`TEMPLATE.md`](./TEMPLATE.md) §6:

```js
{
  slug: "streaming-join-playground",
  company: "Synnada",
  title: "Streaming Join Playground",
  what: "Feeds two synthetic event streams into a windowed join and shows rows matching, buffering, and expiring live.",
  tags: ["streaming", "sql"]
},
```

The card links to `./demos/<slug>/`, so `slug` must match the directory name.

---

## Building a demo

Read [`TEMPLATE.md`](./TEMPLATE.md). It is the contract, not a suggestion: it
covers the required directory layout, the "it must actually work" bar,
performance, keyboard access, mobile, the exact provenance wording, and what
is forbidden (logos, borrowed brand colours, affiliation claims, naming a demo
as if it were a company's product).

## Running locally

No toolchain. Open `index.html` in a browser — it works over `file://`.

If you prefer a server:

```sh
python3 -m http.server 8000
```

then visit <http://localhost:8000/>.

## Design system

`assets/base.css` is the single visual signature across every demo: a system
font stack for body text (monospace only for code and numeric readouts),
light and dark via `prefers-color-scheme` (with a `data-theme` override),
a fluid type scale, a 4 px spacing rhythm, and one restrained teal accent.
Demos should use its tokens and components rather than inventing their own
colours.

## Licence

Code in this repository is released under the MIT Licence by Aarush
Kandukoori. Company names and trademarks referenced in demo titles and
provenance notes remain the property of their respective owners and are used
only to describe what inspired each independent demo.
