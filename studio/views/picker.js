// #/ — the technology picker: every catalog row, searchable, with the two
// facts the catalog itself cannot show (does a map exist, is there an
// unfinished draft in this browser), plus the door to a brand new one.

import { h, clear } from "../lib/dom.js";
import { isSlug } from "../lib/validate.js";

const COLUMNS = ["Name", "Vendor", "Category", "Status", "Map", "Draft"];

// A column whose heading needs a word of explanation.
const COLUMN_TITLES = {
  Map: "inferred from status: a planned technology may still have a file",
};

export function render(root, ctx) {
  let query = "";
  let adding = false;
  let addError = null;
  let addValue = "";

  const count = h("span", { class: "count" });
  const body = h("tbody");
  const addBox = h("div", { class: "panel new-tech" });

  const search = h("input", {
    type: "search",
    placeholder: "Search id, name, vendor or category…",
    "aria-label": "Search technologies",
    oninput: (event) => {
      query = event.target.value;
      paintRows();
    },
  });

  // Which technologies this browser has an unfinished draft for, read once
  // for the whole render rather than once per row per keystroke: the search
  // box repaints the table on every character.
  const drafts = draftIds(ctx.store, ctx.catalog);
  const statuses = knownStatuses(ctx.schema);

  function paintRows() {
    const rows = filter(ctx.catalog, query);
    clear(body);
    for (const row of rows) {
      body.appendChild(rowNode(ctx, row, drafts, statuses));
    }
    if (rows.length === 0) {
      body.appendChild(h("tr", {},
        h("td", { colspan: String(COLUMNS.length) },
          h("span", { class: "muted" }, "No technology matches that search."))));
    }
    count.textContent =
      `${rows.length} of ${ctx.catalog.length} technologies`;
  }

  function paintAdd() {
    clear(addBox);
    addBox.hidden = !adding;
    if (!adding) return;
    // The box is rebuilt whenever the error line changes, so what was typed
    // is kept here rather than in the DOM.
    const input = h("input", {
      type: "text",
      class: "mono",
      value: addValue,
      placeholder: "cisco-asa",
      "aria-label": "New technology id",
      oninput: (event) => { addValue = event.target.value; },
      onkeydown: (event) => { if (event.key === "Enter") submit(input.value); },
    });
    addBox.appendChild(h("p", { class: "field-label" }, "New technology id"));
    addBox.appendChild(input);
    addBox.appendChild(h("p", { class: "help" },
      "A slug: lower-case letters, digits and hyphens. It becomes " +
      "data/technologies/<id>.yml and cannot be changed later."));
    if (addError) addBox.appendChild(h("p", { class: "error" }, addError));
    addBox.appendChild(h("div", { class: "btn-row" },
      h("button", {
        type: "button", class: "btn btn-primary",
        onclick: () => submit(input.value),
      }, "Create"),
      h("button", {
        type: "button", class: "btn",
        onclick: () => {
          adding = false;
          addError = null;
          addValue = "";
          paintAdd();
        },
      }, "Cancel")));
    input.focus();
    input.setSelectionRange(addValue.length, addValue.length);
  }

  function submit(raw) {
    const id = String(raw || "").trim();
    addValue = id;
    if (id === "") {
      addError = "Enter an id.";
    } else if (!isSlug(id, ctx.schema)) {
      addError = `'${id}' must match ${ctx.schema.vocab.slug_pattern}`;
    } else if (ctx.catalog.some((row) => row && row.id === id)) {
      addError = `'${id}' is already in the catalog.`;
    } else {
      ctx.navigate(`#/tech/${encodeURIComponent(id)}`);
      return;
    }
    paintAdd();
  }

  const section = h("section", {},
    h("h1", {}, "Technologies"),
    h("div", { class: "toolbar" },
      search,
      h("button", {
        type: "button", class: "btn btn-primary",
        onclick: () => { adding = !adding; addError = null; paintAdd(); },
      }, "New technology"),
      count),
    addBox,
    h("div", { class: "table-wrap" },
      h("table", {},
        h("thead", {}, h("tr", {}, COLUMNS.map((name) => h("th", {
          title: COLUMN_TITLES[name] || null,
        }, name)))),
        body)));

  paintAdd();
  paintRows();
  root.appendChild(section);
}

function filter(catalog, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (needle === "") return catalog.slice();
  return catalog.filter((row) => {
    if (!row) return false;
    return ["id", "name", "vendor", "category"].some((key) =>
      String(row[key] || "").toLowerCase().includes(needle));
  });
}

function rowNode(ctx, row, drafts, statuses) {
  const id = String(row.id || "");
  const status = String(row.status || "");
  const href = `#/tech/${encodeURIComponent(id)}`;
  // A map file exists for everything that is not merely planned; asking the
  // server would mean 87 requests to draw one page.
  const mapped = status !== "" && status !== "planned";
  return h("tr", {
    class: "clickable",
    // The name is a real link, so the keyboard, the middle button and "open
    // in a new tab" all work; clicking anywhere else in the row is a
    // convenience on top of it.
    onclick: (event) => {
      if (insideLink(event.target)) return;
      ctx.navigate(href);
    },
  },
    h("td", {}, h("a", { href }, h("strong", {}, String(row.name || id))),
      h("div", { class: "mono muted" }, id)),
    h("td", {}, String(row.vendor || "")),
    h("td", {}, String(row.category || "")),
    // A status the schema does not know (or none at all) has no badge
    // colour to wear, and an empty badge reads as a rendering fault.
    h("td", {}, statuses.has(status)
      ? h("span", { class: `badge badge-status-${status}` }, status)
      : h("span", { class: "muted" }, status === "" ? "—" : status)),
    h("td", {}, mapped ? "yes" : "no"),
    h("td", {}, drafts.has(id)
      ? h("span", { class: "badge badge-draft" }, "draft")
      : ""));
}

// The link handles its own click; letting the row handle it too would
// navigate twice for one gesture.
function insideLink(node) {
  let current = node;
  while (current && current.tagName) {
    if (current.tagName === "A") return true;
    current = current.parentNode;
  }
  return false;
}

// The ids with a draft in this browser.  A browser in private mode can
// refuse storage outright; a picker that cannot say "draft" is still a
// usable picker.
//
// Asked one row at a time, so a refusal on one id costs that row's badge
// rather than every badge after it.
export function draftIds(store, catalog) {
  const out = new Set();
  for (const row of catalog || []) {
    if (!row || !row.id) continue;
    try {
      if (store.hasDraft(row.id)) out.add(String(row.id));
    } catch (err) {
      // This row simply gets no badge.
    }
  }
  return out;
}

function knownStatuses(schema) {
  const vocab = (schema && schema.vocab) || {};
  return new Set(Array.isArray(vocab.statuses) ? vocab.statuses : []);
}
