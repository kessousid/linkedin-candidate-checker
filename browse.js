function el(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function load() {
  const status = el('status');
  const { apiBase } = await chrome.storage.sync.get(['apiBase']);
  if (!apiBase) {
    status.className = 'error';
    status.textContent = 'Backend not configured yet -- set it in the extension Options page first.';
    return;
  }

  status.textContent = 'Loading…';
  status.className = '';

  try {
    // /api/candidates/search has no skill/location filters applied, which
    // (per buildCandidateQuery.js) matches every candidate -- no api key
    // needed either, this route is open. limit=200 in one page is plenty
    // for what this extension adds one recruiter at a time.
    const url = new URL('/api/candidates/search', apiBase);
    url.searchParams.set('limit', '200');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.candidates.length) {
      status.textContent = 'No candidates yet.';
      return;
    }

    const tbody = el('tbody');
    tbody.innerHTML = data.candidates.map((c) => {
      const we = c.workExperience[0] || {};
      const linkedinCell = c.linkedinUrl
        ? `<a href="${escapeHtml(c.linkedinUrl)}" target="_blank" rel="noopener">Profile</a>`
        : '';
      return `<tr>
        <td>${escapeHtml(c.fullName)}</td>
        <td>${escapeHtml(we.title)}</td>
        <td>${escapeHtml(we.company)}</td>
        <td>${escapeHtml(c.location)}</td>
        <td>${linkedinCell}</td>
      </tr>`;
    }).join('');

    el('table').style.display = '';
    status.textContent = `${data.total} candidate${data.total === 1 ? '' : 's'}${data.totalIsExact ? '' : ' (showing first page)'}.`;
  } catch (err) {
    status.className = 'error';
    status.textContent = `Couldn't load candidates: ${err.message}`;
  }
}

el('refreshBtn').addEventListener('click', load);
load();
