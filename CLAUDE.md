# CLAUDE.md

## Project Overview

Bookshelf Scanner is a full-stack web app that photographs bookshelves and identifies books using GPT-4o Vision. Users capture/upload a bookshelf image, review identified books, and export a CSV for import into Libib (library management app).

## Tech Stack

- **Backend:** Node.js + Express (single file: `server.js`)
- **Frontend:** Vanilla HTML/CSS/JS (no framework, no bundler)
- **Image Processing:** Sharp (resize, crop, tile)
- **AI:** OpenAI GPT-4o Vision API for book spine recognition
- **Metadata:** Open Library Search API for ISBN lookup
- **Deployment:** Vercel (serverless, see `vercel.json`)

## Project Structure

```
server.js           # Express server — all backend logic (API routes, image processing, GPT calls)
public/
  index.html        # Single-page app shell (3-step wizard UI)
  app.js            # Frontend state management, event handlers, API calls
  style.css         # Mobile-responsive styles (green theme)
uploads/            # Temporary image storage (gitignored, uses /tmp on Vercel)
.env.example        # Environment variable template
vercel.json         # Vercel deployment config (300s timeout)
```

## Commands

```bash
npm start           # Start production server (node server.js)
npm run dev         # Start with auto-reload (node --watch server.js)
```

No build step, no test suite, no linter configured.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for GPT-4o Vision |
| `PORT` | No | Server port (defaults to 3000) |
| `GOOGLE_BOOKS_API_KEY` | No | Google Books key for the catalog check; without it Google Books is often rate-limited (treated as "unknown") |

Copy `.env.example` to `.env` and fill in values.

## Architecture & Key Patterns

### Book Identification Pipeline (server.js)

The scanning process is a multi-pass pipeline:

All passes live in `runScan()` and use OpenAI Structured Outputs (`callJson()` with a strict JSON schema), so responses always parse.

1. **Pass 1 — Count:** Quick GPT-4o call to estimate book count and shelf layout
2. **Pass 2 — Identify:** Adaptive image tiling (2-4 cols, 2-4 rows) with 25% overlap, plus one full-image pass; parallel GPT-4o "high" detail calls via `Promise.allSettled` (a failed section is skipped, not fatal)
3. **Deduplication:** Merge results across overlapping tiles, keep highest confidence (confidence is an integer 0–100; `toConfidence()` clamps it and maps legacy high/medium/low labels)
4. **Pass 3 — Verify:** Text-only GPT call to fix title/author mix-ups
5. **Pass 4 — Visual verify:** Re-show the full image with the list; drop books GPT can't find on the shelf
6. **Pass 5 — Catalog check:** `catalogCheck()` looks each book up in Open Library and Google Books in parallel (4 books at a time, 8 s per request, 25 s for the whole pass). Found in both → +15 confidence, one → +5, neither → −25 and `notInCatalog: true`. A catalog that times out or rate-limits counts as unknown, never "not found". Matches are stored in `book.catalogMatch` (with `matchedFor`), which `/api/lookup` reuses if the title/author weren't edited

### Streaming scan results

`POST /api/scan` with `Accept: application/x-ndjson` streams newline-delimited JSON events while the scan runs:
`stage` (progress message), `overview` (Pass 1), `tile` (cumulative deduped books after each section), `warning` (a section failed), then `result` (final books) or `error`. Without that header it returns a single JSON `{ books, overview }`. The frontend shows books on the review screen as they arrive (read-only until `result`). If the client disconnects, the server aborts the remaining GPT calls.

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scan` | POST | Upload image → identified books (multipart form; NDJSON stream if requested) |
| `/api/lookup` | POST | Enrich book list with ISBN & metadata. Books with an `isbn13` (barcode/typed) are looked up exactly by ISBN; others reuse scan-time catalog matches, then Open Library, then Google Books. Max 500 books, 6 at a time |

### Frontend Flow

Three-step wizard: **Capture** → **Review & Edit** → **Export CSV**

- Client-side image compression before upload (max 3200px, JPEG quality 0.80); small JPEG/PNGs are sent as-is, and the original is kept if compressing makes it bigger
- One automatic retry if the network drops before the scan response starts (never after streaming begins)
- Review screen shows confidence as a percentage (≥80 green, 50–79 yellow, <50 red) with a "Remove all below 50%" button
- 270s client timeout (fits within Vercel's 300s limit); books found before a timeout are kept and marked unverified

### ISBN barcode scanning

"🏷️ Scan ISBN Barcodes" (capture step) and "Add by Barcode" (review step) open a camera overlay that reads EAN-13 barcodes with **ZXing** (`@zxing/browser@0.2.1` UMD from jsDelivr, pinned with an SRI `integrity` hash — the only third-party script; update the hash if you bump the version). Only valid ISBN-13s starting 978/979 are accepted (other barcodes such as prices are ignored); ISBNs can also be typed (ISBN-10 is converted). On Done, ISBNs go to `/api/lookup` → `lookupByIsbn()` (Open Library, one retry, then Google Books) and are added to the review list as `source: "barcode"` at 100% confidence. The scanned ISBN is always kept, even when unmatched, so it still exports to Libib; `lookupFailed: true` means the catalogs didn't respond (not "not found"). The camera needs HTTPS (or localhost).

## Key Conventions

- **No frameworks** — vanilla JS on frontend, plain Express on backend. Keep it simple.
- **Single-file backend** — all server logic lives in `server.js`. No routing modules or middleware files.
- **Stateless** — no database, no sessions. Each scan is independent.
- **Vercel-aware** — code detects Vercel environment for upload paths (`/tmp/uploads`).

## Dependencies

| Package | Purpose |
|---------|---------|
| express | Web server |
| multer | Multipart file upload handling |
| openai | GPT-4o Vision API client |
| sharp | Image resize/crop/tile processing |
| dotenv | Load .env variables |

No dev dependencies.

## Common Issues & Recent Fixes

- **Timeouts on Vercel:** Client compresses images before upload; Vercel maxDuration set to 300s
- **Hallucinated books:** Multi-pass verification pipeline reduces false positives
- **Undercounting:** Adaptive tiling with overlap ensures books at tile edges aren't missed
- **API key whitespace:** Key is trimmed on load to prevent trailing newline issues
- **Slow catalogs:** Open Library searches often take 2–3 s; the catalog pass is time-boxed so it can't push a scan past Vercel's limit
- **Local testing behind a proxy:** Node's built-in `fetch` ignores `HTTPS_PROXY`; run with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21) if catalog requests fail with `fetch failed`
- **`.hidden` on buttons:** `.btn` sets `display`, so buttons need `.btn.hidden` (in style.css) to actually hide
- **Unreadable formats (e.g. HEIC):** `/api/scan` checks the image decodes with sharp before streaming and returns 415 with instructions
