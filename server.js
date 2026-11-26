require("dotenv").config();
const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const { checkBotId } = require("botid/server");

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
// Cost tracking – every GPT call adds its token usage to the current request's
// tally (AsyncLocalStorage keeps one tally per request without threading it
// through every function). Logged as one "scan_usage"/"fix_usage" line.
// ---------------------------------------------------------------------------
const usageStore = new AsyncLocalStorage();

// Models: photos need full GPT-4o; the text-only steps (Pass 3 verify and
// /api/fix) are simple enough for the much cheaper GPT-4o mini.
// Mini isn't cheaper for images (it bills image tokens at a big multiplier).
const MODEL_VISION = (process.env.OPENAI_MODEL_VISION || "gpt-4o").trim();
const MODEL_TEXT   = (process.env.OPENAI_MODEL_TEXT   || "gpt-4o-mini").trim();

// Estimated USD per 1M tokens [input, output] — list prices at time of writing.
// Override with OPENAI_PRICES='{"gpt-4o":[2.5,10]}'; OPENAI_PRICE_INPUT_PER_M /
// OPENAI_PRICE_OUTPUT_PER_M still override the vision model's price.
const PRICES = { "gpt-4o": [2.5, 10], "gpt-4o-mini": [0.15, 0.6] };
try {
  Object.assign(PRICES, JSON.parse(process.env.OPENAI_PRICES || "{}"));
} catch {
  console.warn("OPENAI_PRICES is not valid JSON — using default prices");
}
if (process.env.OPENAI_PRICE_INPUT_PER_M || process.env.OPENAI_PRICE_OUTPUT_PER_M) {
  const [inP, outP] = PRICES[MODEL_VISION] || PRICES["gpt-4o"];
  PRICES[MODEL_VISION] = [
    Number(process.env.OPENAI_PRICE_INPUT_PER_M) || inP,
    Number(process.env.OPENAI_PRICE_OUTPUT_PER_M) || outP,
  ];
}

/** Price for a model name as reported by the API (e.g. "gpt-4o-mini-2024-07-18"). */
function priceFor(model) {
  if (PRICES[model]) return { price: PRICES[model], known: true };
  // Longest configured name that the reported (dated) model name starts with
  const base = Object.keys(PRICES)
    .filter((k) => model.startsWith(k + "-"))
    .sort((a, b) => b.length - a.length)[0];
  if (base) return { price: PRICES[base], known: true };
  return { price: PRICES["gpt-4o"] || [2.5, 10], known: false };
}

/** Run fn with a fresh usage tally; returns { result | error, usage }. */
async function withUsage(fn) {
  const usage = { calls: 0, input_tokens: 0, output_tokens: 0, by_pass: {}, by_model: {} };
  return usageStore.run(usage, fn).then(
    (result) => ({ result, usage }),
    (error) => ({ error, usage })
  );
}

/** Add one call's token usage to the current request's tally. */
function recordUsage(schemaName, model, inTok, outTok) {
  const usage = usageStore.getStore();
  if (!usage) return;
  usage.calls += 1;
  usage.input_tokens += inTok;
  usage.output_tokens += outTok;
  const p = (usage.by_pass[schemaName] ||= { calls: 0, in: 0, out: 0 });
  p.calls += 1; p.in += inTok; p.out += outTok;
  const m = (usage.by_model[model] ||= { calls: 0, in: 0, out: 0 });
  m.calls += 1; m.in += inTok; m.out += outTok;
}

/** Log one structured line with tokens and estimated cost for a request. */
function logUsage(event, usage, extra = {}) {
  let est = 0;
  let priceUnknown = false;
  for (const [model, m] of Object.entries(usage.by_model)) {
    const { price: [inP, outP], known } = priceFor(model);
    if (!known) priceUnknown = true;
    est += (m.in * inP + m.out * outP) / 1e6;
  }
  console.log(JSON.stringify({
    event,
    calls: usage.calls,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    est_usd: Number(est.toFixed(4)),
    ...(priceUnknown ? { price_unknown: true } : {}),
    ...extra,
    by_pass: usage.by_pass,
    by_model: usage.by_model,
  }));
}

// ---------------------------------------------------------------------------
// Bot protection – Vercel BotID on the endpoints that cost money
// ---------------------------------------------------------------------------
// BOTID_MODE: "enforce" (default) blocks bots; "log" only logs verdicts;
// "off" skips the check. Off Vercel (local dev) the check can't run and fails open.
const BOTID_MODE = (process.env.BOTID_MODE || "enforce").toLowerCase();
let botIdUnavailableLogged = false;

