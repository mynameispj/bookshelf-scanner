require("dotenv").config();
const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Multer – store uploaded photos temporarily
// ---------------------------------------------------------------------------
const uploadDir = process.env.VERCEL ? "/tmp/uploads" : path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// OpenAI client
// ---------------------------------------------------------------------------
const openai = new OpenAI({ apiKey: (process.env.OPENAI_API_KEY || "").trim() });

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ---------------------------------------------------------------------------
// Image helpers – tiling & enhancement
// ---------------------------------------------------------------------------

/** Enhance an image buffer: auto-level, sharpen */
async function enhanceImage(buffer) {
  return sharp(buffer)
    .normalize()                          // auto-levels contrast
    .sharpen({ sigma: 1.2 })             // gentle sharpen for text
    .toBuffer();
}

/** Convert a buffer to a base64 data-URI */
function bufferToDataUri(buf, mime = "image/jpeg") {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/**
 * Split an image into overlapping tiles.
 * Adaptive grid: uses the book-count estimate to decide how many columns/rows.
 * More books → more tiles → better per-tile accuracy.
 * Each tile gets ~15% overlap on edges so books at borders aren't missed.
 */
async function tileImage(buffer, overview = null) {
  const meta = await sharp(buffer).metadata();
  const w = meta.width;
  const h = meta.height;

  // For small images (< 1200px on both sides), don't tile
  if (w < 1200 && h < 1200) {
    const enhanced = await enhanceImage(buffer);
    return [{ buffer: enhanced, label: "full image" }];
  }

  // Adaptive grid sizing based on estimated book count and image size
  const bookCount = overview?.count || 0;
  const shelves   = overview?.shelves || 1;

  // Columns: wider images & more books → more columns
  let cols, rows;
  if (bookCount >= 40 || w >= 3000) {
    cols = 4;
  } else if (bookCount >= 20 || w >= 2000) {
    cols = 3;
  } else {
    cols = 2;
  }

  // Rows: match shelf count, min 1, but at least 2 for tall images
  if (shelves >= 4 || h >= 3000) {
    rows = 4;
  } else if (shelves >= 2 || h >= 1600) {
    rows = Math.max(shelves, 2);
  } else {
    rows = 1;
  }

  console.log(`  Adaptive tiling: ${cols}×${rows} grid for ~${bookCount} books, ${shelves} shelves, ${w}×${h}px`);

  const overlapFrac = 0.15;
  const regions = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cellW = Math.round(w / cols);
      const cellH = Math.round(h / rows);
      const padL = col > 0        ? Math.round(cellW * overlapFrac) : 0;
      const padR = col < cols - 1  ? Math.round(cellW * overlapFrac) : 0;
      const padT = row > 0         ? Math.round(cellH * overlapFrac) : 0;
      const padB = row < rows - 1  ? Math.round(cellH * overlapFrac) : 0;

      const left   = Math.max(0, col * cellW - padL);
      const top    = Math.max(0, row * cellH - padT);
      const right  = Math.min(w, (col + 1) * cellW + padR);
      const bottom = Math.min(h, (row + 1) * cellH + padB);

      regions.push({
        left,
        top,
        width:  right - left,
        height: bottom - top,
        label:  `row${row + 1}-col${col + 1}`,
      });
    }
  }

  const tiles = await Promise.all(
    regions.map(async (r) => {
      const buf = await sharp(buffer)
        .extract({ left: r.left, top: r.top, width: r.width, height: r.height })
        .pipe(sharp().normalize().sharpen({ sigma: 1.2 }))
        .toBuffer();
      return { buffer: buf, label: r.label };
    })
  );

  return tiles;
}

// ---------------------------------------------------------------------------
// GPT helpers
// ---------------------------------------------------------------------------

/** Parse a GPT response – strip markdown fences, return JS object */
function parseGptJson(raw) {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return JSON.parse(text);
}

/** Pass 1 – quick count & overview using low-detail (cheap) */
async function countBooks(dataUri) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 1024,
    messages: [
      {
        role: "system",
        content: `You are a book-counting assistant. The user will send a photo of a bookshelf.
Count every distinct book whose spine or cover is at least partially visible.
Scan systematically: shelf by shelf, left to right, top to bottom.
Include books that are sideways, stacked flat, partially hidden, or only partly in frame.

Return ONLY a JSON object with these fields, no markdown fences, no commentary:
{
  "count": <number>,
  "shelves": <number of distinct shelf rows visible>,
  "notes": "<brief description of layout, e.g. '3 shelves, some books stacked flat on top'>"
}`,
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUri, detail: "low" } },
          { type: "text", text: "How many books are visible in this image?" },
        ],
      },
    ],
  });
  return parseGptJson(completion.choices[0].message.content);
}

