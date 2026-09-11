// Service worker: the only part of the extension that talks to the backend.
// Keeping tokens here (rather than in popup.js/search-content-script.js)
// means they never need to be read by anything other than this one place.
//
// The backend moved off Curatal Dev onto the staging environment (that
// host isn't configurable anywhere in this extension) -- as a signed-in
// Platform Admin (Keycloak email+password login, the same
// _login/_refresh-token shape CuratalApp's own client uses for candidates:
// src/api/client.ts, src/api/environment.ts), not a plain shared API key
// against a throwaway clone. Platform Admin specifically (not Recruiter)
// -- confirmed live against C:\CuratalIT's source, it's the one role
// accepted by both accounts_service's isrecruiterAuthorized()
// (LOOKUP/ADD/MISSING_LINKEDIN_PATH below) and pca_service's
// isPcaAndPlatformAdminAuthorized()/canAccessCandidateProfile()
// (PCA_*_PATH below, which writes the backfill's resolved LinkedIn URL
// back onto the candidate's own profile).
const API_HOST = 'https://staging.curatal.com';
// Login goes through the separate recruiter_service (confirmed live: its
// validation error names /home/ubuntu/curatal_backend/recruiter_service/...),
// not the candidate-oriented accounts_service _login this used before --
// recruiter_service's own login only rejects a 'Candidate' role, so a
// Platform Admin account logs in here too, same endpoint.
const LOGIN_PATH = '/api/v1/recruiter/login';
const REFRESH_TOKEN_PATH = '/api/v1/refresh-token';
// The extension goes through the KrakenD gateway now, not accounts_service's
// own /curatal_account prefix (per the team's routing table: KrakenD's
// external path for these three is bare /api/v1/..., which it forwards
// internally as backend path /v1/accounts/candidate/sourced/...). Confirmed
// live on staging.curatal.com -- a real 401 across GET/POST with no body/
// rate-limit headers, consistent with KrakenD doing its own JWT check before
// forwarding to accounts_service (an earlier 502 Bad Gateway on this same
// path family, before the KrakenD side came up, is gone as of this check).
const LOOKUP_PATH = '/api/v1/accounts/candidate/sourced/lookup';
const ADD_PATH = '/api/v1/accounts/candidate/sourced';
const MISSING_LINKEDIN_PATH = '/api/v1/accounts/candidate/sourced/missing-linkedin';

// Writes the bulk-backfill crawl's resolved LinkedIn URL back onto the
// candidate's own Curatal profile (Social Media Links section) -- a
// completely different backend service (pca_service) from the three paths
// above (accounts_service). On Curatal Dev this went through pca_service's
// own gateway prefix (/curatal_pca/api/v1/pca/getProfile/byEmail,
// PATCH .../updateProfile/:candidateId) -- staging goes through KrakenD
// instead, at different paths, confirmed live by driving the actual PCA
// Admin UI (staging.curatal.com/app/pca_admin/search-candidates ->
// Profile Information -> Save) and reading the real requests it made
// (performance.getEntriesByType('resource'), since neither was a plain
// 401/400 to eyeball): POST /api/v1/pca/profile/byEmail, PATCH
// /api/v1/pca/update/profile/:candidateId -- same shape as the portal
// frontend's own ApiUrls.js (pcaGetProfileByEmail, pcaCandidateProfileUpdate).
// Both endpoints require the logged-in account's JWT to carry a PCA Admin/
// PCA Agent/Platform Admin realm role -- a plain Recruiter login can't call
// these. isrecruiterAuthorized() on the three accounts_service paths above
// accepts Platform Admin too, so logging in as Platform Admin (not
// Recruiter) covers everything with one login.
const PCA_GET_PROFILE_BY_EMAIL_PATH = '/api/v1/pca/profile/byEmail';
const PCA_UPDATE_PROFILE_PATH = '/api/v1/pca/update/profile';

const ACCESS_TOKEN_KEY = 'curatal_access_token';
const REFRESH_TOKEN_KEY = 'curatal_refresh_token';
const RECRUITER_EMAIL_KEY = 'curatal_recruiter_email';

async function getSession() {
  const stored = await chrome.storage.local.get([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, RECRUITER_EMAIL_KEY]);
  return {
    accessToken: stored[ACCESS_TOKEN_KEY],
    refreshToken: stored[REFRESH_TOKEN_KEY],
    email: stored[RECRUITER_EMAIL_KEY],
  };
}

async function storeTokens({ access_token, refresh_token }, email) {
  const toStore = { [ACCESS_TOKEN_KEY]: access_token, [REFRESH_TOKEN_KEY]: refresh_token };
  if (email) toStore[RECRUITER_EMAIL_KEY] = email;
  await chrome.storage.local.set(toStore);
}

async function clearSession() {
  await chrome.storage.local.remove([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, RECRUITER_EMAIL_KEY]);
}

async function login(email, password) {
  const res = await fetch(new URL(LOGIN_PATH, API_HOST), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { error: body.message || body.error || `login_failed_${res.status}` };
  }
  await storeTokens(body, email);
  return { ok: true };
}

async function refreshAccessToken() {
  const { refreshToken } = await getSession();
  if (!refreshToken) return null;
  try {
    const res = await fetch(new URL(REFRESH_TOKEN_PATH, API_HOST), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) throw new Error(`refresh_failed_${res.status}`);
    const body = await res.json();
    await storeTokens(body);
    return body.access_token;
  } catch {
    await clearSession();
    return null;
  }
}

