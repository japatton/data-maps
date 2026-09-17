// #/tech/<id> — the editor: a rail that lists what the technology contains
// and a pane holding the form for whatever the rail has selected.
//
// The view owns three things the forms in editor-forms.js do not: getting a
// document into the store (published file, catalog row only, or brand new),
// the draft banner and autosave, and the repaint loop.  The decisions behind
// those three live in lib/editor-state.js and are tested there; `start`
// below is the wiring, and everything under it paints.  Every edit goes
// through the store, so validation, the change list and the emitter all see
// the same document.
//
// Repaints are coalesced and only the head, rail and pane are rebuilt; the
// caret is put back where it was, because a text widget commits on `change`
// (blur or Enter) and Enter would otherwise drop focus mid-form.

import { h, clear } from "../lib/dom.js";
import { errorFor } from "../lib/forms.js";
import { publishedFor } from "../lib/examples.js";
import {
  autosaveUnlessPending, flushAutosave, cancelAutosave, draftDecision,
  resolveLoad, attachExample,
} from "../lib/editor-state.js";
import {
  technologyForm, datasetForm, newDataset, pathLabel, confirmed,
  orderedSet, keyOrder,
} from "./editor-forms.js";

// How many upstream changes the stale-draft banner lists before it stops
// counting them out.
const MAX_BANNER_CHANGES = 20;

export function render(root, ctx, params) {
  // A draft save still pending from the technology being left belongs to
  // that technology, and the store still holds its document, so it is
  // written now rather than dropped 500 ms short of the edit.  Autosaves are
  // deliberately not covered by the generation guard - see the flush above.
  flushAutosave();
  const id = String((params && params.id) || "");
  // The shell bumped this before calling us: anything this render starts
  // paints only while it is still the render on screen.
  const mine = ctx.generation;
  const wrap = h("section", { class: "editor" },
    h("p", { class: "muted" }, "Loading…"));
  root.appendChild(wrap);
  start(wrap, ctx, id, mine).catch((err) => {
    if (ctx.generation !== mine) return;
    clear(wrap);
    wrap.appendChild(h("h1", {}, "This technology could not be opened"));
    wrap.appendChild(h("p", { class: "error" },
      String((err && err.message) || err)));
    wrap.appendChild(h("p", { class: "muted" },
      "Nothing was loaded, so nothing can be overwritten from here. Fix the "
      + "server or the address and reload."));
    wrap.appendChild(h("p", {}, h("a", { href: "#/" },
      "Back to technologies")));
  });
}