/** Returns true (and sends a 403) if the request looks automated. */
async function rejectBots(req, res) {
  if (BOTID_MODE === "off") return false;
  try {
    const verdict = await checkBotId({
      advancedOptions: {
        headers: req.headers,
        vercelOidcToken: req.headers["x-vercel-oidc-token"] || process.env.VERCEL_OIDC_TOKEN,
      },
    });
    if (verdict.isBot && !verdict.isVerifiedBot) {
      console.warn(JSON.stringify({ event: "bot_blocked", path: req.path, mode: BOTID_MODE }));
      if (BOTID_MODE === "enforce") {
        res.status(403).json({ error: "Automated requests aren't allowed. Please use the app in a browser." });
        return true;
      }
    }
  } catch (err) {
    // Not on Vercel (no OIDC token / request context): allow, so local dev keeps working.
    if (!botIdUnavailableLogged) {
      botIdUnavailableLogged = true;
      console.warn("  BotID check unavailable, allowing requests:", err?.message || err);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

// BotID's browser script reads process.env.NODE_ENV, which only exists under a
// bundler. Serve it with that value filled in ("development" off Vercel, where
// BotID skips itself), so the page can load it as a plain ES module.
// The .mjs file is never require()d, so Vercel only ships it because it's
// listed in vercel.json "includeFiles". It's read lazily so a missing file
// breaks only this one URL, never the whole app at startup.
let botIdClientJs = null;
function getBotIdClientJs() {
  if (botIdClientJs === null) {
    try {
      botIdClientJs = fs
        .readFileSync(require.resolve("botid/client/core").replace(/index\.js$/, "index.mjs"), "utf8")
        .replaceAll("process.env.NODE_ENV", JSON.stringify(process.env.VERCEL ? "production" : "development"));
    } catch (err) {
      console.error("BotID browser script missing from deployment — check includeFiles in vercel.json:", err.message);
      botIdClientJs = false;
    }
  }
  return botIdClientJs;
}
app.get("/vendor/botid.mjs", (_req, res) => {
  const js = getBotIdClientJs();
  if (!js) return res.status(503).type("text/plain").send("BotID script unavailable");
  res.type("application/javascript").set("Cache-Control", "public, max-age=3600").send(js);
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "1mb" })); // book lists carry catalog data; 100kb default is too small

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

// JSON schemas for OpenAI Structured Outputs. Strict mode requires a top-level
// object, every property listed in `required`, and additionalProperties: false.
const BOOK_PROPS = {
  title:      { type: "string" },
  author:     { type: "string" },
  confidence: { type: "integer" }, // 0–100, clamped server-side by toConfidence()
};

function booksSchema(extraProps = {}) {
  const props = { ...BOOK_PROPS, ...extraProps };
  return {
    type: "object",
    properties: {
      books: {
        type: "array",
        items: {
          type: "object",
          properties: props,
          required: Object.keys(props),
          additionalProperties: false,
        },
      },
    },
    required: ["books"],
    additionalProperties: false,
  };
}

const COUNT_SCHEMA = {
  type: "object",
  properties: {
    count:   { type: "integer" },
    shelves: { type: "integer" },
    notes:   { type: "string" },
  },
  required: ["count", "shelves", "notes"],
  additionalProperties: false,
};
const TILE_SCHEMA   = booksSchema();
// Pass 3 returns only the corrections (1-based indexes), not the whole list again —
// output tokens cost 4× input, so echoing every book was most of this pass's cost.
const VERIFY_EDITS_SCHEMA = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index:  { type: "integer" },
          title:  { type: "string" },
          author: { type: "string" },
        },
        required: ["index", "title", "author"],
        additionalProperties: false,
      },
    },
    remove: { type: "array", items: { type: "integer" } },
  },
  required: ["edits", "remove"],
  additionalProperties: false,
};
// Pass 4 returns only the numbers of books it can't find in the photo.
const NOT_VISIBLE_SCHEMA = {
  type: "object",
  properties: { notVisible: { type: "array", items: { type: "integer" } } },
  required: ["notVisible"],
  additionalProperties: false,
};

/** Numbered list as shown to GPT: `1. "Title" by Author`. */
function numberedList(books) {
  return books
    .map((b, i) => `${i + 1}. "${b.title || "(no title)"}" by ${b.author || "Unknown"}`)
    .join("\n");
}

/**
 * Apply Pass 3's edits/removals to the list. Pure: untouched books keep every
 * field; edited books keep their confidence and get corrected: true.
 * Out-of-range, duplicate and no-op entries are ignored.
 */
function applyVerifyEdits(books, result) {
  const inRange = (i) => Number.isInteger(i) && i >= 1 && i <= books.length;
  const out = books.map((b) => ({ ...b }));
  const seen = new Set();
  let corrected = 0;
  for (const e of result?.edits || []) {
    if (!inRange(e.index) || seen.has(e.index)) continue;
    seen.add(e.index);
    const b = out[e.index - 1];
    const title = String(e.title || "").trim() || b.title;
    const author = String(e.author || "").trim() || b.author;
    if (title === b.title && author === b.author) continue;
    b.title = title;
    b.author = author;
    b.corrected = true;
    corrected += 1;
  }
  const drop = new Set((result?.remove || []).filter(inRange));
  return { books: out.filter((_, i) => !drop.has(i + 1)), corrected, removed: drop.size };
}

/** Drop the books Pass 4 couldn't see (1-based indexes); out-of-range ignored. */
function dropNotVisible(books, notVisible) {
  const drop = new Set((notVisible || []).filter((i) => Number.isInteger(i) && i >= 1 && i <= books.length));
  return {
    books: books.filter((_, i) => !drop.has(i + 1)),
    removed: books.filter((_, i) => drop.has(i + 1)).map((b) => b.title),
  };
}

/**
 * Call GPT with a strict JSON schema and return the parsed object.
 * Throws on refusals and on truncated output (callers fall back where they can).
 */
async function callJson({ model = MODEL_VISION, max_tokens, messages, schemaName, schema, signal }) {
  const completion = await openai.chat.completions.create(
    {
      model,
      max_tokens,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema },
      },
    },
    { signal }
  );
  recordUsage(
    schemaName,
    completion.model || model,
    completion.usage?.prompt_tokens || 0,
    completion.usage?.completion_tokens || 0
  );
  const choice = completion.choices[0];
  if (choice.message.refusal) {
    throw new Error(`Model refused (${schemaName}): ${choice.message.refusal}`);
  }
  if (choice.finish_reason === "length") {
    throw new Error(`Model output truncated (${schemaName}) — max_tokens reached`);
  }
  return parseGptJson(choice.message.content);
}

/** Pass 1 – quick count & overview. Low detail is enough for a rough count (it only steers the tile grid) and costs 85 image tokens instead of ~765. */
async function countBooks(dataUri, signal) {
  return callJson({
    schemaName: "book_count",
    schema: COUNT_SCHEMA,
    signal,
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

Return an object with these fields:
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
          { type: "text", text: "How many books are visible in this image? Count carefully — look for thin spines and partially hidden books. Err on the side of counting more rather than fewer." },
        ],
      },
    ],
  });
}

