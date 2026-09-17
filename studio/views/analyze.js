// #/analyze — the log analysis workbench.
//
// Paste or open a vendor export; a model says which catalog entry it is and
// how well that entry covers it; Elasticsearch says which of the mapped ECS
// targets are actually populated. The output is a report: nothing here ever
// writes to the editor or to the repository.
//
// Every decision this view makes — what the sample is, which buttons may be
// pressed, what a run does, which finished steps still describe what is on
// screen — lives in lib/analysis-state.js and is tested there.  What is left
// here is the painting.
//
// Everything the model returns is untrusted text. It only ever reaches the
// page through `h()`'s text nodes, and only ever reaches Markdown through
// `reportMarkdown`'s escaping.

import { h, clear } from "../lib/dom.js";
import { selectField } from "../lib/forms.js";
import { createClient } from "../lib/llm.js";
import { dataStreamOf, sampleDataStream } from "../lib/elastic.js";
import { reportMarkdown } from "../lib/report.js";
import { isExcluded, oversize, formatSize, byteLength } from "../lib/examples.js";
import { attachExample } from "../lib/editor-state.js";
import { globalObject } from "../lib/global.js";
import {
  MAX_INPUT_LABEL, state, clipEdit, endpointHost, endpointLabel, setText,
  sampleInfo, shown, pick, ensureDoc, prefill, datasetsOf, formatsOf,
  identifyRules, assessRules, elasticRules, loadSources, runIdentify,
  runAssess, runElastic, reportInput, message,
} from "../lib/analysis-state.js";

// The pure helpers the tests reach for through this module.
export { clipEdit, endpointHost, endpointLabel };

const OBSERVED_COLUMNS = [
  "field", "example", "in inventory", "inventory field", "suggested ECS",
  "status", "note",
];

// The paint functions of the most recent render. A request that finishes
// after the view was rebuilt (a trip to Settings and back) still updates the
// state above, and then repaints through whichever view is mounted now.
let panels = null;

function repaint(...keys) {
  if (!panels) return;
  for (const key of keys) {
    const paint = panels[key];
    if (paint) paint();
  }
}

// --- what the runs are given ---------------------------------------------

function llmConfig(ctx) {
  const analysis = ctx.effective().analysis || {};
  return {
    apiKind: analysis.api_kind,
    apiUrl: analysis.api_url,
    model: analysis.model,
    apiVersion: analysis.api_version,
    apiKey: analysis.api_key,
  };
}

function elasticConfig(ctx) {
  const elastic = ctx.effective().elastic || {};
  return { url: elastic.url, apiKey: elastic.api_key };
}

// The document cache, as the state module reads it.
function docsOf(ctx) {
  return {
    has: (id) => ctx.sourcesCache.has(id),
    get: (id) => ctx.sourcesCache.get(id),
    load: (id) => ctx.loadSource(id),
  };
}

function picked(ctx) {
  return pick({ state, catalog: ctx.catalog, docs: docsOf(ctx) });
}

function identifyDeps(ctx) {
  return {
    state,
    repaint,
    catalog: ctx.catalog,
    docs: docsOf(ctx),
    client: createClient(llmConfig(ctx)),
    sampleInfo: () => sampleInfo(state),
    loadSources: (signal) => loadSources({
      state, catalog: ctx.catalog, load: (id) => ctx.loadSource(id),
      repaint, signal,
    }),
  };
}

function assessDeps(ctx) {
  return {
    state,
    repaint,
    schema: ctx.schema,
    client: createClient(llmConfig(ctx)),
    sampleInfo: () => sampleInfo(state),
    choice: () => picked(ctx),
  };
}

function elasticDeps(ctx) {
  return {
    state,
    repaint,
    config: elasticConfig(ctx),
    client: { sample: sampleDataStream },
    choice: () => picked(ctx),
  };
}

// The Cancel button and the timeout share one path: abort the run's own
// controller and let its catch report the cancellation.
function cancelRun(key) {
  const controller = state[key].controller;
  if (controller) controller.abort();
}

