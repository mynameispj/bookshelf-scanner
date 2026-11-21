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
const btnRemoveLow = $("#btn-remove-low");
const btnLookup   = $("#btn-lookup");
const enrichedList = $("#enriched-list");
const btnDownload  = $("#btn-download-csv");
const btnStartOver = $("#btn-start-over");
const loading     = $("#loading");
const loadingText = $("#loading-text");
const scanProgress = $("#scan-progress");

// ── Utilities ───────────────────────────────────────────────────────────────
function showLoading(msg) { loadingText.textContent = msg; loading.classList.remove("hidden"); }
function hideLoading()    { loading.classList.add("hidden"); }
function showStep(el)     { [stepCapture, stepReview, stepExport].forEach(s => s.classList.add("hidden")); el.classList.remove("hidden"); }
function setStep(n) {
  document.querySelectorAll('.step-pip').forEach((pip, i) => {
    pip.classList.remove('active', 'done');
    if (i + 1 === n) pip.classList.add('active');
    if (i + 1 < n) pip.classList.add('done');
  });
}

/**
 * Compress an image file to stay under Vercel's 4.5 MB body limit.
 * Resizes to max 3200px on longest side and uses JPEG quality 0.80.
 * This preserves enough spine-text detail for GPT while keeping size ~2-3 MB.
 * Skips re-encoding photos that are already small, and never returns a file
 * bigger than the original. Rejects if the browser can't decode the image
 * (e.g. HEIC on desktop) — the caller then uploads the original.
 */
function compressImage(file, maxDim = 3200, quality = 0.80) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { naturalWidth: width, naturalHeight: height } = img;
      const fitsAlready = width <= maxDim && height <= maxDim;
      if (fitsAlready && file.size < 2.5 * 1024 * 1024 && /jpe?g|png/i.test(file.type)) {
        resolve(file); // small enough already — re-encoding would only lose detail
        return;
      }
      if (!fitsAlready) {
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
        (blob) => {
          if (!blob) return reject(new Error("Canvas compression failed"));
          resolve(blob.size < file.size ? blob : file);
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not load image for compression"));
    };
    img.src = url;
  });
}

// ── Step 1: Image selection ─────────────────────────────────────────────────
function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  selectedFile = file;
  previewImg.src = URL.createObjectURL(file);
  previewContainer.classList.remove("hidden");
  btnScan.disabled = false;
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

  showLoading("Uploading photo…");

  const formData = new FormData();
  formData.append("photo", photoBlob, selectedFile.name || "photo.jpg");

  // Abort after 4.5 minutes to stay within Vercel's 5-minute limit
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 270000);

  // Books shown on the review screen while the scan is still running
  let gotPartial = false;
  let progress = { done: 0, total: 0, stage: "" };

  function onScanEvent(ev) {
    switch (ev.type) {
      case "stage":
        progress.stage = ev.message;
        if (gotPartial) renderScanProgress(progress);
        else showLoading(ev.message);
        break;
      case "tile":
        progress.done = ev.done;
        progress.total = ev.total;
        identifiedBooks = ev.books;
        if (!gotPartial) {
          gotPartial = true;
          hideLoading();
          setStep(2);
          showStep(stepReview);
        }
        renderReviewList({ pending: true });
        renderScanProgress(progress);
        break;
      case "warning":
        console.warn("Scan warning:", ev.message);
        break;
      case "result":
        identifiedBooks = ev.books;
        break;
      case "error":
        throw new Error(ev.error);
    }
  }

  const postScan = () => fetch("/api/scan", {
    method: "POST",
    body: formData,
    headers: { Accept: "application/x-ndjson" },
    signal: controller.signal,
  });

  try {
    let res;
    try {
      res = await postScan();
    } catch (netErr) {
      // One automatic retry if the network dropped before the server answered.
      // (Never retry once results have started streaming — that would pay for the scan twice.)
      if (!(netErr instanceof TypeError)) throw netErr;
      console.warn("Network error starting scan, retrying once:", netErr);
      showLoading("Connection hiccup — retrying…");
      await new Promise((r) => setTimeout(r, 1500));
      res = await postScan();
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/x-ndjson")) {
      await readNdjson(res, onScanEvent);
    } else if (contentType.includes("application/json")) {
      // Errors raised before streaming starts (upload too large, no file, …)
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      identifiedBooks = data.books;
    } else {
      // Non-JSON error responses (e.g. Vercel HTML error pages)
      const text = await res.text();
      if (res.status === 413) throw new Error("Image too large. Please use a smaller photo.");
      if (res.status === 415) throw new Error("Couldn't read this image format — please upload a JPEG or PNG.");
      if (res.status >= 500) throw new Error(`Server error (${res.status}). Please try again in a moment.`);
      throw new Error(`Unexpected response (${res.status}): ${text.slice(0, 120)}`);
    }

    renderScanProgress(null);
    renderReviewList();
    setStep(2);
    showStep(stepReview);
  } catch (err) {
    renderScanProgress(null);
    if (gotPartial) {
      // Keep what we already found so the user doesn't lose it.
      identifiedBooks.forEach((b) => { b.unverified = true; });
      renderReviewList();
    }
    const partialNote = gotPartial ? "\n\nThe books found so far are kept — marked as unverified." : "";
    if (err.name === "AbortError") {
      alert("Scan timed out. Try a smaller or clearer photo with fewer books." + partialNote);
    } else if (err instanceof TypeError) {
      // TypeError from fetch = network-level failure (connection refused, DNS, CORS, etc.)
      console.error("Network error during scan:", err);
      alert("Scan failed: Could not reach the server. Check your internet connection and try again.\n\nIf the problem persists, the image may be too large — try a lower-resolution photo.");
    } else {
      alert("Scan failed: " + (err.message || "Unknown error") + partialNote);
    }
  } finally {
    clearTimeout(abortTimer);
    hideLoading();
  }
});