/** Pass 2 – identify books in a single tile */
async function identifyBooksInTile(tileDataUri, tileLabel, overview, totalTiles, signal) {
  // Omit the book count from the anchor hint — telling GPT "there are ~N books"
  // can pressure it to hallucinate entries to reach the expected number.
  const anchorHint = overview
    ? `The image shows ${overview.shelves} shelf/shelves. Layout: ${overview.notes}. You are looking at the ${tileLabel} section.`
    : `You are looking at the ${tileLabel} section of a bookshelf.`;

  const result = await callJson({
    schemaName: "tile_books",
    schema: TILE_SCHEMA,
    signal,
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
  - confidence  (integer 0–100: how sure you are this title AND author are correct)
    • 80–100 = text clearly readable
    • 50–79  = partially readable, you're fairly sure
    • 0–49   = guessing from color/shape/partial letters

TEXT ORIENTATION — books appear in many orientations:
- Spines run vertically (text reads bottom-to-top or top-to-bottom).
- Books stacked flat may show a cover or back cover face-up or face-down — read the cover text.
- Text on flat-stacked books may be UPSIDE DOWN relative to the rest of the image — mentally rotate and read it anyway.
- Do NOT skip a book just because its text is rotated or upside down.

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
- Do NOT skip books just because the text is hard to read — include them with a low confidence (below 50).
- Scan the ENTIRE image from edge to edge before finishing. Check every stack, every upright spine, every flat cover.
- If you can only see a partial title, include what you can see — do NOT complete it from memory.
- If a spine is too blurry to read ANY text, skip it rather than guessing a title.
- Books sideways, stacked flat, upside down, or partially hidden count — but only if you can see them.
- If you recognise a well-known book BY ITS VISIBLE TEXT, use the correct known title and author.
- NEVER fill in books based on what "might" be on a shelf or what books are commonly owned. Every entry must be grounded in text or cover art you can actually see in this image.
- When in doubt about whether something is a real book spine vs background, omit it.

Return an object with a "books" array.
Example: {"books":[{"title":"Dune","author":"Frank Herbert","confidence":92},{"title":"1984","author":"George Orwell","confidence":65}]}
If no books are visible in this section, return {"books":[]}.`,
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: tileDataUri, detail: "high" } },
          { type: "text", text: "Identify every book whose spine or cover you can actually see in this section. Scan every shelf left to right, and check all stacked books — including flat-stacked books whose covers or text may be upside down or rotated. Only include books grounded in text or cover art visible in this image — never guess or invent titles." },
        ],
      },
    ],
  });
  return result.books.map((b) => ({ ...b, confidence: toConfidence(b.confidence) }));
}

// ---------------------------------------------------------------------------
// Deduplication – merge results from multiple tiles
// ---------------------------------------------------------------------------

/** Normalize a title for comparison */
function normalizeTitle(t) {
  return (t || "")
    .toLowerCase()
    .replace(/&/g, "and") // "Toast & Jam" == "Toast and Jam"
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
 * Normalize a confidence value to an integer 0–100. Accepts numbers or the
 * legacy "high"/"medium"/"low" labels (e.g. from older clients).
 */
function toConfidence(c) {
  const legacy = { high: 90, medium: 65, low: 35 };
  const n = typeof c === "number" ? c : legacy[String(c).toLowerCase()] ?? Number(c);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Merge book arrays from multiple tiles. Keep the highest-confidence copy
 * when duplicates are found (same or similar normalized title).
 */
function deduplicateBooks(allBooks) {
  const results = []; // array of { normTitle, book }

  for (const book of allBooks) {
    const normTitle = normalizeTitle(book.title);
    if (!normTitle) continue;

    // Find existing entry that's similar
    let matched = false;
    for (let i = 0; i < results.length; i++) {
      if (titlesAreSimilar(normTitle, results[i].normTitle)) {
        // Keep whichever has higher confidence; if tied, keep the one with the longer (more complete) title
        const existingRank = toConfidence(results[i].book.confidence);
        const newRank = toConfidence(book.confidence);
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
async function verifyAndCleanBooks(books, signal) {
  if (books.length === 0) return books;

  try {
    const result = await callJson({
      model: MODEL_TEXT,
      schemaName: "verify_edits",
      schema: VERIFY_EDITS_SCHEMA,
      signal,
      max_tokens: 2048,
      messages: [
        {
          role: "system",
          content: `You are a book-data quality checker. You will receive a numbered list of books identified from a bookshelf photo.

Your job is to FIX common errors:

1. AUTHOR NAME AS TITLE: This is the #1 most common error. Famous authors (Philip Roth, Stephen King, James Patterson, etc.) often have their name printed VERY LARGE on the spine. The OCR may mistake the author name for the book title. If the "title" field is just an author's name (e.g. title="PHILIP ROTH", title="STEPHEN KING", title="Philip"), this is WRONG — the real title was missed. Try to identify the actual book title from context (other entries, the author name), or REMOVE the entry if you cannot determine the real title.
2. AUTHOR IN TITLE: If the title field contains the author's name combined with the book title (e.g. title="Stephen King It"), split it so title="It" and author="Stephen King".
3. TITLE IN AUTHOR: If the author field contains a title or subtitle, move it to the title field.
4. UNKNOWN AUTHOR: If the author is "Unknown" but you recognize the book from its title, fill in the correct author.
5. WRONG AUTHOR: If you know the real author of a well-known book and it doesn't match, correct it.
6. TITLE CLEANUP: Fix obvious OCR-style errors in titles (e.g. "Tnr Hobbit" → "The Hobbit"). But do NOT change titles you don't recognize — they might be correct niche books.
7. DUPLICATE DETECTION: If two entries are clearly the same book (e.g. "The Hobbit" and "Hobbit, The"), keep one and remove the other. Also merge entries that are clearly variations (e.g. one with a subtitle and one without).
8. REPEATED TEXT IN TITLE: If a title contains the same phrase repeated, clean it to just the real title.
9. SUMMARY/REVIEW BOOKS: If a title starts with "Summary of", "Review of", etc., change it to the real book title.
10. GARBAGE ENTRIES: Remove entries where the title is just a single word that is clearly an author's first or last name, or entries that don't represent actual books.

Return ONLY what needs changing — leave correct books out entirely:
- "edits": books to correct, each with its list number ("index") and the full corrected title and author (repeat a field that doesn't change exactly as it was).
- "remove": list numbers of duplicates and garbage entries to delete (for a duplicate pair, remove the less complete one).
If everything looks right, return {"edits":[],"remove":[]}.`,
        },
        {
          role: "user",
          content: `Please review and fix any issues in this book list:\n${numberedList(books)}`,
        },
      ],
    });
    const { books: cleaned, corrected, removed } = applyVerifyEdits(books, result);
    console.log(`  Pass 3 (verify) → ${corrected} corrections, ${removed} removed`);
    return cleaned;
  } catch (e) {
    if (signal?.aborted) throw e;
    console.warn("  Pass 3 (verify) failed, using uncleaned results:", e.message);
    return books;
  }
}

// ---------------------------------------------------------------------------
// Pass 4 – visual verification: re-show the original image + book list to GPT
// and ask it to confirm which books are actually visible on the shelf.
// This is the primary defence against hallucinated books.
// ---------------------------------------------------------------------------
async function visuallyVerifyBooks(books, imageDataUri, signal) {
  if (books.length === 0) return books;

  try {
    const result = await callJson({
      schemaName: "not_visible_books",
      schema: NOT_VISIBLE_SCHEMA,
      signal,
      max_tokens: 512,
      messages: [
        {
          role: "system",
          content: `You are a book verification assistant. You will receive a bookshelf photo and a list of books that were claimed to be identified from it.

Your job: look at the actual photo and decide, for EACH book in the list, whether you can genuinely see that book's spine or cover in the image.

A book is visible if:
- You can find its spine or cover somewhere in the image.
- At least part of the title text is actually readable on a spine you can see.
- Or you can confidently identify it from clearly recognisable cover art.

A book is NOT visible if:
- You cannot find any spine in the image that plausibly matches this title.
- The title seems to have been invented — no visible spine corresponds to it.
- The entry looks like a garbled mis-reading of a different book that IS on the shelf.

Do NOT over-reject: if you are genuinely unsure, treat the book as visible.
But hallucinated books — those with no matching spine anywhere — must be listed as not visible.

Return ONLY the list numbers of the books that are NOT visible:
{"notVisible":[3,7]}
If every book is visible, return {"notVisible":[]}.`,
        },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageDataUri, detail: "high" } },
            {
              type: "text",
              text: `Here is the list of books the scanner identified. Please look at the photo and list the numbers of any books whose spine or cover you can NOT find:\n\n${numberedList(books)}`,
            },
          ],
        },
      ],
    });
    const { books: confirmed, removed } = dropNotVisible(books, result.notVisible);
    if (removed.length > 0) {
      console.log(`  Pass 4 (visual verify) → removed ${removed.length} unconfirmed book(s): ${removed.join(", ")}`);
    } else {
      console.log(`  Pass 4 (visual verify) → all books confirmed`);
    }
    return confirmed;
  } catch (e) {
    if (signal?.aborted) throw e;
    console.warn("  Pass 4 (visual verify) failed, keeping unverified results:", e.message);
    return books;
  }
}

// ---------------------------------------------------------------------------
// POST /api/scan  – accept an image, return identified books (two-pass + tiling)
// ---------------------------------------------------------------------------
app.post("/api/scan", async (req, res, next) => {
  // Check for bots before accepting the upload, so they can't even send a photo
  if (await rejectBots(req, res)) return;
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
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });

  // Reject formats we can't decode (e.g. HEIC) before streaming starts, so the
  // client gets a normal JSON error with a helpful message.
  let imageBuffer;
  try {
    imageBuffer = fs.readFileSync(req.file.path);
    const meta = await sharp(imageBuffer).metadata();
    if (!meta.width || !meta.height) throw new Error("no dimensions");
  } catch {
    fs.unlink(req.file.path, () => {});
    return res.status(415).json({
      error: "Couldn't read this image format — please upload a JPEG or PNG. " +
        "On iPhone: Settings → Camera → Formats → Most Compatible.",
    });
  }

  // Clients that send `Accept: application/x-ndjson` get progress events as
  // newline-delimited JSON while the scan runs; others get one JSON response.
  const streaming = (req.headers.accept || "").includes("application/x-ndjson");

  // Stop paying for GPT calls if the client goes away mid-scan.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  let emit = () => {};
  if (streaming) {
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    emit = (event) => {
      if (!res.writableEnded) res.write(JSON.stringify(event) + "\n");
    };
  }

  const startedAt = Date.now();
  const mimeType = req.file.mimetype || "image/jpeg";
  const { result, error, usage } = await withUsage(() => runScan(imageBuffer, mimeType, emit, controller.signal));
  logUsage("scan_usage", usage, {
    outcome: error ? (controller.signal.aborted ? "aborted" : "error") : "ok",
    books: result?.books?.length ?? null,
    ms: Date.now() - startedAt,
  });

  try {
    if (error) throw error;
    if (streaming) {
      emit({ type: "result", ...result });
      res.end();
    } else {
      res.json(result);
    }
  } catch (err) {
    if (controller.signal.aborted) {
      console.log("  Scan aborted — client disconnected");
      return;
    }
    console.error("Scan error:", err?.message || err);
    const message = scanErrorMessage(err);
    if (streaming) {
      emit({ type: "error", error: message });
      res.end();
    } else {
      res.status(500).json({ error: message });
    }
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

/** Map an error from the scan pipeline to a user-facing message. */
function scanErrorMessage(err) {
  if (err?.status === 401 || err?.code === "invalid_api_key") {
    return "OpenAI API key is missing or invalid. Check server configuration.";
  }
  if (err?.code === "insufficient_quota") {
    return "OpenAI quota exceeded. Please check your billing.";
  }
  return err?.message || "Failed to process image";
}

/**
 * Run the full identification pipeline. Calls emit(event) with progress:
 *   {type:"stage", stage, message}
 *   {type:"overview", overview}
 *   {type:"tile", label, done, total, books}   (books = cumulative deduped list)
 *   {type:"warning", label, message}
 * Returns { books, overview }.
 */
async function runScan(imageBuffer, mimeType, emit, signal) {
  // ── Pass 1: Quick count ───────────────────────────────────
  emit({ type: "stage", stage: "count", message: "Counting books & shelves…" });
  const fullUri = bufferToDataUri(imageBuffer, mimeType);
  let overview = null;
  try {
    overview = await countBooks(fullUri, signal);
    console.log(`  Pass 1 → ~${overview.count} books, ${overview.shelves} shelves`);
    emit({ type: "overview", overview });
  } catch (e) {
    if (signal.aborted) throw e;
    console.warn("  Pass 1 (count) failed, continuing without anchor:", e.message);
  }

  // ── Tile the image (adaptive grid based on book count) ───
  const tiles = await tileImage(imageBuffer, overview);
  console.log(`  Tiling → ${tiles.length} tile(s)`);

  // ── Pass 2: Identify books in each tile + full image (parallel) ──
  const jobs = [
    { label: "full image (overview)", uri: fullUri },
    ...tiles.map((tile) => ({ label: tile.label, uri: bufferToDataUri(tile.buffer, "image/jpeg") })),
  ];
  emit({
    type: "stage",
    stage: "identify",
    message: `Reading spines in ${jobs.length} section${jobs.length === 1 ? "" : "s"}…`,
  });

  const allBooks = [];
  let done = 0;
  const settled = await Promise.allSettled(
    jobs.map((job) =>
      identifyBooksInTile(job.uri, job.label, overview, tiles.length, signal).then(
        (books) => {
          allBooks.push(...books);
          done++;
          emit({ type: "tile", label: job.label, done, total: jobs.length, books: deduplicateBooks(allBooks) });
          return books;
        },
        (err) => {
          done++;
          if (!signal.aborted) {
            console.warn(`  Pass 2 (${job.label}) failed:`, err.message);
            emit({ type: "warning", label: job.label, message: `Couldn't read section ${job.label}` });
            emit({ type: "tile", label: job.label, done, total: jobs.length, books: deduplicateBooks(allBooks) });
          }
          throw err;
        }
      )
    )
  );

  if (signal.aborted) throw new Error("Scan aborted");
  const failures = settled.filter((s) => s.status === "rejected");
  if (failures.length === jobs.length) throw failures[0].reason; // nothing worked

  const dedupedBooks = deduplicateBooks(allBooks);
  console.log(`  Pass 2 → ${allBooks.length} raw IDs, ${dedupedBooks.length} after dedup (${failures.length} section(s) failed)`);

  // ── Pass 3: Verify & clean title/author data ──────────────
  emit({ type: "stage", stage: "verify", message: "Checking titles & authors…" });
  const pass3Books = await verifyAndCleanBooks(dedupedBooks, signal);

  // ── Pass 4: Visual confirmation – remove hallucinated books ──
  emit({ type: "stage", stage: "visual", message: "Double-checking every book against the photo…" });
  const verifiedBooks = (await visuallyVerifyBooks(pass3Books, fullUri, signal))
    .map((b) => ({ ...b, confidence: toConfidence(b.confidence) }));

  // ── Pass 5: Catalog check – Open Library + Google Books ──
  emit({ type: "stage", stage: "catalog", message: "Checking books against Open Library & Google Books…" });
  const books = await catalogCheck(verifiedBooks, signal);
  if (signal.aborted) throw new Error("Scan aborted");

  console.log(`  Final → ${books.length} book(s) after all passes`);
  return { books, overview };
}

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