export function render(root, ctx) {
  // The shell bumps this before every route render.  The state module's
  // state outlives this view on purpose - a run started here and finished
  // after a trip to Settings still records its answer - but the nodes below
  // do not, so nothing this render owns is painted once another route has
  // been drawn.  Whichever view is mounted then paints that answer itself.
  const gen = ctx.generation;
  const view = {
    ctx,
    live: () => ctx.generation === gen,
    sampleLine: h("p", { class: "help" }),
    identifyBox: h("div", {}),
    choiceBox: h("div", {}),
    assessBox: h("div", {}),
    // Its own panel, because the whole panel disappears when there is no
    // Elastic URL or the dataset's route names no data stream.
    elasticBox: h("div", { class: "panel" }),
    reportBox: h("div", {}),
  };

  const input = h("textarea", {
    rows: "10",
    class: "mono",
    "aria-label": "Log sample",
    placeholder: "Paste a few lines of the vendor export…",
    value: state.text,
    oninput: (event) => {
      const target = event.target;
      const incoming = String(target.value);
      const caret = typeof target.selectionStart === "number"
        ? target.selectionStart : null;
      setText(state, incoming, null);
      // A paste over the cap is truncated; the box must show what was kept,
      // or the admin reads one sample on screen and Studio sends another.
      const edit = clipEdit(incoming, state.text, caret);
      if (edit) {
        target.value = edit.value;
        if (typeof target.setSelectionRange === "function") {
          target.setSelectionRange(edit.caret, edit.caret);
        }
      }
      // Every step downstream of the sample may have just gone stale.
      repaint("sample", "identify", "assess", "report");
    },
  });

  const file = h("input", {
    type: "file",
    "aria-label": "Log file",
    onchange: (event) => {
      const chosen = event.target.files && event.target.files[0];
      if (!chosen) return;
      readFile(chosen).then((text) => {
        setText(state, text, chosen.name);
        if (input.isConnected) input.value = state.text;
        repaint("sample", "identify", "assess", "elastic", "report");
      }, (err) => {
        // The file was not read, so nothing changed: whatever was pasted
        // before is still the sample, and still what the buttons act on.
        repaint("sample", "identify", "assess", "elastic", "report");
        if (!view.live()) return;
        clear(view.sampleLine).appendChild(h("span", { class: "error" },
          `Could not read ${chosen.name}: ${message(err)}`));
      });
    },
  });

  root.appendChild(h("section", { class: "analyze" },
    h("h1", {}, "Analyze a log sample"),
    h("p", { class: "muted" },
      "The sample is sent to the analysis endpoint configured in Settings, " +
      "and nowhere else. Nothing here writes to the catalog."),
    h("div", { class: "panel" },
      h("h2", {}, "Log sample"),
      input,
      h("div", { class: "btn-row" }, file),
      view.sampleLine),
    h("div", { class: "panel" }, h("h2", {}, "1. Identify"), view.identifyBox),
    h("div", { class: "panel" }, h("h2", {}, "2. Catalog entry"),
      view.choiceBox),
    h("div", { class: "panel" }, h("h2", {}, "3. Assess"), view.assessBox),
    view.elasticBox,
    h("div", { class: "panel" }, h("h2", {}, "Report"), view.reportBox)));

  panels = {
    sample: () => paintSample(view),
    identify: () => paintIdentify(view),
    choice: () => paintChoice(view),
    assess: () => paintAssess(view),
    elastic: () => paintElastic(view),
    report: () => paintReport(view),
  };
  // A technology chosen before a reload has no document in the cache yet.
  ensureDoc(state.choice.techId, { state, docs: docsOf(ctx), repaint });
  repaint("sample", "identify", "choice", "assess", "elastic", "report");
}

// --- the sample -----------------------------------------------------------

