// The editor's forms: one function per section of a technology document,
// each returning a single Element.
//
// Every control maps 1:1 to a schema key and reports its edit through the
// `env` object the view hands in (see views/editor.js):
//
//   env.schema            the published schema.json
//   env.store             the working document (read with store.get)
//   env.sel               {kind, index, formatIndex} - what is open
//   env.err(path)         the validator's message pinned to `path`, or null
//   env.set/unset         write / remove one key
//   env.setText           write a trimmed string, or remove the key when blank
//   env.push/insert/remove/move   list edits
//   env.select(patch)     move the selection
//
// Required keys are written even when empty, so the validator says "must be
// a non-empty string" rather than "missing key"; optional keys are removed
// when emptied, so the emitter never writes `notes: ""`.
//
// Nothing here touches `document` at import time: the pure helpers at the
// top are importable (and tested) under Node.

import { h, downloadText } from "../lib/dom.js";
import { toJson, toCsv, toYaml, exportName } from "../lib/export.js";
import { globalObject } from "../lib/global.js";
import {
  textField, textArea, selectField, checkbox, checkboxGroup, listEditor,
  stringList, ecsPicker,
} from "../lib/forms.js";
import {
  exampleStem, examplePath, publishedList, formatSize, byteLength, oversize,
  isExcluded, MAX_BYTES,
} from "../lib/examples.js";

// --- pure helpers ------------------------------------------------------

// The ECS targets the CSOC's alerting profiles ask for, for one dataset's
// event categories.  Unknown categories contribute nothing (the validator
// reports them separately).
export function requiredEcs(schema, categories) {
  const profiles = (schema && schema.profiles) || {};
  const out = new Set();
  for (const category of Array.isArray(categories) ? categories : []) {
    const wanted = profiles[category];
    if (!Array.isArray(wanted)) continue;
    for (const name of wanted) out.add(name);
  }
  return out;
}

// Counts for the line above the field table.  A target counts as covered
// when some field points at it and is not itself marked unmapped - an
// unmapped row with an ECS name in it is an aspiration, not a mapping.
export function fieldSummary(fields, required) {
  const list = Array.isArray(fields) ? fields : [];
  const need = required instanceof Set
    ? required
    : new Set(Array.isArray(required) ? required : []);
  const covered = new Set();
  let mapped = 0;
  for (const field of list) {
    if (field === null || typeof field !== "object") continue;
    if (field.status === "mapped") mapped += 1;
    const target = typeof field.ecs === "string" ? field.ecs : "";
    if (target !== "" && field.status !== "unmapped" && need.has(target)) {
      covered.add(target);
    }
  }
  return {
    count: list.length,
    mapped,
    covered: covered.size,
    required: need.size,
  };
}

export function summaryLine(summary) {
  return `${summary.count} fields · ${summary.mapped} mapped · `
       + `${summary.covered} alerting-required targets covered of `
       + `${summary.required}`;
}

// --- canonical key order -----------------------------------------------
//
// The emitter publishes a mapping in insertion order, so a key created by
// Studio at the end of its mapping shows up in the merge request as a moved
// line rather than an added one.  The order is not Studio's to decide: it is
// `schema.vocab.key_order`, published from schema.py's KEY_ORDER, which is
// the order the 87 authored files actually use - so a key Studio adds lands
// where an author would have written it, and adding a key to the schema
// places it here with no second list to remember.

// The existing keys of `obj` that a newly created `key` must sit in front of.
// A key the order does not name belongs at the end, and so moves nothing.
export function keysAfter(obj, key, order) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return [];
  const list = Array.isArray(order) ? order : [];
  const rankOf = (name) => {
    const at = list.indexOf(name);
    return at === -1 ? Infinity : at;
  };
  const mine = rankOf(key);
  if (!Number.isFinite(mine)) return [];
  return Object.keys(obj).filter(
    (name) => name !== key && rankOf(name) > mine);
}

// A copy of `obj` with `key` set, placed in canonical order.  An existing key
// keeps its position: reordering what an author already wrote would be diff
// noise of exactly the kind this is here to avoid.
export function orderedInsert(obj, key, value, order) {
  const source = obj !== null && typeof obj === "object" && !Array.isArray(obj)
    ? obj : {};
  const after = new Set(keysAfter(source, key, order));
  const out = {};
  let placed = Object.prototype.hasOwnProperty.call(source, key);
  for (const name of Object.keys(source)) {
    if (!placed && after.has(name)) {
      out[key] = value;
      placed = true;
    }
    out[name] = name === key ? value : source[name];
  }
  if (!placed) out[key] = value;
  return out;
}

// The same insertion, but through the store.  A key that already exists is
// a plain write, in the place it already occupies; a new one is placed by
// rebuilding its mapping with orderedInsert, which keeps every existing key
// in its existing relative order and only decides where the new one lands.
//
// Two mappings cannot be replaced wholesale, because `store.set` needs a key
// to write: the document root and the catalog row.  A new key there is
// appended and the keys that should follow it are lifted to the back, one
// store write each - the same order, reached the long way round.
export function orderedSet(store, path, value, order) {
  const at = Array.isArray(path) ? path : [path];
  if (at.length === 0) {
    throw new TypeError("orderedSet: path must name a key");
  }
  const parent = at.slice(0, -1);
  const key = at[at.length - 1];
  const before = store.get(parent);
  const mapping = before !== null && typeof before === "object"
    && !Array.isArray(before);
  const fresh = !(mapping
                  && Object.prototype.hasOwnProperty.call(before, key));
  if (!fresh || !mapping || isRoot(parent)) {
    store.set(at, value);
    if (!fresh || !mapping) return store;
    for (const later of keysAfter(store.get(parent), key, order)) {
      const move = parent.concat(later);
      const kept = store.get(move);
      store.unset(move);
      store.set(move, kept);
    }
    return store;
  }
  store.set(parent, orderedInsert(before, key, value, order));
  return store;
}