async function start(wrap, ctx, id, mine) {
  const store = ctx.store;
  const page = {
    ctx, id, mine, store,
    catalogRow: ctx.catalog.find((row) => row && row.id === id) || null,
    draft: null,
    savedAt: null,
    dirty: false,
    repaintQueued: false,
    head: h("div", { class: "editor-head" }),
    banner: h("div", { class: "editor-banner" }),
    rail: h("aside", { class: "rail" }),
    pane: h("div", { class: "pane" }),
  };

  // Keep what is already open (coming back from Review), otherwise fetch.
  const plan = resolveLoad({
    storeHas: store.id === id && store.doc !== null,
    row: page.catalogRow,
  });
  if (plan.action !== "keep") {
    // loadSource resolves null only for a genuine 404 and rejects on
    // anything else, so a blank document is never started over a server
    // error.  "load" opens the published file; "row-only" and "new" both
    // open a blank one - with a catalog row behind it, or without one.
    const source = await ctx.loadSource(id);
    if (ctx.generation !== mine) return;
    const opened = resolveLoad({ source, row: page.catalogRow,
                                 storeHas: false });
    store.loadTechnology(id, {
      source: opened.action === "load" ? source : null,
      catalogRow: page.catalogRow,
      published: publishedFor(ctx.examples, id),
    });
    ctx.editorSelection = { kind: "tech", index: 0, formatIndex: 0 };
    // Only a document just loaded from the published file can be replaced by
    // a draft; once the admin is editing, their own autosaves are not news.
    page.draft = safeCall(() => store.loadDraft(id), null);
  }

  // A sample attached from Analyze, handed over through the context because
  // the store may have been holding another technology at the time.  Taken
  // after the draft decision above, so resuming a draft merges it in rather
  // than replacing it (store.resumeDraft keeps records the draft has not
  // seen); cleared either way, so a later visit does not attach it twice.
  //
  // The draft is written as the record lands: nothing else will schedule an
  // autosave until the admin edits something, and a reload before then
  // would lose the record the admin just crossed a view to attach.
  const carried = ctx.pendingExample;
  if (carried && String(carried.tech) === id) {
    ctx.pendingExample = null;
    const written = safeCall(() => attachExample(store, {
      dataset: carried.dataset, label: carried.label || "",
      content: carried.content,
    }, page.draft), null);
    page.savedAt = written ? written.savedAt : null;
  }
  // store.isDirty() deep-compares the whole document against its baseline,
  // and the head is repainted on every keystroke that commits and on every
  // click in the rail.  The answer can only change when the document does,
  // so it is computed where the document is written and read from here.
  reread(page);

  clear(wrap);
  wrap.appendChild(page.head);
  wrap.appendChild(page.banner);
  wrap.appendChild(h("div", { class: "split" }, page.rail, page.pane));
  paint(page);
}

// --- the loop ------------------------------------------------------------

function live(page) {
  return page.ctx.generation === page.mine;
}

function reread(page) {
  page.dirty = safeCall(() => page.store.isDirty(), false);
}

function schedule(page) {
  if (page.repaintQueued) return;
  page.repaintQueued = true;
  Promise.resolve().then(() => {
    page.repaintQueued = false;
    if (live(page)) paint(page);
  });
}

// Autosave is debounced so a burst of edits (a duplicated field row, a
// kind change that rewrites a hop) writes one draft, not five.
//
// While the banner is still offering a stored draft, autosave is off: the
// document on screen is the published file, and saving it would overwrite
// the very draft the admin has not yet decided about.  Resume or Discard
// settles the question and switches saving back on.
function touched(page) {
  reread(page);
  autosaveUnlessPending(page.draft, page.id, () => {
    // The save is deliberately not generation-guarded (leaving the view
    // flushes it), but it must still be about this technology: a store
    // already reloaded for another one would write that document under
    // this id.
    if (page.store.id !== page.id) return;
    const written = safeCall(() => page.store.saveDraft(), null);
    page.savedAt = written ? written.savedAt : null;
    if (live(page) && page.head.isConnected) paintHead(page, page.store.errors());
  });
  schedule(page);
}

function paint(page) {
  const issues = page.store.errors();
  paintHead(page, issues);
  paintBanner(page);
  paintRail(page, issues);
  paintPane(page, issues);
}

// Every region is rebuilt from scratch, so whichever one holds the caret
// has to hand it back afterwards: the head and the rail carry buttons a
// keyboard reaches them by, not only the pane.
function repainting(node, draw) {
  const focus = focusPathIn(node, document.activeElement);
  clear(node);
  draw();
  restoreFocus(node, focus);
}

// --- the environment the forms edit through ------------------------------

