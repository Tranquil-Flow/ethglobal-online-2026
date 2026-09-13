#!/usr/bin/env node
// Hedera mirror receipt page server (loopback-only).
// Reads ONLY from the public Hedera mirror node — no keys, no signed payloads.
// Author: Lane Hedera-Mirror-Receipt-Page (w6-v2)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');

const HOST = '127.0.0.1';
const PORT = 4364;
const PROBE_TIMEOUT_MS = 5000;
const MIRROR_BASE = 'https://testnet.mirrornode.hedera.com/api/v1/transactions';
const HASHSCAN_BASE = 'https://hashscan.io/testnet/transaction';
const CANONICAL_TX = '0.0.7162784-1789239567-211071753';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
};

function decodeMemoBase64(b64) {
  try {
    if (!b64) return '';
    const buf = Buffer.from(b64, 'base64');
    return buf.toString('utf-8');
  } catch {
    return '';
  }
}

function tinybarToHbar(tb) {
  if (typeof tb !== 'number') return null;
  // 1 HBAR = 100,000,000 tinybar
  return tb / 100_000_000;
}

function summarizeTx(rawTx, txId) {
  // Identify direction of the transfer: payer -> recipient.
  // Payer account id is parsed from the transaction id (0.0.<payer>).
  const payerFromId = (txId || '').split('-')[0] || null;

  // Pick the recipient: highest-positive non-treasury, non-payer transfer.
  // Treasury for tx fees is 0.0.802 (well-known Node treasury fee account).
  let recipient = null;
  let operator = null;
  let recipientAmount = null;
  let operatorAmount = null;

  const transfers = Array.isArray(rawTx?.transfers) ? rawTx.transfers : [];
  for (const t of transfers) {
    if (t.account === '0.0.802') continue;
    if (typeof t.amount !== 'number') continue;
    const amount = t.amount;
    if (amount > 0 && t.account !== payerFromId) {
      // candidate recipient; pick the largest positive
      if (!recipient || amount > recipientAmount) {
        recipient = t.account;
        recipientAmount = amount;
      }
    }
    if (amount < 0 && t.account !== payerFromId) {
      // operator alt transfer (negative); pick the largest debit magnitude
      if (!operator || Math.abs(amount) > Math.abs(operatorAmount ?? 0)) {
        operator = t.account;
        operatorAmount = amount;
      }
    }
  }

  // Amount tinybar is the credit to the recipient (for a 1-recipient transfer).
  const amountTinybar = typeof recipientAmount === 'number' ? recipientAmount : null;

  return {
    result: rawTx?.result ?? null,
    name: rawTx?.name ?? null,
    consensusTimestamp: rawTx?.consensus_timestamp ?? null,
    validStartTimestamp: rawTx?.valid_start_timestamp ?? null,
    transactionId: rawTx?.transaction_id ?? null,
    payer: payerFromId,
    recipient,
    operator,
    amountTinybar,
    amountHbar: tinybarToHbar(amountTinybar),
    maxFeeTinybar: rawTx?.max_fee != null ? Number(rawTx.max_fee) : null,
    chargedTxFeeTinybar: typeof rawTx?.charged_tx_fee === 'number' ? rawTx.charged_tx_fee : null,
    memoBase64: rawTx?.memo_base64 ?? null,
    memoUtf8: decodeMemoBase64(rawTx?.memo_base64),
    node: rawTx?.node ?? null,
    transactionHash: rawTx?.transaction_hash ?? null,
    transfers,
  };
}

