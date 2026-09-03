// Service worker: the only part of the extension that talks to the Curatal
// backend. Keeping both API calls here (rather than in popup.js) means the
// API key never needs to be read by anything other than this one place.

async function getConfig() {
  const { apiBase, apiKey } = await chrome.storage.sync.get(['apiBase', 'apiKey']);
  return { apiBase, apiKey };
}

async function checkCandidate({ name, company }) {
  const { apiBase, apiKey } = await getConfig();
  if (!apiBase || !apiKey) {
    return { error: 'not_configured' };
  }
  const url = new URL('/api/candidates/match', apiBase);
  url.searchParams.set('name', name);
  if (company) url.searchParams.set('company', company);

  const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
  if (!res.ok) {
    return { error: `backend_error_${res.status}` };
  }
  return res.json();
}

async function uploadCandidate({ fullName, company, title, linkedinUrl, pdfDataUrl, pdfFilename }) {
  const { apiBase, apiKey } = await getConfig();
  if (!apiBase || !apiKey) {
    return { error: 'not_configured' };
  }

  const formData = new FormData();
  formData.append('fullName', fullName);
  if (company) formData.append('company', company);
  if (title) formData.append('title', title);
  if (linkedinUrl) formData.append('linkedinUrl', linkedinUrl);
  if (pdfDataUrl) {
    // The popup can't hand a File object across the runtime.sendMessage
    // boundary, so it sends the file as a data URL and this reconstitutes
    // it into a real Blob for the multipart body.
    const blob = await (await fetch(pdfDataUrl)).blob();
    formData.append('pdf', blob, pdfFilename || 'profile.pdf');
  }

  const url = new URL('/api/candidates', apiBase);
  const res = await fetch(url, { method: 'POST', headers: { 'x-api-key': apiKey }, body: formData });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { error: body.error || `backend_error_${res.status}` };
  }
  return body;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CHECK_CANDIDATE') {
    checkCandidate(message.payload).then(sendResponse);
    return true;
  }
  if (message.type === 'UPLOAD_CANDIDATE') {
    uploadCandidate(message.payload).then(sendResponse);
    return true;
  }
  return false;
});
