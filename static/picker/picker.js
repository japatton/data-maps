// The only module that touches the page: selects, hash, fetches, buttons.
import { parseHash, formatHash } from "./hash.js";
import { resolve, select, options, current } from "./state.js";
import { headerHtml, artifactHtml, downloadsHtml } from "./render.js";

const el = (id) => document.getElementById(id);
let index = null;
let state = null;
let loaded = { path: null, cribl: null, ingest: null, map: null };
let blobUrl = null;
// Bumped on every fetch so a slow earlier selection cannot render over a
// newer one when the responses come back out of order.
let requestId = 0;

function fill(selectEl, items, value, label) {
  selectEl.innerHTML = '<option value="">—</option>';
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item.id !== undefined ? item.id : item.format;
    opt.textContent = label(item);
    if (opt.value === value) opt.selected = true;
    selectEl.appendChild(opt);
  }
  selectEl.disabled = items.length === 0;
}

function syncForm() {
  const o = options(index, state);
  fill(el("pick-tech"), o.techs, state.tech, (t) => t.name + " (" + t.category + ")");
  fill(el("pick-dataset"), o.datasets, state.dataset, (d) => d.name || d.id);
  fill(el("pick-format"), o.formats, state.format,
       (f) => f.format + (f.recommended ? " · recommended" : ""));
  el("pick-cribl").checked = state.cribl;
  el("pick-dest").value = state.dest;
}

function notice(text) {
  const p = el("picker-notice");
  p.hidden = !text;
  p.textContent = text || "";
}

function getJson(url) {
  return fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

function getText(url) {
  return fetch(url).then((r) => (r.ok ? r.text() : "")).catch(() => "");
}

function loadArtifacts(sel) {
  const path = sel.format.path;
  if (loaded.path === path) return Promise.resolve(loaded);
  const wants = sel.format.has_cribl_pipeline;
  const id = ++requestId;
  return Promise.all([
    getText("exports/map/" + path + ".html"),
    wants ? getJson("exports/cribl/" + path + ".json") : Promise.resolve(null),
    wants ? getJson("exports/ingest/" + path + ".json") : Promise.resolve(null),
  ]).then((results) => {
    if (id !== requestId) return null;
    const data = { path, map: results[0], cribl: results[1], ingest: results[2] };
    // Memoise a complete result only.  getJson and getText swallow a failed
    // request into null/"", so caching one under its path would leave that
    // block broken for the rest of the session and, worse, read as an
    // unauthored block; leaving loaded.path alone makes the next selection
    // of this block try again.
    if (data.map && (!wants || (data.cribl && data.ingest))) loaded = data;
    return data;
  });
}

function wireButtons(sel, data) {
  const root = el("result-artifact");
  for (const button of root.querySelectorAll("button[data-copy]")) {
    button.addEventListener("click", () => {
      const which = button.getAttribute("data-copy");
      const text = which === "cribl"
        ? JSON.stringify(data.cribl, null, 2)
        : JSON.stringify(data.ingest.pipeline, null, 2);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => { button.textContent = "Copied"; });
      }
    });
  }
  const download = root.querySelector("a[data-download='ingest']");
  if (download && data.ingest) {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    const body = JSON.stringify(data.ingest.pipeline, null, 2) + "\n";
    blobUrl = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    download.href = blobUrl;
  }
}

function renderResult() {
  const sel = current(index, state);
  const result = el("picker-result");
  if (!sel) {
    result.hidden = true;
    return;
  }
  loadArtifacts(sel).then((data) => {
    if (!data) return;
    el("result-header").innerHTML = headerHtml(sel);
    el("result-map").innerHTML = downloadsHtml(sel.format.path)
      + '<div class="format-variant active">' + (data.map || "<p>Map unavailable.</p>") + "</div>";
    el("result-artifact").innerHTML = artifactHtml(sel, state, data);
    wireButtons(sel, data);
    result.hidden = false;
  }).catch(() => {
    notice("The result could not be loaded; try again.");
    result.hidden = true;
  });
}

function apply(next, pushHash) {
  state = next;
  syncForm();
  if (pushHash) {
    const hash = formatHash(state);
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }
  renderResult();
}

function fromHash() {
  const r = resolve(index, parseHash(location.hash));
  notice(r.notice);
  apply(r.state, true);
}

function onChange(level) {
  return (event) => {
    const value = level === "cribl" ? event.target.checked : event.target.value;
    notice(null);
    apply(select(index, state, level, value), true);
  };
}

getJson("exports/picker.json").then((idx) => {
  if (!idx) {
    notice("The picker index could not be loaded.");
    return;
  }
  index = idx;
  el("pick-tech").addEventListener("change", onChange("tech"));
  el("pick-dataset").addEventListener("change", onChange("dataset"));
  el("pick-format").addEventListener("change", onChange("format"));
  el("pick-cribl").addEventListener("change", onChange("cribl"));
  el("pick-dest").addEventListener("change", onChange("dest"));
  window.addEventListener("hashchange", fromHash);
  fromHash();
});
