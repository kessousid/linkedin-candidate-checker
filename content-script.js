// Runs on https://www.linkedin.com/in/* (declared in manifest.json), and is
// also re-injected on demand by popup.js via chrome.scripting.executeScript
// before every message it sends. That second path is required, not
// redundant: LinkedIn is a single-page app, so navigating to a profile from
// elsewhere in LinkedIn (e.g. clicking your own name from the feed) doesn't
// fire a real page load -- Chrome only auto-injects declarative
// content_scripts on real navigations, so the declarative injection above
// silently never happens for that case. The guard below makes re-injection
// safe (skips re-adding the message listener) instead of doubling up.
if (!window.__curatalContentScriptLoaded) {
  window.__curatalContentScriptLoaded = true;
  initCuratalContentScript();
}

function initCuratalContentScript() {

// LinkedIn's DOM is not a stable public API -- class names are largely
// hashed/generated and shift over time. The selectors below are written to
// degrade gracefully (multiple fallbacks, never throw) rather than assume
// permanence; if LinkedIn changes its markup, scrapeProfile() should start
// returning nulls instead of breaking the extension outright, which is the
// signal that this file needs an update.

function textOf(el) {
  return el ? el.textContent.trim().replace(/\s+/g, ' ') : null;
}

// Only elements with no element children ("leaf-ish"), and short text at
// that, are worth pattern-matching -- LinkedIn nests containers many levels
// deep, so an ancestor div's `textContent` is the concatenation of
// everything inside it (the whole top card, half the activity feed, etc.),
// not just the one line it visually renders. Verified live: without this
// filter, a naive `main div, main span` scan matches the *first* "at"
// inside one of those giant concatenated strings and then greedily
// swallows the rest of the page as the "company".
function leafTextNodes(root) {
  return Array.from(root.querySelectorAll('*'))
    .filter((el) => el.children.length === 0)
    .map(textOf)
    .filter((t) => t && t.length < 150);
}

function scrapeName() {
  const main = document.querySelector('main') || document;
  // LinkedIn's current profile layout has no <h1> at all -- the name is the
  // first <h2> inside <main>. h1 is tried first in case an older/different
  // layout uses it; verified live that the h2 fallback is what actually
  // fires today.
  const heading = main.querySelector('h1') || main.querySelector('h2');
  return textOf(heading);
}

// Parses the top-card headline ("Title at Company"), which LinkedIn shows
// for anyone with a current position regardless of whether the fuller
// Experience section has rendered/loaded. Takes the first match, since the
// top card renders before the activity feed (which can contain other
// people's "X at Y"-shaped headlines further down the DOM).
function scrapeCurrentEmployer() {
  const main = document.querySelector('main') || document;
  for (const text of leafTextNodes(main)) {
    const match = /^(.+?)\s+at\s+(.+)$/i.exec(text);
    if (match) {
      return { title: match[1].trim(), company: match[2].trim() };
    }
  }
  return { title: null, company: null };
}

function scrapeProfile() {
  const { title, company } = scrapeCurrentEmployer();
  return {
    fullName: scrapeName(),
    company,
    title,
    linkedinUrl: window.location.href.split('?')[0],
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SCRAPE_PROFILE') {
    sendResponse(scrapeProfile());
    return false;
  }
  return false;
});

}
