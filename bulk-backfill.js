function el(id) {
  return document.getElementById(id);
}

// Candidates are now minutes-to-hours apart (see background.js's alarm-driven
// pacing) -- most of the time nothing is actively happening, just waiting for
// the next scheduled candidate. lastState + the interval below keep the ETA
// text ("in about N minutes") counting down even though no new
// BULK_BACKFILL_PROGRESS message arrives until something actually changes.
let lastState = null;

function formatEta(nextRunAt) {
  if (!nextRunAt) return 'soon';
  const msLeft = nextRunAt - Date.now();
  const when = new Date(nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (msLeft <= 60000) return `any moment now (around ${when})`;
  const mins = Math.round(msLeft / 60000);
  if (mins < 60) return `in about ${mins} minute${mins === 1 ? '' : 's'} (around ${when})`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `in about ${hours}h ${remMins}m (around ${when})`;
}

function renderState(state) {
  lastState = state;
  const {
    candidates, running, processedCount, total, cursor, stopRequested, mode, nextRunAt,
    autoContinue, batchesRun, totalMatched, totalNoMatch, totalErrors, sweepComplete, lastError,
  } = state;
  el('startBtn').disabled = running;
  el('stopBtn').disabled = !running || stopRequested;
  el('limitInput').disabled = running;
  el('resetCursorBtn').disabled = running;
  el('modeManual').disabled = running;
  el('modeAuto').disabled = running;
  el('recheckBtn').disabled = running || !(candidates || []).some((c) => c.status === 'no_match' || c.status === 'error');

  el('cursorText').textContent = `Next fresh batch resumes after candidate id ${cursor || 0} — click "Reset to first batch" to start over from the beginning.`;

  if (!candidates || !candidates.length) {
    if (sweepComplete) {
      el('progressText').textContent = `Done — reached the end of the list. ${batchesRun || 0} batch(es) run this session: ${totalMatched || 0} matched, ${totalNoMatch || 0} no confident match, ${totalErrors || 0} errors.`;
    } else if (lastError && !running) {
      el('progressText').textContent = `Couldn't fetch candidates from Curatal: ${lastError}. Check you're logged in (Settings) and try Start again.`;
    } else if (running && stopRequested) {
      el('progressText').textContent = 'Stopping — finishing the candidate currently in progress, then will halt…';
    } else {
      el('progressText').textContent = running ? 'Fetching candidates…' : 'Not started yet.';
    }
    el('resultsTable').style.display = 'none';
    return;
  }

  const batchMatched = candidates.filter((c) => c.status === 'matched').length;
  const batchNoMatch = candidates.filter((c) => c.status === 'no_match').length;
  const batchErrors = candidates.filter((c) => c.status === 'error').length;
  // A candidate object sits at 'searching' only for the few seconds to a
  // couple minutes it's actually being checked -- the rest of the (much
  // longer) gap between candidates, none of them are, which is what tells
  // the waiting-for-next-alarm branch below apart from actively-working.
  const activelyProcessing = candidates.some((c) => c.status === 'searching');

  const overallSuffix = autoContinue
    ? ` — running total across ${batchesRun || 1} batch(es): ${totalMatched || 0} matched, ${totalNoMatch || 0} no confident match, ${totalErrors || 0} errors`
    : '';
  const batchLabel = mode === 'recheck' ? 'Recheck' : `Batch ${batchesRun || 1}`;
  const tallySuffix = `(${batchMatched} matched, ${batchNoMatch} no confident match, ${batchErrors} errors so far)${overallSuffix}`;

  let statusLine;
  if (!running) {
    statusLine = `${batchLabel} done: ${processedCount} of ${total} processed ${tallySuffix}.`;
  } else if (stopRequested) {
    statusLine = `Stopping (finishing the current candidate, can take a minute)… ${batchLabel}: ${processedCount} of ${total} done so far.`;
  } else if (activelyProcessing) {
    statusLine = `${batchLabel}: actively checking candidate ${processedCount + 1} of ${total} right now… ${tallySuffix}`;
  } else {
    statusLine = `${batchLabel}: ${processedCount} of ${total} done so far ${tallySuffix} — next candidate ${formatEta(nextRunAt)}. Paced to avoid triggering LinkedIn's bot detection again; this tab doesn't need to stay open while it waits.`;
  }
  el('progressText').textContent = statusLine;

  el('resultsTable').style.display = '';
  el('resultsBody').innerHTML = candidates.map((c) => `<tr>
    <td>${c.fullName}</td>
    <td>${c.phone || ''}</td>
    <td>${c.email || ''}</td>
    <td>${c.currentCompany || ''}</td>
    <td class="status-${c.status}">${c.status}</td>
    <td>${c.detail || ''}</td>
  </tr>`).join('');
}

// Re-render every 30s off the last-known state, purely so the "next
// candidate in about N minutes" countdown keeps ticking down while this tab
// sits open across a long gap with no new BULK_BACKFILL_PROGRESS message.
setInterval(() => {
  if (lastState && lastState.running) renderState(lastState);
}, 30000);

el('startBtn').addEventListener('click', async () => {
  const limit = parseInt(el('limitInput').value, 10) || 25;
  const autoContinue = el('modeAuto').checked;
  el('startBtn').disabled = true;
  await chrome.runtime.sendMessage({ type: 'START_BULK_BACKFILL', payload: { limit, autoContinue } });
});

el('stopBtn').addEventListener('click', async () => {
  el('stopBtn').disabled = true;
  await chrome.runtime.sendMessage({ type: 'STOP_BULK_BACKFILL' });
});

el('resetCursorBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'RESET_BULK_CURSOR' });
  const state = await chrome.runtime.sendMessage({ type: 'GET_BULK_BACKFILL_STATUS' });
  renderState(state);
});

el('recheckBtn').addEventListener('click', async () => {
  el('recheckBtn').disabled = true;
  const result = await chrome.runtime.sendMessage({ type: 'RECHECK_UNRESOLVED' });
  if (result && result.error) {
    el('recheckBtn').disabled = false;
    if (result.error !== 'nothing_to_recheck') el('progressText').textContent = result.error;
  }
});

function toCsvValue(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

el('downloadReportBtn').addEventListener('click', async () => {
  const { rows } = await chrome.runtime.sendMessage({ type: 'GET_BULK_REPORT' });
  if (!rows || !rows.length) {
    el('progressText').textContent = 'Nothing to download yet -- no candidates processed since the last reset.';
    return;
  }
  const header = ['Full Name', 'Phone', 'Email', 'Current Company', 'Status', 'Detail'];
  const lines = [header.map(toCsvValue).join(',')];
  rows.forEach((r) => {
    lines.push([r.fullName, r.phone, r.email, r.currentCompany, r.status, r.detail].map(toCsvValue).join(','));
  });
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `curatal-linkedin-backfill-report-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'BULK_BACKFILL_PROGRESS') {
    renderState(message.payload);
  }
});

(async () => {
  const state = await chrome.runtime.sendMessage({ type: 'GET_BULK_BACKFILL_STATUS' });
  renderState(state);
})();