function makeEnv(page, issues) {
  const store = page.store;
  const ctx = page.ctx;
  const seen = new Set();
  return {
    ctx,
    schema: ctx.schema,
    store,
    issues,
    seen,
    sel: selection(page),
    err(path) {
      seen.add(keyOf(path));
      return errorFor(issues, path);
    },
    // A key created here lands in the order the authored files use, not at
    // the end of its mapping, so the merge request shows an added line
    // rather than a reshuffled block.
    set(path, value) {
      orderedSet(store, path, value, keyOrder(path, store, ctx.schema));
      touched(page);
    },
    unset(path) { store.unset(path); touched(page); },
    // An optional key: a blank box removes it, so the emitter never writes
    // `notes: ""`.
    setText(path, value) {
      const clean = String(value === null || value === undefined ? "" : value)
        .trim();
      if (clean === "") {
        store.unset(path);
      } else {
        orderedSet(store, path, clean, keyOrder(path, store, ctx.schema));
      }
      touched(page);
    },
    insert(path, index, item) {
      store.insert(path, Number(index), item);
      touched(page);
    },
    // Appends, creating the list when the key is missing entirely.
    push(path, item) {
      const list = store.get(path);
      if (Array.isArray(list)) store.insert(path, list.length, item);
      else store.set(path, [item]);
      touched(page);
    },
    remove(path, index) { store.remove(path, Number(index)); touched(page); },
    addExample(record) { store.addExample(record); touched(page); },
    removeExample(index) {
      store.removeExample(Number(index));
      touched(page);
    },
    move(path, from, to) {
      store.move(path, Number(from), Number(to));
      touched(page);
    },
    select(patch) {
      Object.assign(page.ctx.editorSelection, patch);
      schedule(page);
    },
  };
}

// The selection, clamped to what the document actually holds: a deleted
// dataset or format must not leave the pane pointing past the end.
function selection(page) {
  const ctx = page.ctx;
  const store = page.store;
  const sel = ctx.editorSelection || (ctx.editorSelection = {});
  const datasets = Array.isArray(store.doc.datasets) ? store.doc.datasets : [];
  if (sel.kind !== "dataset" || datasets.length === 0) {
    sel.kind = "tech";
    sel.index = 0;
  } else {
    sel.index = clamp(Number(sel.index) || 0, datasets.length - 1);
  }
  const ds = sel.kind === "dataset" ? datasets[sel.index] : null;
  const formats = ds && Array.isArray(ds.formats) ? ds.formats : [];
  sel.formatIndex = formats.length
    ? clamp(Number(sel.formatIndex) || 0, formats.length - 1)
    : 0;
  return sel;
}

// --- the head ------------------------------------------------------------

function paintHead(page, issues) {
  const errorCount = issues.length;
  const title = errorCount
    ? `${errorCount} validation ${errorCount === 1 ? "error" : "errors"} `
      + `must be fixed before review:\n${errorLines(issues)}`
    : "Review the changes and open a merge request";
  repainting(page.head, () => paintHeadInto(page, errorCount, title));
}

function paintHeadInto(page, errorCount, title) {
  const { head, store, id, ctx } = page;
  // Whether the published catalog carries a row for this id - the delete
  // screen can remove that row even when no map file was ever built.
  const inCatalog = (ctx.catalog || []).some(
    (row) => row && row.id === id);
  head.appendChild(h("div", { class: "editor-title" },
    h("h1", {}, store.doc.name ? String(store.doc.name) : "Untitled"),
    h("span", { class: "mono muted" }, id),
    store.isNew ? h("span", { class: "badge badge-draft" }, "new file") : null,
    h("span", {
      class: errorCount ? "pill pill-bad" : "pill pill-on",
      title,
    }, errorCount
      ? `${errorCount} ${errorCount === 1 ? "error" : "errors"}`
      : "valid")));
  head.appendChild(h("div", { class: "btn-row" },
    h("button", {
      type: "button",
      class: "btn btn-primary",
      disabled: errorCount > 0,
      title,
      onclick: () => ctx.navigate(
        `#/tech/${encodeURIComponent(id)}/review`),
    }, "Review changes"),
    h("button", {
      type: "button",
      class: "btn",
      disabled: !safeCall(() => store.hasDraft(id), false),
      title: "Throw away this browser's draft and reload the published file",
      onclick: () => { discardDraft(page); },
    }, "Discard draft"),
    h("button", {
      type: "button", class: "btn btn-danger",
      // store.isNew only says the map file is absent, and that is not the
      // same as nothing to delete: a row-only technology (a catalog row with
      // no document yet) still has a row, and removing it is exactly what
      // the delete screen is for.  The published catalog is the honest
      // signal.  Only a technology in neither place is a genuine no-op.
      disabled: store.isNew && !inCatalog,
      title: store.isNew && !inCatalog
        ? "Not in the catalog and not published - there is nothing to delete."
        : "Remove this technology, its catalog row and its example records",
      onclick: () => ctx.navigate(`#/tech/${encodeURIComponent(id)}/delete`),
    }, "Delete technology"),
    h("span", { class: "muted" },
      page.dirty ? "unsaved changes" : "no changes yet"),
    page.savedAt
      ? h("span", { class: "muted" }, `· draft saved ${clock(page.savedAt)}`)
      : null));
}