const OL_FIELDS = "title,author_name,isbn,cover_i,first_publish_year,publisher,number_of_pages_median,subject";
const CATALOG_TIMEOUT_MS = 8000;          // per request (Open Library often takes 2–3 s)
const CATALOG_PASS_BUDGET_MS = 25000;     // whole catalog pass; unchecked books stay "unknown"
const CATALOG_CONCURRENCY = 4;            // books looked up at once (be gentle on Open Library)

/** Fetch JSON, throwing on network errors, timeouts and non-2xx responses. */
async function fetchJson(url, signal) {
  const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  const resp = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${new URL(url).host}`);
  return resp.json();
}

/** Open Library search; throws if the service can't be reached. */
async function openLibraryDocs(param, value, limit, signal) {
  const url = `https://openlibrary.org/search.json?${param}=${encodeURIComponent(value)}&limit=${limit}&fields=${OL_FIELDS}`;
  return (await fetchJson(url, signal)).docs || [];
}

/** Search Open Library with a query string, return top N docs ([] on any error) */
async function searchOpenLibrary(query, limit = 5, signal) {
  return openLibraryDocs("q", query, limit, signal).catch(() => []);
}

/** Search Open Library specifically by title field ([] on any error) */
async function searchOpenLibraryByTitle(title, limit = 5, signal) {
  return openLibraryDocs("title", title, limit, signal).catch(() => []);
}