// 401-retry-with-refresh-token, same shape as CuratalApp's own axios
// interceptor (src/api/client.ts) -- one retry with a fresh access token,
// then give up and clear the session so the options page prompts a
// re-login rather than every subsequent call silently failing.
async function apiFetch(path, options = {}) {
  const { accessToken } = await getSession();
  if (!accessToken) {
    return { error: 'not_logged_in' };
  }

  const doFetch = (token) => fetch(new URL(path, API_HOST), {
    ...options,
    // The gateway briefly served a 200 HTML fallback for these paths before
    // its routing rule was added (confirmed live). If a browser ever cached
    // that response for a given URL+method, 'default' cache mode would keep
    // replaying it locally even after the server-side fix -- 'no-store'
    // guarantees every call actually reaches the network.
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  let res;
  try {
    res = await doFetch(accessToken);
    if (res.status === 401) {
      const newToken = await refreshAccessToken();
      if (!newToken) return { error: 'not_logged_in' };
      res = await doFetch(newToken);
    }
  } catch (err) {
    // fetch() itself throws on a true network failure (DNS, connection
    // refused, offline) -- this used to be uncaught, which for the bulk
    // crawler meant processNextBulkCandidate's promise just rejected
    // silently (caught only by the top-level .catch(console.error) on the
    // alarm listener), leaving bulkState stuck at "running" forever with no
    // error ever shown in the UI.
    return { error: `network_error: ${(err && err.message) || err}` };
  }

  // Read as text first, not res.json() directly -- a gateway that doesn't
  // recognize this path can return 200 with an HTML fallback page (e.g.
  // serving the frontend app for any unmatched route) instead of a real
  // 404, which used to silently collapse into an empty {} body via
  // res.json().catch(() => ({})) and surface as an unhelpful generic
  // "missing_linkedin_fetch_failed" with no way to tell what actually
  // came back.
  const rawText = await res.text().catch(() => '');
  let body;
  try {
    body = rawText ? JSON.parse(rawText) : {};
  } catch {
    const snippet = rawText.slice(0, 200).replace(/\s+/g, ' ').trim();
    return { error: `non_json_response_${res.status}: ${snippet || '(empty body)'}` };
  }
  if (!res.ok) {
    return { error: body.error || body.message || `backend_error_${res.status}` };
  }
  return body;
}

async function checkCandidate({ fullName, phone, email, linkedinUrl }) {
  // linkedinUrl is now the primary lookup key -- a LinkedIn profile is
  // enough on its own to check, since (unlike a phone number) it can't
  // collide with an unrelated candidate. phone/email remain optional
  // secondary signals; at least one identifier of any kind is still
  // required (the real endpoint's validation enforces this too, not just
  // this client).
  if (!phone && !email && !linkedinUrl) return { error: 'identifier_required' };
  return apiFetch(LOOKUP_PATH, {
    method: 'POST',
    body: JSON.stringify({ fullName, phone, email, linkedinUrl }),
  });
}

async function uploadCandidate({ fullName, phone, email, currentCompany, linkedinUrl, pdfDataUrl }) {
  if (!phone) return { error: 'phone_required' };
  // pdfDataUrl is accepted here (popup.js still builds one) but not
  // forwarded -- the real accounts service has no resume-attachment path
  // wired up for sourced candidates yet, that's a separate, larger piece
  // of work involving S3 upload middleware, out of scope for now. Sending
  // it would also just fail the endpoint's Joi validation (unknown key).
  void pdfDataUrl;
  return apiFetch(ADD_PATH, {
    method: 'POST',
    body: JSON.stringify({ fullName, phone, email, currentCompany, linkedinUrl }),
  });
}

async function getPcaProfileByEmail(email) {
  return apiFetch(PCA_GET_PROFILE_BY_EMAIL_PATH, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

// Fetches the candidate's LIVE profile right before writing (not the
// possibly-stale missing-linkedin snapshot the batch was built from -- a
// batch can sit around for a while, and someone else could have already
// filled this in by then) and only PATCHes if linkedin_url is still
// actually empty, per instruction: never overwrite an existing value.
// The update endpoint does a raw field-by-field DB write, not a merge
// (confirmed live in pca_service's profile.service.js -- updateProfileData
// builds the social-links row straight from whatever's in the request
// body) -- sending only linkedin_url would blank out github_url/
// twitter_url/etc. for anyone who already has those set, so the full
// current profile_information block is resent unchanged apart from
// linkedin_url, same as CuratalApp's own profile form always does.
async function attachLinkedinUrlIfMissing(email, linkedinUrl) {
  if (!email) return { error: 'no_email_on_file' };

  const profileResult = await getPcaProfileByEmail(email);
  if (profileResult.error) return { error: profileResult.error };
  const candidateId = profileResult.data?.personal_information?.candidate_id;
  if (!candidateId) return { error: 'candidate_id_missing' };

  const existing = profileResult.data?.profile_information || {};
  if (existing.linkedin_url) return { skipped: true, existingUrl: existing.linkedin_url };

  const patchResult = await apiFetch(`${PCA_UPDATE_PROFILE_PATH}/${candidateId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      profile_information: {
        profile_heading: existing.profile_heading || '',
        linkedin_url: linkedinUrl,
        github_url: existing.github_url || '',
        youtube_url: existing.youtube_url || '',
        fb_url: existing.fb_url || '',
        insta_url: existing.insta_url || '',
        kaggle_url: existing.kaggle_url || '',
        twitter_url: existing.twitter_url || '',
        website_url: existing.website_url || '',
      },
    }),
  });
  if (patchResult.error) return { error: patchResult.error };
  return { saved: true };
}

const BULK_CURSOR_KEY = 'bulkBackfillCursor';

async function fetchMissingLinkedinCandidates(limit, after) {
  return apiFetch(`${MISSING_LINKEDIN_PATH}?limit=${limit}&after=${after || 0}`, { method: 'GET' });
}

async function getBulkCursor() {
  const stored = await chrome.storage.local.get([BULK_CURSOR_KEY]);
  return stored[BULK_CURSOR_KEY] || 0;
}

async function setBulkCursor(value) {
  await chrome.storage.local.set({ [BULK_CURSOR_KEY]: value });
}

// LinkedIn flagged this account for automated profile access after an
// unattended overnight run (a real security checkpoint, not just a
// rate-limit page). Rather than a short cooldown between bursts of
// back-to-back activity, a whole batch is paced across BULK_SPREAD_DURATION_MS
// -- randomized gaps averaging a few candidates an hour, not a script
// hammering through 25 people in minutes. That pacing IS the safety
// mechanism now (replacing an earlier, stricter "2 batches per 15 minutes"
// cooldown that also just disabled Automatic mode outright), which is why
// Automatic mode is safe to leave enabled below.
const BULK_SPREAD_DURATION_MS = 12 * 60 * 60 * 1000;
const BULK_ALARM_NAME = 'bulkBackfillNextCandidate';

// The very first candidate of a freshly (re)started batch fires quickly --
// reads as someone clicking Start and it actually doing something, not a
// dead page. Every candidate after that is what actually gets spread across
// BULK_SPREAD_DURATION_MS: average gap = duration / (batchSize - 1) so the
// last candidate lands near the end of the window, randomized +-50% so
// consecutive gaps don't look machine-timed.
function bulkFirstCandidateDelayMs() {
  return 3000 + Math.random() * 12000;
}

function bulkNextCandidateDelayMs(batchSize) {
  const gaps = Math.max(batchSize - 1, 1);
  const avgGapMs = BULK_SPREAD_DURATION_MS / gaps;
  return avgGapMs * (0.5 + Math.random());
}

// bulkState otherwise lives only in the service worker's memory -- and with
// candidates now spread minutes-to-hours apart, the worker WILL be killed by
// Chrome and restarted between almost every single one (MV3 workers die
// after ~30s idle regardless of scheduled future work). This single storage
// key is the actual source of truth the whole run resumes from on every
// wake-up, not just a display snapshot for after a reload.
const BULK_RUN_STATE_KEY = 'bulkBackfillRunState';

function defaultBulkRunState() {
  return {
    running: false, stopRequested: false, mode: 'sweep', candidates: [], queue: [],
    processedCount: 0, total: 0, cursor: 0, limit: 25, autoContinue: false,
    batchesRun: 0, totalMatched: 0, totalNoMatch: 0, totalErrors: 0,
    sweepComplete: false, lastError: null, nextRunAt: null,
  };
}

async function getBulkRunState() {
  const stored = await chrome.storage.local.get([BULK_RUN_STATE_KEY]);
  return stored[BULK_RUN_STATE_KEY] || defaultBulkRunState();
}

// The results table only ever shows the CURRENT/last batch (bulkState.candidates
// gets replaced wholesale on every new batch fetch) -- an autoContinue run left
// going overnight would otherwise leave no way to see who was actually matched
// across the whole sweep once morning's batch has scrolled everything else off.
// Appended once per candidate, across every batch, until the next "Reset to
// first batch" click clears it back out alongside the cursor.
const BULK_ALL_RESULTS_KEY = 'bulkBackfillAllResults';

async function appendToBulkReport(candidate) {
  const stored = await chrome.storage.local.get([BULK_ALL_RESULTS_KEY]);
  const rows = stored[BULK_ALL_RESULTS_KEY] || [];
  rows.push({
    fullName: candidate.fullName,
    phone: candidate.phone,
    email: candidate.email,
    currentCompany: candidate.currentCompany,
    status: candidate.status,
    detail: candidate.detail,
  });
  await chrome.storage.local.set({ [BULK_ALL_RESULTS_KEY]: rows }).catch(() => {});
}

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[.,()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Common trailing/legal words that carry no identifying information on
// their own -- skipped when picking out a company's distinctive word so
// "Extrieve Technologies PVT Ltd." resolves to "extrieve", not "pvt".
// Deliberately not relied on as an exhaustive strip-list (an earlier
// version tried that -- it only works for suffixes someone thought to add
// in advance); this is just which words to skip over while scanning left
// to right for the first real one.
const COMPANY_GENERIC_WORDS = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'llc', 'inc', 'incorporated', 'corp', 'corporation',
  'co', 'company', 'technologies', 'technology', 'solutions', 'solution', 'systems', 'system',
  'services', 'service', 'group', 'india', 'international', 'global', 'the', 'and',
]);

// A company's identifying word is normally the one it leads with --
// "Extrieve" in "Extrieve Technologies PVT Ltd.", "Curatal" in "CURATAL
// Talent Solutions Pvt Ltd" -- so this scans left to right for the first
// word that isn't generic/legal boilerplate and isn't too short to be
// meaningful on its own, rather than depending on stripping out every
// possible suffix in advance.
function companyCoreToken(company) {
  const words = normalizeForMatch(company).split(' ').filter(Boolean);
  const distinctive = words.find((w) => w.length >= 3 && !COMPANY_GENERIC_WORDS.has(w));
  return distinctive || words[0] || '';
}

// Whether the target company shows up anywhere in a profile's full
// Experience section text -- past roles included, not just the current
// one -- rather than requiring it to be their single most-current listed
// position (which parsing the search-results headline was limited to).
// Partial/substring, deliberately: "Extrieve" in the experience text is
// enough to count as a match for "Extrieve Technologies PVT Ltd." in
// Curatal, not an exact full-string match.
// Substring matching works well for longer distinctive words ("extrieve"
// can only mean one thing), but a short acronym like "ey" or "ge" would
// spuriously match inside ordinary words ("th[ey]", "mon[ey]", "ur[ge]") --
// so short tokens are matched on a word boundary instead of as a plain
// substring, rather than being rejected outright (the old `length < 3`
// guard silently made two-letter companies like "EY" unmatchable).
function containsToken(normalizedText, token) {
  if (!token || token.length < 2) return false;
  if (token.length <= 3) return new RegExp(`\\b${token}\\b`).test(normalizedText);
  return normalizedText.includes(token);
}

function experienceContainsCompany(experienceText, company) {
  return containsToken(normalizeForMatch(experienceText), companyCoreToken(company));
}

// Same "leading distinctive word" idea as companyCoreToken, tuned for
// institution names -- "Birla" out of "Birla Institute of Technology and
// Science, Pilani", "Noida" out of "Noida Institute of Engineering &
// Technology". Curatal's education field can list more than one
// institution per candidate (all their degrees, joined with " | "), so the
// caller checks each one separately against a single LinkedIn profile's
// listed education.
const EDU_GENERIC_WORDS = new Set([
  'institute', 'institution', 'university', 'college', 'school', 'of', 'technology', 'technologies',
  'the', 'and', 'engineering', 'science', 'sciences', 'management', 'studies', 'india', 'national',
  'international', 'academy', 'polytechnic', 'education',
]);

function institutionCoreToken(name) {
  const words = normalizeForMatch(name).split(' ').filter(Boolean);
  const distinctive = words.find((w) => w.length >= 3 && !EDU_GENERIC_WORDS.has(w));
  return distinctive || words[0] || '';
}

// Curatal's education field lists every institution a candidate attended
// (schools included), " | "-joined, in no consistent order -- sometimes
// the degree-granting college/university comes first, sometimes last. For
// disambiguating a common name, a K-12 school ("Kendriya Vidyalaya",
// "St. Xavier's Public School") is far less distinctive than the college,
// since thousands of unrelated people share the same school chain -- so
// prefer whichever listed institution reads as higher education, falling
// back to the longest (most specific-sounding) name if none obviously do.
function pickPrimaryInstitution(educationField) {
  const institutions = String(educationField || '').split('|').map((s) => s.trim()).filter(Boolean);
  if (!institutions.length) return null;
  const higherEd = institutions.filter(
    (inst) => /university|institute|college|iit|iim|nit\b|polytechnic/i.test(inst) && !/school|vidyalaya|vidya mandir/i.test(inst),
  );
  const pool = higherEd.length ? higherEd : institutions;
  return pool.reduce((best, cur) => (cur.length > best.length ? cur : best), pool[0]);
}

// Used as a fallback when the experience/company check can't confirm a
// match -- e.g. Curatal's data is a stale employer, or the person's
// LinkedIn headline is out of date -- checking whether any of Curatal's
// on-file institutions for this candidate show up in the profile's
// Education section instead.
function educationContainsInstitution(educationText, educationField) {
  if (!educationField) return false;
  const normalizedText = normalizeForMatch(educationText);
  if (!normalizedText) return false;
  return String(educationField).split('|').some((institution) => containsToken(normalizedText, institutionCoreToken(institution)));
}

// A single word matches any word it's an exact initial for ("d" for
// "dhanavel") -- common in South Indian records where Curatal has only a
// father's-name initial on file where LinkedIn shows it spelled out.
// Anything longer must match exactly -- this is an initial-expansion
// check, not a fuzzy one.
function wordMatches(shortWord, longWord) {
  if (shortWord === longWord) return true;
  if (shortWord.length === 1) return longWord.startsWith(shortWord);
  return false;
}

// True when shorterWords, word for word (each via wordMatches), forms a
// leading prefix of longerWords -- i.e. the shorter name is the longer
// name with some trailing words (or an initial) missing, not just any
// shared words in any position.
function namePrefixMatches(shorterWords, longerWords) {
  if (!shorterWords.length || shorterWords.length > longerWords.length) return false;
  return shorterWords.every((w, i) => wordMatches(w, longerWords[i]) || wordMatches(longerWords[i], w));
}

function namesMatch(a, b) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // LinkedIn display names occasionally run two words of a compound name
  // together with no space ("DineshReddy Gujjula" for Curatal's "Dinesh
  // Reddy Gujjula") -- comparing with all whitespace stripped catches that
  // without loosening this into a partial/substring match.
  if (na.replace(/ /g, '') === nb.replace(/ /g, '')) return true;
  // Curatal sometimes has less name than the real profile does -- a
  // first-name-only record (DB "Aayatri" vs LinkedIn "Aayatri Bhowmick"),
  // a truncated one (DB "Kathyayani Lakshmi" vs "Kathyayani Lakshmi
  // Yamini Karri"), or a father's-name initial where LinkedIn spells it
  // out (DB "Tamilselvan D" vs "Tamilselvan Dhanavel"). None of these mean
  // either side is "wrong" -- there's just less data in Curatal. Accept
  // when one side's words are, in order, a prefix of the other's (each
  // word exact or a valid initial) -- still a real, ordered signal, not a
  // loose word-overlap check -- and leave resolveNameMatch's company/
  // education verification to confirm it rather than trusting the name
  // alone.
  const aWords = na.split(' ');
  const bWords = nb.split(' ');
  return namePrefixMatches(aWords, bWords) || namePrefixMatches(bWords, aWords);
}

// Tie-breaker used only when experience/education still leave more than
// one candidate standing -- Curatal's location field is "city,country"
// (e.g. "Gwalior,India"), while LinkedIn's search-result location line is
// typically "city, state, country"; comparing on city alone (the part
// before the first comma) is the reliable common ground between the two
// formats. Read straight off the search-results card, so this costs no
// extra profile visit.
function locationsMatch(profileLocation, dbLocation) {
  if (!profileLocation || !dbLocation) return false;
  const dbCity = String(dbLocation).split(',')[0].trim();
  if (dbCity.length < 3) return false;
  return normalizeForMatch(profileLocation).includes(normalizeForMatch(dbCity));
}

// A plain "Full Name" search returns everyone LinkedIn has with that name,
// ranked by its own relevance/network signals -- for a common name the
// actual Curatal candidate can easily rank past the crawl's per-candidate
// visit budget (BATCH_SIZE * MAX_BATCHES in resolveNameMatch) and never get
// checked at all. Folding company/education into the search keywords --
// confirmed live: LinkedIn's People search matches against full
// Experience/Education text, not just the headline -- lets LinkedIn's own
// index do that narrowing before any batching starts.
//
// Uses the FULL company/institution string, not the short "core token"
// used later to check page text (e.g. "minuscule" out of "Minuscule
// Technologies Pvt. LTD.") -- confirmed live, the bare token barely
// changes LinkedIn's ranking while the full phrase does. Company and
// education are tried as SEPARATE queries, not one combined query --
// confirmed live these can pull in opposite directions on the same field
// of candidates: for one name, company+education combined nailed the
// single right profile while company alone buried it under a huge
// employer's other people; for another, company alone nailed it while
// adding education diluted the query enough that the right profile fell
// out of the results entirely.
//
// The NAME portion is quoted first (an exact-phrase match) when Curatal's
// name has no bare initial -- confirmed live, leaving a normal name
// unquoted also matches partial/prefix variants ("Hitesh K.", "Hitesh
// Kumar Jha") that can flood the pool with unrelated people sharing a
// common name. But quoting is skipped -- not just deprioritized, skipped
// -- whenever Curatal's name has a single-letter word (e.g. "Tamilselvan
// D" for a father's-name initial): quoting that phrase excludes the
// person's real, spelled-out surname outright, since "D" as a literal
// phrase token never matches "Dhanavel". An unquoted attempt of every
// combo is always tried too (after the quoted ones, when both run) --
// confirmed live this is also what's needed when LinkedIn's own profile
// runs two of Curatal's separately-spaced words together
// ("Dinesh Reddy Gujjula" in Curatal vs "DineshReddy Gujjula" as
// displayed), which an exact-phrase quoted search can't bridge either.
//
// A tier is trusted (used as-is, no further tiers tried) once it returns
// a small-enough, non-empty pool -- small enough that resolveNameMatch's
// batch cap can actually check all of it -- since that's a real precision
// signal, not just "found something". Noisier tiers get merged into an
// accumulating pool instead of discarded, so a name that never finds a
// small pool anywhere still ends up with the union of everything tried.
const SMALL_POOL_MAX = 6;

function fullNameHasInitial(fullName) {
  const words = String(fullName || '').trim().split(/\s+/);
  return words.some((w, i) => i > 0 && w.length === 1);
}

function buildSearchTiers(candidate) {
  const institution = candidate.education ? pickPrimaryInstitution(candidate.education) : null;
  const tiers = [];
  const addCombosFor = (nameKeyword) => {
    if (candidate.currentCompany && institution) tiers.push(`${nameKeyword} ${candidate.currentCompany} ${institution}`);
    if (candidate.currentCompany) tiers.push(`${nameKeyword} ${candidate.currentCompany}`);
    if (institution) tiers.push(`${nameKeyword} ${institution}`);
  };

  if (!fullNameHasInitial(candidate.fullName)) {
    addCombosFor(`"${candidate.fullName}"`);
  }
  addCombosFor(candidate.fullName);
  tiers.push(candidate.fullName);
  return tiers;
}

async function searchCandidateProfiles(tab, candidate) {
  const tiers = buildSearchTiers(candidate);
  const merged = [];
  const seenUrls = new Set();
  let rawCardsSeen = false;

  for (let i = 0; i < tiers.length; i += 1) {
    if (bulkState.stopRequested) break;
    if (i > 0) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(1500 + Math.random() * 1000);
    }
    // eslint-disable-next-line no-await-in-loop
    const cards = await searchLinkedIn(tab, tiers[i]);
    if (cards.length > 0) rawCardsSeen = true;
    const tierMatches = cards.filter((card) => namesMatch(card.name, candidate.fullName));

    if (tierMatches.length >= 1 && tierMatches.length <= SMALL_POOL_MAX) {
      return { nameMatches: tierMatches, rawCardsSeen };
    }
    for (let j = 0; j < tierMatches.length; j += 1) {
      if (!seenUrls.has(tierMatches[j].linkedinUrl)) {
        seenUrls.add(tierMatches[j].linkedinUrl);
        merged.push(tierMatches[j]);
      }
    }
  }

  return { nameMatches: merged, rawCardsSeen };
}

// Last resort when no tier above finds the right name at all. Curatal's
// stored name can run two words together where the actual LinkedIn
// profile splits them ("Veermatam" in Curatal vs "Veer Matam" as
// displayed) -- confirmed live: LinkedIn's own search does exact
// tokenized matching, not fuzzy word-boundary splitting, so a search for
// the concatenated form finds nothing even though the person is right
// there on LinkedIn. Falling back to just the first name -- the part of a
// name least likely to have this problem -- plus whatever company/
// education signal is available trades search precision for actually
// surfacing the candidate to check; firstNameMatches() below (not the
// full-name namesMatch) is what makes it safe to still count as a match
// once we're looking at the real card. Skipped when there's no company or
// education to narrow by --
// a bare first name alone is too noisy to be worth the extra request.
// Same first-word comparison as namesMatch's prefix logic (exact, or a
// single-letter initial expansion), but on the first word ALONE -- used
// only for filtering buildFirstNameFallbackKeywords' results, where the
// surname itself is exactly what's in question (a search-index quirk like
// "Veermatam"/"Veer Matam", or a plain spelling variant like "Dayan"/
// "Dayaan"). Requiring the full name to still line up via namesMatch here
// would just reintroduce the same strictness this fallback exists to route
// around; resolveNameMatch's experience/education batches are what
// actually confirm the candidate from here, same as every other tier.
function firstNameMatches(cardName, candidateFullName) {
  const cardFirst = normalizeForMatch(cardName).split(' ')[0] || '';
  const candidateFirst = normalizeForMatch(candidateFullName).split(' ')[0] || '';
  if (!cardFirst || !candidateFirst) return false;
  return wordMatches(cardFirst, candidateFirst) || wordMatches(candidateFirst, cardFirst);
}

function buildFirstNameFallbackKeywords(candidate) {
  const firstWord = String(candidate.fullName || '').trim().split(/\s+/)[0];
  if (!firstWord) return null;
  const parts = [firstWord];
  if (candidate.currentCompany) {
    parts.push(candidate.currentCompany);
  } else if (candidate.education) {
    const institution = pickPrimaryInstitution(candidate.education);
    if (institution) parts.push(institution);
  }
  return parts.length > 1 ? parts.join(' ') : null;
}

async function scrapeCurrentSearchResults(tab) {
  const [{ result: cards }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scrapeSearchResultsInPage,
  });
  return cards || [];
}

async function searchLinkedIn(tab, keywords) {
  await ensureTabAlive(tab);
  await chrome.tabs.update(tab.id, { url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}` });
  await waitForTabLoad(tab.id);
  await sleep(2500); // LinkedIn's own client-side render finishes shortly after 'complete'
  let cards = await scrapeCurrentSearchResults(tab);
  if (!cards.length) {
    // LinkedIn's client-side render can still lag behind the tab's
    // 'complete' event at this point -- confirmed live this happens when
    // it also renders a "Did you mean X?" spelling-suggestion widget above
    // the real results, an extra render step a fixed wait doesn't always
    // outlast. One retry after a longer wait before concluding there
    // really are no results, rather than reporting a false negative.
    await sleep(2500);
    cards = await scrapeCurrentSearchResults(tab);
  }
  return cards;
}

// Runs INSIDE the LinkedIn search-results tab via chrome.scripting.executeScript.
// Deliberately self-contained (no references to outer-scope functions/vars)
// since Chrome serializes this function and injects it standalone -- same
// card-extraction logic as search-content-script.js's extractCard(), kept
// as a separate copy here rather than shared, since this one has to be
// injectable on its own.
function scrapeSearchResultsInPage() {
  function textOf(node) {
    return node ? node.textContent.trim().replace(/\s+/g, ' ') : null;
  }
  function extractCard(li) {
    const degreeEl = Array.from(li.querySelectorAll('*')).find((node) => {
      if (node.children.length > 2) return false;
      return /^.+?\s*•\s*(1st|2nd|3rd\+?)$/.test(textOf(node) || '');
    });
    if (!degreeEl) return null;
    const match = /^(.+?)\s*•\s*(1st|2nd|3rd\+?)$/.exec(textOf(degreeEl));
    const name = match[1].trim();
    const nameLink = Array.from(li.querySelectorAll('a[href*="/in/"]'))
      .filter((a) => (textOf(a) || '').includes(name))
      .sort((a, b) => (textOf(a) || '').length - (textOf(b) || '').length)[0];
    const linkedinUrl = nameLink ? nameLink.href.split('?')[0] : null;
    // Verified live (same as search-content-script.js's extractCard): the
    // degree element's parent's children are exactly
    // [name+degree, headline, location], in that order.
    const siblings = degreeEl.parentElement ? Array.from(degreeEl.parentElement.children) : [];
    const idx = siblings.indexOf(degreeEl);
    const headline = idx >= 0 && siblings[idx + 1] ? textOf(siblings[idx + 1]) : null;
    const location = idx >= 0 && siblings[idx + 2] ? textOf(siblings[idx + 2]) : null;
    return { name, linkedinUrl, headline, location };
  }
  return Array.from(document.querySelectorAll('div[role="listitem"]'))
    .map(extractCard)
    .filter((card) => card && card.name && card.linkedinUrl);
}

// The profile's own Experience/Education sections only render on real,
// physical scrolling -- confirmed live it's absent from the DOM on page
// load, and setting scrollTop / dispatching wheel events / scrollIntoView()
// from injected JS all move the page but never trigger it to actually
// appear (LinkedIn's virtualization apparently only responds to genuine
// input, which a content script has no way to produce). LinkedIn
// separately exposes dedicated URLs for each -- what "Show all
// experiences" / "Show all N educations" link to -- that render
// immediately on load with no scrolling needed at all, so those are used
// instead of the profile page itself.
function experienceDetailsUrl(profileUrl) {
  return `${profileUrl.replace(/\/?$/, '')}/details/experience/`;
}

function educationDetailsUrl(profileUrl) {
  return `${profileUrl.replace(/\/?$/, '')}/details/education/`;
}

// Runs INSIDE either details page. Returns plain text rather than trying
// to parse out individual company/institution names (the markup varies
// enough between profiles -- grouped multi-role entries under one company
// vs. separate entries, similarly for degrees -- that a structural parse
// would be fragile); the caller instead checks whether the target
// company/institution name appears anywhere in this text. Truncated before
// "More profiles for you", a trailing suggestions block on both pages
// showing unrelated people -- without cutting that off, a match could come
// from a stranger shown there instead of the candidate's own history.
function scrapeDetailsPageText() {
  const main = document.querySelector('main') || document.body;
  return main.innerText.split('More profiles for you')[0];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    // Safety net in case the 'complete' event is missed for some reason --
    // never hang the whole crawl on one candidate.
    setTimeout(resolve, 15000);
  });
}

// The crawl holds one background tab for its whole run instead of opening a
// fresh one per candidate. That tab can vanish underneath it -- the user
// closes it, Chrome discards a hidden/inactive tab under memory pressure --
// and every subsequent chrome.tabs.update(tab.id, ...) then throws "No tab
// with id: N", cascading into an error status for every remaining candidate
// even though nothing about them was actually wrong. Recreate it on demand
// instead of trusting the id stays valid for the life of the run. `tab` is
// a plain `{ id }` holder (not a live chrome.tabs.Tab), mutated in place so
// every caller sharing the same object picks up the new id automatically.
async function ensureTabAlive(tab) {
  try {
    await chrome.tabs.get(tab.id);
  } catch {
    const fresh = await chrome.tabs.create({ url: 'about:blank', active: false });
    tab.id = fresh.id;
  }
}

async function visitDetailsPage(tab, url) {
  await ensureTabAlive(tab);
  await chrome.tabs.update(tab.id, { url });
  await waitForTabLoad(tab.id);
  await sleep(1500);
  const [{ result: text }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scrapeDetailsPageText,
  });
  return text;
}

