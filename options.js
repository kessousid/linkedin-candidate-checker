async function load() {
  const { loggedIn } = await chrome.runtime.sendMessage({ type: 'GET_LOGIN_STATE' });
  const loggedInAs = document.getElementById('loggedInAs');
  if (loggedIn) {
    loggedInAs.style.display = 'block';
    loggedInAs.textContent = 'Logged in to Curatal Dev.';
    document.getElementById('saveBtn').textContent = 'Log in as someone else';
  }
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  const status = document.getElementById('status');
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!email || !password) {
    status.textContent = 'Email and password are both required.';
    return;
  }

  // curatal-dev.openturf.dev is baked into manifest.json's host_permissions
  // (not requested at runtime) precisely so there's no path in this
  // extension that can be pointed at staging or production.
  status.textContent = 'Logging in…';
  const result = await chrome.runtime.sendMessage({
    type: 'RECRUITER_LOGIN',
    payload: { email, password },
  });

  if (result.error) {
    status.textContent = `Login failed: ${result.error}`;
    return;
  }
  status.textContent = 'Logged in.';
  document.getElementById('password').value = '';
  load();
});

load();