// --- the draft banner ----------------------------------------------------

function paintBanner(page) {
  const { banner, store, draft } = page;
  clear(banner);
  if (draft === null) return;
  // What moved in the published files while this draft sat in the browser:
  // the draft's own record of the baseline it was taken from, diffed against
  // the baseline just loaded.
  const decision = draftDecision({
    draft, baseHash: store.baseHash(), baseline: store.baseline,
  });
  banner.appendChild(h("div", { class: "panel draft-banner" },
    h("p", {}, `A draft from ${when(draft.savedAt)} exists.`),
    decision.stale
      ? h("p", { class: "notice" },
          "The published file changed since this draft was saved.")
      : null,
    decision.changes ? changeList(decision.changes) : null,
    decision.stale
      ? h("p", { class: "notice" },
          "Resume puts the draft back exactly as it was saved, which undoes "
          + "the changes listed above unless you make them again. Discard "
          + "keeps the published file. Whichever you choose, the review "
          + "screen marks anything that would revert newer work.")
      : null,
    h("p", { class: "help" },
      "Autosave is paused until you choose, so editing below cannot "
      + "overwrite this draft."),
    h("div", { class: "btn-row" },
      h("button", {
        type: "button", class: "btn btn-primary",
        onclick: () => {
          store.resumeDraft(draft);
          page.draft = null;
          touched(page);
        },
      }, "Resume"),
      h("button", {
        type: "button", class: "btn",
        onclick: () => {
          safeCall(() => store.clearDraft(page.id), null);
          page.draft = null;
          reread(page);
          paint(page);
        },
      }, "Discard"))));
}

function changeList(lines) {
  const listed = lines.slice(0, MAX_BANNER_CHANGES);
  const rest = lines.length - listed.length;
  return h("div", {},
    h("ul", { class: "change-list" },
      listed.map((line) => h("li", {}, line))),
    rest > 0
      ? h("p", { class: "help" },
          `and ${rest} more ${rest === 1 ? "change" : "changes"}`)
      : null);
}

async function discardDraft(page) {
  const { ctx, store, id } = page;
  if (!confirmed("Discard this browser's draft and reload the published "
                 + "file? Unsaved edits are lost.")) return;
  // A save still in flight would write the draft straight back.
  cancelAutosave();
  safeCall(() => store.clearDraft(id), null);
  const source = await ctx.loadSource(id);
  if (!live(page)) return;
  // `published` on every load, without exception: it is what a new record's
  // stem is checked against, and a load that omitted it would leave the
  // collision check with nothing to collide with.
  store.loadTechnology(id, { source, catalogRow: page.catalogRow,
                             published: publishedFor(ctx.examples, id) });
  page.draft = null;
  page.savedAt = null;
  reread(page);
  ctx.editorSelection = { kind: "tech", index: 0, formatIndex: 0 };
  paint(page);
}

// --- the rail ------------------------------------------------------------

function paintRail(page, issues) {
  repainting(page.rail, () => paintRailInto(page, issues));
}