// Runs INSIDE the profile tab. The top-of-profile "current company" /
// "school" pills render immediately with the rest of the page -- no
// lazy-load issue like Experience/Education -- and, confirmed live, stay
// populated even for profiles where the dedicated /details/experience/ and
// /details/education/ pages come back completely empty (observed for
// profiles with only one entry in that section). LinkedIn's CSS classes
// here are opaque generated hashes that reshuffle across profiles/builds,
// so this anchors on the pill icons' semantic ids instead
// (svg#company-accent-*, svg#school-accent-*), which held up across two
// unrelated profiles when checked live.
function scrapeProfileTopCard() {
  function extractPill(prefix) {
    const icon = document.querySelector(`main svg[id^="${prefix}-accent"]`);
    if (!icon) return null;
    const row = icon.closest('div');
    return row ? row.textContent.replace(/\s+/g, ' ').trim() : null;
  }
  return { company: extractPill('company'), school: extractPill('school') };
}

async function visitProfileTopCard(tab, profileUrl) {
  await ensureTabAlive(tab);
  await chrome.tabs.update(tab.id, { url: profileUrl });
  await waitForTabLoad(tab.id);
  await sleep(1500);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scrapeProfileTopCard,
  });
  return result || { company: null, school: null };
}

// Works through the name-matching search results in batches of 3,
// escalating what's checked within each batch before moving to the next.
// When Curatal actually has a current company on file for this candidate:
//
//   1. Name + Experience only, for all 3 in the batch -- the cheap check.
//      If exactly one profile confirms, that's the answer.
//   2. Still unresolved (zero, or more than one, experience match)? Check
//      Education too, for the same 3 -- a profile now counts if EITHER
//      experience or education agrees. This is what a plain single-signal
//      check can't do: pull an ambiguous pair of experience-matches apart
//      by whether education *also* lines up, or catch someone whose
//      Curatal company is stale but whose education isn't.
//   3. Still unresolved? Move to the next 3 name-matches and repeat.
//
// When Curatal has no company on file at all (currentCompany is blank),
// stage 1 would just visit the Experience page and immediately fail every
// time -- companyCoreToken('') can't match anything -- so that visit is
// skipped entirely and each batch goes straight to Name + Education only.
//
// A pool smaller than 3 just becomes one undersized batch and goes through
// the same stages -- no special-casing needed. Capped at MAX_BATCHES so
// one very common name doesn't turn into dozens of profile visits, which
// is what actually counts against LinkedIn's profile-view limit for
// non-premium accounts.
async function resolveNameMatch(nameMatches, candidate, tab) {
  const BATCH_SIZE = 3;
  const MAX_BATCHES = 2;
  const batchCount = Math.min(Math.ceil(nameMatches.length / BATCH_SIZE), MAX_BATCHES);
  const hasCompany = !!candidate.currentCompany;

  for (let b = 0; b < batchCount; b += 1) {
    if (bulkState.stopRequested) return { resolved: false, reason: 'stopped' };
    const batch = nameMatches.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);

    // Stage 0: one cheap visit per profile -- the top-of-profile company/
    // school pills (see scrapeProfileTopCard), merged with the
    // already-scraped headline. Resolves the common case in a single
    // visit instead of two, and catches profiles where the dedicated
    // Experience/Education pages come back empty.
    const staged = [];
    for (let i = 0; i < batch.length; i += 1) {
      if (bulkState.stopRequested) return { resolved: false, reason: 'stopped' };
      await sleep(2000 + Math.random() * 1500);
      // eslint-disable-next-line no-await-in-loop
      const topCard = await visitProfileTopCard(tab, batch[i].linkedinUrl);
      const textBlob = `${batch[i].headline || ''} ${topCard.company || ''} ${topCard.school || ''}`;
      staged.push({
        profile: batch[i],
        textBlob,
        expMatch: hasCompany && experienceContainsCompany(textBlob, candidate.currentCompany),
        eduMatch: !!candidate.education && educationContainsInstitution(textBlob, candidate.education),
      });
    }

    if (!hasCompany) {
      // No company on file -- education is the only signal available.
      if (!candidate.education) return { resolved: false, reason: 'no company or education on file to match against' };
      const eduOnly = staged.filter((r) => r.eduMatch);
      if (eduOnly.length === 1) {
        return { resolved: true, profile: eduOnly[0].profile, via: 'education' };
      }
      if (eduOnly.length > 1 && candidate.currentLocation) {
        const byLocation = eduOnly.filter((r) => locationsMatch(r.profile.location, candidate.currentLocation));
        if (byLocation.length === 1) {
          return { resolved: true, profile: byLocation[0].profile, via: 'education+location' };
        }
      }
      if (eduOnly.length === 0) {
        // Top card + headline didn't have it -- fall back to the full
        // Education history page for a deeper (costlier) check.
        const deep = [];
        for (let i = 0; i < staged.length; i += 1) {
          if (bulkState.stopRequested) return { resolved: false, reason: 'stopped' };
          await sleep(2000 + Math.random() * 1500);
          // eslint-disable-next-line no-await-in-loop
          const educationText = await visitDetailsPage(tab, educationDetailsUrl(staged[i].profile.linkedinUrl));
          if (educationContainsInstitution(`${staged[i].textBlob} ${educationText}`, candidate.education)) {
            deep.push(staged[i].profile);
          }
        }
        if (deep.length === 1) {
          return { resolved: true, profile: deep[0], via: 'education' };
        }
        if (deep.length > 1 && candidate.currentLocation) {
          const byLocation = deep.filter((p) => locationsMatch(p.location, candidate.currentLocation));
          if (byLocation.length === 1) {
            return { resolved: true, profile: byLocation[0], via: 'education+location' };
          }
        }
      }
      // eslint-disable-next-line no-continue
      continue;
    }

    // hasCompany: try the cheap experience signal first.
    const stage0Matches = staged.filter((r) => r.expMatch);
    if (stage0Matches.length === 1) {
      return { resolved: true, profile: stage0Matches[0].profile, via: 'experience' };
    }

    if (stage0Matches.length > 1) {
      // Ambiguous even at the cheap stage -- try to break the tie with
      // education or location before spending more profile visits.
      if (candidate.education) {
        const eduBreak = stage0Matches.filter((r) => r.eduMatch);
        if (eduBreak.length === 1) {
          return { resolved: true, profile: eduBreak[0].profile, via: 'experience+education' };
        }
      }
      if (candidate.currentLocation) {
        const byLocation = stage0Matches.filter((r) => locationsMatch(r.profile.location, candidate.currentLocation));
        if (byLocation.length === 1) {
          return { resolved: true, profile: byLocation[0].profile, via: 'experience+location' };
        }
      }
      // eslint-disable-next-line no-continue
      continue;
    }

    // stage0Matches.length === 0 -- current-company pill/headline didn't
    // confirm anyone. Fall back to the full Experience history page
    // (catches a stale Curatal company that still shows up as a past
    // role), then Education as a second signal, same as before.
    const stage1 = [];
    for (let i = 0; i < staged.length; i += 1) {
      if (bulkState.stopRequested) return { resolved: false, reason: 'stopped' };
      await sleep(2000 + Math.random() * 1500);
      // eslint-disable-next-line no-await-in-loop
      const experienceText = await visitDetailsPage(tab, experienceDetailsUrl(staged[i].profile.linkedinUrl));
      const expMatch = experienceContainsCompany(`${staged[i].textBlob} ${experienceText}`, candidate.currentCompany);
      stage1.push({ profile: staged[i].profile, textBlob: staged[i].textBlob, eduMatch: staged[i].eduMatch, expMatch });
    }
    const stage1Matches = stage1.filter((r) => r.expMatch);
    if (stage1Matches.length === 1) {
      return { resolved: true, profile: stage1Matches[0].profile, via: 'experience' };
    }

    if (candidate.education) {
      const combined = [];
      for (let i = 0; i < stage1.length; i += 1) {
        if (bulkState.stopRequested) return { resolved: false, reason: 'stopped' };
        let eduMatch = stage1[i].eduMatch;
        if (!stage1[i].expMatch && !eduMatch) {
          await sleep(2000 + Math.random() * 1500);
          // eslint-disable-next-line no-await-in-loop
          const educationText = await visitDetailsPage(tab, educationDetailsUrl(stage1[i].profile.linkedinUrl));
          eduMatch = educationContainsInstitution(`${stage1[i].textBlob} ${educationText}`, candidate.education);
        }
        if (stage1[i].expMatch || eduMatch) {
          combined.push({ profile: stage1[i].profile, via: stage1[i].expMatch ? 'experience' : 'education' });
        }
      }
      if (combined.length === 1) {
        return { resolved: true, profile: combined[0].profile, via: combined[0].via };
      }
      if (combined.length > 1 && candidate.currentLocation) {
        const byLocation = combined.filter((r) => locationsMatch(r.profile.location, candidate.currentLocation));
        if (byLocation.length === 1) {
          return { resolved: true, profile: byLocation[0].profile, via: `${byLocation[0].via}+location` };
        }
      }
    }
    // Unresolved (0 or 2+ matches even with education factored in) --
    // fall through to the next batch of 3, if any remain.
  }

  return { resolved: false, reason: nameMatches.length > BATCH_SIZE * batchCount ? `checked ${batchCount * BATCH_SIZE} of ${nameMatches.length} name matches` : 'no confident match' };
}

