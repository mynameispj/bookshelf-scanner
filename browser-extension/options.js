const DEFAULT_SERVER = 'http://localhost:3000';

const input  = document.getElementById('server-url');
const btn    = document.getElementById('btn-save');
const status = document.getElementById('status');

chrome.storage.sync.get(['serverUrl'], (result) => {
  input.value = result.serverUrl || DEFAULT_SERVER;
});

btn.addEventListener('click', () => {
  const url = input.value.trim().replace(/\/$/, '') || DEFAULT_SERVER;
  chrome.storage.sync.set({ serverUrl: url }, () => {
    status.textContent = '✓ Saved';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
});