// The two paths `store.set` refuses: the document itself, and the catalog
// row.
function isRoot(path) {
  if (path.length === 0) return true;
  return path.length === 1 && String(path[0]) === "row";
}

// One node's published key order, or [] when the schema does not name it.
// `kind` picks the sub-table of the two nodes that have one.
//
// An empty list is not an error here, and deliberately not the same answer
// the validator gives: this decides only *where* a new key is written, and
// a node nothing knows the order of gets the key appended, which is the one
// harmless placement.  The validator, reading the same table, rejects that
// key as unknown — so a mistyped node name shows up as a validation error
// on screen rather than as a silent misplacement in the diff.
function orderOf(schema, node, kind) {
  const table = (schema && schema.vocab && schema.vocab.key_order) || {};
  const keys = kind === undefined ? table[node] : (table[node] || {})[kind];
  return Array.isArray(keys) ? keys : [];
}

// Which order list governs the mapping that `path`'s last segment lives in.
// A hop's keys depend on its kind, so the hop itself is read back from the
// store; anything this does not recognise orders nothing and appends.
export function keyOrder(path, store, schema) {
  const at = Array.isArray(path) ? path : [];
  const container = at.slice(0, -1);
  if (container.length === 0) return orderOf(schema, "technology");
  if (String(container[0]) === "row") {
    return container.length === 1 ? orderOf(schema, "catalog_row") : [];
  }
  if (String(container[0]) !== "datasets") return [];
  const rest = container.slice(2);
  if (rest.length === 0) return orderOf(schema, "dataset");
  if (String(rest[0]) === "route") {
    if (rest.length === 1) return orderOf(schema, "route");
    if (rest.length === 3) {
      const hop = store ? store.get(container) : null;
      const kind = hop !== null && typeof hop === "object" ? hop.hop : null;
      return orderOf(schema, "hop", kind);
    }
    return [];
  }
  if (String(rest[0]) !== "formats") return [];
  const tail = rest.slice(2);
  if (tail.length === 0) return orderOf(schema, "format");
  if (tail.length === 1 && String(tail[0]) === "parsing") {
    return orderOf(schema, "parsing");
  }
  if (tail.length === 1 && String(tail[0]) === "recommendations") {
    return orderOf(schema, "recommendations");
  }
  if (tail.length === 2 && String(tail[0]) === "fields") {
    return orderOf(schema, "field");
  }
  if (tail.length === 2 && String(tail[0]) === "recommendations") {
    return orderOf(schema, "recommendation_side", String(tail[1]));
  }
  return [];
}

// The autosave queue moved to lib/editor-state.js, where the editor's other
// decisions live and where it can be tested without a form in sight.  It is
// re-exported here because that is where the forms' callers import it from.
export {
  AUTOSAVE_MS, scheduleAutosave, flushAutosave, cancelAutosave,
  pendingAutosave, autosaveUnlessPending,
} from "../lib/editor-state.js";

// A path as an admin would read it: datasets[0].formats[1].fields[2].ecs
export function pathLabel(path) {
  let out = "";
  for (const part of Array.isArray(path) ? path : []) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out === "" ? String(part) : `.${part}`;
  }
  return out;
}

export function newDataset() {
  return {
    id: "",
    name: "",
    event_categories: [],
    route: { direct: [{ hop: "cribl" }] },
    formats: [],
  };
}

export function newFormat(name) {
  return { format: name, parsing: { mechanism: "none" }, fields: [] };
}

export function newField() {
  return { vendor: "", ecs: null, status: "unmapped" };
}

export function newHop(kind) {
  return { hop: kind };
}

// --- the formats tablist -----------------------------------------------
//
// One id space per painted strip: the pane is rebuilt from scratch on every
// edit, and a tab must never point at a panel a previous paint left behind.
let tabSeq = 0;

function nextTabSeq() {
  tabSeq += 1;
  return tabSeq;
}

// What one tab in the strip declares: the panel it controls, whether it is
// the open one, and - a roving tabindex - whether it is the strip's single
// tab stop, so Tab moves past the whole strip rather than through every tab.
export function tabAria(seq, at, selected) {
  const on = at === selected;
  return {
    id: `format-tab-${seq}-${at}`,
    role: "tab",
    "aria-selected": on ? "true" : "false",
    "aria-controls": `format-panel-${seq}`,
    tabindex: on ? "0" : "-1",
  };
}

// The one panel every tab controls, named back by the open tab.
export function panelAria(seq, selected) {
  return {
    id: `format-panel-${seq}`,
    role: "tabpanel",
    "aria-labelledby": `format-tab-${seq}-${selected}`,
  };
}

// Which tab a key moves to: Left and Right wrap around the strip, Home and
// End jump to its ends.  Any other key is the browser's, and says so with
// null so the handler leaves it alone.
export function tabTarget(key, at, count) {
  const total = Number(count);
  if (!Number.isInteger(total) || total <= 0) return null;
  const from = Math.min(Math.max(Math.trunc(Number(at)) || 0, 0), total - 1);
  if (key === "ArrowRight") return (from + 1) % total;
  if (key === "ArrowLeft") return (from - 1 + total) % total;
  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  return null;
}

// The keys `kind` allows, in a stable order, minus the discriminator itself.
export function hopKeys(schema, kind) {
  const table = (schema && schema.vocab && schema.vocab.hop_keys) || {};
  const entry = table[kind] || { required: [], optional: [] };
  const required = (entry.required || []).filter((key) => key !== "hop");
  return required.concat(entry.optional || []);
}

function has(obj, key) {
  return obj !== null && typeof obj === "object"
    && Object.prototype.hasOwnProperty.call(obj, key);
}

