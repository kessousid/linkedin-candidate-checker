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

// Loose enough to catch real-world formats (spaces, dashes, parens, a
// leading +country code) without also matching arbitrary copied text --
// mostly digits, 7-15 digits total once separators are stripped. This is a
// convenience pre-fill, never a requirement: the field stays a normal,
// fully-editable text input either way, since phone/email lookup tools
// aren't something every user runs every time.
function looksLikePhoneNumber(text) {
  const trimmed = (text || '').trim();
  if (!trimmed || trimmed.length > 25) return false;
  if (!/^\+?[\d\s\-().]+$/.test(trimmed)) return false;
  const digitCount = (trimmed.match(/\d/g) || []).length;
  return digitCount >= 7 && digitCount <= 15;
}

async function tryAutofillPhoneFromClipboard() {
  if (el('phone').value.trim()) return; // never clobber something already there
  try {
    const clipboardText = await navigator.clipboard.readText();
    if (looksLikePhoneNumber(clipboardText)) {
      el('phone').value = clipboardText.trim();
      el('phoneAutofillHint').style.display = 'block';
    }
  } catch {
    // Clipboard read can fail (permission not yet granted, empty/non-text
    // clipboard, popup not focused) -- silently leave the field for manual
    // entry, which always works regardless.
  }
}

function renderStatus(result) {
  const box = el('statusBox');
  el('addSection').style.display = 'none';
  el('uploadStatus').style.display = 'none';

  if (result.error) {
    box.innerHTML = `<div class="status error">Couldn't reach Curatal: ${result.error}</div>`;
    return;
  }
  if (result.exists) {
    const viaText = result.via === 'linkedin_url' ? 'This LinkedIn user is already on Curatal' : 'Already on Curatal';
    box.innerHTML = `<div class="status found">✅ ${viaText}<br><strong>${result.fullName || ''}</strong></div>`;
    return;
  }
  box.innerHTML = `<div class="status not_found">Not found on Curatal.</div>`;
  el('addSection').style.display = 'block';
}

async function init() {
  const { loggedIn } = await chrome.runtime.sendMessage({ type: 'GET_LOGIN_STATE' });
  if (!loggedIn) {
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
  await tryAutofillPhoneFromClipboard();
  el('phone').addEventListener('input', () => {
    el('phoneAutofillHint').style.display = 'none';
  });

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

el('searchSkillBtn').addEventListener('click', () => {
  const skill = el('skillInput').value.trim();
  if (!skill) return;
  const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(skill)}`;
  chrome.tabs.create({ url });
});

el('bulkBackfillLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('bulk-backfill.html') });
});

el('checkBtn').addEventListener('click', async () => {
  const fullName = el('fullName').value.trim();
  const phone = el('phone').value.trim();
  const email = el('email').value.trim();
  if (!fullName) {
    el('statusBox').innerHTML = '<div class="status error">Enter a name to check.</div>';
    return;
  }
  if (!phone && !email && !scrapedLinkedinUrl) {
    el('statusBox').innerHTML = '<div class="status error">No LinkedIn profile URL found, and no phone/email entered -- need at least one to check.</div>';
    return;
  }

  el('checkBtn').disabled = true;
  el('statusBox').innerHTML = '<div class="status not_found">Checking…</div>';
  const result = await chrome.runtime.sendMessage({ type: 'CHECK_CANDIDATE', payload: { fullName, phone, email, linkedinUrl: scrapedLinkedinUrl } });
  el('checkBtn').disabled = false;
  renderStatus(result);
});

el('addBtn').addEventListener('click', async () => {
  el('addBtn').disabled = true;
  const uploadStatus = el('uploadStatus');
  uploadStatus.style.display = 'block';
  uploadStatus.className = 'status not_found';
  uploadStatus.textContent = 'Adding…';

  const fullName = el('fullName').value.trim();
  const company = el('company').value.trim();
  const phone = el('phone').value.trim();
  const email = el('email').value.trim();
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
      phone,
      email,
      currentCompany: company,
      linkedinUrl: scrapedLinkedinUrl,
      pdfDataUrl,
    },
  });
  el('addBtn').disabled = false;

  if (result.error) {
    uploadStatus.className = 'status error';
    uploadStatus.textContent = result.error === 'already_exists'
      ? 'This profile is already in Curatal.'
      : `Add failed: ${result.error}`;
  } else {
    uploadStatus.className = 'status found';
    uploadStatus.textContent = '✅ Added to Curatal.';
  }
});

init();
