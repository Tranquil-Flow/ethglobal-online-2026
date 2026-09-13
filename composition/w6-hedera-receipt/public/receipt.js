// Hedera mirror receipt page client.
// Independent of any other local artifact — fetches /api/receipt and renders.

(function () {
  'use strict';

  const CANONICAL_TX = '0.0.7162784-1789239567-211071753';

  const $ = (id) => document.getElementById(id);

  const form = $('probe-form');
  const txInput = $('tx-input');
  const probeBtn = $('probe-btn');
  const errorCard = $('error-card');
  const errorDetail = $('error-detail');
  const resultCard = $('result-card');
  const resultBadge = $('result-badge');
  const resultHeadline = $('result-headline');

  // Initialize default tx.
  txInput.value = CANONICAL_TX;

  function setText(id, value) {
    const el = $(id);
    if (el == null) return;
    el.textContent = (value == null || value === '') ? '—' : String(value);
  }

  function setHref(id, value) {
    const el = $(id);
    if (el == null) return;
    if (!value) {
      el.textContent = '—';
      el.removeAttribute('href');
      return;
    }
    el.href = value;
    el.textContent = value;
  }

  function showError(message) {
    errorDetail.textContent = message || '—';
    errorCard.classList.remove('hidden');
    resultCard.classList.add('hidden');
  }

  function showResult(payload) {
    errorCard.classList.add('hidden');
    resultCard.classList.remove('hidden');

    const ok = payload && payload.ok;
    const sum = (payload && payload.summary) || {};

    resultBadge.classList.remove('ok', 'fail');
    if (ok) {
      resultBadge.classList.add('ok');
      resultBadge.textContent = 'OK';
      resultHeadline.textContent = 'Receipt verified against Hedera mirror node';
    } else {
      resultBadge.classList.add('fail');
      resultBadge.textContent = 'NOT VERIFIED';
      resultHeadline.textContent = 'Receipt not verified';
    }

    setText('r-tx', payload?.tx);
    setText('r-result', sum.result || (ok ? '—' : 'unknown'));
    setText('r-name', sum.name);
    setText('r-ts', sum.consensusTimestamp);
    setText('r-valid-start', sum.validStartTimestamp);
    setText('r-payer', sum.payer);
    setText('r-recipient', sum.recipient);
    setText('r-operator', sum.operator);

    const amtHBAR = (sum.amountHbar != null) ? `${sum.amountHbar} HBAR (${sum.amountTinybar} tinybar)` : null;
    setText('r-amount', amtHBAR);
    setText('r-max-fee', sum.maxFeeTinybar != null ? `${sum.maxFeeTinybar / 100000000} HBAR (${sum.maxFeeTinybar} tinybar)` : null);
    setText('r-fee', sum.chargedTxFeeTinybar != null ? `${sum.chargedTxFeeTinybar} tinybar` : null);
    setText('r-memo-b64', sum.memoBase64);
    setText('r-memo-utf8', sum.memoUtf8);
    setText('r-node', sum.node);
    setHref('r-mirror', payload?.mirrorUrl);
    setHref('r-hashscan', payload?.hashscanUrl);
    setText('r-captured', payload?.capturedAt);

    document.getElementById('r-raw').textContent = JSON.stringify(payload, null, 2);
  }

  async function probe(tx, asJson) {
    if (asJson) {
      return { ok: false, error: 'not-used' };
    }
    const url = `/api/receipt?tx=${encodeURIComponent(tx)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000); // client-side guard; server enforces 5s
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => null);
      return { ok: res.ok, data, status: res.status };
    } catch (err) {
      return { ok: false, error: err?.name === 'AbortError' ? 'client_timeout' : 'network_error', detail: String(err?.message || err) };
    } finally {
      clearTimeout(t);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tx = (txInput.value || '').trim();
    if (!tx) {
      showError('Please enter a Hedera transaction ID.');
      return;
    }
    probeBtn.disabled = true;
    probeBtn.textContent = 'Verifying…';
    try {
      const out = await probe(tx);
      if (out.ok && out.data) {
        showResult(out.data);
      } else {
        if (out.data) {
          showResult(out.data); // server returns 200 even for mirror errors but with ok=false
        } else {
          showError(`${out.error || 'request_failed'}${out.detail ? ` — ${out.detail}` : ''}`);
        }
      }
    } finally {
      probeBtn.disabled = false;
      probeBtn.textContent = 'Verify';
    }
  });

  // On load: automatically probe the canonical tx if no ?tx was supplied.
  function bootInitial() {
    const params = new URLSearchParams(window.location.search);
    const initialTx = (params.get('tx') || '').trim() || CANONICAL_TX;
    txInput.value = initialTx;
    if (params.has('tx') || !sessionStorage.getItem('w6-receipt-loaded')) {
      sessionStorage.setItem('w6-receipt-loaded', '1');
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootInitial);
  } else {
    bootInitial();
  }
})();
