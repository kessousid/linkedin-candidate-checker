function el(id) {
  return document.getElementById(id);
}

function renderState(state) {
  const {
    candidates, running, processedCount, total, cursor,
    autoContinue, batchesRun, totalMatched, totalNoMatch, totalErrors, sweepComplete, lastError,
  } = state;
  el('startBtn').disabled = running;
  el('stopBtn').disabled = !running;
  el('limitInput').disabled = running;
  el('resetCursorBtn').disabled = running;
  el('modeManual').disabled = running;
  el('modeAuto').disabled = running;
  el('recheckBtn').disabled = running || !(candidates || []).some((c) => c.status === 'no_match' || c.status === 'error');

  el('cursorText').textContent = `Next batch resumes after candidate id ${cursor || 0} — click "Reset to first batch" to start over from the beginning.`;

  if (!candidates || !candidates.length) {
    if (sweepComplete) {
      el('progressText').textContent = `Done — reached the end of the list. ${batchesRun || 0} batch(es) run this session: ${totalMatched || 0} matched, ${totalNoMatch || 0} no confident match, ${totalErrors || 0} errors.`;
    } else if (lastError && !running) {
      el('progressText').textContent = `Couldn't fetch candidates from Curatal: ${lastError}. Check you're logged in (Settings) and try Start again.`;
    } else {
      el('progressText').textContent = running ? 'Fetching candidates…' : 'Not started yet.';
    }
    el('resultsTable').style.display = 'none';
    return;
  }

  const batchMatched = candidates.filter((c) => c.status === 'matched').length;
  const batchNoMatch = candidates.filter((c) => c.status === 'no_match').length;
  const batchErrors = candidates.filter((c) => c.status === 'error').length;

  const overallSuffix = autoContinue
    ? ` — running total across ${batchesRun || 1} batch(es): ${totalMatched || 0} matched, ${totalNoMatch || 0} no confident match, ${totalErrors || 0} errors`
    : '';

  el('progressText').textContent = running
    ? `Batch ${batchesRun || 1}: processing ${processedCount} of ${total}… (${batchMatched} matched, ${batchNoMatch} no confident match, ${batchErrors} errors so far this batch)${overallSuffix}`
    : `Batch ${batchesRun || 1} done: ${processedCount} of ${total} processed (${batchMatched} matched, ${batchNoMatch} no confident match, ${batchErrors} errors)${overallSuffix}.`;

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
  if (result && result.error === 'nothing_to_recheck') {
    el('recheckBtn').disabled = false;
  }
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
