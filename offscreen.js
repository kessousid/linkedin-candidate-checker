// Runs inside the offscreen document (see background.js's
// ensureOffscreenDocument()). This exists for exactly one reason: MV3
// service workers cannot fetch() file:// URLs at all -- a hard Chrome
// platform restriction, not something "Allow access to file URLs" changes.
// An offscreen document is a real page context (like a hidden tab), so it
// can. background.js hands off the actual file read to this file instead
// of trying to do it itself.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'READ_FILE_URL') return false;

  (async () => {
    try {
      const res = await fetch(message.url);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      sendResponse({ ok: true, dataUrl });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();

  return true; // async response
});
