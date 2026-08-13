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
- Every demo carries this line, visibly, in its own page header:

  > Built by Aarush Kandukoori with AI assistance. An independent mini-demo
  > inspired by `<Company>`'s public product description; not affiliated with
  > `<Company>`.

## Built with AI assistance

These demos were built by Aarush Kandukoori with AI assistance, and every one
of them says so on its own page. The design, the choice of what to build for
each company, the technique each demo demonstrates, and the review of whether
it actually works are his; the code was written with an AI assistant's help.
Neither half of that is hidden.

## One demo per link

Each demo is a **sealed page**. A company receives a link to their demo and
only their demo, and a demo page contains no link to the site root, to an
index, or to any sibling demo — see [`TEMPLATE.md`](./TEMPLATE.md) §2 "It is
sealed". The landing page at the site root enumerates nothing: no list, no
filter, no count, no links to demos. The inventory of what has been built
lives in `local/INVENTORY.json`, which is gitignored and never published.

### What this does not do

**This is not access control, and it is not privacy.** Two things are worth
being plain about:

- **The repository is public.** Anyone who finds it — including anyone who
  received a demo link and went looking — can browse
  `github.com/aarushkandukoori/startup-demos`, read the directory listing
  under `demos/`, and see every company a demo was built for. That is a
  property of a public repository, not something the site can undo.
- **The site is public too.** Every demo URL is guessable and unauthenticated.
  Nothing here checks who is asking.

What the sealed-page rule actually buys is narrower and worth stating
honestly: a recipient reading their own demo is not *shown* the others, and
trimming the URL to the site root does not hand them a list. Someone who goes
looking will find them. If a demo ever needs to be genuinely private, it must
not be published from a public repository at all.

All data shown in every demo is synthetic and generated in-browser. Nothing
here is real measurement data, and nothing here — least of all the
medical-device-inspired demos — is a medical device, a diagnostic, or advice
of any kind.

---

## Layout

```
.
├── index.html            landing page — a few sentences, enumerates nothing
├── demos.js              deliberately empty; kept so /demos.js is not a 404
├── local/                gitignored, never published
│   └── INVENTORY.json    the demo list — companies, slugs, titles
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

## The landing page has no list

The site root used to render a card grid of every demo from a published
`demos.js` manifest. It no longer does, and the manifest is now an empty
array.

The reason is the one thing the old design got wrong: **a published manifest
undoes a sealed page.** Demo pages were careful never to link to each other,
but `demos.js` sat at the repository root, and GitHub Pages serves every file
at the repository root. Any recipient who trimmed their demo URL back to `/`
saw a grid of every company; anyone who fetched `/demos.js` directly saw the
same list even if the grid were removed. The isolation was one URL edit deep.

So the root page is now static: a few sentences saying what the site is and
that it is not an index. No list, no filter, no counts, no links to demos, and
no script that could ever grow one. `demos.js` is kept as
`window.DEMOS = []` — with a comment saying why — only so that `/demos.js`
returns valid empty JavaScript rather than a 404 page, and so that an agent
which appends an entry out of habit leaks nothing by itself.

### Adding a demo

Record it in **`local/INVENTORY.json`**, which is gitignored and never
published:

```json
{
  "slug": "streaming-join-playground",
  "company": "Synnada",
  "title": "Streaming Join Playground",
  "what": "Feeds two synthetic event streams into a windowed join and shows rows matching, buffering, and expiring live.",
  "tags": ["streaming", "sql"]
}
```

`slug` must match the directory name under `demos/`. The demo is then
delivered as its own direct link:

```
https://aarushkandukoori.github.io/startup-demos/demos/<slug>/
```

Nothing needs to be added to the site for that link to work — `demos/<slug>/`
is served because the directory exists, not because it is listed anywhere.

---

## Building a demo

Read [`TEMPLATE.md`](./TEMPLATE.md). It is the contract, not a suggestion: it
covers the required directory layout, the "it must actually work" bar,
performance, keyboard access, mobile, the exact attribution wording, the
no-cross-demo-navigation rule, and what is forbidden (logos, borrowed brand
colours, affiliation claims, naming a demo as if it were a company's
product). §8 is the mechanical publish gate — a demo ships only when C1–C7
all pass.

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
