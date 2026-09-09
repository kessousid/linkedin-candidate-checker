function el(id) {
  return document.getElementById(id);
}

function renderLoginState({ loggedIn, email }) {
  el('loggedInView').style.display = loggedIn ? 'block' : 'none';
  el('loginForm').style.display = loggedIn ? 'none' : 'block';
  if (loggedIn) {
    el('loggedInAs').textContent = `Logged in as ${email || 'a Curatal Dev Platform Admin'}.`;
  }
}

async function load() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_LOGIN_STATE' });
  renderLoginState(state);
}

el('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = el('status');
  const email = el('email').value.trim();
  const password = el('password').value;

  if (!email || !password) {
    status.className = 'status error';
    status.textContent = 'Email and password are required.';
    return;
  }

  el('loginBtn').disabled = true;
  status.className = 'status';
  status.textContent = 'Logging in…';

  const result = await chrome.runtime.sendMessage({ type: 'LOGIN', payload: { email, password } });
  el('loginBtn').disabled = false;

  if (result.error) {
    status.className = 'status error';
    status.textContent = `Login failed: ${result.error}`;
    return;
  }

  status.className = 'status ok';
  status.textContent = 'Logged in.';
  el('password').value = '';
  await load();
});

el('logoutBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'LOGOUT' });
  await load();
});

load();
