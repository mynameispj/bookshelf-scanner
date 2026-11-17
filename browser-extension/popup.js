const DEFAULT_SERVER = 'http://localhost:3000';

let serverUrl      = DEFAULT_SERVER;
let identifiedBooks = [];
let enrichedBooks   = [];
let selectedFile    = null;

const $ = (s) => document.querySelector(s);

const stepCapture = $('#step-capture');
const stepReview  = $('#step-review');
const stepExport  = $('#step-export');
const loading     = $('#loading');
const loadingText = $('#loading-text');

// ── Init ────────────────────────────────────────────────────────────────────
chrome.storage.sync.get(['serverUrl'], (result) => {
  serverUrl = (result.serverUrl || DEFAULT_SERVER).replace(/\/$/, '');
  checkServerStatus();
});

$('#btn-settings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ── Server status ────────────────────────────────────────────────────────────
async function checkServerStatus() {
  const badge = $('#server-status');
  badge.textContent = 'checking…';
  badge.className = 'status-badge checking';
  try {
    const res = await fetch(serverUrl, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
    if (res.ok || res.status < 500) {
      badge.textContent = '● online';
      badge.className = 'status-badge online';
    } else {
      throw new Error('server error');
    }
  } catch {
    badge.textContent = '● offline';
    badge.className = 'status-badge offline';
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────
function showLoading(msg) {
  loadingText.textContent = msg;
  loading.classList.remove('hidden');
}
function hideLoading() { loading.classList.add('hidden'); }
function showStep(el) {
  [stepCapture, stepReview, stepExport].forEach(s => s.classList.add('hidden'));
  el.classList.remove('hidden');
}

function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

// Compress image before upload (adapted from public/app.js)
function compressImage(file, maxDim = 2000, quality = 0.80) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width  = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('Compression failed')),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = URL.createObjectURL(file);
  });
}

// ── Step 1: Image selection ───────────────────────────────────────────────────
function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  selectedFile = file;
  $('#preview-img').src = URL.createObjectURL(file);
  $('#preview-container').classList.remove('hidden');
  $('#btn-scan').disabled = false;
}

$('#input-camera').addEventListener('change', handleFileSelect);
$('#input-upload').addEventListener('change', handleFileSelect);

// ── Step 1 → 2: Scan ─────────────────────────────────────────────────────────
$('#btn-scan').addEventListener('click', async () => {
  if (!selectedFile) return;

  showLoading('Compressing image…');

  let blob;
  try {
    blob = await compressImage(selectedFile);
  } catch {
    blob = selectedFile;
  }

  showLoading('Scanning bookshelf… (this takes 20–90 s)');

  const formData = new FormData();
  formData.append('photo', blob, selectedFile.name || 'photo.jpg');

  const stages = [
    { delay: 8000,  msg: 'Counting books…' },
    { delay: 20000, msg: 'Identifying books section by section…' },
    { delay: 50000, msg: 'Verifying titles & authors…' },
    { delay: 90000, msg: 'Still working — large shelf detected…' },
  ];
  const timers = stages.map(s => setTimeout(() => showLoading(s.msg), s.delay));

  try {
    const res = await fetch(`${serverUrl}/api/scan`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(270000),
    });

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text();
      throw new Error(res.status === 413 ? 'Image too large.' : `Server error (${res.status}): ${text.slice(0,100)}`);
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scan failed');

    identifiedBooks = data.books;
    renderReviewList();
    showStep(stepReview);
  } catch (err) {
    alert('Scan failed: ' + (err.name === 'TimeoutError' ? 'Timed out. Try a smaller photo.' : err.message));
  } finally {
    timers.forEach(clearTimeout);
    hideLoading();
  }
});

