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
  } else if (bookCount >= 15 || w >= 2000) {
    cols = 3;
  } else {
    cols = 2;
  }

  // Rows: match shelf count, but enforce minimum 2 for any non-trivial image
  if (shelves >= 4 || h >= 3000) {
    rows = 4;
  } else if (shelves >= 3 || h >= 2400) {
    rows = 3;
  } else {
    rows = Math.max(shelves, 2); // minimum 2 rows always
  }

  console.log(`  Adaptive tiling: ${cols}×${rows} grid for ~${bookCount} books, ${shelves} shelves, ${w}×${h}px`);

  const overlapFrac = 0.25; // 25% overlap to catch books at tile boundaries
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

/** Pass 1 – quick count & overview using auto detail for accuracy */
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
People commonly UNDERCOUNT books in photos — count carefully and err on the side of counting MORE.
Look for thin spines, small paperbacks, and books partially hidden behind others.

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
          { type: "image_url", image_url: { url: dataUri, detail: "auto" } },
          { type: "text", text: "How many books are visible in this image? Count carefully — look for thin spines and partially hidden books. Err on the side of counting more rather than fewer." },
        ],
      },
    ],
  });
  return parseGptJson(completion.choices[0].message.content);
}

/** Pass 2 – identify books in a single tile */
async function identifyBooksInTile(tileDataUri, tileLabel, overview, totalTiles) {
  // Omit the book count from the anchor hint — telling GPT "there are ~N books"
  // can pressure it to hallucinate entries to reach the expected number.
  const anchorHint = overview
    ? `The image shows ${overview.shelves} shelf/shelves. Layout: ${overview.notes}. You are looking at the ${tileLabel} section.`
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

CRITICAL RULES — READ CAREFULLY:
- Only report a book if you can actually see its spine or cover in THIS image. Never invent or guess books.
- Include every book you can genuinely see, even if it means returning 20+ entries.
- Do NOT skip books just because the text is hard to read — include them with "low" confidence.
- Scan the ENTIRE image from edge to edge before finishing.
- If you can only see a partial title, include what you can see — do NOT complete it from memory.
- If a spine is too blurry to read ANY text, skip it rather than guessing a title.
- Books sideways, stacked flat, or partially hidden count — but only if you can see them.
- If you recognise a well-known book BY ITS VISIBLE TEXT, use the correct known title and author.
- NEVER fill in books based on what "might" be on a shelf or what books are commonly owned. Every entry must be grounded in text or cover art you can actually see in this image.
- When in doubt about whether something is a real book spine vs background, omit it.

Return ONLY a JSON array, no markdown fences, no commentary.
Example: [{"title":"Dune","author":"Frank Herbert","confidence":"high"},{"title":"1984","author":"George Orwell","confidence":"medium"}]
If no books are visible in this section, return [].`,
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: tileDataUri, detail: "high" } },
          { type: "text", text: "Identify every book whose spine or cover you can actually see in this section. Scan every shelf left to right. Only include books grounded in text or cover art visible in this image — never guess or invent titles." },
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

/** Check if two normalized titles are fuzzy-matches (one contains the other, or high word overlap) */
function titlesAreSimilar(normA, normB) {
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  // One is a substring of the other (handles "Best Hikes with Kids" vs "Best Hikes with Kids Western Washington")
  if (normA.includes(normB) || normB.includes(normA)) return true;

  // Word-level overlap: if 60%+ of the shorter title's words appear in the longer one
  const wordsA = normA.match(/[a-z0-9]+/g) || [];
  const wordsB = normB.match(/[a-z0-9]+/g) || [];
  if (wordsA.length < 2 || wordsB.length < 2) return false;

  const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  const matchCount = shorter.filter(w => w.length > 2 && longer.includes(w)).length;
  const significantWords = shorter.filter(w => w.length > 2).length;
  return significantWords > 0 && matchCount / significantWords >= 0.6;
}

/**
 * Merge book arrays from multiple tiles. Keep the highest-confidence copy
 * when duplicates are found (same or similar normalized title).
 */
function deduplicateBooks(allBooks) {
  const confRank = { high: 3, medium: 2, low: 1 };
  const results = []; // array of { normTitle, book }

  for (const book of allBooks) {
    const normTitle = normalizeTitle(book.title);
    if (!normTitle) continue;

    // Find existing entry that's similar
    let matched = false;
    for (let i = 0; i < results.length; i++) {
      if (titlesAreSimilar(normTitle, results[i].normTitle)) {
        // Keep whichever has higher confidence; if tied, keep the one with the longer (more complete) title
        const existingRank = confRank[results[i].book.confidence] || 0;
        const newRank = confRank[book.confidence] || 0;
        if (newRank > existingRank || (newRank === existingRank && book.title.length > results[i].book.title.length)) {
          results[i] = { normTitle, book };
        }
        matched = true;
        break;
      }
    }

    if (!matched) {
      results.push({ normTitle, book });
    }
  }

  return results.map(r => r.book);
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

1. AUTHOR NAME AS TITLE: This is the #1 most common error. Famous authors (Philip Roth, Stephen King, James Patterson, etc.) often have their name printed VERY LARGE on the spine. The OCR may mistake the author name for the book title. If the "title" field is just an author's name (e.g. title="PHILIP ROTH", title="STEPHEN KING", title="Philip"), this is WRONG — the real title was missed. Try to identify the actual book title from context (other entries, the author name), or REMOVE the entry if you cannot determine the real title.
2. AUTHOR IN TITLE: If the title field contains the author's name combined with the book title (e.g. title="Stephen King It"), split it so title="It" and author="Stephen King".
3. TITLE IN AUTHOR: If the author field contains a title or subtitle, move it to the title field.
4. UNKNOWN AUTHOR: If the author is "Unknown" but you recognize the book from its title, fill in the correct author.
5. WRONG AUTHOR: If you know the real author of a well-known book and it doesn't match, correct it.
6. TITLE CLEANUP: Fix obvious OCR-style errors in titles (e.g. "Tnr Hobbit" → "The Hobbit"). But do NOT change titles you don't recognize — they might be correct niche books.
7. DUPLICATE DETECTION: If two entries are clearly the same book (e.g. "The Hobbit" and "Hobbit, The"), keep only the one with higher confidence. Also merge entries that are clearly variations (e.g. one with a subtitle and one without).
8. REPEATED TEXT IN TITLE: If a title contains the same phrase repeated, clean it to just the real title.
9. SUMMARY/REVIEW BOOKS: If a title starts with "Summary of", "Review of", etc., change it to the real book title.
10. GARBAGE ENTRIES: Remove entries where the title is just a single word that is clearly an author's first or last name, or entries that don't represent actual books.

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
// Pass 4 – visual verification: re-show the original image + book list to GPT
// and ask it to confirm which books are actually visible on the shelf.
// This is the primary defence against hallucinated books.
// ---------------------------------------------------------------------------
async function visuallyVerifyBooks(books, imageDataUri) {
  if (books.length === 0) return books;

  const bookListText = books
    .map((b, i) => `${i + 1}. "${b.title}" by ${b.author}`)
    .join("\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 4096,
    messages: [
      {
        role: "system",
        content: `You are a book verification assistant. You will receive a bookshelf photo and a list of books that were claimed to be identified from it.

Your job: look at the actual photo and decide, for EACH book in the list, whether you can genuinely see that book's spine or cover in the image.

Mark a book "visible": true ONLY if:
- You can find its spine or cover somewhere in the image.
- At least part of the title text is actually readable on a spine you can see.
- Or you can confidently identify it from clearly recognisable cover art.

Mark a book "visible": false if:
- You cannot find any spine in the image that plausibly matches this title.
- The title seems to have been invented — no visible spine corresponds to it.
- The entry looks like a garbled mis-reading of a different book that IS on the shelf.

Do NOT over-reject: if you are genuinely unsure, lean toward visible=true.
But hallucinated books — those with no matching spine anywhere — must be marked visible=false.

Return ONLY a JSON array in this exact format, no markdown fences, no commentary:
[{"title":"...","author":"...","confidence":"...","corrected":true|false,"visible":true}]`,
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUri, detail: "high" } },
          {
            type: "text",
            text: `Here is the list of books the scanner identified. Please look at the photo and set "visible": true only for books whose spine or cover you can actually see:\n\n${bookListText}`,
          },
        ],
      },
    ],
  });

  try {
    const verified = parseGptJson(completion.choices[0].message.content);
    const removed = verified.filter((b) => b.visible === false).map((b) => b.title);
    if (removed.length > 0) {
      console.log(`  Pass 4 (visual verify) → removed ${removed.length} unconfirmed book(s): ${removed.join(", ")}`);
    } else {
      console.log(`  Pass 4 (visual verify) → all books confirmed`);
    }
    // Strip the helper field and return only confirmed books
    return verified
      .filter((b) => b.visible !== false)
      .map(({ visible: _v, ...rest }) => rest);
  } catch (e) {
    console.warn("  Pass 4 (visual verify) parse failed, keeping unverified results:", e.message);
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

    // ── Pass 2: Identify books in each tile + full image (parallel) ──
    const tilePromises = tiles.map((tile) => {
      const uri = bufferToDataUri(tile.buffer, "image/jpeg");
      return identifyBooksInTile(uri, tile.label, overview, tiles.length);
    });

    // Also run identification on the full image for a holistic view
    const fullImagePromise = identifyBooksInTile(fullUri, "full image (overview)", overview, tiles.length);

    const [fullImageResult, ...tileResults] = await Promise.all([fullImagePromise, ...tilePromises]);

    // Flatten tile results + full image results and deduplicate
    const allBooks = [...fullImageResult, ...tileResults.flat()];
    const dedupedBooks = deduplicateBooks(allBooks);

    console.log(`  Pass 2 → ${allBooks.length} raw IDs, ${dedupedBooks.length} after dedup`);

    // ── Pass 3: Verify & clean title/author data ──────────────
    const pass3Books = await verifyAndCleanBooks(dedupedBooks);

    // ── Pass 4: Visual confirmation – remove hallucinated books ──
    const books = await visuallyVerifyBooks(pass3Books, fullUri);

    console.log(`  Final → ${books.length} book(s) after all passes`);

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
