async function load() {
  const { apiBase, apiKey } = await chrome.storage.sync.get(['apiBase', 'apiKey']);
  if (apiBase) document.getElementById('apiBase').value = apiBase;
  if (apiKey) document.getElementById('apiKey').value = apiKey;
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  const status = document.getElementById('status');
  const apiBaseRaw = document.getElementById('apiBase').value.trim().replace(/\/+$/, '');
  const apiKey = document.getElementById('apiKey').value.trim();

  let origin;
  try {
    origin = new URL(apiBaseRaw).origin;
  } catch {
    status.textContent = 'Enter a valid URL, e.g. https://your-app.up.railway.app';
    return;
  }
  if (!apiKey) {
    status.textContent = 'API key is required.';
    return;
  }

  // The backend origin is user-supplied, so it's requested as an optional
  // permission at save time rather than baked into manifest.json's
  // host_permissions -- the extension only ever holds a grant for the one
  // origin actually configured.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    status.textContent = 'Permission to reach that URL was not granted, so it was not saved.';
    return;
  }

  await chrome.storage.sync.set({ apiBase: origin, apiKey });
  status.textContent = 'Saved.';
});

load();