function paintRailInto(page, issues) {
  const { rail, store } = page;
  const sel = selection(page);
  const datasets = Array.isArray(store.doc.datasets) ? store.doc.datasets : [];
  const techErrors = issues.filter(
    (issue) => sectionOf(issue.path, store) === null).length;
  rail.appendChild(railItem({
    on: sel.kind === "tech",
    title: "Technology",
    sub: `${store.doc.vendor || "no vendor"} · ${datasets.length} `
       + `dataset${datasets.length === 1 ? "" : "s"}`,
    count: techErrors,
    onclick: () => { Object.assign(sel, { kind: "tech" }); schedule(page); },
  }));
  rail.appendChild(h("p", { class: "field-label rail-heading" }, "Datasets"));
  datasets.forEach((ds, index) => {
    const count = issues.filter((issue) =>
      sectionOf(issue.path, store) === index).length;
    const formats = ds && Array.isArray(ds.formats) ? ds.formats : [];
    rail.appendChild(railItem({
      on: sel.kind === "dataset" && sel.index === index,
      title: (ds && ds.name) || (ds && ds.id) || `Dataset ${index + 1}`,
      id: ds && ds.id,
      chips: formats.map((entry) =>
        ((entry && entry.format) ? String(entry.format) : "?")),
      count,
      onclick: () => {
        Object.assign(sel, { kind: "dataset", index, formatIndex: 0 });
        schedule(page);
      },
    }));
  });
  if (datasets.length === 0) {
    rail.appendChild(h("p", { class: "help" }, "No datasets yet."));
  }
  // "'datasets' must be a non-empty list" belongs to no dataset, so the
  // rail says it where the missing dataset would be.
  const listError = errorFor(issues, ["datasets"]);
  if (listError) rail.appendChild(h("p", { class: "error" }, listError));
  rail.appendChild(h("div", { class: "btn-row" },
    h("button", {
      type: "button", class: "btn",
      onclick: () => {
        const env = makeEnv(page, issues);
        env.push(["datasets"], newDataset());
        env.select({ kind: "dataset", index: datasets.length,
                     formatIndex: 0 });
      },
    }, "+ Add dataset")));
}

function railItem({ on, title, id: subId, sub, chips, count, onclick }) {
  return h("div", {
    class: on ? "rail-item rail-on" : "rail-item",
    // A div that answers to Enter and the space bar is a button, and
    // nothing but the role says so to a screen reader.
    role: "button",
    "aria-pressed": on ? "true" : "false",
    tabindex: "0",
    onclick,
    onkeydown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onclick();
      }
    },
  },
    h("div", { class: "rail-line" },
      h("strong", {}, String(title)),
      count ? h("span", { class: "badge badge-bad" }, String(count)) : null),
    subId ? h("div", { class: "mono muted" }, String(subId)) : null,
    sub ? h("div", { class: "muted rail-sub" }, sub) : null,
    chips && chips.length
      ? h("div", {}, chips.map((name) => h("span", { class: "chip" }, name)))
      : null);
}

// --- the pane ------------------------------------------------------------

function paintPane(page, issues) {
  repainting(page.pane, () => paintPaneInto(page, issues));
}

function paintPaneInto(page, issues) {
  const { pane, store } = page;
  const sel = selection(page);
  const env = makeEnv(page, issues);
  pane.appendChild(sel.kind === "dataset" ? datasetForm(env)
                                          : technologyForm(env));
  // Anything the forms did not anchor to a control - an unknown key, a
  // problem in a format that is not open, "'datasets' must be a non-empty
  // list" when there are none - is still the admin's to fix, so it is
  // listed rather than hidden.  Every issue belongs to exactly one section,
  // which is what keeps the two rail counts adding up to the header's.
  const wanted = sel.kind === "dataset" ? sel.index : null;
  const left = issues.filter((issue) =>
    Array.isArray(issue.path)
    && sectionOf(issue.path, store) === wanted
    && !env.seen.has(keyOf(issue.path)));
  if (left.length) {
    pane.appendChild(h("section", { class: "panel" },
      h("h3", {}, "Other problems here"),
      h("ul", {}, left.map((issue) => h("li", {},
        h("span", { class: "mono muted" }, pathLabel(issue.path)),
        " ",
        h("span", { class: "error-inline" }, issue.message))))));
  }
}

