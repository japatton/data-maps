// The working document an admin edits in Studio.
//
// The store holds one technology document plus its catalog row, applies form
// edits addressed by path, answers "is this valid / what changed / is it
// dirty", and keeps a draft in browser storage so a half-finished edit
// survives a reload.  Paths whose first segment is "row" address the catalog
// row; every other path addresses the technology document.
//
// Browser module: storage is injected (defaulting to localStorage, resolved
// lazily so importing this file touches no browser globals).

import { validateTechnology, validateCatalog } from "./validate.js";
import { diffDocs, deepEqual } from "./diff.js";
import { exampleStem, validateExample } from "./examples.js";
import { globalObject } from "./global.js";

const DRAFT_PREFIX = "datamaps-studio-draft:";

// The most a single draft record may occupy, in JSON characters. Browsers
// give an origin a few megabytes of localStorage in total, so one draft that
// large would evict everything else it shares the origin with.
//
// The draft carries the attached example records as well as the document
// and its baseline, so a technology with a couple of 256 KB records counts
// them all against this; the baseline is what gets dropped first.
const SIZE_LIMIT = 4 * 1024 * 1024;

// FNV-1a, 32 bits, over the JSON text of `obj`, as eight lowercase hex
// digits.  Used to record which baseline a draft was taken from, so a draft
// resumed after the catalog moved on can be flagged as stale.
export function hashDoc(obj) {
  const text = JSON.stringify(obj);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clone(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function blankDoc(id) {
  return { id, name: "", vendor: "", datasets: [] };
}

function blankRow(id) {
  return {
    id,
    name: "",
    vendor: "",
    category: "",
    status: "planned",
    priority: "standard",
  };
}

export function createStore({ schema, storage } = {}) {
  const subscribers = [];

  const store = {
    id: null,
    doc: null,
    row: null,
    baseline: null,
    // The published document a resumed draft was taken from, when the draft
    // kept one.  Only set by resumeDraft, only when the file moved on
    // underneath the draft; null otherwise, and null again on load().
    resumedFrom: null,
    isNew: false,
    // Raw example records attached in this session, as
    // {dataset, label, content}.  They are not part of the YAML document -
    // the commit writes each one as its own file - but they travel with it:
    // saved into the draft, listed by changes(), validated by errors(), and
    // dropped the moment another technology is loaded.
    examples: [],
    // The technology's entry in the published examples.json,
    // {dataset: [{label, path, size}]}, so a new record can be checked
    // against the stems that already exist.
    publishedExamples: {},
    addExample,
    removeExample,
    loadTechnology,
    newTechnology,
    get,
    set,
    unset,
    insert,
    remove,
    move,
    errors,
    isDirty,
    changes,
    subscribe,
    saveDraft,
    hasDraft,
    loadDraft,
    clearDraft,
    resumeDraft,
    reverts,
    baseHash,
  };

  // Resolved on use, never at import: a module-scope read of localStorage
  // would break in any non-browser host and in privacy modes that throw.
  function backing() {
    if (storage !== undefined && storage !== null) {
      return storage;
    }
    try {
      return globalObject.localStorage || null;
    } catch (err) {
      return null;
    }
  }

  function notify() {
    for (const fn of subscribers.slice()) {
      fn(store);
    }
  }

  function subscribe(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("store.subscribe: expected a function");
    }
    subscribers.push(fn);
    return function unsubscribe() {
      const at = subscribers.indexOf(fn);
      if (at !== -1) {
        subscribers.splice(at, 1);
      }
    };
  }

  function load(id, source, catalogRow, published) {
    store.id = id;
    store.isNew = source === null || source === undefined;
    store.doc = store.isNew ? blankDoc(id) : clone(source);
    store.row = catalogRow === null || catalogRow === undefined
      ? blankRow(id)
      : clone(catalogRow);
    // Pending records belong to the technology that was open, so loading
    // another one drops them rather than filing them under the wrong id.
    store.examples = [];
    store.publishedExamples = published && typeof published === "object"
      ? published
      : {};
    store.baseline = { doc: clone(store.doc), row: clone(store.row) };
    store.resumedFrom = null;
    notify();
    return store;
  }

  function loadTechnology(id, { source = null, catalogRow = null,
                                published = null } = {}) {
    return load(id, source, catalogRow, published);
  }

  function newTechnology(id) {
    return load(id, null, null, null);
  }

  // --- example records --------------------------------------------------

  /** Attach one raw record; whether it is valid is errors()' business. */
  function addExample(record) {
    requireLoaded("addExample");
    const entry = record && typeof record === "object" ? record : {};
    store.examples.push({
      dataset: String(entry.dataset === null || entry.dataset === undefined
        ? "" : entry.dataset),
      label: String(entry.label === null || entry.label === undefined
        ? "" : entry.label).trim(),
      content: String(entry.content === null || entry.content === undefined
        ? "" : entry.content),
    });
    notify();
    return store;
  }

  /** Detach the record at `index`; no record there is a RangeError. */
  function removeExample(index) {
    requireLoaded("removeExample");
    if (!Number.isInteger(index) || index < 0
        || index >= store.examples.length) {
      throw new RangeError(`store.removeExample: no record at index ${index}`);
    }
    store.examples.splice(index, 1);
    notify();
    return store;
  }

  function exampleIssues() {
    const out = [];
    const excluded = (schema && schema.examples
      && Array.isArray(schema.examples.excluded))
      ? schema.examples.excluded
      : [];
    store.examples.forEach((entry, index) => {
      const others = store.examples.filter((_, at) => at !== index);
      for (const issue of validateExample(entry, store.doc,
                                          store.publishedExamples, others,
                                          excluded)) {
        out.push({ path: ["examples", index].concat(issue.path),
                   message: issue.message });
      }
    });
    return out;
  }

  // --- paths ------------------------------------------------------------

  function requireLoaded(caller) {
    if (store.doc === null) {
      throw new Error(
        `store.${caller}: load a technology before editing it`);
    }
  }

  function resolve(path) {
    const parts = Array.isArray(path) ? path : [path];
    if (parts[0] === "row") {
      return { root: store.row, rest: parts.slice(1) };
    }
    return { root: store.doc, rest: parts };
  }

  function get(path) {
    const { root, rest } = resolve(path);
    let node = root;
    for (const key of rest) {
      if (node === null || node === undefined || typeof node !== "object") {
        return undefined;
      }
      node = node[key];
    }
    return node;
  }

  // A numeric segment addressing a list may name an existing item or the one
  // position past the end (which appends); anything beyond that would leave
  // holes - an array with empty slots that JSON.stringify writes as nulls and
  // the validator then reports as a broken document.
  //
  // A path that carries the index as a string ("4") indexes the array exactly
  // as the number does, so it is held to exactly the same bounds rather than
  // slipping past the check and writing the hole itself.
  function checkIndex(node, key, caller) {
    if (!Array.isArray(node)) {
      return;
    }
    const index = typeof key === "number"
      ? key
      : (typeof key === "string" && /^-?\d+$/.test(key) ? Number(key) : null);
    if (index === null) {
      return;
    }
    if (index < 0 || index > node.length) {
      throw new RangeError(
        `store.${caller}: index ${key} is outside 0..${node.length}`);
    }
  }

  // Walks to the parent of `rest`, creating the containers on the way: an
  // array when the next segment is a number, an object otherwise.
  function parentOf(root, rest, create, caller) {
    let node = root;
    for (let index = 0; index < rest.length - 1; index += 1) {
      const key = rest[index];
      if (caller !== undefined) checkIndex(node, key, caller);
      let next = node[key];
      if (next === null || next === undefined || typeof next !== "object") {
        if (!create) {
          return undefined;
        }
        next = typeof rest[index + 1] === "number" ? [] : {};
        node[key] = next;
      }
      node = next;
    }
    return node;
  }

  function set(path, value) {
    requireLoaded("set");
    const { root, rest } = resolve(path);
    if (rest.length === 0) {
      throw new Error("store.set: path must name a key");
    }
    const parent = parentOf(root, rest, true, "set");
    const key = rest[rest.length - 1];
    checkIndex(parent, key, "set");
    parent[key] = value;
    notify();
    return store;
  }

  function unset(path) {
    requireLoaded("unset");
    const { root, rest } = resolve(path);
    if (rest.length === 0) {
      throw new Error("store.unset: path must name a key");
    }
    const parent = parentOf(root, rest, false);
    if (parent === undefined || parent === null) {
      return store;
    }
    const key = rest[rest.length - 1];
    if (Array.isArray(parent) && typeof key === "number") {
      parent.splice(key, 1);
    } else {
      delete parent[key];
    }
    notify();
    return store;
  }

  // --- list mutators ----------------------------------------------------

  function listAt(path, caller) {
    requireLoaded(caller);
    const list = get(path);
    if (!Array.isArray(list)) {
      throw new Error(`store.${caller}: ${JSON.stringify(path)} is not a list`);
    }
    return list;
  }

  // Where an item *lands* is clamped; which item is *acted on* is not.
  //
  // insert's `index` and move's `to` are destinations: a caller that says
  // "put it at the end" by passing the length, or that arrives with a stale
  // index after a re-render, gets the nearest legal position rather than an
  // exception, and nothing is lost.  remove's `index` and move's `from` name
  // an existing item, and a wrong one there means the caller is about to
  // delete or move something it did not mean to, so those throw RangeError.
  // store.set follows the same rule for a numeric path segment: past the end
  // of the list is a RangeError rather than a hole.
  function clamp(index, high) {
    if (!Number.isInteger(index)) {
      return high;
    }
    return Math.min(Math.max(index, 0), high);
  }

  /** Insert `item` at `index`; an index outside the list is clamped. */
  function insert(path, index, item) {
    const list = listAt(path, "insert");
    list.splice(clamp(index, list.length), 0, item);
    notify();
    return store;
  }

  /** Remove the item at `index`; no item there is a RangeError. */
  function remove(path, index) {
    const list = listAt(path, "remove");
    if (!Number.isInteger(index) || index < 0 || index >= list.length) {
      throw new RangeError(`store.remove: no item at index ${index}`);
    }
    const [gone] = list.splice(index, 1);
    // A pending record names its dataset by id, so deleting the dataset
    // would leave a record the commit cannot file and the validator can
    // only complain about.  The invariant is kept here, where the dataset
    // actually goes, rather than in each caller.
    if (isDatasetList(path) && gone && typeof gone === "object") {
      dropExamplesFor(gone.id);
    }
    notify();
    return store;
  }

  function isDatasetList(path) {
    const parts = Array.isArray(path) ? path : [path];
    return parts.length === 1 && String(parts[0]) === "datasets";
  }

  // A dataset with no id yet takes nothing with it: "" is not a name a
  // record can meaningfully have been filed under.
  function dropExamplesFor(datasetId) {
    const id = typeof datasetId === "string" ? datasetId : "";
    if (id === "") return;
    store.examples = store.examples.filter(
      (entry) => String(entry.dataset) !== id);
  }

  // `to` is the index the item lands on once it has been lifted out, so
  // move(p, 0, 1) on [a, b, c] gives [b, a, c].  No item at `from` is a
  // RangeError; a `to` outside the list is clamped.
  function move(path, from, to) {
    const list = listAt(path, "move");
    if (!Number.isInteger(from) || from < 0 || from >= list.length) {
      throw new RangeError(`store.move: no item at index ${from}`);
    }
    const [item] = list.splice(from, 1);
    list.splice(clamp(to, list.length), 0, item);
    notify();
    return store;
  }

  // --- validation, dirtiness, change summary ----------------------------

  const ROW_PREFIX = "catalog[0]:";

  function unwrapRowMessage(message) {
    return typeof message === "string" && message.startsWith(ROW_PREFIX)
      ? `catalog:${message.slice(ROW_PREFIX.length)}`
      : message;
  }

  function errors() {
    // The expected id is the one the document was loaded or created under -
    // its filename - not the id currently typed into the form, so that editing
    // the id field to something else is reported as the mismatch it is.
    const expectedId = store.id !== null
      ? store.id
      : (store.doc && store.doc.id);
    const issues = validateTechnology(store.doc, expectedId, schema);
    // The catalog validator only speaks in whole catalogs, so the row is
    // wrapped in a one-row catalog and the issues are pulled back under
    // ["row", ...] for the form to highlight.  The wrapper's index leaks into
    // the message too ("catalog[0]: ..."), so that is trimmed to "catalog:".
    for (const issue of validateCatalog({ technologies: [store.row] },
                                        schema)) {
      const path = issue.path;
      const rowPath = path[0] === "technologies" && path[1] === 0
        ? ["row"].concat(path.slice(2))
        : ["row"];
      issues.push({ path: rowPath, message: unwrapRowMessage(issue.message) });
    }
    for (const issue of exampleIssues()) {
      issues.push(issue);
    }
    return issues;
  }

  function isDirty() {
    if (store.baseline === null) {
      return false;
    }
    // An attached record is a change even when the document itself is
    // untouched: it is a file this commit would create.
    if (store.examples.length > 0) {
      return true;
    }
    return !deepEqual({ doc: store.doc, row: store.row }, store.baseline);
  }

  function changes() {
    if (store.baseline === null) {
      return [];
    }
    const docChanges = diffDocs(store.baseline.doc, store.doc);
    const rowChanges = diffDocs(store.baseline.row, store.row).map(
      (change) => Object.assign({}, change, {
        label: `catalog.${change.label}`,
        path: ["row"].concat(change.path),
      }));
    const exampleChanges = store.examples.map((entry, index) => ({
      path: ["examples", index],
      label: `examples[${exampleStem(entry.dataset, entry.label)}]`,
      kind: "added",
    }));
    return docChanges.concat(rowChanges, exampleChanges);
  }

  // --- drafts -----------------------------------------------------------

  function baseHash() {
    return hashDoc(store.baseline);
  }

  function draftKey(id) {
    return DRAFT_PREFIX + id;
  }

  // Returns the saved draft, or null when no storage is available.
  //
  // The record carries the baseline as well as the edit, which doubles its
  // size; a document large enough to push the pair past SIZE_LIMIT drops the
  // baseline rather than the draft, and says so with `baselineOmitted` - the
  // stale-draft list then falls back to the warning alone, which is what a
  // pre-baseline draft already does.
  function saveDraft() {
    const backend = backing();
    if (backend === null || store.id === null) {
      return null;
    }
    const draft = {
      id: store.id,
      doc: clone(store.doc),
      row: clone(store.row),
      examples: clone(store.examples),
      isNew: store.isNew,
      baseHash: baseHash(),
      // The published document and row this draft was taken from, so a
      // draft resumed after the files moved on can say what moved rather
      // than only that something did.  Older drafts have no `baseline`;
      // the hash alone still marks them stale.
      baseline: clone(store.baseline),
      savedAt: new Date().toISOString(),
    };
    let text = JSON.stringify(draft);
    if (text.length > SIZE_LIMIT) {
      delete draft.baseline;
      draft.baselineOmitted = true;
      text = JSON.stringify(draft);
    }
    try {
      backend.setItem(draftKey(store.id), text);
    } catch (err) {
      // A full quota or a storage-blocking privacy mode must not take the
      // form down with it; the edit lives on in memory either way.
      return null;
    }
    return draft;
  }

  // A record this cannot make sense of is removed as it is read: hasDraft
  // only looks for the key, so a corrupt one left in place would keep the
  // picker's "draft" badge lit for a draft nothing can ever resume.
  function loadDraft(id) {
    const backend = backing();
    if (backend === null) {
      return null;
    }
    let raw;
    try {
      raw = backend.getItem(draftKey(id));
    } catch (err) {
      // Storage refused the read; there is nothing to clear, and nothing
      // says the record is bad.
      return null;
    }
    if (raw === null || raw === undefined) {
      return null;
    }
    let draft = null;
    try {
      draft = JSON.parse(raw);
    } catch (err) {
      draft = null;
    }
    if (draft !== null && typeof draft === "object") {
      return draft;
    }
    clearDraft(id);
    return null;
  }

  // Only whether a record is there: the picker asks this for every row it
  // draws, and parsing each draft to answer would be megabytes of JSON for a
  // yes/no.  A record too corrupt to parse still counts as a draft until
  // something reads it: loadDraft is where that is discovered and cleared.
  function hasDraft(id) {
    const backend = backing();
    if (backend === null) {
      return false;
    }
    try {
      return backend.getItem(draftKey(id)) !== null;
    } catch (err) {
      return false;
    }
  }

  function clearDraft(id) {
    const backend = backing();
    if (backend !== null) {
      try {
        backend.removeItem(draftKey(id));
      } catch (err) {
        // Nothing to do: the draft is unreachable either way.
      }
    }
    return store;
  }

  // Replaces the working document with the draft's; the baseline stays as it
  // was loaded, so isDirty()/changes() still measure against the committed
  // files rather than against the draft.
  function resumeDraft(draft) {
    if (draft === null || typeof draft !== "object") {
      return store;
    }
    if (draft.doc !== undefined) {
      store.doc = clone(draft.doc);
    }
    if (draft.row !== undefined) {
      store.row = clone(draft.row);
    }
    // The document is replaced, but attached records are merged: one carried
    // in from Analyze on the way to this screen arrived after the draft was
    // written, and resuming must not silently throw it away.  A stem the
    // draft already holds wins, so a record is never attached twice.
    if (Array.isArray(draft.examples)) {
      const merged = clone(draft.examples);
      const stems = merged.map(
        (entry) => exampleStem(entry && entry.dataset, entry && entry.label));
      for (const entry of store.examples) {
        const stem = exampleStem(entry.dataset, entry.label);
        if (stems.indexOf(stem) === -1) {
          merged.push(entry);
          stems.push(stem);
        }
      }
      store.examples = merged;
    }
    if (typeof draft.isNew === "boolean") {
      store.isNew = draft.isNew;
    }
    // Keep what the draft was taken from, so reverts() can separate the
    // user's own edits from the published changes this resume undoes.  A
    // draft that exceeded SIZE_LIMIT had its baseline dropped on the way in
    // and carries baselineOmitted instead; there is nothing to compare
    // against then, and saying nothing is better than guessing.
    store.resumedFrom = draft.baseline && typeof draft.baseline === "object"
      ? clone(draft.baseline)
      : null;
    notify();
    return store;
  }

  // The subset of changes() that puts back a value the draft was written
  // against, over a different value that has since been published.  Each one
  // undoes somebody else's committed edit, which is the case the review
  // screen has to call out: the drift guard cannot see it, because the
  // baseline it compares was loaded fresh and does match the branch.
  function reverts() {
    if (store.resumedFrom === null || store.baseline === null) {
      return [];
    }
    return changes().filter((change) => {
      const path = change.path || [];
      const inRow = path[0] === "row";
      const rest = inRow ? path.slice(1) : path;
      if (path[0] === "examples") {
        return false;
      }
      const draftSide = valueAt(
        inRow ? store.resumedFrom.row : store.resumedFrom.doc, rest);
      const baseSide = valueAt(
        inRow ? store.baseline.row : store.baseline.doc, rest);
      const nowSide = valueAt(inRow ? store.row : store.doc, rest);
      // Restoring exactly what the draft was written against, over a
      // baseline that says something else.  An edit the user actually made
      // fails the first test; a field nobody touched fails the second.
      return deepEqual(nowSide, draftSide) && !deepEqual(baseSide, draftSide);
    });
  }

  function valueAt(root, path) {
    let node = root;
    for (const step of path) {
      if (node === null || node === undefined) {
        return undefined;
      }
      node = node[step];
    }
    return node;
  }

  return store;
}
