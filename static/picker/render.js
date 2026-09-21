// HTML for the result panel.  Pure string builders so the Node tests can
// hold the texts; picker.js puts them in the DOM and wires the buttons.

export function esc(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Element text, not an attribute value: a quote needs no escaping there, and
// leaving it alone keeps a pipeline body readable as the JSON it is (and
// keeps what the tests read identical to what a copy button would hand over).
function escText(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const ELASTIC_PARSES = ["elastic-integration", "elastic-ingest-pipeline"];

export function headerHtml(sel) {
  const f = sel.format;
  return '<h2 class="result-title">' + esc(sel.tech.name) + ' <span class="muted">/</span> '
    + esc(sel.dataset.name || sel.dataset.id) + ' <span class="muted">/</span> <code>'
    + esc(f.format) + "</code></h2>"
    + '<p class="parsing"><span class="chip">' + esc(f.mechanism) + "</span>"
    + (f.artifact ? " " + esc(f.artifact) : "") + "</p>";
}

export function downloadsHtml(path) {
  const base = "exports/map/" + path;
  return '<p class="downloads">Download the map: '
    + '<a href="' + esc(base) + '.json" download>JSON</a> · '
    + '<a href="' + esc(base) + '.md" download>Markdown</a> · '
    + '<a href="' + esc(base) + '.csv" download>CSV</a></p>';
}

function downstreamNote(f) {
  return '<p class="downstream-note">Parsing happens downstream in ' + esc(f.artifact || f.mechanism)
    + "; this pipeline only identifies the event and tags event.dataset.</p>";
}

function coverageBadge(c) {
  let text = c.translated + " of " + c.total + " steps translated";
  if (c.partial) text += ", " + c.partial + " partial";
  if (c.manual) text += ", " + c.manual + " manual";
  const cls = c.manual || c.partial ? "coverage-badge coverage-partial" : "coverage-badge coverage-full";
  return '<span class="' + cls + '">' + esc(text) + "</span>";
}

// An empty id attribute is invalid HTML, so the nested pres inside the
// manual steps carry none at all.
function pre(id, text) {
  return '<pre class="artifact mono"' + (id ? ' id="' + esc(id) + '"' : "") + ">"
    + escText(text) + "</pre>";
}

export function artifactHtml(sel, state, data) {
  const f = sel.format;
  if (f.mechanism === "none") {
    return '<h3>Parser</h3><p class="artifact-note">Cribl is not in this path for this feed.</p>';
  }
  if (!f.has_cribl_pipeline || !data.cribl || !data.ingest) {
    return '<h3>Parser</h3><p class="artifact-note">No pipeline has been authored for this block yet. '
      + 'See the <a href="tech/' + esc(sel.tech.id) + '.html">technology page</a>.</p>';
  }
  const parts = [];
  if (state.cribl) {
    parts.push("<h3>Cribl Stream pipeline</h3>");
    if (ELASTIC_PARSES.indexOf(f.mechanism) !== -1) parts.push(downstreamNote(f));
    parts.push('<p class="artifact-actions"><button type="button" data-copy="cribl">Copy</button> '
      + '<a href="exports/cribl/' + esc(f.path) + '.json" download>Download</a> '
      + "<code>" + esc(data.cribl.id) + "</code></p>");
    parts.push(pre("artifact-cribl", JSON.stringify(data.cribl, null, 2)));
    return parts.join("\n");
  }
  const env = data.ingest;
  parts.push("<h3>Elasticsearch ingest pipeline</h3>");
  if (ELASTIC_PARSES.indexOf(f.mechanism) !== -1) parts.push(downstreamNote(f));
  parts.push('<p class="artifact-actions">' + coverageBadge(env.coverage)
    + ' <button type="button" data-copy="ingest">Copy</button> '
    + '<a href="#" data-download="ingest" download="' + esc(env.id) + '.ingest.json">Download</a> '
    + "<code>PUT _ingest/pipeline/" + esc(env.id) + "</code></p>");
  if (env.requires && env.requires.length) {
    parts.push('<p class="artifact-note">Requires: ' + env.requires.map(esc).join(", ")
      + " (set <code>script.painless.regex.enabled: true</code> on the node).</p>");
  }
  parts.push(pre("artifact-ingest", JSON.stringify(env.pipeline, null, 2)));
  if (env.notes && env.notes.length) {
    parts.push("<h4>Notes</h4><ul class=\"notes\">" + env.notes.map((n) => "<li>" + esc(n) + "</li>").join("") + "</ul>");
  }
  if (env.manual_steps && env.manual_steps.length) {
    parts.push("<h4>Manual steps</h4><ol class=\"manual-steps\">");
    for (const step of env.manual_steps) {
      parts.push('<li class="manual-step"><strong>' + esc(step.function) + "</strong>"
        + (step.partial ? ' <span class="chip">partial</span>' : "")
        + (step.description ? " — " + esc(step.description) : "")
        + '<br><span class="muted">' + esc(step.reason) + "</span>"
        + "<details><summary>Original Cribl function</summary>"
        + pre("", JSON.stringify(step.original, null, 2)) + "</details></li>");
    }
    parts.push("</ol>");
  }
  parts.push('<p class="artifact-note">Field map: ' + Object.keys(env.field_map || {})
    .map((k) => "<code>" + esc(k) + "</code> → <code>" + esc(env.field_map[k]) + "</code>").join(", ") + "</p>");
  return parts.join("\n");
}