async function fetchMirrorTx(txId, signal) {
  const url = `${MIRROR_BASE}/${encodeURIComponent(txId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'w6-hedera-receipt-page/1.0 (+loopback)' },
    signal,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { ok: res.ok, status: res.status, url, json, rawText: text };
}

async function probeReceipt(txId) {
  const capturedAt = new Date().toISOString();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('mirror probe timeout')), PROBE_TIMEOUT_MS);
  try {
    const out = await fetchMirrorTx(txId, ac.signal);
    if (!out.ok) {
      return {
        tx: txId,
        capturedAt,
        mirrorUrl: out.url,
        ok: false,
        error: `mirror_node_http_${out.status}`,
        errorDetail: out.json?.message || out.rawText?.slice(0, 200) || null,
      };
    }
    const list = Array.isArray(out.json?.transactions) ? out.json.transactions : [];
    if (list.length === 0) {
      return {
        tx: txId,
        capturedAt,
        mirrorUrl: out.url,
        ok: false,
        error: 'not_found',
        errorDetail: 'mirror returned empty transactions[]',
      };
    }
    const raw = list[0];
    const summary = summarizeTx(raw, txId);
    return {
      tx: txId,
      capturedAt,
      mirrorUrl: out.url,
      ok: true,
      summary,
      hashscanUrl: `${HASHSCAN_BASE}/${encodeURIComponent(txId)}`,
      links: {
        mirror: out.url,
        hashscan: `${HASHSCAN_BASE}/${encodeURIComponent(txId)}`,
      },
    };
  } catch (err) {
    return {
      tx: txId,
      capturedAt,
      mirrorUrl: `${MIRROR_BASE}/${encodeURIComponent(txId)}`,
      ok: false,
      error: err?.name === 'AbortError' ? 'mirror_timeout' : 'mirror_unreachable',
      errorDetail: String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'access-control-allow-origin': 'http://127.0.0.1:4364',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = String(text);
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = normalize(rel).replace(/^([/\\.]+)/, '/');
  const filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    sendText(res, 200, data, MIME[ext] || 'application/octet-stream');
  } catch {
    sendText(res, 404, 'not found');
  }
}

async function readJsonBody(req, max = 8 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    let total = 0;
    const chunks = [];
    req.on('data', c => {
      total += c.length;
      if (total > max) { rejectBody(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      try { resolveBody(raw ? JSON.parse(raw) : {}); } catch (e) { rejectBody(e); }
    });
    req.on('error', rejectBody);
  });
}

const server = http.createServer(async (req, res) => {
  // Loopback-only. Reject anything that doesn't target 127.0.0.1:4364.
  const sock = req.socket;
  if (!sock || sock.remoteAddress !== '127.0.0.1') {
    sendText(res, 403, 'loopback-only');
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const { pathname } = url;
  const method = (req.method || 'GET').toUpperCase();

  // OPTIONS (CORS preflight)
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': 'http://127.0.0.1:4364',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
    });
    res.end();
    return;
  }

  // Health
  if (pathname === '/healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true, host: HOST, port: PORT, ts: new Date().toISOString() });
    return;
  }

  // GET /api/receipt?tx=...
  if (pathname === '/api/receipt' && method === 'GET') {
    const tx = (url.searchParams.get('tx') || '').trim();
    if (!tx) {
      sendJson(res, 400, { ok: false, error: 'missing_tx', errorDetail: 'provide ?tx=<hedera-tx-id>' });
      return;
    }
    const out = await probeReceipt(tx);
    sendJson(res, 200, out);
    return;
  }

  // POST /api/receipt — body { "tx": "..." }
  if (pathname === '/api/receipt' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const tx = String(body?.tx || '').trim();
      if (!tx) {
        sendJson(res, 400, { ok: false, error: 'missing_tx' });
        return;
      }
      const out = await probeReceipt(tx);
      sendJson(res, 200, out);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: 'bad_request', errorDetail: String(err?.message || err) });
    }
    return;
  }

  if (method === 'GET') {
    await serveStatic(req, res, pathname);
    return;
  }

  sendText(res, 405, 'method not allowed');
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[w6-hedera-receipt] listening on http://${HOST}:${PORT}  (canonical_tx=${CANONICAL_TX})`);
});

// Export CANONICAL_TX for any caller wanting it (e.g. an evidence manifest).
export { CANONICAL_TX, MIRROR_BASE, HASHSCAN_BASE, HOST, PORT };
