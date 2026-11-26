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
| `BOTID_MODE` | No | `enforce` (default) blocks bots on the paid endpoints; `log` only logs verdicts; `off` disables the check |
| `OPENAI_MODEL_VISION` | No | Model for the photo passes (count, tiles, visual verify). Default `gpt-4o` |
| `OPENAI_MODEL_TEXT` | No | Model for the text-only steps (Pass 3 verify, `/api/fix`). Default `gpt-4o-mini`; set `gpt-4o` to switch back |
| `OPENAI_PRICES` | No | JSON price table for the cost estimate, USD per 1M tokens `[input, output]`, e.g. `{"gpt-4o":[2.5,10]}`. Defaults: gpt-4o 2.5/10, gpt-4o-mini 0.15/0.60 |
| `OPENAI_PRICE_INPUT_PER_M` / `OPENAI_PRICE_OUTPUT_PER_M` | No | Older override for the vision model's price only (still honoured) |

Copy `.env.example` to `.env` and fill in values.

## Architecture & Key Patterns

### Book Identification Pipeline (server.js)

The scanning process is a multi-pass pipeline:

All passes live in `runScan()` and use OpenAI Structured Outputs (`callJson()` with a strict JSON schema), so responses always parse.

1. **Pass 1 — Count:** Quick GPT-4o call at `detail: "low"` (85 image tokens) to estimate book count and shelf layout; it only steers the tile grid
2. **Pass 2 — Identify:** Adaptive image tiling (2-4 cols, 2-4 rows) with 25% overlap, plus one full-image pass; parallel GPT-4o "high" detail calls via `Promise.allSettled` (a failed section is skipped, not fatal)
3. **Deduplication:** Merge results across overlapping tiles, keep highest confidence (confidence is an integer 0–100; `toConfidence()` clamps it and maps legacy high/medium/low labels)
4. **Pass 3 — Verify:** Text-only call on `MODEL_TEXT` (gpt-4o mini) to fix title/author mix-ups. It returns **only corrections** (`VERIFY_EDITS_SCHEMA`: `edits` by 1-based index + `remove`), applied by `applyVerifyEdits()` — untouched books keep every field, edited ones keep their confidence and get `corrected: true`
5. **Pass 4 — Visual verify:** Re-show the full image with the numbered list; GPT returns only the numbers it can't find (`NOT_VISIBLE_SCHEMA`), which `dropNotVisible()` removes
6. **Pass 5 — Catalog check:** `catalogCheck()` looks each book up in Open Library and Google Books in parallel (4 books at a time, 8 s per request, 25 s for the whole pass). Found in both → +15 confidence, one → +5, neither → −25 and `notInCatalog: true`. A catalog that times out or rate-limits counts as unknown, never "not found". Matches are stored in `book.catalogMatch` (with `matchedFor`), which `/api/lookup` reuses if the title/author weren't edited

### Streaming scan results