/** Pass 2 – identify books in a single tile */
async function identifyBooksInTile(tileDataUri, tileLabel, overview, totalTiles) {
  const anchorHint = overview
    ? `The full bookshelf contains approximately ${overview.count} books across ${overview.shelves} shelf/shelves. Layout: ${overview.notes}. You are looking at the ${tileLabel} section.`
    : `You are looking at the ${tileLabel} section of a bookshelf.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 8192,
    messages: [
      {
        role: "system",
        content: `You are a book-identification expert. You will receive a cropped section of a bookshelf photo.
${anchorHint}

Your task: identify EVERY SINGLE book whose spine or cover is at least partially visible in THIS section.
Scan methodically: shelf by shelf, left to right, top to bottom. Do NOT stop early.

For each book return:
  - title       (string – the book's title ONLY, no author names)
  - author      (string – the author's name ONLY, "Unknown" if unreadable)
  - confidence  ("high" | "medium" | "low")
    • "high"   = text clearly readable
    • "medium" = partially readable, you're fairly sure
    • "low"    = guessing from color/shape/partial letters

TITLE vs AUTHOR — how to tell them apart on a spine:
- On most spines the author name and title are in SEPARATE text blocks with different font sizes.
- The author name is usually SMALLER text and appears at the TOP or BOTTOM of the spine.
- The title is usually LARGER or bolder text in the MIDDLE of the spine.
- NEVER combine author and title into one field. "Stephen King" is an author, not part of a title.
- If you recognize the book (e.g. "It" by Stephen King), use your world knowledge to confirm the correct title/author split.
- If the cover shows the author name prominently (common for famous authors), do NOT put it in the title field.

CRITICAL RULES:
- You MUST include EVERY book visible, even if it means returning 20+ entries.
- Do NOT skip books just because the text is hard to read — include them with "low" confidence.
- Do NOT stop after finding a few books. Carefully scan the ENTIRE image from edge to edge.
- NEVER HALLUCINATE OR INVENT books. Only report books you can actually SEE in the image.
- If you can only see a partial title, include what you can see — do NOT guess the rest.
- If a spine is too blurry to read ANY text, skip it rather than guessing a title.
- Books that are sideways, stacked flat, or partially behind other books still count — but only if you can see them.
- If you recognize a well-known book BY ITS VISIBLE TEXT, use the commonly known correct title and author.
- Do NOT fill in books based on what "might" be on a shelf. Every entry must be grounded in visible text or recognizable cover art.

Return ONLY a JSON array, no markdown fences, no commentary.
Example: [{"title":"Dune","author":"Frank Herbert","confidence":"high"},{"title":"1984","author":"George Orwell","confidence":"medium"}]
If no books are visible in this section, return [].`,
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: tileDataUri, detail: "high" } },
          { type: "text", text: "Identify ALL books visible in this section. Be thorough — scan every shelf from left to right. Only include books you can actually see, never guess or invent titles." },
        ],
      },
    ],
  });
  return parseGptJson(completion.choices[0].message.content);
}

// ---------------------------------------------------------------------------
// Deduplication – merge results from multiple tiles
// ---------------------------------------------------------------------------

/** Normalize a title for comparison */
function normalizeTitle(t) {
  return (t || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/**
 * Merge book arrays from multiple tiles. Keep the highest-confidence copy
 * when duplicates are found (same normalized title).
 */
function deduplicateBooks(allBooks) {
  const confRank = { high: 3, medium: 2, low: 1 };
  const map = new Map(); // normalizedTitle → best book

  for (const book of allBooks) {
    const key = normalizeTitle(book.title);
    if (!key) continue;

    const existing = map.get(key);
    if (!existing || (confRank[book.confidence] || 0) > (confRank[existing.confidence] || 0)) {
      map.set(key, book);
    }
  }

  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Pass 3 – verification: text-only GPT call to fix title/author issues
// ---------------------------------------------------------------------------
async function verifyAndCleanBooks(books) {
  if (books.length === 0) return books;

  const bookListJson = JSON.stringify(books);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 4096,
    messages: [
      {
        role: "system",
        content: `You are a book-data quality checker. You will receive a JSON array of books identified from a bookshelf photo.

Your job is to FIX common errors:

1. AUTHOR IN TITLE: If the title field contains the author's name (e.g. title="Stephen King It"), split it so title="It" and author="Stephen King".
2. TITLE IN AUTHOR: If the author field contains a title or subtitle, move it to the title field.
3. UNKNOWN AUTHOR: If the author is "Unknown" but you recognize the book from its title, fill in the correct author.
4. WRONG AUTHOR: If you know the real author of a well-known book and it doesn't match, correct it.
5. TITLE CLEANUP: Fix obvious OCR-style errors in titles (e.g. "Tnr Hobbit" → "The Hobbit"). But do NOT change titles you don't recognize — they might be correct niche books.
6. DUPLICATE DETECTION: If two entries are clearly the same book (e.g. "The Hobbit" and "Hobbit, The"), keep only the one with higher confidence.
7. REPEATED TEXT IN TITLE: If a title contains the same phrase repeated (e.g. "Moon Take a Hike Seattle Moon Take a Hike Seattle Hikes Within Two Hours"), clean it to just the real title ("Moon Take a Hike Seattle").
8. SUMMARY/REVIEW BOOKS: If a title starts with "Summary of", "Review of", or "Summary and Detail Review of", the real book is what follows. Change the title to just the real book title and set the author to the real author, not the summary publisher.

For each book, preserve the original confidence field. If you made a correction, set "corrected": true on that entry.

Return ONLY the corrected JSON array, no markdown fences, no commentary. Keep the same format:
[{"title":"...","author":"...","confidence":"high|medium|low","corrected":true|false}]`,
      },
      {
        role: "user",
        content: `Please review and fix any issues in this book list:\n${bookListJson}`,
      },
    ],
  });

  try {
    const cleaned = parseGptJson(completion.choices[0].message.content);
    console.log(`  Pass 3 (verify) → ${cleaned.filter(b => b.corrected).length} corrections made`);
    return cleaned;
  } catch (e) {
    console.warn("  Pass 3 (verify) parse failed, using uncleaned results:", e.message);
    return books;
  }
}

// ---------------------------------------------------------------------------
// POST /api/scan  – accept an image, return identified books (two-pass + tiling)
// ---------------------------------------------------------------------------
app.post("/api/scan", (req, res, next) => {
  upload.single("photo")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "Image too large. Max 20 MB." });
      }
      return res.status(400).json({ error: err.message || "Upload failed" });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });

    const imageBuffer = fs.readFileSync(req.file.path);
    const mimeType = req.file.mimetype || "image/jpeg";

    // ── Pass 1: Quick count at low detail ─────────────────────
    const fullUri = bufferToDataUri(imageBuffer, mimeType);
    let overview = null;
    try {
      overview = await countBooks(fullUri);
      console.log(`  Pass 1 → ~${overview.count} books, ${overview.shelves} shelves`);
    } catch (e) {
      console.warn("  Pass 1 (count) failed, continuing without anchor:", e.message);
    }

    // ── Tile the image (adaptive grid based on book count) ───
    const tiles = await tileImage(imageBuffer, overview);
    console.log(`  Tiling → ${tiles.length} tile(s)`);

    // ── Pass 2: Identify books in each tile (parallel) ────────
    const tileResults = await Promise.all(
      tiles.map((tile) => {
        const uri = bufferToDataUri(tile.buffer, "image/jpeg");
        return identifyBooksInTile(uri, tile.label, overview, tiles.length);
      })
    );

    // Flatten and deduplicate
    const allBooks = tileResults.flat();
    const dedupedBooks = deduplicateBooks(allBooks);

    console.log(`  Pass 2 → ${allBooks.length} raw IDs, ${dedupedBooks.length} after dedup`);

    // ── Pass 3: Verify & clean title/author data ──────────────
    const books = await verifyAndCleanBooks(dedupedBooks);

    // Clean up uploaded file
    fs.unlink(req.file.path, () => {});

    res.json({ books, overview });
  } catch (err) {
    console.error("Scan error:", err?.message || err);
    if (err?.status === 401 || err?.code === "invalid_api_key") {
      return res.status(500).json({ error: "OpenAI API key is missing or invalid. Check server configuration." });
    }
    if (err?.code === "insufficient_quota") {
      return res.status(500).json({ error: "OpenAI quota exceeded. Please check your billing." });
    }
    res.status(500).json({ error: err.message || "Failed to process image" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/lookup  – look up ISBN + metadata via Open Library
// ---------------------------------------------------------------------------

/** Check if two author strings are a plausible match */
function authorsMatch(expected, candidate) {
  if (!expected || expected === "Unknown" || !candidate) return true; // can’t verify
  const norm = (s) => s.toLowerCase().replace(/[^a-z\s]/g, "").trim();

  // Split into individual name words for comparison
  const expWords  = norm(expected).split(/\s+/).filter(w => w.length > 2);
  const candWords = norm(candidate).split(/\s+/).filter(w => w.length > 2);

  if (expWords.length === 0) return true;

  // Match if the last name (last word) matches, OR if at least half of expected name words appear
  const expLast  = expWords[expWords.length - 1];
  const candLast = candWords[candWords.length - 1];
  if (expLast === candLast) return true;

  // Check if any expected word appears as a substring of any candidate word
  const matchCount = expWords.filter(ew =>
    candWords.some(cw => cw.includes(ew) || ew.includes(cw))
  ).length;
  return matchCount >= Math.ceil(expWords.length / 2);
}

/** Check if a result looks like a summary/review knockoff */
function isSummaryKnockoff(resultTitle, queryTitle) {
  const rt = (resultTitle || "").toLowerCase();
  const qt = (queryTitle || "").toLowerCase();
  // If the search query doesn’t start with "summary" but the result does, skip it
  if (!qt.startsWith("summary") && rt.startsWith("summary")) return true;
  if (!qt.startsWith("review") && rt.startsWith("review")) return true;
  if (!qt.startsWith("analysis") && rt.startsWith("analysis of")) return true;
  return false;
}

/** Search Open Library with a query string, return top N docs */
async function searchOpenLibrary(query, limit = 5) {
  const encoded = encodeURIComponent(query);
  const url = `https://openlibrary.org/search.json?q=${encoded}&limit=${limit}&fields=title,author_name,isbn,cover_i,first_publish_year,publisher,number_of_pages_median,subject`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.docs || [];
  } catch {
    return [];
  }
}

/** Search Open Library specifically by title field */
async function searchOpenLibraryByTitle(title, limit = 5) {
  const encoded = encodeURIComponent(title);
  const url = `https://openlibrary.org/search.json?title=${encoded}&limit=${limit}&fields=title,author_name,isbn,cover_i,first_publish_year,publisher,number_of_pages_median,subject`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.docs || [];
  } catch {
    return [];
  }
}