// Reassigned to a freshly-loaded getBulkRunState() at the start of every
// alarm wake-up (see processNextBulkCandidate below) -- this module-level
// variable is just the current invocation's working copy, not something
// that survives between candidates the way it used to when one run held
// a single tab open end to end.
let bulkState = defaultBulkRunState();

// True for the whole span of an active processCandidate() call. Chrome
// extension message/alarm handlers interleave on one JS thread -- a
// candidate's search can be mid-await for tens of seconds, during which a
// STOP click (or another alarm/message) can run its own handler. If that
// handler reassigns bulkState (bulkState = await getBulkRunState()) while a
// candidate is still in flight, the in-flight call's LATER mutations would
// apply through its closure over bulkState -- which by then points at a
// different object -- landing on something that never gets persisted.
// (Not what caused the totalMatched:1-with-everything-pending bug, which
// turned out to be the queue/candidates aliasing issue described above
// advanceToNextBulkBatch -- but a real hazard in its own right once
// multiple entry points can reassign the same mutable module-level
// variable.) Everything that would otherwise reassign bulkState mid-flight
// checks this flag first and mutates the SAME live object in place instead.
let bulkOperationInFlight = false;

function broadcastBulkProgress() {
  // No listener (bulk-backfill.html not open) just means this rejects --
  // the crawl itself doesn't depend on anyone watching.
  chrome.runtime.sendMessage({ type: 'BULK_BACKFILL_PROGRESS', payload: bulkState }).catch(() => {});
  // A silently-swallowed failure here (the old bare .catch(() => {})) would
  // leave a whole candidate's real result never persisted with no trace of
  // why -- log it loudly instead, even though it's not expected to fire in
  // normal operation.
  chrome.storage.local.set({ [BULK_RUN_STATE_KEY]: bulkState })
    .catch((err) => console.error('[bulk] storage.local.set failed', err));
}

