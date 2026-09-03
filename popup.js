let activeTabId = null;
let scrapedLinkedinUrl = null;
let scrapedTitle = null;

function el(id) {
  return document.getElementById(id);
}

// LinkedIn is a single-page app: navigating to a profile from elsewhere in
// LinkedIn (e.g. clicking your own name from the feed) doesn't fire a real
// page load, so manifest.json's declarative content_scripts injection --
// which only fires on real navigations -- silently never runs for that
// case, leaving the tab with no content script to message. Explicitly
// (re-)injecting here, right before every message, makes this work
// regardless of how the user got to the profile page. content-script.js
// guards against double-injection, so calling this when the script is
// already present is a safe no-op.
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] });
  } catch {
    // Injection can fail on pages the extension isn't allowed to touch;
    // the subsequent sendMessage below will surface that as its own error.
  }
}

function renderStatus(status, body) {
  const box = el('statusBox');
  el('addSection').style.display = 'none';

  if (status === 'error') {
    box.innerHTML = `<div class="status error">Couldn't reach Curatal: ${body.error}</div>`;
    return;
  }
  if (status === 'found') {
    const m = body.match;
    const roles = m.workExperience.map((w) => `${w.title || 'Unknown role'} at ${w.company || 'Unknown'}`).join(', ');
    box.innerHTML = `<div class="status found">✅ Already on Curatal<br><strong>${m.fullName}</strong>${m.location ? ` — ${m.location}` : ''}${roles ? `<br>${roles}` : ''}</div>`;
    return;
  }
  if (status === 'review') {
    const items = body.possibleMatches.map((m) => {
      const roles = m.workExperience.map((w) => `${w.title || 'Unknown role'} at ${w.company || 'Unknown'}`).join(', ');
      return `<div class="match-item"><strong>${m.fullName}</strong>${m.location ? ` — ${m.location}` : ''}${roles ? `<br>${roles}` : ''}</div>`;
    }).join('');
    box.innerHTML = `<div class="status review">⚠ Possible matches found — review before adding:${items}</div>`;
    el('addSection').style.display = 'block';
    el('downloadHint').textContent = 'None of these? Add this profile as a new candidate below.';
    return;
  }
  // not_found
  box.innerHTML = `<div class="status not_found">Not found on Curatal.</div>`;
  el('addSection').style.display = 'block';
  el('downloadHint').textContent = '';
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/www\.linkedin\.com\/in\//.test(tab.url || '')) {
    el('notLinkedIn').style.display = 'block';
    return;
  }
  activeTabId = tab.id;

  const { apiBase, apiKey } = await chrome.storage.sync.get(['apiBase', 'apiKey']);
  if (!apiBase || !apiKey) {
    el('notConfigured').style.display = 'block';
    el('openOptions').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    return;
  }

  el('mainForm').style.display = 'block';

  await ensureContentScript(activeTabId);
  let scraped;
  try {
    scraped = await chrome.tabs.sendMessage(activeTabId, { type: 'SCRAPE_PROFILE' });
  } catch {
    scraped = null;
  }
  if (scraped) {
    el('fullName').value = scraped.fullName || '';
    el('company').value = scraped.company || '';
    scrapedLinkedinUrl = scraped.linkedinUrl;
    scrapedTitle = scraped.title;
  }
}

el('checkBtn').addEventListener('click', async () => {
  const name = el('fullName').value.trim();
  const company = el('company').value.trim();
  if (!name) return;

  el('checkBtn').disabled = true;
  el('statusBox').innerHTML = '<div class="status not_found">Checking…</div>';
  const result = await chrome.runtime.sendMessage({ type: 'CHECK_CANDIDATE', payload: { name, company } });
  el('checkBtn').disabled = false;

  if (result.error) {
    renderStatus('error', result);
  } else {
    renderStatus(result.status, result);
  }
});

el('downloadPdfBtn').addEventListener('click', async () => {
  el('downloadHint').textContent = 'Triggering LinkedIn’s Save to PDF…';
  await ensureContentScript(activeTabId);
  const result = await chrome.tabs.sendMessage(activeTabId, { type: 'TRIGGER_SAVE_TO_PDF' });
  if (result.ok) {
    el('downloadHint').textContent = 'Downloading… once it lands in your Downloads folder, select it below.';
  } else {
    el('downloadHint').textContent = `Couldn't find LinkedIn's Save to PDF option (${result.step}). You can still save it manually via the profile's Resources menu, then select it below.`;
  }
});

el('pdfFile').addEventListener('change', () => {
  el('uploadBtn').disabled = !el('pdfFile').files.length;
});

el('uploadBtn').addEventListener('click', async () => {
  const file = el('pdfFile').files[0];
  if (!file) return;

  el('uploadBtn').disabled = true;
  const uploadStatus = el('uploadStatus');
  uploadStatus.style.display = 'block';
  uploadStatus.className = 'status not_found';
  uploadStatus.textContent = 'Uploading…';

  const pdfDataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const result = await chrome.runtime.sendMessage({
    type: 'UPLOAD_CANDIDATE',
    payload: {
      fullName: el('fullName').value.trim(),
      company: el('company').value.trim(),
      title: scrapedTitle,
      linkedinUrl: scrapedLinkedinUrl,
      pdfDataUrl,
      pdfFilename: file.name,
    },
  });

  if (result.error) {
    uploadStatus.className = 'status error';
    uploadStatus.textContent = result.error === 'already_exists'
      ? 'This profile is already in Curatal.'
      : `Upload failed: ${result.error}`;
    el('uploadBtn').disabled = false;
  } else {
    uploadStatus.className = 'status found';
    uploadStatus.textContent = '✅ Added to Curatal.';
  }
});

init();
