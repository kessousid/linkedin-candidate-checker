// Runs on https://www.linkedin.com/search/results/people/* (declared in
// manifest.json). Adds a small "Check Curatal" control to each result card
// already rendered on the page -- it never navigates to another LinkedIn
// page or opens a profile to scrape it. Everything it works with (name,
// headline, profile URL) is exactly what LinkedIn already sent to render
// the search results list; this only reads it and reacts to explicit
// clicks. Nothing here runs automatically against LinkedIn -- the batch
// control below only ever processes cards already on screen, on demand.
if (!window.__curatalSearchScriptLoaded) {
  window.__curatalSearchScriptLoaded = true;
  initSearchAssist();
}

function initSearchAssist() {

function textOf(el) {
  return el ? el.textContent.trim().replace(/\s+/g, ' ') : null;
}

// One result card = one div[role="listitem"] under the results
// div[role="list"] -- verified live against a real LinkedIn People search.
function extractCard(li) {
  // The candidate's own name+degree renders as one element with text like
  // "Full Name • 2nd" ("1st"/"3rd"/"3rd+") -- unique to the card's actual
  // subject, unlike the "X is a mutual connection" line nearby, which
  // has no degree badge.
  const degreeEl = Array.from(li.querySelectorAll('*')).find((el) => {
    if (el.children.length > 2) return false;
    return /^.+?\s*•\s*(1st|2nd|3rd\+?)$/.test(textOf(el) || '');
  });
  if (!degreeEl) return null;
  const match = /^(.+?)\s*•\s*(1st|2nd|3rd\+?)$/.exec(textOf(degreeEl));
  const name = match[1].trim();

  // Cards also wrap in one big overlay <a> spanning the whole card text
  // (used for click-anywhere-to-navigate); the candidate's own name-only
  // link is the shortest <a href*="/in/"> whose text includes their name.
  const nameLink = Array.from(li.querySelectorAll('a[href*="/in/"]'))
    .filter((a) => (textOf(a) || '').includes(name))
    .sort((a, b) => (textOf(a) || '').length - (textOf(b) || '').length)[0];
  const linkedinUrl = nameLink ? nameLink.href.split('?')[0] : null;

  // Headline is the degree element's next sibling within their shared
  // parent (verified live: that parent's children are exactly
  // [name+degree, headline, location]).
  const siblings = degreeEl.parentElement ? Array.from(degreeEl.parentElement.children) : [];
  const idx = siblings.indexOf(degreeEl);
  const headline = idx >= 0 && siblings[idx + 1] ? textOf(siblings[idx + 1]) : null;

  return { name, linkedinUrl, headline, li };
}

// Search-result headlines use "@" ("Senior Dev @ Acme") as often as "at",
// and often trail off into a "|"-separated skills list -- neither pattern
// showed up on profile pages, so this is a separate, wider parse than
// content-script.js's scrapeCurrentEmployer().
function parseHeadline(headline) {
  if (!headline) return { title: null, company: null };
  const match = /^(.+?)\s*(?:\bat\b|@)\s*([^|]+)/i.exec(headline);
  if (match) return { title: match[1].trim(), company: match[2].trim() };
  return { title: headline, company: null };
}

function setStatus(statusEl, text, kind) {
  statusEl.textContent = text;
  statusEl.style.color = { found: '#1e7a34', added: '#1e7a34', review: '#8a6100', error: '#b3261e' }[kind] || '#666';
}

// Checks Curatal for one card by phone/email and, if missing, adds it. Phone
// (and optionally email) has to come from whatever separate lookup tool the
// recruiter is using alongside this extension -- LinkedIn's search results
// never expose either, so there's a small input for it right on the card.
// Only ever called from an explicit click (per-card or the "check all
// visible" batch button), never on page load/scroll.
async function checkAndAddCard(card, statusEl, contactEls) {
  const { company } = parseHeadline(card.headline);
  const phone = contactEls.phone.value.trim();
  const email = contactEls.email.value.trim();
  if (!phone && !email) {
    setStatus(statusEl, 'Enter a phone or email first', 'error');
    return;
  }
  setStatus(statusEl, 'Checking…', null);

  const checkResult = await chrome.runtime.sendMessage({
    type: 'CHECK_CANDIDATE',
    payload: { phone, email },
  });
  if (checkResult.error) {
    setStatus(statusEl, `Error: ${checkResult.error}`, 'error');
    return;
  }
  if (checkResult.exists) {
    setStatus(statusEl, '✅ Already on Curatal', 'found');
    return;
  }

  setStatus(statusEl, 'Adding…', null);
  const uploadResult = await chrome.runtime.sendMessage({
    type: 'UPLOAD_CANDIDATE',
    payload: {
      fullName: card.name,
      phone,
      email,
      currentCompany: company,
      linkedinUrl: card.linkedinUrl,
    },
  });
  if (uploadResult.error) {
    setStatus(statusEl, uploadResult.error === 'already_exists' ? '✅ Already on Curatal' : `Add failed: ${uploadResult.error}`, uploadResult.error === 'already_exists' ? 'found' : 'error');
    return;
  }
  setStatus(statusEl, '✅ Added to Curatal', 'added');
}

const CONTROLS_CLASS = 'curatal-card-controls';

function injectCardControls(card) {
  if (card.li.querySelector(`.${CONTROLS_CLASS}`)) return null;

  const wrap = document.createElement('div');
  wrap.className = CONTROLS_CLASS;
  wrap.style.cssText = 'margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;';

  // LinkedIn search results never expose phone/email -- these are filled in
  // manually (from whatever separate lookup tool the recruiter is using)
  // before checking/adding this card.
  const phoneInput = document.createElement('input');
  phoneInput.type = 'text';
  phoneInput.placeholder = 'Phone';
  phoneInput.style.cssText = 'width:110px;padding:3px 6px;font-size:12px;border:1px solid #ccc;border-radius:4px;';

  const emailInput = document.createElement('input');
  emailInput.type = 'text';
  emailInput.placeholder = 'Email (optional)';
  emailInput.style.cssText = 'width:150px;padding:3px 6px;font-size:12px;border:1px solid #ccc;border-radius:4px;';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Check Curatal';
  btn.style.cssText = 'padding:4px 10px;font-size:12px;border:1px solid #1b4b8c;border-radius:4px;background:white;color:#1b4b8c;cursor:pointer;';

  const status = document.createElement('span');
  status.style.cssText = 'font-size:12px;color:#666;';

  const contactEls = { phone: phoneInput, email: emailInput };

  btn.addEventListener('click', async (e) => {
    // Cards sit inside a full-card overlay <a> (click-anywhere navigates
    // to the profile) -- without this, clicking the button would also
    // navigate away.
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    await checkAndAddCard(card, status, contactEls);
    btn.disabled = false;
  });
  [phoneInput, emailInput].forEach((input) => {
    input.addEventListener('click', (e) => e.stopPropagation());
  });

  wrap.appendChild(phoneInput);
  wrap.appendChild(emailInput);
  wrap.appendChild(btn);
  wrap.appendChild(status);
  card.li.appendChild(wrap);
  return { btn, status, contactEls };
}

function scanAndInject() {
  Array.from(document.querySelectorAll('div[role="listitem"]'))
    .map(extractCard)
    .filter((card) => card && card.name && card.linkedinUrl)
    .forEach(injectCardControls);
}

const BATCH_BAR_ID = 'curatal-batch-bar';

function injectBatchBar() {
  if (document.getElementById(BATCH_BAR_ID)) return;
  const list = document.querySelector('div[role="list"]');
  if (!list) return;

  const bar = document.createElement('div');
  bar.id = BATCH_BAR_ID;
  bar.style.cssText = 'padding:10px;margin-bottom:8px;background:#eef1f6;border-radius:6px;display:flex;align-items:center;gap:10px;font-size:13px;';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Check & add all visible candidates to Curatal';
  btn.style.cssText = 'padding:6px 12px;border:none;border-radius:4px;background:#1b4b8c;color:white;cursor:pointer;font-size:13px;';

  const progress = document.createElement('span');
  progress.style.cssText = 'color:#444;';

  // Only ever processes cards already rendered on this page -- no
  // scrolling, no pagination, no additional LinkedIn page loads. One
  // request to our own backend at a time, with a short pause between, so
  // this never looks like a burst against LinkedIn or hammers our API.
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const cards = Array.from(document.querySelectorAll('div[role="listitem"]'))
      .map(extractCard)
      .filter((card) => card && card.name && card.linkedinUrl);

    for (let i = 0; i < cards.length; i += 1) {
      progress.textContent = `Processing ${i + 1} of ${cards.length}…`;
      const existingWrap = cards[i].li.querySelector(`.${CONTROLS_CLASS}`);
      const controls = injectCardControls(cards[i]) || {
        status: existingWrap.querySelector('span'),
        contactEls: {
          phone: existingWrap.querySelectorAll('input')[0],
          email: existingWrap.querySelectorAll('input')[1],
        },
      };
      // eslint-disable-next-line no-await-in-loop
      await checkAndAddCard(cards[i], controls.status, controls.contactEls);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    progress.textContent = `Done — processed ${cards.length}.`;
    btn.disabled = false;
  });

  bar.appendChild(btn);
  bar.appendChild(progress);
  list.parentElement.insertBefore(bar, list);
}

function scan() {
  injectBatchBar();
  scanAndInject();
}

scan();
// LinkedIn's results list re-renders as the user scrolls/paginates within
// the page; re-scan (cheaply -- injectCardControls/injectBatchBar are both
// no-ops once already present) so newly-rendered cards get their button
// too, without ever triggering a fetch ourselves.
let rescanTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(scan, 300);
});
observer.observe(document.body, { childList: true, subtree: true });

}