// --- small helpers -----------------------------------------------------

// The first few messages behind the error count, for the button's tooltip:
// "3 errors" says how much is wrong, this says what.
const TOOLTIP_ERRORS = 3;

function errorLines(issues) {
  const listed = issues.slice(0, TOOLTIP_ERRORS).map((issue) => {
    const where = Array.isArray(issue.path) ? pathLabel(issue.path) : "";
    return where ? `· ${where}: ${issue.message}` : `· ${issue.message}`;
  });
  const rest = issues.length - listed.length;
  if (rest > 0) {
    listed.push(`· and ${rest} more ${rest === 1 ? "error" : "errors"}`);
  }
  return listed.join("\n");
}

function keyOf(path) {
  return (Array.isArray(path) ? path : []).map(String).join(" ");
}

// Which dataset an issue belongs to, or null for one that belongs to the
// technology - including ["datasets"] itself, which is about the list rather
// than about a member of it, and any index the list does not have.
//
// A pending example record is filed under the dataset it names, because that
// is the section its panel is drawn in; one naming a dataset the document
// does not have has nowhere else to go and lands on the technology.
function sectionOf(path, store) {
  if (!Array.isArray(path)) return null;
  const datasets = Array.isArray(store.doc.datasets) ? store.doc.datasets : [];
  if (String(path[0]) === "examples") {
    const record = (store.examples || [])[Number(path[1])];
    if (!record) return null;
    const at = datasets.findIndex(
      (ds) => ds && String(ds.id) === String(record.dataset));
    return at === -1 ? null : at;
  }
  if (String(path[0]) !== "datasets") return null;
  const index = Number(path[1]);
  if (!Number.isInteger(index) || index < 0 || index >= datasets.length) {
    return null;
  }
  return index;
}

function clamp(value, high) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), Math.max(high, 0));
}

function safeCall(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (err) {
    return fallback;
  }
}

function when(iso) {
  const date = new Date(String(iso || ""));
  if (Number.isNaN(date.getTime())) return String(iso || "an earlier session");
  return date.toLocaleString();
}

function clock(iso) {
  const date = new Date(String(iso || ""));
  if (Number.isNaN(date.getTime())) return "just now";
  return date.toLocaleTimeString();
}

// The focused control as a chain of child indices under `root`, so the caret
// can be put back after the pane is rebuilt.  A structural change (an error
// line appearing) can land it on a neighbour; that is better than losing the
// keyboard entirely, and restoreFocus refuses anything that is not a control.
function focusPathIn(root, node) {
  if (!node || !root || !root.contains(node)) return null;
  const path = [];
  let current = node;
  while (current !== root) {
    const parent = current.parentNode;
    if (!parent || !parent.children) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, current));
    current = parent;
  }
  return path;
}

const FOCUSABLE = ["INPUT", "SELECT", "TEXTAREA", "BUTTON"];

function restoreFocus(root, path) {
  if (!path || path.length === 0) return;
  let node = root;
  for (const index of path) {
    if (!node || !node.children || !node.children[index]) return;
    node = node.children[index];
  }
  // A rail item is a div with a tabindex and a button role, so the tag name
  // alone does not say whether the keyboard can hold it.
  const focusable = FOCUSABLE.includes(node.tagName)
    || (node.getAttribute && node.getAttribute("tabindex") !== null);
  if (!focusable || node.disabled) return;
  node.focus();
  if (node.tagName === "TEXTAREA"
      || (node.tagName === "INPUT" && node.type === "text")) {
    safeCall(() => node.setSelectionRange(node.value.length,
                                          node.value.length), null);
  }
}