function paintSample(view) {
  if (!view.live()) return;
  const line = clear(view.sampleLine);
  if (state.text.trim() === "") {
    line.appendChild(h("span", { class: "muted" }, "Nothing pasted yet."));
    return;
  }
  const info = sampleInfo(state);
  const bits = [
    `Will send: first ${info.lines} ` +
    `${info.lines === 1 ? "line" : "lines"} (${info.bytes} bytes)` +
    ` of ${info.totalLines} ${info.totalLines === 1 ? "line" : "lines"}.`,
  ];
  if (state.fileName) bits.push(`Read from ${state.fileName}.`);
  if (state.clipped) {
    bits.push(`Only the first ${MAX_INPUT_LABEL} of the input was kept.`);
  }
  line.appendChild(h("span", {}, bits.join(" ")));
}

// --- step 1: identify -----------------------------------------------------

function paintIdentify(view) {
  if (!view.live()) return;
  const ctx = view.ctx;
  const box = clear(view.identifyBox);
  const step = shown(state, state.identify, "identify");
  const rules = identifyRules({ state, step, config: llmConfig(ctx) });
  const start = () => { runIdentify(identifyDeps(ctx)); };
  box.appendChild(h("div", { class: "btn-row" },
    h("button", {
      type: "button", class: "btn btn-primary",
      disabled: !rules.enabled,
      onclick: start,
    }, step.status === "done" ? "Identify again" : "Identify"),
    stepStatus(step, progressLabel(), start, () => cancelRun("identify"))));
  // Which box the run will talk to, next to the button that starts it.
  // A site that pins the endpoint draws no fields in Settings, so this is
  // the only place the answer appears while the work is being done — and
  // it is worth showing when the endpoint is overridable too, because the
  // commonest analysis mistake is a run sent to yesterday's model.
  const endpoint = endpointLabel(ctx.effective().analysis);
  if (endpoint) box.appendChild(h("p", { class: "help" }, endpoint));
  if (!rules.ready) {
    box.appendChild(h("p", { class: "notice" },
      "No analysis URL or model is configured. ",
      h("a", { href: "#/settings" }, "Set them in Settings"),
      "."));
  } else if (!rules.hasText) {
    box.appendChild(h("p", { class: "help" },
      "Paste or open a log sample first."));
  }
  if (step.error) box.appendChild(errorDetail(step.error));
  if (step.status === "done") box.appendChild(identifyResult(step.result));
}

function progressLabel() {
  if (state.progress) {
    return `reading the catalog: ${state.progress.done} of ` +
      `${state.progress.total} technologies…`;
  }
  return "asking the model…";
}

function identifyResult(result) {
  if (!result || typeof result !== "object") {
    return h("p", { class: "error" }, "The model returned nothing usable.");
  }
  const box = h("div", {});
  box.appendChild(h("p", { class: "kv-line" },
    keyValue("Technology", result.technology_id),
    keyValue("Dataset", result.dataset_id),
    keyValue("Format", result.format),
    keyValue("Confidence", result.confidence)));
  if (result.unknown && (result.unknown.name || result.unknown.vendor)) {
    box.appendChild(h("p", { class: "notice" },
      "Not in the catalog: " + flat(result.unknown.name) +
      " (" + flat(result.unknown.vendor) + ")"));
  }
  const evidence = asList(result.evidence);
  box.appendChild(h("h3", {}, "Evidence"));
  box.appendChild(evidence.length
    ? h("ul", {}, evidence.map((item) => h("li", { class: "mono" }, flat(item))))
    : h("p", { class: "muted" }, "None given."));
  const alternatives = asList(result.alternatives);
  if (alternatives.length) {
    box.appendChild(h("h3", {}, "Alternatives"));
    box.appendChild(h("ul", {}, alternatives.map((alt) => h("li", {},
      h("span", { class: "mono" }, orDash(alt && alt.technology_id)),
      " / ",
      h("span", { class: "mono" }, orDash(alt && alt.dataset_id)),
      " — " + flat(alt && alt.reason)))));
  }
  return box;
}

// --- the chosen catalog entry ---------------------------------------------