`POST /api/scan` with `Accept: application/x-ndjson` streams newline-delimited JSON events while the scan runs:
`stage` (progress message), `overview` (Pass 1), `tile` (cumulative deduped books after each section), `warning` (a section failed), then `result` (final books) or `error`. Without that header it returns a single JSON `{ books, overview }`. The frontend shows books on the review screen as they arrive (read-only until `result`). If the client disconnects, the server aborts the remaining GPT calls.

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scan` | POST | Upload image → identified books (multipart form; NDJSON stream if requested) |
| `/api/fix` | POST | `{ books, instruction }` → apply a plain-words correction ("book 3 is by Le Guin", "remove the cookbook", "add Dune"). Returns `{ books, reply, changed, updated, removed, added }`. Instruction ≤ 500 chars, ≤ 300 books |
| `/api/lookup` | POST | Enrich book list with ISBN & metadata. Books with an `isbn13` (barcode/typed) are looked up exactly by ISBN; others reuse scan-time catalog matches, then Open Library, then Google Books. Max 500 books, 6 at a time |

### Frontend Flow

Three-step wizard: **Capture** → **Review & Edit** → **Export CSV**

- Client-side image compression before upload (max 3200px, JPEG quality 0.80); small JPEG/PNGs are sent as-is, and the original is kept if compressing makes it bigger
- One automatic retry if the network drops before the scan response starts (never after streaming begins)
- Review screen shows confidence as a percentage (≥80 green, 50–79 yellow, <50 red) with a "Remove all below 50%" button
- 270s client timeout (fits within Vercel's 300s limit); books found before a timeout are kept and marked unverified

### Fix it by describing it

The review step has a "✏️ Fix it by describing it" box; review cards are numbered so users can say "book 3". `/api/fix` asks GPT (`describeFixes()`, strict `FIX_SCHEMA`) for **edits, not a rewritten list** — `{index, action: update|remove, title, author}` plus `additions` and a one-sentence `reply` — and `applyFixes()` applies them: out-of-range/duplicate indexes and no-op edits are ignored, untouched books keep every field (ISBNs, catalog data), updated/added books get `fixed: true` and confidence 100. Ambiguous requests return no edits and an explanation in `reply`. The client keeps one level of undo and highlights changed cards.

### Cost protection

Every scan can make ~20 GPT-4o calls, so the paid endpoints are protected:
- **Vercel BotID** (basic, free) on `POST /api/scan`, `/api/fix` and `/api/lookup`. The browser part is `botid/client/core`, served by `server.js` at `/vendor/botid.mjs` with `process.env.NODE_ENV` filled in (no bundler), and loaded as a module in `index.html` with the same three routes in `protect`. The server calls `rejectBots()` at the top of each handler — before multer saves the upload for `/api/scan` — and returns 403 JSON for bots. Off Vercel (local dev, no OIDC token) the check throws and **fails open** with one log line. The two BotID routes in `vercel.json` must stay **above** the catch-all route. `curl`/Postman calls to these endpoints are reported as bots on Vercel, as intended.
- **Rate limits** are a Vercel Firewall rule (dashboard), not code. The client shows friendly messages for 429 and 403 via `readJsonOrThrow()` / `friendlyHttpError()` in `app.js`.
- **Cost logging:** `callJson()` adds each call's token usage to a per-request tally (`AsyncLocalStorage`, via `withUsage()`); each scan/fix logs one JSON line — `{"event":"scan_usage","calls",…,"input_tokens","output_tokens","est_usd","outcome","books","ms","by_pass","by_model"}` — searchable in Vercel logs. `est_usd` is priced per model (`priceFor()`); `by_pass` (keyed by schema name) shows where the tokens go.
- **Cheap where it's safe:** the photo passes use `MODEL_VISION` (gpt-4o); text-only steps use `MODEL_TEXT` (gpt-4o mini). The verify passes return only changes, not the whole list, because output tokens cost 4× input.
- **Owner-side hard cap:** set a monthly budget limit on the OpenAI project.

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
| botid | Vercel BotID bot protection (server check + browser script served at `/vendor/botid.mjs`) |

No dev dependencies.

## Common Issues & Recent Fixes

- **Timeouts on Vercel:** Client compresses images before upload; Vercel maxDuration set to 300s
- **Hallucinated books:** Multi-pass verification pipeline reduces false positives
- **Undercounting:** Adaptive tiling with overlap ensures books at tile edges aren't missed
- **API key whitespace:** Key is trimmed on load to prevent trailing newline issues
- **Slow catalogs:** Open Library searches often take 2–3 s; the catalog pass is time-boxed so it can't push a scan past Vercel's limit
- **Local testing behind a proxy:** Node's built-in `fetch` ignores `HTTPS_PROXY`; run with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21) if catalog requests fail with `fetch failed`
- **BotID says "check unavailable" in logs on Vercel:** the project needs OIDC enabled (Project → Settings → Security → "Secure backend access with OIDC federation"); until then requests are allowed
- **`.hidden` on buttons:** `.btn` sets `display`, so buttons need `.btn.hidden` (in style.css) to actually hide
- **Files read with `fs` from `node_modules` on Vercel:** Vercel only bundles files that code `require`s. Anything else (like BotID's `client/core/index.mjs`) must be listed in `includeFiles` in `vercel.json`, or it is missing at runtime. Read such files lazily with a fallback; a throw at startup takes the whole site down with `FUNCTION_INVOCATION_FAILED`
- **Unreadable formats (e.g. HEIC):** `/api/scan` checks the image decodes with sharp before streaming and returns 415 with instructions