// Searches LinkedIn for one candidate and resolves (or doesn't) a match,
// mutating candidate.status/detail and bulkState's running totals in
// place. Shared by processNextBulkCandidate (sweep and recheck alike) --
// re-running just the current batch's failures after a matching-logic fix
// needs exactly this same per-candidate flow, not a second copy of it.
async function processCandidate(tab, candidate) {
  candidate.status = 'searching';
  broadcastBulkProgress();

  try {
    let { nameMatches, rawCardsSeen } = await searchCandidateProfiles(tab, candidate);

    // Even every targeted tier above can draw a blank when Curatal's
    // stored name runs two words together that LinkedIn's own profile
    // displays split apart (or vice versa) -- LinkedIn's search is
    // exact-token, not fuzzy, so no amount of rephrasing the rest of the
    // query fixes that. One more attempt, first name only plus whatever
    // company/education signal narrows it.
    if (!nameMatches.length && !bulkState.stopRequested) {
      const fallbackKeywords = buildFirstNameFallbackKeywords(candidate);
      if (fallbackKeywords) {
        await sleep(1500 + Math.random() * 1000);
        const cards = await searchLinkedIn(tab, fallbackKeywords);
        rawCardsSeen = rawCardsSeen || cards.length > 0;
        nameMatches = cards.filter((card) => firstNameMatches(card.name, candidate.fullName));
      }
    }

    if (!nameMatches.length) {
      candidate.status = 'no_match';
      candidate.detail = rawCardsSeen ? 'no name match in results' : 'no search results';
    } else {
      const resolution = await resolveNameMatch(nameMatches, candidate, tab);
      if (resolution.resolved) {
        const saveResult = await attachLinkedinUrlIfMissing(candidate.email, resolution.profile.linkedinUrl);
        if (saveResult.saved) {
          candidate.status = 'matched';
          candidate.detail = `${resolution.profile.linkedinUrl} (via ${resolution.via}, saved to Curatal)`;
        } else if (saveResult.skipped) {
          // Candidate already has a LinkedIn URL on file (possibly set
          // since this batch was fetched) -- never overwrite it, per
          // instruction. Still a real match, just not written.
          candidate.status = 'matched';
          candidate.detail = `${resolution.profile.linkedinUrl} (via ${resolution.via}) -- already has ${saveResult.existingUrl} on file, not overwritten`;
        } else {
          candidate.status = 'error';
          candidate.detail = `found ${resolution.profile.linkedinUrl} (via ${resolution.via}) but failed to save: ${saveResult.error}`;
        }
      } else {
        candidate.status = 'no_match';
        candidate.detail = resolution.reason;
      }
    }
  } catch (err) {
    candidate.status = 'error';
    candidate.detail = String((err && err.message) || err);
  }

  if (candidate.status === 'matched') bulkState.totalMatched += 1;
  else if (candidate.status === 'no_match') bulkState.totalNoMatch += 1;
  else if (candidate.status === 'error') bulkState.totalErrors += 1;

  appendToBulkReport(candidate);
  broadcastBulkProgress();
}

