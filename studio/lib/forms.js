// The form widgets every Studio view is built from.
//
// Each widget returns one Element and reports edits through `onChange`.
// Text-ish widgets commit on the DOM `change` event (blur or Enter) rather
// than on every keystroke, so a view that re-renders itself when the store
// changes does not yank the caret out of the box mid-word; selects, checkboxes
// and the list controls commit immediately, as they have no intermediate
// state.
//
// `document` is only touched inside the widgets, never at import time, so
// this module still loads under Node for the pure helpers below.

import { h, clear } from "./dom.js";

// The first message pinned to exactly this path.  Paths mix strings and
// numbers (["datasets", 0, "id"]); segments are compared as text so a
// caller may pass either.
export function errorFor(issues, path) {
  if (!Array.isArray(issues) || !Array.isArray(path)) return null;
  for (const issue of issues) {
    if (!issue || !Array.isArray(issue.path)) continue;
    if (samePath(issue.path, path)) return issue.message;
  }
  return null;
}

function samePath(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (String(a[i]) !== String(b[i])) return false;
  }
  return true;
}

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

// The lines every widget ends with, in one order everywhere: what the field
// is for, then what is wrong with it.  Either may be absent; h() flattens the
// array and skips the nulls.
function tail({ help, error } = {}) {
  return [
    help ? h("p", { class: "help" }, help) : null,
    error ? h("p", { class: "error" }, error) : null,
  ];
}

// The shell every labelled widget shares: label, control, help, error.
function field(id, label, control, { help, error, cls } = {}) {
  return h("div", { class: cls ? `field ${cls}` : "field" },
    label ? h("label", { class: "field-label", for: id }, label) : null,
    control,
    tail({ help: help, error: error }));
}

function fire(onChange, value) {
  if (typeof onChange === "function") onChange(value);
}

export function textField({ label, value, placeholder, onChange, help, error,
                            mono, type = "text" } = {}) {
  const id = nextId("f");
  const input = h("input", {
    id,
    type,
    class: mono ? "mono" : null,
    value: value === null || value === undefined ? "" : String(value),
    placeholder: placeholder || null,
    "aria-invalid": error ? "true" : null,
    onchange: (event) => fire(onChange, event.target.value),
  });
  return field(id, label, input, { help, error });
}

export function textArea({ label, value, rows = 4, onChange, help, error,
                           placeholder } = {}) {
  const id = nextId("f");
  const input = h("textarea", {
    id,
    rows: String(rows),
    value: value === null || value === undefined ? "" : String(value),
    placeholder: placeholder || null,
    "aria-invalid": error ? "true" : null,
    onchange: (event) => fire(onChange, event.target.value),
  });
  return field(id, label, input, { help, error });
}

// `options` accepts plain strings or {value, label}.  `allowEmpty` adds a
// leading blank choice, and picking it reports "".
export function selectField({ label, value, options = [], onChange,
                              allowEmpty, error, help, emptyLabel = "—" } = {}) {
  const id = nextId("f");
  const select = h("select", {
    id,
    "aria-invalid": error ? "true" : null,
    onchange: (event) => fire(onChange, event.target.value),
  });
  const list = allowEmpty
    ? [{ value: "", label: emptyLabel }].concat(options.map(normalizeOption))
    : options.map(normalizeOption);
  for (const option of list) {
    select.appendChild(h("option", { value: option.value }, option.label));
  }
  // Assigned after the options exist: an empty <select> silently drops it.
  select.value = value === null || value === undefined ? "" : String(value);
  return field(id, label, select, { help, error });
}

function normalizeOption(option) {
  if (option && typeof option === "object") {
    const label = option.label === null || option.label === undefined
      ? option.value
      : option.label;
    return { value: String(option.value), label: String(label) };
  }
  return { value: String(option), label: String(option) };
}

export function checkbox({ label, checked, onChange, help } = {}) {
  const id = nextId("c");
  const box = h("input", {
    id,
    type: "checkbox",
    checked: Boolean(checked),
    onchange: (event) => fire(onChange, event.target.checked),
  });
  return h("div", { class: "field field-check" },
    h("label", { class: "check-line", for: id }, box, h("span", {}, label || "")),
    tail({ help: help }));
}