function clone(value) {
  if (value === null || typeof value !== "object") return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

// Prose keys get a textarea; short identifiers get one line.
const LONG_KEYS = new Set(["notes", "constraints", "description"]);

// --- small shared controls ---------------------------------------------

// A select over a vocabulary.  A required key offers no blank choice unless
// the document already holds a value the vocabulary does not know (which the
// validator is flagging); an optional one offers "—" and removes the key.
function vocabSelect(env, path, { label, value, options, help, optional,
                                  onCommit }) {
  const current = value === null || value === undefined ? "" : String(value);
  const known = options.includes(current);
  return selectField({
    label,
    value: known ? current : "",
    options,
    allowEmpty: optional || !known,
    emptyLabel: !optional && current !== "" && !known
      ? `— ${current} (not allowed) —`
      : "—",
    error: env.err(path),
    help,
    onChange: (next) => {
      // `onCommit` is for a key whose removal has to do more than unset it
      // (pruning an emptied recommendations side, say).
      if (typeof onCommit === "function") {
        onCommit(next);
        return;
      }
      if (next === "") {
        if (optional) env.unset(path);
        return;
      }
      env.set(path, next);
    },
  });
}

// A required free-text key: written even when blank, so the message stays
// "must be a non-empty string".
function requiredText(env, path, opts = {}) {
  return textField(Object.assign({}, opts, {
    value: env.store.get(path),
    error: env.err(path),
    onChange: (value) => env.set(path, value),
  }));
}

// An optional free-text key: blank removes it.
function optionalText(env, path, opts = {}) {
  return textField(Object.assign({}, opts, {
    value: env.store.get(path),
    error: env.err(path),
    onChange: (value) => env.setText(path, value),
  }));
}

function optionalArea(env, path, opts = {}) {
  return textArea(Object.assign({ rows: 3 }, opts, {
    value: env.store.get(path),
    error: env.err(path),
    onChange: (value) => env.setText(path, value),
  }));
}

function iconButton(text, title, disabled, onclick) {
  return h("button", {
    type: "button", class: "btn btn-icon", title, "aria-label": title,
    disabled: Boolean(disabled), onclick,
  }, text);
}

// --- technology --------------------------------------------------------

export function technologyForm(env) {
  const store = env.store;
  const doc = store.doc || {};
  const schema = env.schema;

  const idField = store.isNew
    ? textField({
        label: "Id",
        value: doc.id,
        mono: true,
        error: env.err(["id"]),
        help: "A slug. It becomes data/technologies/<id>.yml and the "
            + "catalog row's id; the filename comes from the address bar, "
            + "so change it there too.",
        onChange: (value) => {
          const id = String(value || "").trim();
          env.set(["id"], id);
          env.set(["row", "id"], id);
        },
      })
    : h("div", { class: "field" },
        h("label", { class: "field-label" }, "Id"),
        h("input", { type: "text", class: "mono", value: String(doc.id || ""),
                     disabled: true }),
        h("p", { class: "help" },
          "The id is the filename; it is fixed once the file exists."),
        env.err(["id"]) ? h("p", { class: "error" }, env.err(["id"])) : null);

  // The catalog row carries its own name and vendor - 25 of the 87 published
  // rows differ from their document on purpose (a shorter list label, a
  // different vendor spelling) - so they are separate fields.  They only
  // follow the document while they are blank or still identical to it, which
  // is what a brand new technology wants and what a diverged one must not
  // suffer.
  function mirror(key, value) {
    const rowValue = store.get(["row", key]);
    const docValue = store.get([key]);
    if (rowValue === undefined || rowValue === null || rowValue === ""
        || rowValue === docValue) {
      env.set(["row", key], value);
    }
  }

  return h("div", {},
    h("section", { class: "panel" },
      h("h2", {}, "Technology"),
      idField,
      textField({
        label: "Name",
        value: doc.name,
        error: env.err(["name"]),
        onChange: (value) => { mirror("name", value); env.set(["name"], value); },
      }),
      textField({
        label: "Vendor",
        value: doc.vendor,
        error: env.err(["vendor"]),
        onChange: (value) => {
          mirror("vendor", value);
          env.set(["vendor"], value);
        },
      }),
      optionalText(env, ["versions"], {
        label: "Versions",
        placeholder: "ASA 9.12, ASA 9.16",
        help: "Free text: the versions this map was written against.",
      }),
      checkbox({
        label: "Draft — the map is published with a draft banner",
        checked: doc.draft === true,
        onChange: (on) => {
          if (on) env.set(["draft"], true);
          else env.unset(["draft"]);
        },
      }),
      stringList({
        label: "References",
        items: Array.isArray(doc.references) ? doc.references : [],
        placeholder: "https://…",
        addLabel: "Add reference",
        error: env.err(["references"]),
        onChange: (values) => {
          if (values.length === 0) env.unset(["references"]);
          else env.set(["references"], values);
        },
      })),
    h("section", { class: "panel" },
      h("h2", {}, "Catalog row"),
      h("p", { class: "help" },
        "These five keys live in data/catalog.yml, not in this file."),
      requiredText(env, ["row", "name"], {
        label: "Name in the catalog",
        help: "May be longer or shorter than the technology name above.",
      }),
      requiredText(env, ["row", "vendor"], { label: "Vendor in the catalog" }),
      vocabSelect(env, ["row", "category"], {
        label: "Category",
        value: store.get(["row", "category"]),
        options: schema.vocab.categories,
      }),
      vocabSelect(env, ["row", "status"], {
        label: "Status",
        value: store.get(["row", "status"]),
        options: schema.vocab.statuses,
      }),
      vocabSelect(env, ["row", "priority"], {
        label: "Priority",
        value: store.get(["row", "priority"]),
        options: schema.vocab.priorities,
      })),
    orphanSection(env));
}

// Records left naming a dataset that is no longer here.  Nothing is drawn
// when there are none, which is the normal case.
function orphanSection(env) {
  const store = env.store;
  const orphans = orphanExamples(store.examples,
                                 store.doc && store.doc.datasets);
  if (orphans.length === 0) return null;
  const techId = String((store.doc && store.doc.id) || store.id || "");
  return h("section", { class: "panel" },
    h("h2", {}, "Example records with no dataset"),
    h("p", { class: "help" },
      "These name a dataset this document no longer has. Rename the "
      + "dataset back, or take the record off."),
    orphans.map(
      (item) => pendingExample(env, techId, item.entry, item.index)));
}

// --- dataset -----------------------------------------------------------

export function datasetForm(env) {
  const index = env.sel.index;
  const datasets = Array.isArray(env.store.doc.datasets)
    ? env.store.doc.datasets : [];
  const ds = datasets[index];
  if (ds === null || ds === undefined || typeof ds !== "object") {
    return h("section", { class: "panel" },
      h("p", { class: "error" }, "This dataset is not a mapping."));
  }
  const base = ["datasets", index];
  const categories = Object.keys(env.schema.profiles || {});
  const chosen = Array.isArray(ds.event_categories) ? ds.event_categories : [];
  const categoryIssues = chosen
    .map((_, at) => env.err(base.concat("event_categories", at)))
    .filter((message) => message !== null && message !== undefined);

  return h("div", {},
    h("section", { class: "panel" },
      h("h2", {}, "Dataset"),
      requiredText(env, base.concat("id"), { label: "Id", mono: true }),
      requiredText(env, base.concat("name"), { label: "Name" }),
      optionalArea(env, base.concat("description"), {
        label: "Description", rows: 5,
      }),
      checkboxGroup({
        label: "Event categories",
        values: chosen,
        options: categories,
        error: env.err(base.concat("event_categories")),
        help: "Each category brings its alerting profile's required ECS "
            + "targets into the field table.",
        onChange: (values) => env.set(base.concat("event_categories"), values),
      }),
      categoryIssues.map((message) => h("p", { class: "error" }, message)),
      h("div", { class: "btn-row" },
        h("button", {
          type: "button", class: "btn btn-danger",
          onclick: () => {
            if (!confirmed(`Delete dataset "${ds.id || index + 1}"?`)) return;
            env.remove(["datasets"], index);
            env.select({ kind: datasets.length > 1 ? "dataset" : "tech",
                         index: Math.max(0, index - 1), formatIndex: 0 });
          },
        }, "Delete dataset"))),
    routeEditor(env, base, ds),
    formatsSection(env, base, ds),
    examplesSection(env, ds));
}

// --- example records ---------------------------------------------------
//
// The one part of the editor that does not write YAML: each record becomes
// its own file under data/examples/<tech>/, created by the same merge
// request.  Records already in the site are listed with a link (they are
// published verbatim, so the link is the record); records attached here are
// listed with what they will be called and a way to take them back off.
// The pending records for one dataset, each with the index it holds in
// store.examples - which is what the validator's paths and removeExample
// both address.
export function pendingFor(examples, datasetId) {
  const out = [];
  (Array.isArray(examples) ? examples : []).forEach((entry, index) => {
    if (entry && String(entry.dataset) === String(datasetId)) {
      out.push({ entry, index });
    }
  });
  return out;
}

// Pending records naming a dataset this document does not have.  Deleting a
// dataset takes its records with it (the store does that), so the usual way
// to arrive here is renaming a dataset's id under a record already
// attached.  They belong to no dataset panel, so the technology form lists
// them - with a Remove, because an error message alone leaves the admin
// with a document that cannot be reviewed and no button to fix it.
export function orphanExamples(examples, datasets) {
  const known = (Array.isArray(datasets) ? datasets : [])
    .map((ds) => (ds ? String(ds.id) : ""));
  const out = [];
  (Array.isArray(examples) ? examples : []).forEach((entry, index) => {
    if (entry && known.indexOf(String(entry.dataset)) === -1) {
      out.push({ entry, index });
    }
  });
  return out;
}

function examplesSection(env, ds) {
  const store = env.store;
  const techId = String((store.doc && store.doc.id) || store.id || "");
  const datasetId = String(ds.id === null || ds.id === undefined ? "" : ds.id);
  const blocked = isExcluded(env.schema, techId);
  const published = publishedList(store.publishedExamples).filter(
    (row) => row.dataset === datasetId);
  const pending = pendingFor(store.examples, datasetId);

  const panel = h("section", { class: "panel" },
    h("h2", {}, "Example records"),
    h("p", { class: "help" },
      "One raw record per file, published byte for byte and never parsed. "
      + "Attaching from Analyze commits the analysis input as pasted; trim "
      + "it first if it is a whole capture."));

  panel.appendChild(published.length
    ? h("ul", { class: "file-list" }, published.map((row) => h("li", {},
      h("a", { href: "../" + row.path, target: "_blank", rel: "noopener" },
        row.stem + ".log"),
      " ",
      h("span", { class: "muted" }, formatSize(row.size)))))
    : h("p", { class: "muted" }, "No records published for this dataset."));

  for (const item of pending) {
    panel.appendChild(pendingExample(env, techId, item.entry, item.index));
  }

  panel.appendChild(blocked
    ? h("p", { class: "notice" },
      `'${techId}' takes no example records: its documentation is `
      + "controlled, and the build rejects one.")
    : attachForm(env, datasetId));
  return panel;
}

function pendingExample(env, techId, entry, index) {
  const base = ["examples", index];
  const stem = exampleStem(entry.dataset, entry.label);
  const size = byteLength(entry.content);
  const messages = ["technology", "dataset", "label", "content"]
    .map((key) => env.err(base.concat(key)))
    .filter((message) => message !== null && message !== undefined);
  return h("div", { class: "panel-row" },
    h("div", { class: "btn-row" },
      h("code", {}, examplePath(techId, stem)),
      h("span", { class: "badge badge-draft" }, "to be created"),
      h("span", { class: "muted" }, formatSize(size)),
      h("button", {
        type: "button", class: "btn btn-danger",
        onclick: () => { env.removeExample(index); },
      }, "Remove")),
    oversize(entry.content)
      ? h("p", { class: "notice" },
        `Over ${formatSize(MAX_BYTES)}: the build will flag this and ask for `
        + "a representative record instead.")
      : null,
    messages.map((message) => h("p", { class: "error" }, message)));
}

function attachForm(env, datasetId) {
  const area = h("textarea", {
    rows: "6", class: "mono", "aria-label": "Example record",
    placeholder: "Paste one raw record…",
  });
  const label = h("input", {
    type: "text", class: "mono", "aria-label": "Label (optional)",
    placeholder: "label (optional)",
  });
  const note = h("p", { class: "help" });
  const file = h("input", {
    type: "file", "aria-label": "Read a record from a file",
    onchange: (event) => {
      const chosen = event.target.files && event.target.files[0];
      if (!chosen) return;
      readAsText(chosen).then((text) => {
        area.value = text;
        note.textContent = `Read ${chosen.name} — `
          + `${formatSize(byteLength(text))}.`
          + (oversize(text) ? " Over the size the build asks for." : "");
      }, (err) => {
        note.textContent = `Could not read that file: ${message(err)}`;
      });
    },
  });

  return h("div", { class: "panel-row" },
    h("h3", {}, "Attach a record"),
    area,
    h("div", { class: "btn-row" },
      label,
      file,
      h("button", {
        type: "button", class: "btn",
        onclick: () => {
          const content = String(area.value || "");
          if (content.trim() === "") {
            note.textContent = "Paste or choose a record first.";
            return;
          }
          env.addExample({
            dataset: datasetId,
            label: String(label.value || "").trim(),
            content,
          });
        },
      }, "Attach")),
    note,
    h("p", { class: "help" },
      "With no label the file is named after the dataset; a label is "
      + "lowercase letters, digits and hyphens."));
}

function readAsText(chosen) {
  if (typeof chosen.text === "function") return chosen.text();
  return new Promise((resolve, reject) => {
    const reader = new globalObject.FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsText(chosen);
  });
}

function message(err) {
  return err && err.message ? err.message : String(err);
}

// Deleting a dataset, a format or a draft asks first.  A host with no
// `confirm` (a test, a kiosk that blocks dialogs) is treated as a yes: the
// admin asked for the button, and the change is still only a draft.
export function confirmed(message) {
  try {
    return typeof globalObject.confirm !== "function"
      || globalObject.confirm(message);
  } catch (err) {
    return true;
  }
}

// --- route -------------------------------------------------------------

function routeEditor(env, base, ds) {
  const route = ds.route !== null && typeof ds.route === "object"
    && !Array.isArray(ds.route) ? ds.route : {};
  const guarded = has(route, "guarded");
  return h("section", { class: "panel" },
    h("h2", {}, "Route"),
    h("p", { class: "help" },
      "The hops the data takes from the source to Elastic. A guarded side "
      + "must contain a guard hop; a direct side must not."),
    env.err(base.concat("route"))
      ? h("p", { class: "error" }, env.err(base.concat("route"))) : null,
    checkbox({
      label: "This dataset crosses the guard",
      checked: guarded,
      help: "Adds the guarded side of the route, and with it the guarded "
          + "recommendations on every format.",
      onChange: (on) => {
        if (on) env.set(base.concat("route", "guarded"), [newHop("guard")]);
        else env.unset(base.concat("route", "guarded"));
      },
    }),
    guarded
      ? hopList(env, base.concat("route", "guarded"), route.guarded, "Guarded")
      : null,
    hopList(env, base.concat("route", "direct"), route.direct, "Direct"));
}

function hopList(env, path, hops, label) {
  const items = Array.isArray(hops) ? hops : [];
  return h("div", { class: "route-side" },
    listEditor({
      label: `${label} hops`,
      items,
      error: env.err(path),
      addLabel: "Add hop",
      empty: "No hops yet.",
      onAdd: () => env.push(path, newHop("cribl")),
      onRemove: (at) => env.remove(path, at),
      onMove: (from, to) => env.move(path, from, to),
      render: (hop, at) => hopBody(env, path.concat(at), hop),
    }));
}

function hopBody(env, path, hop) {
  if (hop === null || typeof hop !== "object" || Array.isArray(hop)) {
    return h("p", { class: "error" }, "This hop is not a mapping.");
  }
  const kind = typeof hop.hop === "string" ? hop.hop : "";
  const known = env.schema.vocab.hops.includes(kind);
  const whole = env.err(path);
  const keys = hopKeys(env.schema, kind);
  // After the select, not before it: the error line comes and goes as the
  // document changes, and the editor puts the caret back by counting
  // children, so a line that appears above the controls would move every one
  // of them.
  return h("div", {},
    selectField({
      label: "Hop kind",
      value: known ? kind : "",
      options: env.schema.vocab.hops,
      allowEmpty: !known,
      emptyLabel: kind === "" ? "—" : `— ${kind} (not allowed) —`,
      error: env.err(path.concat("hop")),
      help: "Changing the kind drops the keys the new kind does not allow.",
      onChange: (next) => {
        if (next === "" || next === kind) return;
        changeHopKind(env, path, hop, next);
      },
    }),
    whole ? h("p", { class: "error" }, whole) : null,
    keys.map((key) => (LONG_KEYS.has(key)
      ? optionalArea(env, path.concat(key), { label: key, rows: 2 })
      : optionalText(env, path.concat(key), { label: key }))));
}

function changeHopKind(env, path, hop, kind) {
  env.set(path, hopAfterKind(env.schema, hop, kind));
}

// A hop is rewritten whole when its kind changes: whatever the new kind does
// not allow would be an "unknown key" the moment the select committed, so it
// is dropped here rather than left for the validator to complain about.  The
// keys that survive are re-emitted in the new kind's own order.
export function hopAfterKind(schema, hop, kind) {
  const source = hop !== null && typeof hop === "object" && !Array.isArray(hop)
    ? hop : {};
  const next = { hop: kind };
  for (const key of hopKeys(schema, kind)) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      next[key] = source[key];
    }
  }
  return next;
}