// Re-runs just the candidates from the most recent batch that weren't
// confidently matched (no_match/error), in place, without touching the
// sweep cursor or re-fetching from Curatal. Exists so a matching-logic fix
// can be verified against exactly the cases that just failed, and so
// candidates that would otherwise only get a second look after a full
// cursor reset aren't left stranded until then. `queue` holds references to
// those specific candidate objects (a subset of bulkState.candidates, not a
// copy) -- processCandidate mutates them in place, so the full batch stays
// visible in the results table throughout, same as before. Deliberately
// autoContinue:false regardless of the sweep's setting -- a recheck is a
// one-off, deliberate re-pass, not something that should chain into
// fetching a whole new batch from Curatal on its own.
async function startBulkRecheck() {
  if (bulkOperationInFlight) return { ok: false, error: 'already_running' };
  const existing = await getBulkRunState();
  if (existing.running) return { ok: false, error: 'already_running' };
  // Indexes into existing.candidates, not the objects themselves or their
  // candidateId -- see the note in advanceToNextBulkBatch for why.
  const targetIndexes = [];
  existing.candidates.forEach((c, i) => {
    if (c.status === 'no_match' || c.status === 'error') targetIndexes.push(i);
  });
  if (!targetIndexes.length) return { ok: false, error: 'nothing_to_recheck' };

  targetIndexes.forEach((i) => {
    const c = existing.candidates[i];
    if (c.status === 'matched') existing.totalMatched -= 1;
    else if (c.status === 'no_match') existing.totalNoMatch -= 1;
    else if (c.status === 'error') existing.totalErrors -= 1;
    c.status = 'pending';
    c.detail = '';
  });

  bulkState = {
    ...existing,
    running: true,
    stopRequested: false,
    mode: 'recheck',
    queue: targetIndexes,
    total: targetIndexes.length,
    processedCount: 0,
    autoContinue: false,
    lastError: null,
  };
  broadcastBulkProgress();
  await scheduleNextBulkCandidate();
  return { ok: true };
}

