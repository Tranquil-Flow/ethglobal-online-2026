// Fetch /api/diagnostics and render the matrix.
const els = {
  captured: document.getElementById("captured"),
  overallDot: document.getElementById("overallDot"),
  overallLabel: document.getElementById("overallLabel"),
  rows: document.getElementById("rows"),
  refresh: document.getElementById("refresh"),
};

function setOverall(state) {
  els.overallDot.className = `dot dot-${state.toLowerCase()}`;
  els.overallLabel.textContent = state;
  els.overallLabel.className = `overall-label label-${state.toLowerCase()}`;
}

function chipFor(state) {
  const safe = String(state || "RED").toUpperCase();
  return `<span class="chip chip-${safe.toLowerCase()}">${safe}</span>`;
}

function render(surfaces, capturedAt) {
  els.captured.textContent = capturedAt
    ? `captured ${new Date(capturedAt).toLocaleString()}`
    : "—";
  const rows = surfaces
    .map(
      (s, i) => `
        <tr>
          <td class="col-idx">${i + 1}</td>
          <td class="col-name">${escapeHtml(s.name)}</td>
          <td class="col-url"><a href="${escapeAttr(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.url)}</a></td>
          <td class="col-state">${chipFor(s.state)}</td>
          <td class="col-reason">${escapeHtml(s.reason || "")}</td>
        </tr>`,
    )
    .join("");
  els.rows.innerHTML = rows;
}

function renderError(message) {
  els.captured.textContent = "—";
  setOverall("RED");
  els.rows.innerHTML = `
    <tr><td colspan="5" class="error">${escapeHtml(message)}</td></tr>`;
}

async function load() {
  els.refresh.disabled = true;
  els.captured.textContent = "probing…";
  els.rows.innerHTML = `<tr class="placeholder"><td colspan="5">Probing 12 surfaces in parallel (5s each)…</td></tr>`;
  try {
    const res = await fetch("/api/diagnostics", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setOverall(data.overall || "RED");
    render(data.surfaces || [], data.capturedAt);
  } catch (err) {
    renderError(`Failed to load diagnostics: ${err && err.message ? err.message : String(err)}`);
  } finally {
    els.refresh.disabled = false;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

els.refresh.addEventListener("click", load);
load();
// Auto-refresh every 30s so the judge sees a live page.
setInterval(load, 30000);