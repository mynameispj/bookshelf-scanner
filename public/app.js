// ── State ───────────────────────────────────────────────────────────────────
let identifiedBooks = []; // [{ title, author }]
let enrichedBooks  = []; // [{ title, author, isbn13, isbn10, coverUrl, … }]
let selectedFile   = null;

// ── DOM refs ────────────────────────────────────────────────────────────────
const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const stepCapture = $("#step-capture");
const stepReview  = $("#step-review");
const stepExport  = $("#step-export");

const inputCamera = $("#input-camera");
const inputUpload = $("#input-upload");
const previewContainer = $("#preview-container");
const previewImg  = $("#preview-img");
const btnScan     = $("#btn-scan");
const bookList    = $("#book-list");
const reviewHint  = $("#review-hint");
const btnAddManual = $("#btn-add-manual");
const btnLookup   = $("#btn-lookup");
const enrichedList = $("#enriched-list");
const btnDownload  = $("#btn-download-csv");
const btnStartOver = $("#btn-start-over");
const loading     = $("#loading");
const loadingText = $("#loading-text");

// ── Utilities ───────────────────────────────────────────────────────────────
function showLoading(msg) { loadingText.textContent = msg; loading.classList.remove("hidden"); }
function hideLoading()    { loading.classList.add("hidden"); }
function showStep(el)     { [stepCapture, stepReview, stepExport].forEach(s => s.classList.add("hidden")); el.classList.remove("hidden"); }

/**
 * Compress an image file to stay under Vercel's 4.5 MB body limit.
 * Resizes to max 2048px on longest side and uses JPEG quality 0.82.
 * Returns a Blob ready for FormData.
 */
function compressImage(file, maxDim = 2048, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width  = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Canvas compression failed"))),
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => reject(new Error("Could not load image for compression"));
    img.src = URL.createObjectURL(file);
  });
}

// ── Step 1: Image selection ─────────────────────────────────────────────────
function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  selectedFile = file;
  previewImg.src = URL.createObjectURL(file);
  previewContainer.classList.remove("hidden");
}

inputCamera.addEventListener("change", handleFileSelect);
inputUpload.addEventListener("change", handleFileSelect);

// ── Step 1 → 2: Scan image ─────────────────────────────────────────────────
btnScan.addEventListener("click", async () => {
  if (!selectedFile) return;

  showLoading("Compressing image…");

  let photoBlob;
  try {
    photoBlob = await compressImage(selectedFile);
    console.log(`Compressed: ${(selectedFile.size/1024/1024).toFixed(1)} MB → ${(photoBlob.size/1024/1024).toFixed(1)} MB`);
  } catch (compErr) {
    // Fallback: send original file if compression fails
    console.warn("Image compression failed, using original:", compErr);
    photoBlob = selectedFile;
  }

  showLoading("Step 1/4: Enhancing image & counting books…");

  const formData = new FormData();
  formData.append("photo", photoBlob, selectedFile.name || "photo.jpg");

  // Animate through loading stages to keep user informed
  const stages = [
    { delay: 4000,  msg: "Step 2/4: Splitting image into sections for higher accuracy…" },
    { delay: 12000, msg: "Step 3/4: Identifying books in each section…" },
    { delay: 30000, msg: "Step 4/4: Verifying titles & authors…" },
    { delay: 50000, msg: "Still working — large shelves take a bit longer…" },
    { delay: 90000, msg: "Almost there — wrapping up identification…" },
  ];
  const timers = stages.map(s => setTimeout(() => showLoading(s.msg), s.delay));

  // Abort after 4.5 minutes to stay within Vercel's 5-minute limit
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 270000);

  try {
    const res = await fetch("/api/scan", { method: "POST", body: formData, signal: controller.signal });

    // Handle non-JSON error responses (e.g. Vercel HTML error pages)
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = await res.text();
      if (res.status === 413) throw new Error("Image too large. Please use a smaller photo.");
      if (res.status >= 500) throw new Error(`Server error (${res.status}). Please try again in a moment.`);
      throw new Error(`Unexpected response (${res.status}): ${text.slice(0, 120)}`);
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    identifiedBooks = data.books;
    renderReviewList();
    showStep(stepReview);
  } catch (err) {
    if (err.name === "AbortError") {
      alert("Scan timed out. Try a smaller or clearer photo with fewer books.");
    } else if (err instanceof TypeError) {
      // TypeError from fetch = network-level failure (connection refused, DNS, CORS, etc.)
      console.error("Network error during scan:", err);
      alert("Scan failed: Could not reach the server. Check your internet connection and try again.\n\nIf the problem persists, the image may be too large — try a lower-resolution photo.");
    } else {
      alert("Scan failed: " + (err.message || "Unknown error"));
    }
  } finally {
    clearTimeout(abortTimer);
    timers.forEach(clearTimeout);
    hideLoading();
  }
});