function paintChoice(view) {
  if (!view.live()) return;
  const ctx = view.ctx;
  const box = clear(view.choiceBox);
  const { doc, dataset } = picked(ctx);
  const techOptions = (ctx.catalog || [])
    .filter((row) => row && row.id)
    .map((row) => ({ value: row.id, label: `${row.id} — ${row.name || ""}` }));
  const datasetOptions = datasetsOf(doc)
    .filter((item) => item && item.id)
    .map((item) => ({ value: item.id, label: `${item.id} — ${item.name || ""}` }));
  const formatOptions = formatsOf(dataset)
    .filter((item) => item && item.format)
    .map((item) => item.format);

  box.appendChild(h("div", { class: "choice-row" },
    selectField({
      label: "Technology",
      value: state.choice.techId,
      options: techOptions,
      allowEmpty: true,
      onChange: (value) => {
        state.choice = { techId: value, datasetId: "", format: "" };
        ensureDoc(value, { state, docs: docsOf(ctx), repaint });
        repaint("choice", "assess", "elastic", "report");
      },
    }),
    selectField({
      label: "Dataset",
      value: state.choice.datasetId,
      options: datasetOptions,
      allowEmpty: true,
      onChange: (value) => {
        state.choice.datasetId = value;
        state.choice.format = "";
        repaint("choice", "assess", "elastic", "report");
      },
    }),
    selectField({
      label: "Format",
      value: state.choice.format,
      options: formatOptions,
      allowEmpty: true,
      onChange: (value) => {
        state.choice.format = value;
        repaint("choice", "assess", "elastic", "report");
      },
    })));

  if (state.choice.techId && !doc) {
    box.appendChild(missingDocNote(ctx, state.choice.techId));
  }
  if (dataset) box.appendChild(attachRow(ctx, dataset));
}

// The sample in the box is a real record of exactly the kind
// data/examples/ is for, so once a dataset is named it can be attached to
// it without being pasted a second time.  Nothing is written to the
// document: the record travels to the editor, where it is listed, checked
// and committed with everything else.
function attachRow(ctx, dataset) {
  const techId = state.choice.techId;
  const blocked = isExcluded(ctx.schema, techId);
  const empty = state.text.trim() === "";
  const why = blocked
    ? `'${techId}' takes no example records: its documentation is `
      + "controlled."
    : (empty ? "Paste a sample above first." : "");
  return h("div", { class: "btn-row" },
    h("button", {
      type: "button", class: "btn", disabled: blocked || empty,
      onclick: () => { attachSample(ctx, dataset.id); },
    }, `Attach this sample to ${dataset.id}`),
    h("span", { class: "help" }, why || attachNote()));
}

function attachNote() {
  const size = byteLength(state.text);
  return `${formatSize(size)} — committed verbatim as an example record`
    + (oversize(state.text)
      ? ", which is over the size the build asks for" : "")
    + (state.clipped
      ? "; the sample was clipped to " + MAX_INPUT_LABEL : "")
    + ".";
}

// Straight into the store when it already holds this technology (the
// record would otherwise be dropped by the load), and through the context
// otherwise: the editor takes it once it has settled which document it is
// showing, so an unresumed draft is still the admin's to decide about.
//
// A record attached into the open store is written to the draft as it
// lands.  The store already holds this technology, so the editor will keep
// it rather than reload - there is no draft banner to overwrite - and
// nothing else would persist the record until the admin typed.
function attachSample(ctx, datasetId) {
  const techId = state.choice.techId;
  if (!techId || !datasetId || state.text.trim() === "") return;
  const store = ctx.store;
  if (store.id === techId && store.doc !== null) {
    attachExample(store, { dataset: datasetId, label: "",
                           content: state.text }, null);
  } else {
    ctx.pendingExample = {
      tech: techId, dataset: datasetId, label: "", content: state.text,
    };
  }
  ctx.navigate(`#/tech/${encodeURIComponent(techId)}`);
}