/** Build an enriched book result from an Open Library doc */
function docToResult(doc, originalBook) {
  const isbn13 = (doc.isbn || []).find((i) => i.length === 13) || "";
  const isbn10 = (doc.isbn || []).find((i) => i.length === 10) || "";
  const coverId = doc.cover_i;
  const coverUrl = coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null;
  return {
    title: doc.title || originalBook.title,
    author: (doc.author_name || []).join(", ") || originalBook.author,
    isbn13,
    isbn10,
    coverUrl,
    publishYear: doc.first_publish_year || "",
    publisher: (doc.publisher || [])[0] || "",
    pages: doc.number_of_pages_median || "",
    subjects: (doc.subject || []).slice(0, 3).join(", "),
    matched: true,
  };
}

/** Find the best Open Library match for a book, using cascading search */
async function lookupOneBook(book) {
  const strategies = [
    // Strategy 1: title + author (general search)
    { query: () => `${book.title} ${book.author !== "Unknown" ? book.author : ""}`.trim(), useAuthorFilter: true },
    // Strategy 2: title only (general search), with author filter
    { query: () => book.title, useAuthorFilter: true },
    // Strategy 3: title field search (more precise), with author filter
    { query: () => book.title, useAuthorFilter: true, titleField: true },
    // Strategy 4: title without subtitle, general search
    { query: () => book.title.split(/[:\u2014\-\u2013]/)[0].trim(), useAuthorFilter: true },
    // Strategy 5: title field search, NO author filter (last resort)
    { query: () => book.title, useAuthorFilter: false, titleField: true },
    // Strategy 6: title without subtitle, NO author filter
    { query: () => book.title.split(/[:\u2014\-\u2013]/)[0].trim(), useAuthorFilter: false },
  ];

  for (const strategy of strategies) {
    const query = strategy.query();
    if (!query || query.length < 2) continue;

    try {
      const docs = strategy.titleField
        ? await searchOpenLibraryByTitle(query, 5)
        : await searchOpenLibrary(query, 5);

      for (const doc of docs) {
        // Skip summary/review knockoffs
        if (isSummaryKnockoff(doc.title, book.title)) continue;

        // Validate author match only if strategy requires it
        if (strategy.useAuthorFilter) {
          const candidateAuthor = (doc.author_name || []).join(", ");
          if (!authorsMatch(book.author, candidateAuthor)) continue;
        }

        // Basic title sanity check: at least one significant word should overlap
        const normQ = query.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2);
        const normT = (doc.title || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2);
        const titleOverlap = normQ.some(qw => normT.some(tw => tw.includes(qw) || qw.includes(tw)));
        if (!titleOverlap && normQ.length > 0) continue;

        return docToResult(doc, book);
      }
    } catch {
      // try next strategy
    }
  }

  // No match found with any strategy
  return { ...book, matched: false };
}

app.post("/api/lookup", async (req, res) => {
  try {
    const { books } = req.body;
    if (!Array.isArray(books))
      return res.status(400).json({ error: "books must be an array" });

    const results = await Promise.all(books.map(lookupOneBook));

    res.json({ books: results });
  } catch (err) {
    console.error("Lookup error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start server (skip when running on Vercel)
// ---------------------------------------------------------------------------
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n📚 Bookshelf Scanner running at http://localhost:${PORT}\n`);
  });
}

module.exports = app;