/** Read a newline-delimited JSON response, calling onEvent for each line. */
async function readNdjson(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

/** Show (or hide, with null) the live progress banner above the book list. */
function renderScanProgress(p) {
  if (!p) { scanProgress.classList.add("hidden"); return; }
  const sections = p.total ? `${p.done}/${p.total} sections read` : "";
  scanProgress.innerHTML = `<span class="spinner-sm"></span><span>${escHtml(p.stage || "Scanning…")}${sections ? ` · ${sections}` : ""}</span>`;
  scanProgress.classList.remove("hidden");
}

// ── Step 2: Review list ─────────────────────────────────────────────────────
// pending = scan still running: show books read-only and disable actions.
function renderReviewList({ pending = false } = {}) {
  const lowCount  = identifiedBooks.filter(b => confPercent(b.confidence) < LOW_CONFIDENCE).length;
  let hint = `Found ${identifiedBooks.length} book(s)`;
  if (pending) hint += " so far — still scanning. You can edit once it's done.";
  else if (lowCount > 0) hint += `. ${lowCount} below ${LOW_CONFIDENCE}% confidence — please double-check those.`;
  else hint += ". Edit titles/authors or remove mistakes.";
  reviewHint.textContent = hint;
  btnLookup.disabled = pending;
  btnAddManual.disabled = pending;
  btnRemoveLow.disabled = pending;
  btnRemoveLow.classList.toggle("hidden", pending || lowCount === 0);
  btnRemoveLow.textContent = `🗑 Remove ${lowCount} below ${LOW_CONFIDENCE}%`;
  bookList.innerHTML = "";

  if (identifiedBooks.length === 0) {
    bookList.innerHTML = pending
      ? '<div class="empty-state"><p>Reading the shelf…</p></div>'
      : '<div class="empty-state"><p>No books detected yet. Try scanning a clearer photo, or add books manually below.</p></div>';
    return;
  }

  identifiedBooks.forEach((book, i) => {
    const pct = confPercent(book.confidence);
    const conf = confBand(pct);
    const confLabel = `${conf === "high" ? "✅" : conf === "medium" ? "🟡" : "🔴"} ${pct}%`;
    const correctedTag = book.corrected ? ' <span class="corrected-tag">✏️ auto-corrected</span>' : '';
    const unverifiedTag = book.unverified ? ' <span class="corrected-tag">⚠ unverified</span>' : '';
    const dis = pending ? "disabled" : "";
    const card = document.createElement("div");
    card.className = `book-card confidence-${conf}${pending ? " pending" : ""}`;
    card.innerHTML = `
      <div class="info">
        <input type="text" data-idx="${i}" data-field="title" value="${esc(book.title)}" placeholder="Title" ${dis} />
        <input type="text" data-idx="${i}" data-field="author" value="${esc(book.author)}" placeholder="Author" ${dis} />
        <span class="meta conf-badge conf-${conf}">${confLabel} confidence${correctedTag}${unverifiedTag}</span>
      </div>
      ${pending ? "" : `<button class="btn btn-danger remove" data-idx="${i}">✕</button>`}
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

// Confidence is a 0–100 score from the server. Bands drive the card colours.
const LOW_CONFIDENCE = 50;
function confPercent(c) {
  if (typeof c === "number" && Number.isFinite(c)) return Math.max(0, Math.min(100, Math.round(c)));
  return { high: 90, medium: 65, low: 35 }[c] ?? 100; // legacy labels; manual books = 100
}
function confBand(pct) { return pct >= 80 ? "high" : pct >= LOW_CONFIDENCE ? "medium" : "low"; }

function esc(s) { return (s || "").replace(/"/g, "&quot;"); }
function escHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Add manual book
btnAddManual.addEventListener("click", () => {
  identifiedBooks.push({ title: "", author: "", confidence: 100 });
  renderReviewList();
  // Focus the last title input
  const inputs = bookList.querySelectorAll('input[data-field="title"]');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

// Remove every book below the low-confidence threshold in one go
btnRemoveLow.addEventListener("click", () => {
  const low = identifiedBooks.filter(b => confPercent(b.confidence) < LOW_CONFIDENCE);
  if (!low.length) return;
  if (!confirm(`Remove ${low.length} book(s) below ${LOW_CONFIDENCE}% confidence?`)) return;
  identifiedBooks = identifiedBooks.filter(b => confPercent(b.confidence) >= LOW_CONFIDENCE);
  renderReviewList();
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
    const n = enrichedBooks.length;
    $("#export-summary").textContent = `Ready to export ${n} book${n !== 1 ? 's' : ''} to Libib.`;
    setStep(3);
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
  btnScan.disabled = true;
  inputCamera.value = "";
  inputUpload.value = "";
  setStep(1);
  showStep(stepCapture);
});