// Why there is no document: a technology that is only planned has no file
// yet, but a mapped one that will not load is a failure to report.
function missingDocNote(ctx, id) {
  // ctx.loadSource rejects for everything but a genuine 404, and its
  // message already names the path it tried.
  const failure = state.docErrors[id];
  if (failure) {
    return h("p", { class: "error" },
      `Could not load this technology's map — ${failure}`);
  }
  const row = (ctx.catalog || []).find((item) => item && item.id === id);
  const status = row ? String(row.status || "") : "";
  if (status && status !== "planned") {
    return h("p", { class: "error" },
      `There is no source/${id}.json, although the catalog says this ` +
      `technology is ${status}.`);
  }
  return h("p", { class: "help" },
    "That technology has no map file yet, so there is nothing to assess.");
}

// --- step 2: assess -------------------------------------------------------

function paintAssess(view) {
  if (!view.live()) return;
  const ctx = view.ctx;
  const box = clear(view.assessBox);
  const step = shown(state, state.assess, "assess");
  const rules = assessRules({
    state, step, config: llmConfig(ctx), picked: picked(ctx),
  });
  const start = () => { runAssess(assessDeps(ctx)); };
  box.appendChild(h("div", { class: "btn-row" },
    h("button", {
      type: "button", class: "btn btn-primary",
      disabled: !rules.enabled,
      onclick: start,
    }, step.status === "done" ? "Assess again" : "Assess"),
    stepStatus(step, "asking the model…", start, () => cancelRun("assess"))));
  if (rules.identifying) {
    box.appendChild(h("p", { class: "help" },
      "Waiting for the identification, which chooses the entry below."));
  } else if (!rules.chosen) {
    box.appendChild(h("p", { class: "help" },
      "Choose a technology, dataset and format above."));
  }
  if (step.error) box.appendChild(errorDetail(step.error));
  if (step.status === "done") box.appendChild(assessResult(ctx, step.result));
}

function assessResult(ctx, result) {
  if (!result || typeof result !== "object") {
    return h("p", { class: "error" }, "The model returned nothing usable.");
  }
  const version = ctx.schema.ecs_version;
  const box = h("div", {});
  box.appendChild(h("h3", {}, "Summary"));
  box.appendChild(h("p", {}, flat(result.summary) || "(none)"));
  box.appendChild(h("p", { class: "muted" },
    `Confidence ${orDash(result.confidence)}`));

  box.appendChild(h("h3", {}, "Observed fields"));
  const observed = asList(result.observed_fields);
  box.appendChild(observed.length
    ? tableNode(OBSERVED_COLUMNS, observed.map((row) => [
      h("span", { class: "mono" }, orDash(row.name)),
      h("span", { class: "mono" }, orDash(row.example)),
      row.in_inventory ? "yes" : "no",
      h("span", { class: "mono" }, orDash(row.inventory_vendor)),
      ecsNode(row.suggested_ecs, row.ecs_known, version, row.ecs_list),
      orDash(row.suggested_status),
      flat(row.note),
    ]))
    : h("p", { class: "muted" }, "The model reported no fields."));

  box.appendChild(h("h3", {}, "Inventory fields not observed"));
  const missing = asList(result.inventory_not_observed);
  box.appendChild(missing.length
    ? h("ul", {}, missing.map((row) => h("li", {},
      h("span", { class: "mono" }, orDash(row.vendor)),
      " — " + flat(row.note))))
    : h("p", { class: "muted" }, "None."));

  box.appendChild(h("h3", {}, "Alerting-required targets"));
  const gaps = asList(result.alerting_gaps);
  box.appendChild(gaps.length
    ? tableNode(["ECS target", "in sample", "note"], gaps.map((row) => [
      ecsNode(row.ecs, row.ecs_known, version, row.ecs_list),
      row.present_in_log ? "yes" : "no",
      flat(row.note),
    ]))
    : h("p", { class: "muted" }, "This dataset's categories require none."));

  box.appendChild(h("h3", {}, "Parsing"));
  const parsing = result.parsing || {};
  box.appendChild(h("p", { class: "kv-line" },
    keyValue("Mechanism", parsing.mechanism),
    keyValue("Parse location", parsing.parse_location)));
  box.appendChild(h("p", {}, flat(parsing.rationale)));

  box.appendChild(h("h3", {}, "Suggested catalog edits"));
  const edits = asList(result.catalog_edits);
  box.appendChild(edits.length
    ? h("ul", {}, edits.map((row) => h("li", {},
      h("strong", {}, flat(row.where)), " — " + flat(row.change))))
    : h("p", { class: "muted" }, "None."));
  return box;
}