// --- formats -----------------------------------------------------------

function formatsSection(env, base, ds) {
  const formats = Array.isArray(ds.formats) ? ds.formats : [];
  const used = new Set(formats
    .map((entry) => (entry && typeof entry === "object" ? entry.format : null))
    .filter((name) => typeof name === "string"));
  const unused = env.schema.vocab.source_formats
    .filter((name) => !used.has(name));
  const selected = formats.length
    ? Math.min(Math.max(Number(env.sel.formatIndex) || 0, 0), formats.length - 1)
    : -1;

  const seq = nextTabSeq();
  const tabs = formats.map((entry, at) => {
    const count = countIssues(env.issues, base.concat("formats", at));
    return h("button", Object.assign({
      type: "button",
      class: at === selected ? "tab tab-on" : "tab",
      onclick: () => env.select({ formatIndex: at }),
      onkeydown: (event) => moveTab(env, event, at, formats.length),
    }, tabAria(seq, at, selected)),
      entry && entry.format ? String(entry.format) : "(no format)",
      count ? h("span", { class: "tab-count" }, String(count)) : null);
  });

  const adder = unused.length
    ? h("select", {
        class: "tab-add",
        "aria-label": "Add format",
        onchange: (event) => {
          const name = event.target.value;
          if (name === "") return;
          env.push(base.concat("formats"), newFormat(name));
          env.select({ formatIndex: formats.length });
        },
      },
      h("option", { value: "" }, "+ Add format"),
      unused.map((name) => h("option", { value: name }, name)))
    : h("span", { class: "help" }, "Every source format is already used.");

  // The adder is a control *about* the strip, not a tab in it, so it sits
  // outside the tablist: a role="tablist" may hold nothing but tabs.
  return h("section", { class: "panel" },
    h("h2", {}, "Formats"),
    env.err(base.concat("formats"))
      ? h("p", { class: "error" }, env.err(base.concat("formats"))) : null,
    h("div", { class: "tabs" },
      h("div", { class: "tablist", role: "tablist",
                 "aria-label": "Source formats" }, tabs),
      adder),
    selected < 0
      ? h("p", { class: "help" },
          "A dataset needs at least one source format. Add one above.")
      : formatForm(env, base, ds, selected, panelAria(seq, selected)));
}

