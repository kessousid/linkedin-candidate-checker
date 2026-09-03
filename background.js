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

// Converts a downloaded file's bytes into a data URL without FileReader --
// FileReader is a Window API and isn't reliably available in an MV3 service
// worker; Blob.arrayBuffer() + btoa() is. Chunked to avoid blowing the call
// stack on String.fromCharCode.apply for a multi-hundred-KB PDF.
async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || 'application/pdf'};base64,${btoa(binary)}`;
}

// chrome.downloads gives back a native OS path (e.g.
// "C:\Users\name\Downloads\file.pdf" on Windows), not a URL.
function nativePathToFileUrl(nativePath) {
  const normalized = nativePath.replace(/\\/g, '/');
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `file://${encodeURI(withLeadingSlash)}`;
}

// Triggers LinkedIn's own Save-to-PDF (via the content script's real click
// sequence), watches chrome.downloads for the resulting file, waits for it
// to finish, and reads its bytes directly -- no manual "choose file" step.
// Lives in the background service worker (not popup.js) specifically so it
// keeps running even if the popup closes while the download is in flight
// (popups close on almost any outside click, and a download can take a
// few seconds).
//
// Correlating "this specific download" is a heuristic, not a guarantee:
// chrome.downloads.onCreated fires for every download in the browser, so
// this accepts the first one that both starts after the trigger and looks
// like a PDF. Reading the file needs "Allow access to file URLs" enabled
// for this extension (chrome://extensions -> Details) -- Chrome does not
// let an extension grant that to itself, so the caller must surface a
// clear fallback (manual file picker) when the file:// fetch fails.
async function downloadAndReadPdf(tabId) {
  const triggerTime = Date.now() - 1000; // buffer for clock/event-loop skew

  let triggerResult;
  try {
    triggerResult = await chrome.tabs.sendMessage(tabId, { type: 'TRIGGER_SAVE_TO_PDF' });
  } catch (err) {
    return { error: 'trigger_failed', message: String(err) };
  }
  if (!triggerResult.ok) {
    return { error: 'trigger_failed', step: triggerResult.step };
  }

  const downloadId = await new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      chrome.downloads.onCreated.removeListener(onCreated);
      resolve(null);
    }, 20000);
    function onCreated(item) {
      const startedAfterTrigger = !item.startTime || new Date(item.startTime).getTime() >= triggerTime;
      const looksLikePdf = item.mime === 'application/pdf' || /\.pdf$/i.test(item.filename || '');
      if (!startedAfterTrigger || !looksLikePdf) return;
      clearTimeout(timeoutId);
      chrome.downloads.onCreated.removeListener(onCreated);
      resolve(item.id);
    }
    chrome.downloads.onCreated.addListener(onCreated);
  });

  if (downloadId == null) {
    return { error: 'download_not_detected' };
  }

  await new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve();
    }, 20000);
    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        clearTimeout(timeoutId);
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve();
      }
    }
    chrome.downloads.onChanged.addListener(onChanged);
  });

  const [item] = await chrome.downloads.search({ id: downloadId });
  if (!item || item.state !== 'complete') {
    return { error: 'download_incomplete' };
  }

  try {
    const res = await fetch(nativePathToFileUrl(item.filename));
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const blob = await res.blob();
    const dataUrl = await blobToDataUrl(blob);
    return { ok: true, dataUrl, filename: item.filename.split(/[\\/]/).pop() };
  } catch (err) {
    // The overwhelmingly common cause: "Allow access to file URLs" isn't
    // enabled for this extension yet. The file did download successfully
    // (chrome://downloads has it) -- this is purely a read-it-back failure.
    return { error: 'file_read_failed', message: String(err) };
  }
}

// Runs the whole "download the PDF, then upload the candidate" sequence in
// one call, entirely inside this service worker. This is deliberate, not
// just convenient: a download takes several seconds, and Chrome closes the
// popup the instant it loses focus -- which happens the moment its own
// download notification bubble appears over the toolbar. Splitting this
// across two round trips (popup awaits the download, *then* separately
// calls upload) meant the popup routinely got killed by that focus loss
// before it ever reached the upload call, silently dropping the candidate
// on the floor even though the download itself succeeded every time.
// Keeping both steps in one background-owned async function means the
// upload still happens even if the popup that kicked it off is long gone.
async function downloadAndUploadCandidate({ tabId, fullName, company, title, linkedinUrl }) {
  const downloadResult = await downloadAndReadPdf(tabId);
  if (!downloadResult.ok) {
    return downloadResult;
  }
  const uploadResult = await uploadCandidate({
    fullName,
    company,
    title,
    linkedinUrl,
    pdfDataUrl: downloadResult.dataUrl,
    pdfFilename: downloadResult.filename,
  });
  if (uploadResult.error) {
    return uploadResult;
  }
  return { ok: true, filename: downloadResult.filename, ...uploadResult };
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
  if (message.type === 'DOWNLOAD_AND_UPLOAD_CANDIDATE') {
    downloadAndUploadCandidate(message.payload).then(sendResponse);
    return true;
  }
  return false;
});