// --- step 3: the Elasticsearch sample -------------------------------------

function paintElastic(view) {
  if (!view.live()) return;
  const ctx = view.ctx;
  const { dataset, format } = picked(ctx);
  const stream = dataStreamOf(dataset);
  state.elasticUrl = String(elasticConfig(ctx).url || "");
  const step = shown(state, state.elastic, "elastic");
  const rules = elasticRules({
    step, stream, url: state.elasticUrl, format,
  });
  const box = clear(view.elasticBox);
  if (!rules.visible) {
    view.elasticBox.hidden = true;
    return;
  }
  view.elasticBox.hidden = false;
  const start = () => { runElastic(elasticDeps(ctx)); };
  box.appendChild(h("h2", {}, "Elasticsearch sample"));
  box.appendChild(h("p", { class: "help" },
    "Data stream ", h("span", { class: "mono" }, stream), "."));
  box.appendChild(h("div", { class: "btn-row" },
    h("button", {
      type: "button", class: "btn",
      disabled: !rules.enabled,
      onclick: start,
    }, step.status === "done" ? "Sample again" : "Sample Elasticsearch"),
    stepStatus(step, "querying…", start)));
  if (step.error) box.appendChild(errorDetail(step.error));
  if (step.status === "done" && step.result) {
    box.appendChild(presenceResult(step.result));
  }
}

function presenceResult(result) {
  const box = h("div", {});
  box.appendChild(h("p", { class: "help" },
    `${result.docCount} ` +
    `${result.docCount === 1 ? "document" : "documents"} sampled.`));
  box.appendChild(result.targets.length
    ? tableNode(["inventory field", "ECS target", "present"],
      result.targets.map((row) => [
        h("span", { class: "mono" }, orDash(row.vendor)),
        h("span", { class: "mono" }, orDash(row.ecs)),
        row.present ? "yes" : "no",
      ]))
    : h("p", { class: "muted" },
      "The chosen format maps no field to an ECS target."));
  box.appendChild(h("h3", {}, "Populated ECS fields the inventory does not map"));
  box.appendChild(result.extras.length
    ? h("p", { class: "mono" }, result.extras.join(", "))
    : h("p", { class: "muted" }, "None."));
  return box;
}

// --- the report -----------------------------------------------------------

function paintReport(view) {
  if (!view.live()) return;
  const ctx = view.ctx;
  const box = clear(view.reportBox);
  const input = reportInput({ state, picked: picked(ctx), schema: ctx.schema });
  const ready = Boolean(input.identify || input.assess || input.elastic);
  const flash = h("span", { class: "flash" });
  const fallback = h("div", {});
  box.appendChild(h("div", { class: "btn-row" },
    h("button", {
      type: "button", class: "btn", disabled: !ready,
      onclick: () => {
        const markdown = reportMarkdown(
          reportInput({ state, picked: picked(ctx), schema: ctx.schema }));
        copy(markdown).then(() => {
          if (!flash.isConnected) return;
          flash.textContent = "Copied.";
          setTimeout(() => { flash.textContent = ""; }, 2000);
        }, (err) => {
          if (!fallback.isConnected) return;
          // No clipboard (an insecure origin, or a refused permission):
          // show the text so it can be copied by hand.
          clear(fallback).appendChild(h("p", { class: "help" },
            `The browser refused the clipboard (${message(err)}). ` +
            "Copy the report from here:"));
          const area = h("textarea", {
            rows: "14", class: "mono", readonly: true, value: markdown,
          });
          fallback.appendChild(area);
          area.select();
        });
      },
    }, "Copy as Markdown"),
    flash,
    !ready ? h("span", { class: "muted" }, "Run a step first.") : null));
  box.appendChild(fallback);
}