// Left/Right/Home/End move the selection, and take the focus with them.  The
// focus is moved here rather than after the repaint because the pane is
// rebuilt on the next microtask and hands the caret back by counting
// children: the tab focused now sits at the same position as the tab that
// replaces it, so the keyboard lands on the newly opened one.
function moveTab(env, event, at, count) {
  const next = tabTarget(event.key, at, count);
  if (next === null) return;
  event.preventDefault();
  const strip = event.currentTarget ? event.currentTarget.parentNode : null;
  const target = strip && strip.children ? strip.children[next] : null;
  if (target && typeof target.focus === "function") target.focus();
  env.select({ formatIndex: next });
}

function countIssues(issues, prefix) {
  let total = 0;
  for (const issue of issues) {
    const path = issue.path;
    if (!Array.isArray(path) || path.length < prefix.length) continue;
    let hit = true;
    for (let at = 0; at < prefix.length; at += 1) {
      if (String(path[at]) !== String(prefix[at])) { hit = false; break; }
    }
    if (hit) total += 1;
  }
  return total;
}

function formatForm(env, base, ds, at, panel) {
  const formats = ds.formats;
  const entry = formats[at];
  const fp = base.concat("formats", at);
  // The panel keeps its role and its id whatever is in it: a tab must not
  // point at an element that is not there.
  const shell = Object.assign({ class: "format-form" }, panel);
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return h("div", shell,
      h("p", { class: "error" }, "This format entry is not a mapping."));
  }
  const fields = Array.isArray(entry.fields) ? entry.fields : [];
  const used = new Set(formats
    .map((other, other_at) => (other_at === at ? null : (other || {}).format))
    .filter((name) => typeof name === "string"));
  const choices = env.schema.vocab.source_formats
    .filter((name) => !used.has(name));
  const recommended = entry.recommended === true;
  const showOmitted = fields.length === 0 || has(entry, "fields_omitted");

  return h("div", shell,
    env.err(fp) ? h("p", { class: "error" }, env.err(fp)) : null,
    vocabSelect(env, fp.concat("format"), {
      label: "Format",
      value: entry.format,
      options: choices,
    }),
    h("h3", {}, "Parsing"),
    env.err(fp.concat("parsing"))
      ? h("p", { class: "error" }, env.err(fp.concat("parsing"))) : null,
    vocabSelect(env, fp.concat("parsing", "mechanism"), {
      label: "Mechanism",
      value: (entry.parsing || {}).mechanism,
      options: env.schema.vocab.mechanisms,
    }),
    optionalText(env, fp.concat("parsing", "artifact"), {
      label: "Artifact",
      placeholder: "Cisco ASA integration (cisco_asa), data stream …",
    }),
    optionalArea(env, fp.concat("parsing", "notes"), {
      label: "Parsing notes", rows: 4,
    }),
    optionalArea(env, fp.concat("enable"), {
      label: "Enable",
      rows: 3,
      help: "How an operator turns this source on at the device.",
    }),
    stringList({
      label: "References",
      items: Array.isArray(entry.references) ? entry.references : [],
      placeholder: "https://…",
      addLabel: "Add reference",
      error: env.err(fp.concat("references")),
      onChange: (values) => {
        if (values.length === 0) env.unset(fp.concat("references"));
        else env.set(fp.concat("references"), values);
      },
    }),
    checkbox({
      label: "Recommended — this is the format to send",
      checked: recommended,
      help: "At most one format per dataset. Ticking this unticks any other.",
      onChange: (on) => setRecommended(env, base, formats, at, on),
    }),
    recommended || has(entry, "recommended_because")
      ? textArea({
          label: "Recommended because",
          rows: 4,
          value: entry.recommended_because,
          error: env.err(fp.concat("recommended_because")),
          help: "Reads after \"because\": the reason this format wins.",
          onChange: (value) => env.setText(fp.concat("recommended_because"),
                                           value),
        })
      : null,
    showOmitted
      ? textArea({
          label: "Fields omitted",
          rows: 4,
          value: entry.fields_omitted,
          error: env.err(fp.concat("fields_omitted")),
          help: fields.length
            ? "Only for an empty inventory — the table below is not empty."
            : "Why this entry publishes no field table. Leave blank to "
              + "publish an empty inventory.",
          onChange: (value) => env.setText(fp.concat("fields_omitted"), value),
        })
      : null,
    recommendationsEditor(env, fp, entry, ds),
    fieldTable(env, fp, entry, ds),
    h("div", { class: "btn-row" },
      h("button", {
        type: "button", class: "btn btn-danger",
        onclick: () => {
          if (!confirmed(`Remove the ${entry.format || "unnamed"} format `
                         + "and its field table?")) return;
          env.remove(base.concat("formats"), at);
          env.select({ formatIndex: Math.max(0, at - 1) });
        },
      }, "Remove format")));
}