/**
 * Search Google Books; throws if the service can't be reached or rate-limits us.
 * Results are mapped to Open Library's doc shape so docToResult() reads both.
 */
async function googleBooksDocs(title, author, signal) {
  const terms = [`intitle:"${title.replace(/"/g, "")}"`];
  if (author && author !== "Unknown") terms.push(`inauthor:"${author.replace(/"/g, "")}"`);
  return googleBooksQuery(terms.join(" "), signal);
}

/** Run a raw Google Books query (e.g. `isbn:978…`) and map results to doc shape. */
async function googleBooksQuery(q, signal) {
  let url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&printType=books`;
  const key = (process.env.GOOGLE_BOOKS_API_KEY || "").trim();
  if (key) url += `&key=${encodeURIComponent(key)}`;
  const data = await fetchJson(url, signal);
  return (data.items || []).map(({ volumeInfo: v = {} }) => ({
    title: [v.title, v.subtitle].filter(Boolean).join(": "),
    author_name: v.authors || [],
    isbn: (v.industryIdentifiers || [])
      .filter((i) => i.type === "ISBN_13" || i.type === "ISBN_10")
      .map((i) => i.identifier),
    cover: v.imageLinks?.thumbnail?.replace(/^http:/, "https:") || null,
    first_publish_year: (v.publishedDate || "").slice(0, 4),
    publisher: v.publisher ? [v.publisher] : [],
    number_of_pages_median: v.pageCount || "",
    subject: v.categories || [],
  }));
}

/** Pick the first catalog doc that plausibly is this book. */
function pickMatchingDoc(docs, book) {
  const want = normalizeTitle(book.title);
  if (!want) return null;
  const mainTitle = (t) => normalizeTitle((t || "").split(/[:(]/)[0]);
  const authorKnown = book.author && book.author !== "Unknown";
  const titleOk = (docTitle) => {
    // Short titles ("It", "Emma") need an exact main-title match, otherwise
    // substring matching would accept "Ithaca" for "It".
    // With no author to check, also insist on the main title, or
    // "The Three-Body Problem" would accept "Death's End (The Three-Body Problem…)".
    if (want.length < 5 || !authorKnown) return mainTitle(docTitle) === mainTitle(book.title);
    return titlesAreSimilar(want, normalizeTitle(docTitle));
  };
  return docs.find((doc) =>
    !isSummaryKnockoff(doc.title, book.title) &&
    authorsMatch(book.author, (doc.author_name || []).join(", ")) &&
    titleOk(doc.title)
  ) || null;
}

/**
 * Look one book up in Open Library and Google Books in parallel.
 * Each source is { doc } on a match, { doc: null } on no match, or
 * { error } when the service couldn't be reached.
 */
async function findCatalogMatch(book, signal) {
  const openLibrary = (async () => {
    const query = `${book.title} ${book.author !== "Unknown" ? book.author : ""}`.trim();
    let doc = pickMatchingDoc(await openLibraryDocs("q", query, 5, signal), book);
    if (!doc) doc = pickMatchingDoc(await openLibraryDocs("title", book.title, 5, signal), book);
    return { doc };
  })().catch((error) => ({ error }));
  const googleBooks = googleBooksDocs(book.title, book.author, signal)
    .then((docs) => ({ doc: pickMatchingDoc(docs, book) }))
    .catch((error) => ({ error }));
  const [ol, gb] = await Promise.all([openLibrary, googleBooks]);
  return { openLibrary: ol, googleBooks: gb };
}

/** Identifies the title/author a catalog match was made for (edits invalidate it). */
function catalogKey(book) {
  return `${normalizeTitle(book.title)}|${(book.author || "").toLowerCase().trim()}`;
}

/** Run fn over items with at most `limit` in flight; keeps input order. */
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Pass 5 – check every book against Open Library and Google Books.
 * Matches raise confidence and carry ISBN/cover data forward for /api/lookup;
 * books found in neither catalog lose confidence and get flagged. A catalog
 * that couldn't be reached counts as "unknown", never as "not found".
 */
async function catalogCheck(books, parentSignal) {
  const budget = AbortSignal.timeout(CATALOG_PASS_BUDGET_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, budget]) : budget;
  let warned = false;
  const checked = await mapWithLimit(books, CATALOG_CONCURRENCY, async (book) => {
    if (signal.aborted) return { ...book, catalog: null, notInCatalog: false, catalogMatch: null };
    const { openLibrary, googleBooks } = await findCatalogMatch(book, signal);
    const sources = [openLibrary, googleBooks];
    const answered = sources.filter((s) => !s.error);
    const matched = answered.filter((s) => s.doc);
    if (!warned && sources.some((s) => s.error)) {
      warned = true;
      console.warn("  Pass 5 (catalog) – a catalog was unreachable:",
        sources.filter((s) => s.error).map((s) => s.error.message).join("; "));
    }

    const out = { ...book, catalog: null, notInCatalog: false, catalogMatch: null };
    if (answered.length === 0) return out; // both catalogs unreachable: leave as-is

    out.catalog = {
      openLibrary: openLibrary.error ? null : !!openLibrary.doc,
      googleBooks: googleBooks.error ? null : !!googleBooks.doc,
    };
    const bestDoc = openLibrary.doc || googleBooks.doc;
    if (bestDoc) out.catalogMatch = { ...docToResult(bestDoc, book), matchedFor: catalogKey(book) };

    const conf = toConfidence(book.confidence);
    if (matched.length === 2) out.confidence = toConfidence(conf + 15);
    else if (matched.length === 1) out.confidence = toConfidence(conf + 5);
    else {
      out.confidence = toConfidence(conf - 25);
      out.notInCatalog = true;
    }
    return out;
  });
  const found = checked.filter((b) => b.catalogMatch).length;
  const missing = checked.filter((b) => b.notInCatalog).length;
  console.log(`  Pass 5 (catalog) → ${found} found, ${missing} not in any catalog`);
  return checked;
}

// ---------------------------------------------------------------------------
// ISBN helpers – barcode scanning and typed ISBNs
// ---------------------------------------------------------------------------

/** True if a 13-digit string has a valid EAN-13 check digit. */
function isValidIsbn13(s) {
  if (!/^\d{13}$/.test(s)) return false;
  const sum = [...s.slice(0, 12)].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(s[12]);
}

/** True if a 10-character string is a valid ISBN-10 (last char may be X). */
function isValidIsbn10(s) {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  const sum = [...s].reduce((acc, c, i) => acc + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
  return sum % 11 === 0;
}

/** Normalize any ISBN-10/13 input to a valid book ISBN-13, or null. */
function toIsbn13(input) {
  const s = String(input || "").toUpperCase().replace(/[^0-9X]/g, "");
  if (s.length === 13) return /^97[89]/.test(s) && isValidIsbn13(s) ? s : null;
  if (s.length === 10 && isValidIsbn10(s)) {
    const base = "978" + s.slice(0, 9);
    const sum = [...base].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
    return base + ((10 - (sum % 10)) % 10);
  }
  return null;
}

/** ISBN-10 for a 978-prefixed ISBN-13 (979 ISBNs have no ISBN-10). */
function isbn13To10(isbn13) {
  if (!isbn13.startsWith("978")) return "";
  const core = isbn13.slice(3, 12);
  const sum = [...core].reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? "X" : String(check));
}

/**
 * Exact lookup by ISBN: Open Library first, then Google Books. The scanned
 * ISBN is always kept (a work-level match may list other editions' ISBNs),
 * so even an unmatched barcode still exports to Libib by ISBN.
 */
async function lookupByIsbn(isbn13, book = {}) {
  const sources = [
    () => openLibraryDocs("isbn", isbn13, 1),
    () => openLibraryDocs("isbn", isbn13, 1), // one retry: Open Library is sometimes slow
    () => googleBooksQuery(`isbn:${isbn13}`),
  ];
  let answered = false; // did any catalog actually respond (vs. time out / error)?
  for (let i = 0; i < sources.length; i++) {
    if (i === 1 && answered) continue; // Open Library answered "no match": don't retry it
    try {
      const [doc] = await sources[i]();
      answered = true;
      if (doc) {
        return { ...docToResult(doc, book), isbn13, isbn10: isbn13To10(isbn13), source: book.source };
      }
    } catch {
      // catalog unreachable — try the next one
    }
  }
  return {
    title: book.title || "",
    author: book.author || "",
    isbn13,
    isbn10: isbn13To10(isbn13),
    coverUrl: null,
    source: book.source,
    matched: false,
    lookupFailed: !answered, // true = catalogs unreachable, not "this ISBN doesn't exist"
  };
}

/** Build an enriched book result from an Open Library doc */
function docToResult(doc, originalBook) {
  const isbn13 = (doc.isbn || []).find((i) => i.length === 13) || "";
  const isbn10 = (doc.isbn || []).find((i) => i.length === 10) || "";
  const coverId = doc.cover_i;
  const coverUrl = coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : (doc.cover || null);
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

/**
 * Find the best catalog match for a book. Reuses the match from the scan's
 * catalog pass when the title/author haven't been edited since; otherwise
 * tries Open Library strategies, then Google Books.
 */
async function lookupOneBook(book) {
  // Books added by barcode (or with a typed ISBN) are looked up exactly.
  const isbn13 = toIsbn13(book.isbn13 || book.isbn10 || book.isbn);
  if (isbn13) return lookupByIsbn(isbn13, book);

  const cached = book.catalogMatch;
  if (cached?.matched && cached.matchedFor === catalogKey(book)) {
    const { matchedFor: _k, ...result } = cached;
    return result;
  }

  // Different searches to find candidates; every candidate must pass the same
  // title + author check as the scan's catalog pass (pickMatchingDoc). There is
  // deliberately no "ignore the author" fallback: that once turned "The Joy of
  // Costco" into an unrelated book that shares the word "Costco". If nothing
  // matches, the book keeps its scanned title/author (matched: false).
  const author = book.author && book.author !== "Unknown" ? book.author : "";
  const mainTitle = book.title.split(/[:\u2014\-\u2013]/)[0].trim();
  const strategies = [
    { query: `${book.title} ${author}`.trim() },          // title + author
    { query: book.title },                                 // title only
    { query: book.title, titleField: true },               // title field search
    { query: mainTitle },                                  // title without subtitle
  ];

  for (const { query, titleField } of strategies) {
    if (!query || query.length < 2) continue;
    const docs = titleField
      ? await searchOpenLibraryByTitle(query, 5)
      : await searchOpenLibrary(query, 5);
    const doc = pickMatchingDoc(docs, book);
    if (doc) return docToResult(doc, book);
  }

  // Open Library had nothing — try Google Books before giving up
  try {
    const doc = pickMatchingDoc(await googleBooksDocs(book.title, book.author), book);
    if (doc) return docToResult(doc, book);
  } catch {
    // Google Books unreachable or rate-limited
  }

  // No match found with any strategy
  const { catalogMatch: _m, ...rest } = book;
  return { ...rest, matched: false };
}

app.post("/api/lookup", async (req, res) => {
  if (await rejectBots(req, res)) return;
  try {
    const { books } = req.body;
    if (!Array.isArray(books))
      return res.status(400).json({ error: "books must be an array" });
    if (books.length > 500)
      return res.status(400).json({ error: "Too many books in one lookup (max 500)" });

    // Limit concurrency so a big batch of barcodes doesn't flood Open Library
    const results = await mapWithLimit(books, 6, lookupOneBook);

    res.json({ books: results });
  } catch (err) {
    console.error("Lookup error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/fix  – apply a correction the user describes in plain words
// ("book 3 is by Le Guin", "remove the cookbook", "add Dune by Frank Herbert")
// ---------------------------------------------------------------------------

// GPT returns *edits* rather than a rewritten list, so it can't silently drop
// or change books it wasn't asked about, and fields like isbn13/source survive.
const FIX_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index:  { type: "integer" },
          action: { type: "string", enum: ["update", "remove"] },
          title:  { type: "string" },
          author: { type: "string" },
        },
        required: ["index", "action", "title", "author"],
        additionalProperties: false,
      },
    },
    additions: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, author: { type: "string" } },
        required: ["title", "author"],
        additionalProperties: false,
      },
    },
  },
  required: ["reply", "edits", "additions"],
  additionalProperties: false,
};

const FIX_MAX_INSTRUCTION = 500;
const FIX_MAX_BOOKS = 300;

/** Ask GPT to turn a plain-words correction into edits on the numbered list. */
async function describeFixes(books, instruction) {
  const list = books.length
    ? books.map((b, i) => `${i + 1}. "${b.title || "(no title)"}" by ${b.author || "Unknown"}`).join("\n")
    : "(the list is empty)";
  return callJson({
    model: MODEL_TEXT,
    schemaName: "book_fixes",
    schema: FIX_SCHEMA,
    max_tokens: 2048,
    messages: [
      {
        role: "system",
        content: `You edit a list of books that a user is reviewing after scanning their bookshelf.
The user describes a correction in plain words. Turn it into edits.

Rules:
- Apply ONLY what the user asked. Never touch other books.
- Books are numbered from 1 as shown. "index" is that 1-based number.
- The user may refer to a book by number ("book 3", "the third one"), by title, or by author ("the cookbook", "the Tolkien one"). Match it against the list.
- action "update": give the book's full corrected title and author. Repeat any field that doesn't change exactly as it was.
- action "remove": title and author are "".
- "additions": books the user asks to add that aren't in the list.
- You may use your knowledge to complete a name or title the user clearly identifies (e.g. "by Le Guin" → "Ursula K. Le Guin"), but never invent changes they didn't ask for.
- If the request is ambiguous (several books match) or matches nothing, return no edits and no additions, and explain in "reply".
- "reply": one short, friendly sentence saying what you changed (or why you couldn't).`,
      },
      {
        role: "user",
        content: `Book list:\n${list}\n\nCorrection: ${instruction}`,
      },
    ],
  });
}