// --- shared pieces -------------------------------------------------------

function stepStatus(step, runningLabel, onRetry, onCancel) {
  if (step.status === "running") {
    return h("span", { class: "step-status" },
      h("span", { class: "muted" }, runningLabel),
      onCancel
        ? h("button", { type: "button", class: "btn", onclick: onCancel },
            "Cancel")
        : null);
  }
  if (step.status === "done") {
    return h("span", { class: "flash" }, `done in ${seconds(step.ms)} s`);
  }
  if (step.status === "error") {
    return h("span", { class: "step-status" },
      h("span", { class: "error" }, step.error.message),
      h("button", { type: "button", class: "btn", onclick: onRetry }, "Retry"));
  }
  if (step.status === "cancelled") {
    return h("span", { class: "step-status" },
      h("span", { class: "muted" }, step.note || "Cancelled."),
      h("button", { type: "button", class: "btn", onclick: onRetry },
        "Re-run"));
  }
  if (step.status === "stale") {
    return h("span", { class: "step-status" },
      h("span", { class: "notice" },
        "The inputs changed since this ran — re-run it."),
      h("button", { type: "button", class: "btn", onclick: onRetry }, "Re-run"));
  }
  return h("span", { class: "muted" }, "Not run.");
}

// "Technology cisco-asa" — the label small and muted, the value in mono, the
// pair kept on one line.
function keyValue(label, value) {
  return h("span", { class: "kv" },
    h("span", { class: "kv-key" }, label),
    h("span", { class: "mono" }, orDash(value)));
}

function errorDetail(error) {
  if (!error || !error.detail) return h("span", {});
  return h("pre", { class: "raw mono" }, error.detail);
}

function tableNode(columns, rows) {
  return h("div", { class: "table-wrap" },
    h("table", {},
      h("thead", {}, h("tr", {}, columns.map((name) => h("th", {}, name)))),
      h("tbody", {}, rows.map((cells) => h("tr", {},
        cells.map((cell) => h("td", {}, cell)))))));
}

// An ECS suggestion the dictionary does not know is struck through and
// named, exactly as the report renders it.
//
// A model asked for one target sometimes answers with several
// ("source.ip, source.port"); checkEcsNames splits those into `ecs_list`
// with one flag each, so each name is marked on its own rather than the
// whole string being struck through because one of them was wrong.
function ecsNode(name, known, version, list) {
  if (Array.isArray(list) && list.length) {
    const flags = Array.isArray(known) ? known : [];
    const parts = [];
    list.forEach((item, index) => {
      if (index > 0) parts.push(", ");
      parts.push(ecsName(item, flags[index], version));
    });
    return h("span", {}, parts);
  }
  // A flag array with no list to go with it says nothing about the name.
  return ecsName(name, Array.isArray(known) ? null : known, version);
}

function ecsName(name, known, version) {
  const clean = flat(name);
  if (clean === "") return h("span", { class: "muted" }, "—");
  if (known === false) {
    return h("span", {},
      h("del", { class: "mono" }, clean),
      h("span", { class: "error-inline" }, ` (not in ECS ${version || "?"})`));
  }
  return h("span", { class: "mono" }, clean);
}

function asList(value) {
  return Array.isArray(value)
    ? value.filter((item) => item !== null && item !== undefined)
    : [];
}

/** One line of text, whatever the model actually returned. */
function flat(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function orDash(value) {
  const clean = flat(value);
  return clean === "" ? "—" : clean;
}

function seconds(ms) {
  return (ms / 1000).toFixed(1);
}

function copy(text) {
  const clipboard = globalObject.navigator && globalObject.navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== "function") {
    return Promise.reject(new Error("no clipboard API"));
  }
  return clipboard.writeText(text);
}

function readFile(file) {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsText(file);
  });
}