// The schema allows one recommended format per dataset, so ticking one
// unticks every other - and takes its reason with it, because a reason with
// nothing to justify is itself an error.  Unticking clears both keys rather
// than writing `recommended: false`, which no authored file contains.
export function setRecommended(env, base, formats, at, on) {
  const fp = base.concat("formats", at);
  if (!on) {
    env.unset(fp.concat("recommended"));
    env.unset(fp.concat("recommended_because"));
    return;
  }
  const list = Array.isArray(formats) ? formats : [];
  list.forEach((other, other_at) => {
    if (other_at === at || other === null || typeof other !== "object") return;
    if (other.recommended || has(other, "recommended_because")) {
      env.unset(base.concat("formats", other_at, "recommended"));
      env.unset(base.concat("formats", other_at, "recommended_because"));
    }
  });
  env.set(fp.concat("recommended"), true);
}

// --- recommendations ---------------------------------------------------

function recommendationsEditor(env, fp, entry, ds) {
  const recs = entry.recommendations !== null
    && typeof entry.recommendations === "object"
    && !Array.isArray(entry.recommendations) ? entry.recommendations : {};
  const route = ds.route !== null && typeof ds.route === "object" ? ds.route : {};
  const hasGuardedRoute = has(route, "guarded");
  const sides = ["guarded", "direct"].filter((side) =>
    side === "direct" || hasGuardedRoute || has(recs, side));

  return h("div", { class: "recs" },
    h("h3", {}, "Recommendations"),
    h("p", { class: "help" },
      "What to do on each side of the route: where to parse, and what "
      + "Cribl, Elastic and the relay each own."),
    env.err(fp.concat("recommendations"))
      ? h("p", { class: "error" }, env.err(fp.concat("recommendations")))
      : null,
    sides.map((side) => recommendationSide(
      env, fp, recs, side, side === "guarded" && !hasGuardedRoute)));
}