/**
 * Apply GPT's edits to the book list. Pure function: ignores out-of-range or
 * repeated indexes, keeps every untouched book exactly as it was, and reports
 * which positions (in the new list) changed.
 */
function applyFixes(books, { edits = [], additions = [], reply = "" }) {
  const seen = new Set();
  const valid = edits.filter((e) => {
    const i = e.index - 1;
    if (!Number.isInteger(i) || i < 0 || i >= books.length || seen.has(i)) return false;
    seen.add(i);
    return true;
  });

  const updated = new Set();
  const removed = new Set();
  const next = books.map((b) => ({ ...b }));
  for (const e of valid) {
    const i = e.index - 1;
    if (e.action === "remove") { removed.add(i); continue; }
    const title = (e.title || "").trim() || next[i].title;
    const author = (e.author || "").trim() || next[i].author;
    if (title === next[i].title && author === next[i].author) continue; // no-op edit
    next[i] = { ...next[i], title, author, fixed: true, confidence: 100, notInCatalog: false };
    updated.add(i);
  }

  const kept = [];
  const changed = [];
  next.forEach((b, i) => {
    if (removed.has(i)) return;
    if (updated.has(i)) changed.push(kept.length);
    kept.push(b);
  });

  const added = additions
    .map((a) => ({ title: (a.title || "").trim(), author: (a.author || "").trim() || "Unknown" }))
    .filter((a) => a.title)
    .map((a) => ({ ...a, confidence: 100, fixed: true, source: "manual" }));
  for (const a of added) {
    changed.push(kept.length);
    kept.push(a);
  }

  return { books: kept, reply, changed, updated: updated.size, removed: removed.size, added: added.length };
}