// ── Step 2: Review list ─────────────────────────────────────────────────────
function renderReviewList() {
  const highCount = identifiedBooks.filter(b => b.confidence === "high").length;
  const lowCount  = identifiedBooks.filter(b => b.confidence === "low").length;
  let hint = `Found ${identifiedBooks.length} book(s).`;
  if (lowCount > 0) hint += ` ${lowCount} flagged low-confidence — please double-check those.`;
  else hint += " Edit titles/authors or remove mistakes.";
  reviewHint.textContent = hint;
  bookList.innerHTML = "";

  identifiedBooks.forEach((book, i) => {
    const conf = book.confidence || "high";
    const confLabel = conf === "high" ? "✅ High" : conf === "medium" ? "🟡 Medium" : "🔴 Low";
    const correctedTag = book.corrected ? ' <span class="corrected-tag">✏️ auto-corrected</span>' : '';
    const card = document.createElement("div");
    card.className = `book-card confidence-${conf}`;
    card.innerHTML = `
      <div class="info">
        <input type="text" data-idx="${i}" data-field="title" value="${esc(book.title)}" placeholder="Title" />
        <input type="text" data-idx="${i}" data-field="author" value="${esc(book.author)}" placeholder="Author" />
        <span class="meta conf-badge conf-${conf}">${confLabel} confidence${correctedTag}</span>
      </div>
      <button class="btn btn-danger remove" data-idx="${i}">✕</button>
    `;
    bookList.appendChild(card);
  });

  // Wire up inline edits
  bookList.querySelectorAll("input").forEach(input => {
    input.addEventListener("input", (e) => {
      const idx = +e.target.dataset.idx;
      const field = e.target.dataset.field;
      identifiedBooks[idx][field] = e.target.value;
    });
  });

  // Wire up remove buttons
  bookList.querySelectorAll(".remove").forEach(btn => {
    btn.addEventListener("click", (e) => {
      identifiedBooks.splice(+e.target.dataset.idx, 1);
      renderReviewList();
    });
  });
}

function esc(s) { return (s || "").replace(/"/g, "&quot;"); }

// Add manual book
btnAddManual.addEventListener("click", () => {
  identifiedBooks.push({ title: "", author: "" });
  renderReviewList();
  // Focus the last title input
  const inputs = bookList.querySelectorAll('input[data-field="title"]');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

// ── Step 2 → 3: Look up metadata ───────────────────────────────────────────
btnLookup.addEventListener("click", async () => {
  if (identifiedBooks.length === 0) { alert("No books to look up."); return; }

  showLoading("Looking up ISBNs & metadata via Open Library…");

  try {
    const res  = await fetch("/api/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ books: identifiedBooks }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    enrichedBooks = data.books;
    renderEnrichedList();
    showStep(stepExport);
  } catch (err) {
    alert("Lookup failed: " + err.message);
  } finally {
    hideLoading();
  }
});

// ── Step 3: Enriched list ───────────────────────────────────────────────────
function renderEnrichedList() {
  enrichedList.innerHTML = "";
  enrichedBooks.forEach((book, i) => {
    const card = document.createElement("div");
    card.className = `enriched-card ${book.matched ? "" : "no-match"}`;

    const coverHtml = book.coverUrl
      ? `<img class="cover" src="${book.coverUrl}" alt="cover" />`
      : `<div class="cover" style="display:flex;align-items:center;justify-content:center;font-size:.7rem;color:#999;background:#eee;width:48px;height:70px;border-radius:4px;">No cover</div>`;

    card.innerHTML = `
      ${coverHtml}
      <div class="details">
        <strong>${esc(book.title)}</strong>
        <span class="sub">${esc(book.author)}</span>
        ${book.isbn13 ? `<span class="sub">ISBN-13: ${book.isbn13}</span>` : ""}
        ${book.isbn10 ? `<span class="sub">ISBN-10: ${book.isbn10}</span>` : ""}
        ${book.publishYear ? `<span class="sub">Published: ${book.publishYear}</span>` : ""}
        ${!book.matched ? `<span class="sub" style="color:#f59e0b;">⚠ No match found — title/author only</span>` : ""}
      </div>
    `;
    enrichedList.appendChild(card);
  });
}

// ── Step 3: Download CSV ────────────────────────────────────────────────────
btnDownload.addEventListener("click", () => {
  // Libib CSV import format – it accepts: title, author, isbn (EAN/ISBN-13), etc.
  // Libib columns: "title","creators","ean_isbn13","upc_isbn10","description","tags","group","status","began","completed","rating","review","price","length"
  const header = [
    "title", "creators", "ean_isbn13", "upc_isbn10",
    "description", "tags", "group", "status",
    "began", "completed", "rating", "review", "price", "length"
  ];

  const rows = enrichedBooks.map((b) => [
    b.title || "",
    b.author || "",
    b.isbn13 ? `="${b.isbn13}"` : "",
    b.isbn10 ? `="${b.isbn10}"` : "",
    "",                                         // description
    b.subjects || "",                            // tags
    "",                                         // group
    "",                                         // status
    "",                                         // began
    "",                                         // completed
    "",                                         // rating
    "",                                         // review
    "",                                         // price
    b.pages ? String(b.pages) : "",             // length
  ]);

  const csvContent = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");

  // UTF-8 BOM so Excel reads special characters correctly
  const bom = "\uFEFF";
  const blob = new Blob([bom + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bookshelf-libib-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Start over ──────────────────────────────────────────────────────────────
btnStartOver.addEventListener("click", () => {
  identifiedBooks = [];
  enrichedBooks = [];
  selectedFile = null;
  previewContainer.classList.add("hidden");
  inputCamera.value = "";
  inputUpload.value = "";
  showStep(stepCapture);
});