function recommendationSide(env, fp, recs, side, orphan) {
  const sp = fp.concat("recommendations", side);
  const body = recs[side] !== null && typeof recs[side] === "object"
    ? recs[side] : {};
  const keys = (env.schema.vocab.rec_keys || {})[side] || [];
  const sideError = env.err(sp);
  return h("div", { class: orphan ? "rec-side rec-orphan" : "rec-side" },
    h("h4", {}, side === "guarded" ? "Guarded side" : "Direct side"),
    orphan
      ? h("p", { class: "error" },
          "The route has no guarded side, so these cannot be published.")
      : null,
    sideError ? h("p", { class: "error" }, sideError) : null,
    keys.map((key) => {
      const path = sp.concat(key);
      if (key === "parse_location") {
        // Commits through setRec like every other key, so clearing it prunes
        // a side whose only key it was instead of leaving `{}` behind, which
        // the validator rejects as "must not be empty".
        return vocabSelect(env, path, {
          label: "Parse location",
          value: body[key],
          options: env.schema.vocab.parse_locations,
          optional: true,
          onCommit: (value) => setRec(env, fp, side, key, value),
        });
      }
      return textArea({
        label: key,
        rows: 4,
        value: body[key],
        error: env.err(path),
        onChange: (value) => setRec(env, fp, side, key, value),
      });
    }),
    has(recs, side)
      ? h("div", { class: "btn-row" },
          h("button", {
            type: "button", class: "btn btn-danger",
            onclick: () => pruneRecs(env, fp, side),
          }, `Remove ${side} recommendations`))
      : null);
}

// Writing a recommendation prunes upwards: an empty side, and then an empty
// recommendations block, are removed rather than published as `{}`, which
// the validator rejects as "must not be empty".
export function setRec(env, fp, side, key, value) {
  const clean = String(value === null || value === undefined ? "" : value).trim();
  if (clean !== "") {
    env.set(fp.concat("recommendations", side, key), clean);
    return;
  }
  env.unset(fp.concat("recommendations", side, key));
  pruneEmpty(env, fp, side);
}

