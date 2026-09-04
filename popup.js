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
  el('uploadStatus').style.display = 'none';

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
    return;
  }
  // not_found
  box.innerHTML = `<div class="status not_found">Not found on Curatal.</div>`;
  el('addSection').style.display = 'block';
}

async function init() {
  const { apiBase, apiKey } = await chrome.storage.sync.get(['apiBase', 'apiKey']);
  if (!apiBase || !apiKey) {
    el('notConfigured').style.display = 'block';
    el('openOptions').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    return;
  }
  el('configuredSections').style.display = 'block';

  // The skill-search box (below) works regardless of what page is open --
  // only the single-profile check/add section needs an actual profile
  // page open to scrape.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/www\.linkedin\.com\/in\//.test(tab.url || '')) {
    el('notLinkedIn').style.display = 'block';
    return;
  }
  activeTabId = tab.id;
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

el('viewAllLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('browse.html') });
});

el('searchSkillBtn').addEventListener('click', () => {
  const skill = el('skillInput').value.trim();
  if (!skill) return;
  const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(skill)}`;
  chrome.tabs.create({ url });
});

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

// No download, no file picker, no local disk involved at all: builds a
// small PDF summary from the scraped profile data entirely in memory
// (pdf-builder.js) and uploads it directly. This is deliberately not a
// copy of LinkedIn's own PDF export -- that path (trigger their Save to
// PDF, wait for the download, read it back) turned out fragile in
// practice: the download notification steals the popup's focus and closes
// it mid-flow, and MV3 service workers can't even fetch() a file:// URL to
// read the result back. Synchronous in-memory generation has none of
// that -- it can't fail partway through.
el('addBtn').addEventListener('click', async () => {
  el('addBtn').disabled = true;
  const uploadStatus = el('uploadStatus');
  uploadStatus.style.display = 'block';
  uploadStatus.className = 'status not_found';
  uploadStatus.textContent = 'Uploading…';

  const fullName = el('fullName').value.trim();
  const company = el('company').value.trim();
  const pdfDataUrl = buildProfileSummaryPdf({
    fullName,
    title: scrapedTitle,
    company,
    linkedinUrl: scrapedLinkedinUrl,
  });

  const result = await chrome.runtime.sendMessage({
    type: 'UPLOAD_CANDIDATE',
    payload: {
      fullName,
      company,
      title: scrapedTitle,
      linkedinUrl: scrapedLinkedinUrl,
      pdfDataUrl,
      pdfFilename: `${fullName || 'candidate'}.pdf`,
    },
  });
  el('addBtn').disabled = false;

  if (result.error) {
    uploadStatus.className = 'status error';
    uploadStatus.textContent = result.error === 'already_exists'
      ? 'This profile is already in Curatal.'
      : `Upload failed: ${result.error}`;
  } else {
    uploadStatus.className = 'status found';
    uploadStatus.textContent = '✅ Added to Curatal.';
  }
});

init();
