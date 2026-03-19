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

Copy `.env.example` to `.env` and fill in values.

## Architecture & Key Patterns

### Book Identification Pipeline (server.js)

The scanning process is a multi-pass pipeline:

1. **Pass 1 — Count:** Quick GPT-4o call at "low" detail to estimate book count (cheap)
2. **Pass 2 — Identify:** Adaptive image tiling (2-4 cols, 1-4 rows based on count) with 15% overlap, parallel GPT-4o "high" detail calls per tile
3. **Pass 3 — Verify:** Text-only GPT call to fix hallucinated titles/authors
4. **Deduplication:** Merge results across overlapping tiles, keep highest confidence

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scan` | POST | Upload image → returns identified books (multipart form) |
| `/api/lookup` | POST | Enrich book list with ISBN & metadata from Open Library |

### Frontend Flow

Three-step wizard: **Capture** → **Review & Edit** → **Export CSV**

- Client-side image compression before upload (max 3200px, JPEG quality 0.80)
- 270s client timeout (fits within Vercel's 300s limit)

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
