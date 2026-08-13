/* ==========================================================================
   demos.js — deliberately empty.

   THIS FILE NO LONGER CARRIES THE DEMO LIST, AND NOTHING LOADS IT.

   It used to hold one entry per demo and drive a card grid on the landing
   page. That was a leak: every file at the repository root is served by
   GitHub Pages, so anyone who received a link to one demo could trim the URL
   to /demos.js and read the name of every other company we had built for.
   A demo page is supposed to be sealed (TEMPLATE.md §2, "It is sealed") — a
   published manifest defeats that no matter how carefully the demo pages
   themselves are written.

   So:

   - index.html no longer references this file and renders no list, no
     filter and no count. It enumerates nothing.
   - The inventory now lives in local/INVENTORY.json, which is gitignored and
     never published. That is where a new demo gets recorded.
   - The array below stays as an empty array rather than being deleted, so
     that anything still requesting /demos.js gets valid, empty JavaScript
     instead of a 404 page — and so that an agent that appends an entry here
     out of habit breaks nothing and leaks nothing on its own.

   DO NOT ADD ENTRIES HERE. Add them to local/INVENTORY.json. Anything
   appended below is published to the open internet.

   Each demo is delivered as its own direct link:
     https://aarushkandukoori.github.io/startup-demos/demos/<slug>/
   ========================================================================== */

window.DEMOS = [];
