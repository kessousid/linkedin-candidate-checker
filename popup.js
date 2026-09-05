let activeTabId = null;
let scrapedLinkedinUrl = null;

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

function renderStatus(result) {
  const box = el('statusBox');
  el('addSection').style.display = 'none';
  el('uploadStatus').style.display = 'none';

  if (result.error) {
    box.innerHTML = `<div class="status error">Couldn't reach Curatal: ${result.error}</div>`;
    return;
  }
  if (result.exists) {
    box.innerHTML = `<div class="status found">✅ Already on Curatal<br><strong>${result.fullName || ''}</strong></div>`;
    return;
  }
  box.innerHTML = `<div class="status not_found">Not found on Curatal (checked by phone/email).</div>`;
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
  }
}

el('searchSkillBtn').addEventListener('click', () => {
  const skill = el('skillInput').value.trim();
  if (!skill) return;
  const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(skill)}`;
  chrome.tabs.create({ url });
});

el('checkBtn').addEventListener('click', async () => {
  const phone = el('phone').value.trim();
  const email = el('email').value.trim();
  if (!phone && !email) {
    el('statusBox').innerHTML = '<div class="status error">Enter a phone number or email to check.</div>';
    return;
  }

  el('checkBtn').disabled = true;
  el('statusBox').innerHTML = '<div class="status not_found">Checking…</div>';
  const result = await chrome.runtime.sendMessage({ type: 'CHECK_CANDIDATE', payload: { phone, email } });
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

  const result = await chrome.runtime.sendMessage({
    type: 'UPLOAD_CANDIDATE',
    payload: {
      fullName,
      phone,
      email,
      currentCompany: company,
      linkedinUrl: scrapedLinkedinUrl,
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