// Entry point for the Start button. Fetches the first batch, then hands off
// to the alarm-driven engine below -- this function itself returns almost
// immediately (the message handler doesn't wait around for a whole run),
// same as clicking Start always felt like, even though the run itself now
// takes hours.
async function startBulkSweep({ limit, autoContinue }) {
  if (bulkOperationInFlight) return;
  const existing = await getBulkRunState();
  if (existing.running) return;

  const cursor = await getBulkCursor();
  bulkState = {
    ...defaultBulkRunState(),
    running: true,
    mode: 'sweep',
    cursor,
    limit,
    autoContinue: !!autoContinue,
  };
  broadcastBulkProgress();
  await advanceToNextBulkBatch();
}

async function stopBulk() {
  await chrome.alarms.clear(BULK_ALARM_NAME);
  // Only safe to reload a fresh copy when nothing's actively processing --
  // otherwise this would orphan that in-flight call's eventual mutations
  // (see bulkOperationInFlight above). When something IS in flight, mutate
  // the exact same live object it's already holding instead.
  if (!bulkOperationInFlight) {
    bulkState = await getBulkRunState();
  }
  bulkState.stopRequested = true;
  bulkState.running = false;
  bulkState.nextRunAt = null;
  broadcastBulkProgress();
}

// Fetches the next batch of `limit` candidates from Curatal and queues it up
// (sweep mode only -- called both for the very first batch and, if
// autoContinue is on, every time one batch finishes and the run chains into
// the next). candidates and queue are the SAME array here (unlike recheck,
// which processes a subset) -- the whole freshly-fetched batch is the queue.
async function advanceToNextBulkBatch() {
  const result = await fetchMissingLinkedinCandidates(bulkState.limit, bulkState.cursor);
  if (result.error || !result.candidates) {
    // Fetching the candidate list itself failed (auth, network, gateway
    // routing, backend error) -- surface it instead of silently reverting
    // to "not started", which looked indistinguishable from never having
    // clicked Start at all.
    bulkState.running = false;
    bulkState.nextRunAt = null;
    bulkState.lastError = result.error || 'missing_linkedin_fetch_failed';
    broadcastBulkProgress();
    return;
  }
  if (!result.candidates.length) {
    bulkState.running = false;
    bulkState.nextRunAt = null;
    bulkState.sweepComplete = true;
    broadcastBulkProgress();
    return;
  }

  // Advance the cursor immediately, not after the batch finishes -- so
  // stopping partway through (or the worker never getting a chance to run
  // again) still leaves forward progress for next time instead of
  // re-fetching the same page.
  await setBulkCursor(result.nextAfter);
  bulkState.cursor = result.nextAfter;
  bulkState.batchesRun += 1;
  bulkState.candidates = result.candidates.map((c) => ({ ...c, status: 'pending', detail: '' }));
  // queue holds INDEXES into bulkState.candidates, NOT object references --
  // see the note above bulkOperationInFlight for why: bulkState round-trips
  // through chrome.storage.local (JSON serialization) between almost every
  // step, which silently breaks object-reference aliasing between two
  // arrays that started out pointing at the same objects. A plain index
  // survives that round-trip intact (array order/length is preserved even
  // though object identity isn't). Index, not candidateId -- confirmed
  // live, Curatal's missing-linkedin data can have several rows (different
  // companies) share the same candidateId, which would collide under a
  // find-by-id lookup.
  bulkState.queue = bulkState.candidates.map((_, i) => i);
  bulkState.total = bulkState.queue.length;
  bulkState.processedCount = 0;
  await scheduleNextBulkCandidate();
}