// The selection after ticking or unticking `value`.
//
// The order the document already carries is kept and a newly ticked value is
// appended, rather than the whole list being re-sorted into `options` order:
// `event_categories: [network, authentication]` is the author's ordering and
// ticking a third box must not rewrite it.
export function toggleSelection(values, value, on) {
  const current = (values || []).map(String);
  const wanted = String(value);
  const kept = current.filter((item) => item !== wanted);
  if (!on) return kept;
  return current.indexOf(wanted) === -1 ? kept.concat(wanted) : current;
}

// A set of checkboxes over `options`; reports the whole selected list on
// every tick, in the order the values were chosen.
export function checkboxGroup({ label, values = [], options = [], onChange,
                               error, help } = {}) {
  let chosen = (values || []).map(String);
  const list = options.map(normalizeOption);
  const boxes = list.map((option) => {
    const id = nextId("cg");
    return h("label", { class: "check-line", for: id },
      h("input", {
        id,
        type: "checkbox",
        checked: chosen.indexOf(option.value) !== -1,
        onchange: (event) => {
          chosen = toggleSelection(chosen, option.value, event.target.checked);
          fire(onChange, chosen.slice());
        },
      }),
      h("span", {}, option.label));
  });
  return h("div", { class: "field" },
    label ? h("p", { class: "field-label" }, label) : null,
    h("div", { class: "check-grid" }, boxes),
    tail({ help: help, error: error }));
}

// An ordered list of sub-forms.  `render(item, index, api)` draws one item's
// body; `api.update(partial)` merges `partial` into the item in place - the
// item is the caller's own object, usually a node of the store's working
// document, and it is already changed by the time `onUpdate(index, item,
// partial)` is called, so a handler that wants the old value must have kept
// it, and one that only needs the store notified can pass `partial` on.  The up/down/remove
// controls call `onMove(from, to)` and `onRemove(index)` — the caller owns
// the array (usually via the store), so nothing is mutated here.
//
// `help` and `error` print through the same tail every other widget ends
// with, so a list explains itself where a text field would.
export function listEditor({ label, items = [], render, onAdd, onRemove,
                             onMove, onUpdate, addLabel = "Add", error, help,
                             empty = "Nothing yet." } = {}) {
  const rows = items.map((item, index) => {
    const api = {
      index,
      update(partial) {
        Object.assign(item, partial);
        if (typeof onUpdate === "function") onUpdate(index, item, partial);
      },
    };
    const controls = h("div", { class: "list-controls" },
      button("↑", "Move up", index === 0, () => onMove && onMove(index, index - 1)),
      button("↓", "Move down", index === items.length - 1,
             () => onMove && onMove(index, index + 1)),
      button("✕", "Remove", false, () => onRemove && onRemove(index)));
    return h("div", { class: "list-item" },
      h("div", { class: "list-item-head" },
        h("span", { class: "list-index" }, `#${index + 1}`), controls),
      h("div", { class: "list-item-body" },
        typeof render === "function" ? render(item, index, api) : null));
  });
  return h("div", { class: "field list-editor" },
    label ? h("p", { class: "field-label" }, label) : null,
    rows.length ? rows : h("p", { class: "help" }, empty),
    tail({ help: help, error: error }),
    onAdd ? h("button", { type: "button", class: "btn", onclick: () => onAdd() },
              addLabel) : null);
}

function button(text, title, disabled, onclick) {
  return h("button", {
    type: "button", class: "btn btn-icon", title, "aria-label": title,
    disabled: Boolean(disabled), onclick,
  }, text);
}

// What a string list reports: the rows as typed, minus the ones nobody
// filled in, so an "Add reference" row left blank never reaches the
// document as ''.
export function filledStrings(values) {
  return (values || [])
    .map((value) => (value === null || value === undefined ? "" : String(value)))
    .filter((value) => value.trim() !== "");
}

