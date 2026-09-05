// Service worker: the only part of the extension that talks to the real
// Curatal Dev backend. Keeping the recruiter's tokens here (rather than in
// popup.js/search-content-script.js) means they never need to be read by
// anything other than this one place.
//
// This extension is hardcoded to the Curatal DEV environment only -- never
// staging or production. There is no user-editable "backend URL" any more
// (see options.js): DEV_HOST below is the only host this file will ever
// call, and manifest.json's host_permissions only grants this one origin.
const DEV_HOST = 'https://curatal-dev.openturf.dev';

// Recruiter login/refresh go through the recruiter service; the new
// candidate lookup/create endpoints (added to the accounts service, guarded
// by isrecruiterAuthorized()) go through the accounts service. Both are
// reached through the same gateway host, under the external path shapes
// already used by the real Curatal portal frontend (see
// C:\CuratalIT\portal\src\routes\ApiUrls.js) -- NOT the per-service
// "/curatal_x/api/v1/..." shape CuratalApp's mobile client uses for its own
// separate dev gateway.
//
// IMPORTANT: '/v1/accounts/candidate/sourced/lookup' and
// '/v1/accounts/candidate/sourced' are BRAND NEW routes added to the
// accounts service (see C:\CuratalIT\accounts\src\routes\v1\accounts.route.js).
// Every existing external path in ApiUrls.js is a *rewritten* path (e.g.
// internal '/verifyMobileNo' is exposed as '/v1/accounts/mobileNo/verify'),
// which means the gateway/reverse-proxy in front of these services needs a
// matching rewrite rule added for these two new paths before they're
// reachable -- that config isn't part of any service's source checkout, so
// it has to be added by whoever deploys this change.
const LOOKUP_PATH = '/v1/accounts/candidate/sourced/lookup';
const ADD_PATH = '/v1/accounts/candidate/sourced';
const RECRUITER_LOGIN_PATH = '/v1/recruiter/login';
const REFRESH_TOKEN_PATH = '/v1/refresh-token';

async function getTokens() {
  const { accessToken, refreshToken } = await chrome.storage.local.get(['accessToken', 'refreshToken']);
  return { accessToken, refreshToken };
}

async function setTokens({ accessToken, refreshToken }) {
  await chrome.storage.local.set({ accessToken, refreshToken });
}

async function clearTokens() {
  await chrome.storage.local.remove(['accessToken', 'refreshToken']);
}

async function recruiterLogin(email, password) {
  const res = await fetch(new URL(RECRUITER_LOGIN_PATH, DEV_HOST), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    return { error: body.message || `login_failed_${res.status}` };
  }
  await setTokens({ accessToken: body.access_token, refreshToken: body.refresh_token });
  return { ok: true };
}

let refreshPromise = null;

async function refreshAccessToken() {
  const { refreshToken } = await getTokens();
  if (!refreshToken) return null;
  try {
    const res = await fetch(new URL(REFRESH_TOKEN_PATH, DEV_HOST), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      await clearTokens();
      return null;
    }
    await setTokens({ accessToken: body.access_token, refreshToken: body.refresh_token || refreshToken });
    return body.access_token;
  } catch {
    return null;
  }
}

// Fetch wrapper that attaches the recruiter's access token and retries once
// on a 401 after refreshing it -- same shape as CuratalApp's own
// axios interceptor (src/api/client.ts), so a stale token never surfaces to
// the popup/content-script callers as a raw failure.
async function authedFetch(path, options = {}) {
  const { accessToken } = await getTokens();
  if (!accessToken) {
    return { error: 'not_logged_in' };
  }

  const doFetch = async (token) => fetch(new URL(path, DEV_HOST), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  let res = await doFetch(accessToken);
  if (res.status === 401) {
    refreshPromise = refreshPromise ?? refreshAccessToken();
    const newToken = await refreshPromise;
    refreshPromise = null;
    if (!newToken) {
      return { error: 'not_logged_in' };
    }
    res = await doFetch(newToken);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { error: body.error || body.message || `backend_error_${res.status}` };
  }
  return body;
}

async function checkCandidate({ phone, email }) {
  if (!phone && !email) return { error: 'phone_or_email_required' };
  return authedFetch(LOOKUP_PATH, {
    method: 'POST',
    body: JSON.stringify({ phone, email }),
  });
}

async function uploadCandidate({ fullName, phone, email, currentCompany, linkedinUrl }) {
  if (!phone) return { error: 'phone_required' };
  return authedFetch(ADD_PATH, {
    method: 'POST',
    body: JSON.stringify({ fullName, phone, email, currentCompany, linkedinUrl }),
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'RECRUITER_LOGIN') {
    recruiterLogin(message.payload.email, message.payload.password).then(sendResponse);
    return true;
  }
  if (message.type === 'RECRUITER_LOGOUT') {
    clearTokens().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'GET_LOGIN_STATE') {
    getTokens().then(({ accessToken }) => sendResponse({ loggedIn: !!accessToken }));
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