export function pruneRecs(env, fp, side) {
  env.unset(fp.concat("recommendations", side));
  const all = env.store.get(fp.concat("recommendations"));
  if (all && typeof all === "object" && Object.keys(all).length === 0) {
    env.unset(fp.concat("recommendations"));
  }
}

function pruneEmpty(env, fp, side) {
  const body = env.store.get(fp.concat("recommendations", side));
  if (body && typeof body === "object" && Object.keys(body).length === 0) {
    pruneRecs(env, fp, side);
    return;
  }
  const all = env.store.get(fp.concat("recommendations"));
  if (all && typeof all === "object" && Object.keys(all).length === 0) {
    env.unset(fp.concat("recommendations"));
  }
}

// --- field table -------------------------------------------------------

const FIELD_COLUMNS = ["#", "Vendor field", "Type", "Description",
                       "ECS target", "Status", "Custom", "Transform",
                       "Notes", ""];

function fieldTable(env, fp, entry, ds) {
  const fields = Array.isArray(entry.fields) ? entry.fields : [];
  const required = requiredEcs(env.schema, ds.event_categories);
  const summary = fieldSummary(fields, required);
  const listPath = fp.concat("fields");
  const body = h("tbody", {}, fields.map((field, at) =>
    fieldRow(env, listPath, field, at, fields.length, required)));
  if (fields.length === 0) {
    body.appendChild(h("tr", {},
      h("td", { colspan: String(FIELD_COLUMNS.length) },
        h("span", { class: "muted" },
          "No fields yet. Add one, or say why the inventory is empty "
          + "above."))));
  }
  return h("div", { class: "field-table-wrap" },
    h("h3", {}, "Fields"),
    h("p", { class: "summary-line" }, summaryLine(summary)),
    env.err(listPath) ? h("p", { class: "error" }, env.err(listPath)) : null,
    h("div", { class: "table-wrap field-table" },
      h("table", {},
        h("thead", {}, h("tr", {},
          FIELD_COLUMNS.map((name) => h("th", {}, name)))),
        body)),
    h("div", { class: "btn-row" },
      h("button", {
        type: "button", class: "btn",
        onclick: () => env.push(listPath, newField()),
      }, "+ Add field"),
      h("span", { class: "export-label" }, "Export"),
      exportButton(env, fp, "json"),
      exportButton(env, fp, "csv"),
      exportButton(env, fp, "yaml")));
}

const EXPORT_MIME = {
  json: "application/json;charset=utf-8",
  csv: "text/csv;charset=utf-8",
  yaml: "text/yaml;charset=utf-8",
};

const EXPORT_RENDER = { json: toJson, csv: toCsv, yaml: toYaml };

// One format, downloaded as it stands in the editor - drafts included, so
// what is on screen is what lands in the file.
//
// The document is read out of the store when the button is clicked rather
// than closed over from the render: typing in a cell commits to the store
// without repainting the table, so a captured format would be an edit stale
// by the time anyone pressed this.  fp is [.., "formats", n], so the dataset
// it belongs to is two segments up.
function exportButton(env, fp, kind) {
  return h("button", {
    type: "button", class: "btn btn-export",
    title: "Download this format as " + kind.toUpperCase(),
    onclick: () => {
      const store = env.store;
      const doc = {
        techId: String((store.doc && store.doc.id) || store.id || ""),
        dataset: store.get(fp.slice(0, -2)) || {},
        format: store.get(fp) || {},
      };
      downloadText(exportName(doc, kind), EXPORT_MIME[kind],
                   EXPORT_RENDER[kind](doc));
    },
  }, kind.toUpperCase());
}

function fieldRow(env, listPath, field, at, total, required) {
  const path = listPath.concat(at);
  if (field === null || typeof field !== "object" || Array.isArray(field)) {
    return h("tr", {}, h("td", { colspan: String(FIELD_COLUMNS.length) },
      h("span", { class: "error" }, `Field ${at + 1} is not a mapping.`)));
  }
  const status = typeof field.status === "string" ? field.status : "";
  const whole = env.err(path);
  return h("tr", { class: `field-row status-${status || "none"}` },
    h("td", { class: "cell-num" }, String(at + 1)),
    h("td", { class: "cell-vendor" },
      requiredText(env, path.concat("vendor"), { mono: true }),
      whole ? h("p", { class: "error" }, whole) : null),
    h("td", { class: "cell-type" },
      optionalText(env, path.concat("type"), {})),
    h("td", { class: "cell-prose" },
      optionalArea(env, path.concat("description"), { rows: 2 })),
    h("td", { class: "cell-ecs" },
      ecsPicker({
        value: field.ecs,
        ecs: env.schema.ecs,
        required,
        error: env.err(path.concat("ecs")),
        onChange: (value) => env.set(path.concat("ecs"), value),
      })),
    h("td", { class: "cell-status" },
      vocabSelect(env, path.concat("status"), {
        value: status,
        options: env.schema.vocab.field_statuses,
      })),
    h("td", { class: "cell-type" },
      optionalText(env, path.concat("custom"), { mono: true })),
    h("td", { class: "cell-prose" },
      optionalArea(env, path.concat("transform"), { rows: 2 })),
    h("td", { class: "cell-prose" },
      optionalArea(env, path.concat("notes"), { rows: 2 })),
    h("td", { class: "cell-controls" },
      h("div", { class: "row-controls" },
        iconButton("↑", "Move up", at === 0,
                   () => env.move(listPath, at, at - 1)),
        iconButton("↓", "Move down", at === total - 1,
                   () => env.move(listPath, at, at + 1)),
        iconButton("⧉", "Duplicate", false,
                   () => env.insert(listPath, at + 1, clone(field))),
        iconButton("✕", "Delete", false,
                   () => env.remove(listPath, at)))));
}
