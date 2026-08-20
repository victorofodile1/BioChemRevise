# biochemrevise.co.uk

A-level Biology revision notes covering the full **AQA 7401 / 7402** specification — 53 spec-point pages
across 8 topics, each with full notes, a 5-minute cram sheet, a mark-scheme wording drill, three
in-browser study tools (Tutor AI, Blurt AI, Feynman AI), and **551 exam-style practice questions
(1,375 marks)** with full mark schemes at the end of every section.

It's a **plain static site**: no build step, no dependencies, no framework. Every page is a
self-contained HTML file. That means it deploys to Vercel instantly and will still work in ten years.

## Structure

```
.
├── index.html          # homepage: search + all 53 spec points grouped by topic
├── 404.html
├── robots.txt
├── sitemap.xml
├── vercel.json         # cleanUrls, caching + security headers
├── notes/
│   ├── 3-1-1-monomers-and-polymers.html
│   ├── 3-1-2-carbohydrates.html
│   └── …  (53 files)
├── AI-TOOLS-GUIDE.md   # how to make the three study tools model-backed
└── ai-upgrade/         # starter code for that — inert until you move it to ./api
```

URLs are clean — `notes/3-1-2-carbohydrates.html` is served at `/notes/3-1-2-carbohydrates`.

## Run it locally

Any static server will do. With Python (already on macOS):

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Note that with `http.server` the clean URLs won't resolve — use
`/notes/3-1-2-carbohydrates.html` locally, or run `vercel dev` for behaviour identical to production.

## Push to GitHub

```bash
git init
git add .
git commit -m "A-level Biology revision site: 53 AQA spec points"
git branch -M main
git remote add origin git@github.com:YOUR-USERNAME/biochemrevise.git
git push -u origin main
```

## Deploy to Vercel

**Option A — dashboard (easiest).** Go to <https://vercel.com/new>, import the GitHub repo, and deploy.
Leave every build setting blank: framework preset `Other`, no build command, output directory `.`.
Every push to `main` redeploys automatically.

**Option B — CLI.**

```bash
npm i -g vercel
vercel        # preview deploy
vercel --prod # production
```

## Custom domain

In the Vercel project → **Settings → Domains** → add `biochemrevise.co.uk` and `www.biochemrevise.co.uk`.
Vercel will show the DNS records to add at your registrar — typically an `A` record for the apex pointing
at `76.76.21.21` and a `CNAME` for `www` pointing at `cname.vercel-dns.com` (use whatever Vercel shows
you, as these can change).

## Adding a new spec point

1. Drop the new self-contained HTML file in `notes/` using the same slug pattern (`3-9-1-topic-name.html`).
2. Add a matching `<a class="card">` block to `index.html` inside the right `<section class="topic">`.
3. Add the page to the sidebar `.site-nav` list in the other note pages (or re-run the generator).
4. Add a `<url>` entry to `sitemap.xml`.

## Practice questions

Every section ends with an **Exam-style practice** block:

- **AS / A2 / Both** switch in the block header. The choice is remembered and applies to every block on
  every page. Pages for topics 3.5–3.8 are A2-only, so the switch is hidden there.
- **Show mark schemes** reveals every answer in that block at once, with AQA's marking points and the
  accept / ignore / reject rules, plus the paper each one comes from.
- Diagrams the questions depend on are in `notes/figures/`, referenced as `/notes/figures/<name>.png`.

The questions are original, written in the style of real AQA past-paper questions; the mark schemes use
AQA's own marking points. That provenance is stated in every block.

They were built from the workbook PDFs in `A3) Workbooks` and are baked into the HTML — there's no
separate data file to keep in sync, and no JavaScript is needed to read them.

## Notes on the study tools

Tutor AI, Blurt AI and Feynman AI currently run **entirely client-side** — they match your writing against
a hand-written keyword list baked into each page. No network requests, no API keys, nothing stored.
See `AI-TOOLS-GUIDE.md` for how to upgrade them to real model-backed tools.

---

AQA is not affiliated with and does not endorse this site.