async function scheduleNextBulkCandidate() {
  const delayMs = bulkState.processedCount === 0
    ? bulkFirstCandidateDelayMs()
    : bulkNextCandidateDelayMs(bulkState.queue.length);
  bulkState.nextRunAt = Date.now() + delayMs;
  chrome.alarms.create(BULK_ALARM_NAME, { when: bulkState.nextRunAt });
  broadcastBulkProgress();
}

// The actual unit of work a wake-up performs: one candidate, then either
// schedule the next one, chain into a fresh batch (sweep + autoContinue), or
// stop. Always starts by reloading state from storage -- the module-level
// bulkState from whatever processed the PREVIOUS candidate is long gone,
// the worker that held it was killed once it went idle.
async function processNextBulkCandidate() {
  // Defensive: shouldn't normally happen for a single named one-shot alarm,
  // but if it ever did fire twice (or overlapped a resumed alarm), this is
  // exactly the kind of overlap that caused the bulkState-reassignment race
  // above -- bail rather than start a second concurrent candidate.
  if (bulkOperationInFlight) return;

  bulkState = await getBulkRunState();
  if (!bulkState.running || bulkState.stopRequested) {
    bulkState.running = false;
    bulkState.nextRunAt = null;
    broadcastBulkProgress();
    return;
  }

  if (bulkState.processedCount >= bulkState.queue.length) {
    if (bulkState.mode === 'sweep' && bulkState.autoContinue) {
      await advanceToNextBulkBatch();
    } else {
      bulkState.running = false;
      bulkState.nextRunAt = null;
      broadcastBulkProgress();
    }
    return;
  }

  const candidateIndex = bulkState.queue[bulkState.processedCount];
  const candidate = bulkState.candidates[candidateIndex];
  if (!candidate) {
    // Shouldn't happen (every index in queue comes from candidates itself),
    // but skip rather than get permanently stuck if it ever does.
    bulkState.processedCount += 1;
    await scheduleNextBulkCandidate();
    return;
  }
  bulkOperationInFlight = true;
  try {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    await processCandidate(tab, candidate);
    await chrome.tabs.remove(tab.id).catch(() => {});
  } finally {
    bulkOperationInFlight = false;
  }
  bulkState.processedCount += 1;

  if (bulkState.stopRequested || !bulkState.running) {
    bulkState.running = false;
    bulkState.nextRunAt = null;
    broadcastBulkProgress();
    return;
  }

  if (bulkState.processedCount >= bulkState.queue.length) {
    if (bulkState.mode === 'sweep' && bulkState.autoContinue) {
      await advanceToNextBulkBatch();
    } else {
      bulkState.running = false;
      bulkState.nextRunAt = null;
      broadcastBulkProgress();
    }
    return;
  }

  await scheduleNextBulkCandidate();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BULK_ALARM_NAME) {
    processNextBulkCandidate().catch((err) => console.error('[bulk] alarm step failed', err));
  }
});

// A pending chrome.alarms alarm is the only thing keeping a run alive
// between candidates -- if it's gone (the extension was reloaded in
// chrome://extensions during dev, or Chrome itself restarted) while
// bulkState still says running:true, the run would otherwise silently
// stall for however many hours are left with nothing to wake it back up.
// Runs on both onStartup (browser relaunch) and onInstalled (extension
// reload/update), and reschedules from wherever nextRunAt says next,
// firing soon instead if that time already passed while nobody was around.
async function resumeBulkAlarmIfNeeded() {
  const state = await getBulkRunState();
  if (!state.running) return;
  const alarm = await chrome.alarms.get(BULK_ALARM_NAME);
  if (alarm) return;
  const when = state.nextRunAt && state.nextRunAt > Date.now() ? state.nextRunAt : Date.now() + 5000;
  chrome.alarms.create(BULK_ALARM_NAME, { when });
}

chrome.runtime.onStartup.addListener(() => {
  resumeBulkAlarmIfNeeded().catch((err) => console.error('[bulk] resume on startup failed', err));
});

// Reloading the extension in chrome://extensions only replaces this
// background script -- an already-open bulk-backfill.html tab keeps
// running its OLD page code and never re-asks for status, so it looks
// dead/stuck even though the new background script is right there waiting
// to answer it. Auto-refresh any such open tab so the fix above actually
// reaches the screen without a manual F5 the user has to remember every
// time, and make sure a mid-run alarm survived the reload (see above).
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({ url: `${chrome.runtime.getURL('bulk-backfill.html')}*` })
    .then((tabs) => tabs.forEach((t) => chrome.tabs.reload(t.id)))
    .catch(() => {});
  resumeBulkAlarmIfNeeded().catch((err) => console.error('[bulk] resume on install failed', err));
});

// Without this, clicking the toolbar icon does nothing (there's no
// default_popup any more, and no action.onClicked listener either) --
// this is what makes the click open popup.html as a side panel instead.
// A side panel, unlike the old popup, stays open across navigation within
// the tab instead of Chrome force-closing it on every outside click, which
// was the actual complaint (clicking a link to another LinkedIn profile
// closed the popup before a real page reload even had a chance to happen).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'START_BULK_BACKFILL') {
    startBulkSweep(message.payload).catch((err) => console.error('[bulk] crawl failed', err));
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'STOP_BULK_BACKFILL') {
    // Unlike the old back-to-back loop, there's almost never an in-flight
    // candidate to interrupt -- candidates are now minutes-to-hours apart,
    // so stopping is just: cancel the pending alarm so the next one never
    // fires. stopBulk() persists+broadcasts running:false immediately.
    stopBulk().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'GET_BULK_BACKFILL_STATUS') {
    getBulkRunState().then((state) => sendResponse(state));
    return true;
  }
  if (message.type === 'RESET_BULK_CURSOR') {
    // The UI already disables this button while running, but don't trust
    // that alone -- reassigning bulkState here while a candidate is
    // actively in flight would hit the same orphaned-object race described
    // above bulkOperationInFlight's declaration.
    if (bulkOperationInFlight) {
      sendResponse({ ok: false, error: 'already_running' });
      return false;
    }
    Promise.all([
      setBulkCursor(0),
      chrome.storage.local.remove([BULK_RUN_STATE_KEY, BULK_ALL_RESULTS_KEY]),
    ]).then(() => {
      bulkState = defaultBulkRunState();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (message.type === 'GET_BULK_REPORT') {
    chrome.storage.local.get([BULK_ALL_RESULTS_KEY]).then((stored) => {
      sendResponse({ rows: stored[BULK_ALL_RESULTS_KEY] || [] });
    });
    return true;
  }
  if (message.type === 'RECHECK_UNRESOLVED') {
    startBulkRecheck().then(sendResponse).catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (message.type === 'LOGIN') {
    login(message.payload.email, message.payload.password).then(sendResponse);
    return true;
  }
  if (message.type === 'LOGOUT') {
    clearSession().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'GET_LOGIN_STATE') {
    getSession().then(({ accessToken, email }) => sendResponse({ loggedIn: !!accessToken, email }));
    return true;
  }
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