// ── Step 2: Review ────────────────────────────────────────────────────────────
function renderReviewList() {
  const lowCount = identifiedBooks.filter(b => b.confidence === 'low').length;
  let hint = `Found ${identifiedBooks.length} book(s).`;
  if (lowCount) hint += ` ${lowCount} low-confidence — verify those.`;
  $('#review-hint').textContent = hint;

  const list = $('#book-list');
  list.innerHTML = '';

  if (identifiedBooks.length === 0) {
    list.innerHTML = '<p style="color:#6b7280;font-size:.82rem;text-align:center;padding:16px 0">No books detected. Add manually or try another photo.</p>';
    return;
  }

  identifiedBooks.forEach((book, i) => {
    const conf = book.confidence || 'high';
    const confLabel = conf === 'high' ? '✅ High' : conf === 'medium' ? '🟡 Med' : '🔴 Low';
    const card = document.createElement('div');
    card.className = `book-card confidence-${conf}`;
    card.innerHTML = `
      <div class="info">
        <input type="text" data-idx="${i}" data-field="title"  value="${esc(book.title)}"  placeholder="Title" />
        <input type="text" data-idx="${i}" data-field="author" value="${esc(book.author)}" placeholder="Author" />
        <span class="conf-badge conf-${conf}">${confLabel}</span>
      </div>
      <button class="btn btn-danger remove" data-idx="${i}">✕</button>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('input').forEach(input => {
    input.addEventListener('input', (e) => {
      identifiedBooks[+e.target.dataset.idx][e.target.dataset.field] = e.target.value;
    });
  });

  list.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      identifiedBooks.splice(+e.target.dataset.idx, 1);
      renderReviewList();
    });
  });
}

$('#btn-add-manual').addEventListener('click', () => {
  identifiedBooks.push({ title: '', author: '' });
  renderReviewList();
  const inputs = $('#book-list').querySelectorAll('input[data-field="title"]');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

$('#btn-back').addEventListener('click', () => showStep(stepCapture));

// ── Step 2 → 3: Lookup ────────────────────────────────────────────────────────
$('#btn-lookup').addEventListener('click', async () => {
  if (!identifiedBooks.length) { alert('No books to look up.'); return; }

  showLoading('Looking up ISBNs & metadata…');

  try {
    const res  = await fetch(`${serverUrl}/api/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ books: identifiedBooks }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lookup failed');

    enrichedBooks = data.books;
    renderEnrichedList();
    const n = enrichedBooks.length;
    $('#export-summary').textContent = `${n} book${n !== 1 ? 's' : ''} ready to export.`;
    showStep(stepExport);
  } catch (err) {
    alert('Lookup failed: ' + err.message);
  } finally {
    hideLoading();
  }
});

// ── Step 3: Enriched list ──────────────────────────────────────────────────────
function renderEnrichedList() {
  const list = $('#enriched-list');
  list.innerHTML = '';
  enrichedBooks.forEach((book) => {
    const card = document.createElement('div');
    card.className = `enriched-card${book.matched ? '' : ' no-match'}`;
    const coverHtml = book.coverUrl
      ? `<img class="cover" src="${book.coverUrl}" alt="cover" />`
      : `<div class="cover-placeholder">No cover</div>`;
    card.innerHTML = `
      ${coverHtml}
      <div class="details">
        <strong>${esc(book.title)}</strong>
        <span class="sub">${esc(book.author)}</span>
        ${book.isbn13 ? `<span class="sub">ISBN-13: ${book.isbn13}</span>` : ''}
        ${book.publishYear ? `<span class="sub">${book.publishYear}</span>` : ''}
        ${!book.matched ? `<span class="sub" style="color:#f59e0b">⚠ No match found</span>` : ''}
      </div>
    `;
    list.appendChild(card);
  });
}

$('#btn-back-2').addEventListener('click', () => showStep(stepReview));

// ── Download CSV ────────────────────────────────────────────────────────────────
$('#btn-download-csv').addEventListener('click', () => {
  const header = ['title','creators','ean_isbn13','upc_isbn10','description','tags','group','status','began','completed','rating','review','price','length'];
  const rows = enrichedBooks.map((b) => [
    b.title || '', b.author || '',
    b.isbn13 ? `="${b.isbn13}"` : '', b.isbn10 ? `="${b.isbn10}"` : '',
    '', b.subjects || '', '', '', '', '', '', '', '',
    b.pages ? String(b.pages) : '',
  ]);
  const csv = [header, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g,'""')}"`).join(','))
    .join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `bookshelf-libib-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Open full app ────────────────────────────────────────────────────────────────
$('#btn-open-app').addEventListener('click', () => {
  chrome.tabs.create({ url: serverUrl });
});