app.post("/api/fix", async (req, res) => {
  if (await rejectBots(req, res)) return;
  const { books, instruction } = req.body || {};
  if (typeof instruction !== "string" || !instruction.trim())
    return res.status(400).json({ error: "Describe what to fix." });
  if (instruction.length > FIX_MAX_INSTRUCTION)
    return res.status(400).json({ error: `Please keep it under ${FIX_MAX_INSTRUCTION} characters.` });
  if (!Array.isArray(books))
    return res.status(400).json({ error: "books must be an array" });
  if (books.length > FIX_MAX_BOOKS)
    return res.status(400).json({ error: `Too many books for one fix (max ${FIX_MAX_BOOKS}).` });

  const startedAt = Date.now();
  const { result, error, usage } = await withUsage(() => describeFixes(books, instruction.trim()));
  logUsage("fix_usage", usage, { outcome: error ? "error" : "ok", books: books.length, ms: Date.now() - startedAt });
  try {
    if (error) throw error;
    const applied = applyFixes(books, result);
    console.log(`  Fix → ${applied.updated} updated, ${applied.removed} removed, ${applied.added} added`);
    res.json(applied);
  } catch (err) {
    console.error("Fix error:", err?.message || err);
    res.status(500).json({ error: scanErrorMessage(err) });
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