// A list of plain strings — one input per line, plus add and remove.  Every
// edit reports the whole array, blanks dropped.
//
// The rows are drawn from the widget's own copy rather than straight from
// `items`, because an empty row has to exist on screen to be typed into
// while never being reported: "Add" grows the copy and redraws, and only a
// row with something in it reaches `onChange`.
export function stringList({ label, items = [], onChange, placeholder, help,
                            error, addLabel = "Add" } = {}) {
  const current = (items || []).map((v) => (v === null || v === undefined ? "" : String(v)));
  const rows = h("div", {});

  function report() {
    fire(onChange, filledStrings(current));
  }

  function draw() {
    clear(rows);
    if (current.length === 0) {
      rows.appendChild(h("p", { class: "help" }, "None."));
      return;
    }
    current.forEach((value, index) => {
      rows.appendChild(h("div", { class: "string-row" },
        h("input", {
          type: "text",
          value,
          placeholder: placeholder || null,
          onchange: (event) => {
            current[index] = event.target.value;
            report();
          },
        }),
        button("✕", "Remove", false, () => {
          current.splice(index, 1);
          draw();
          report();
        })));
    });
  }

  draw();
  return h("div", { class: "field string-list" },
    label ? h("p", { class: "field-label" }, label) : null,
    rows,
    tail({ help: help, error: error }),
    h("button", {
      type: "button", class: "btn",
      onclick: () => { current.push(""); draw(); },
    }, addLabel));
}

const ECS_DATALIST_ID = "studio-ecs-fields";
// The id each dictionary object's <datalist> was built under.  Keyed on the
// object itself: a second dictionary (a narrowed one, or a reload that
// rebuilt it) must get its own list rather than silently offering the first
// one's names, and a dictionary nothing holds any more is collectable.
const ECS_DATALISTS = new WeakMap();
let datalistSeq = 0;

// One <datalist> per dictionary: it is ~2600 entries, and a copy per field
// row would be thousands of nodes on a wide format.  Returns null for a
// dictionary with nothing in it, so the input simply offers no completions.
function ecsDatalist(ecs) {
  if (ecs === null || typeof ecs !== "object") return null;
  const names = Object.keys(ecs);
  if (names.length === 0) return null;
  const known = ECS_DATALISTS.get(ecs);
  // The page may have been redrawn from scratch since the list was built.
  if (known !== undefined && document.getElementById(known)) return known;
  datalistSeq += 1;
  const id = datalistSeq === 1
    ? ECS_DATALIST_ID
    : `${ECS_DATALIST_ID}-${datalistSeq}`;
  const list = h("datalist", { id });
  for (const name of names) {
    list.appendChild(h("option", { value: name }));
  }
  document.body.appendChild(list);
  ECS_DATALISTS.set(ecs, id);
  return id;
}

// A free-text box backed by the ECS dictionary, with a live hint line: the
// chosen field's type and short description, "not in ECS" for an unknown
// name, and an alerting-required badge when the dataset's profiles ask for
// it.  An empty box commits null, which is how "no target" is stored.
export function ecsPicker({ label, value, ecs = {}, required, onChange, error,
                           help } = {}) {
  const id = nextId("ecs");
  const need = required instanceof Set
    ? required
    : new Set(Array.isArray(required) ? required : []);
  const hint = h("p", { class: "help ecs-hint" });

  function describe(name) {
    const clean = String(name || "").trim();
    if (clean === "") return [h("span", { class: "muted" }, "no ECS target")];
    const entry = ecs[clean];
    const badge = need.has(clean)
      ? h("span", { class: "badge badge-draft" }, "alerting-required")
      : null;
    if (!entry) {
      return [h("span", { class: "error-inline" }, "not in ECS"), badge];
    }
    return [
      h("span", { class: "mono" }, entry.type || "?"),
      h("span", {}, ` — ${entry.short || ""}`),
      badge,
    ];
  }

  function paint(name) {
    while (hint.firstChild) hint.removeChild(hint.firstChild);
    for (const node of describe(name)) if (node) hint.appendChild(node);
  }

  const input = h("input", {
    id,
    type: "text",
    class: "mono",
    list: ecsDatalist(ecs),
    value: value === null || value === undefined ? "" : String(value),
    placeholder: "ecs.field.name",
    "aria-invalid": error ? "true" : null,
    oninput: (event) => paint(event.target.value),
    onchange: (event) => {
      const clean = event.target.value.trim();
      fire(onChange, clean === "" ? null : clean);
    },
  });
  paint(value);
  return h("div", { class: "field" },
    label ? h("label", { class: "field-label", for: id }, label) : null,
    input,
    hint,
    tail({ help: help, error: error }));
}
