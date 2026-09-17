// The editor's decisions, with no DOM in them: how a technology gets into
// the store, what the stale-draft banner has to say, and when an edit may be
// autosaved.  views/editor.js wires these to nodes and paints the answers.

import { diffDocs, describeChanges } from "./diff.js";

/**
 * How to open technology `id`.
 *
 *   keep      the store already holds it (coming back from Review)
 *   load      the published document was fetched and is what to open
 *   row-only  the catalog has a row for it but there is no map file yet
 *   new       neither, so this is a technology nobody has written down
 *
 * `source` is what ctx.loadSource answered: null for a genuine 404 only - it
 * rejects on anything else, so a blank document is never started over a
 * server error.
 */
export function resolveLoad({ source, row, storeHas }) {
  if (storeHas) return { action: "keep" };
  if (source !== null && source !== undefined) return { action: "load" };
  if (row !== null && row !== undefined) return { action: "row-only" };
  return { action: "new" };
}

/**
 * What the draft banner says: whether the published file moved under this
 * draft, and what moved.
 *
 * `baseHash` is the store's hash of the baseline just loaded; `baseline` is
 * that baseline, which the draft's own copy is diffed against.  A draft
 * saved with its baseline left out (too large for storage) is still stale;
 * there is simply nothing to list.  Never diff against the working document:
 * that would invent upstream changes nobody made.
 */
export function draftDecision({ draft, baseHash, baseline, baselineOmitted }) {
  if (draft === null || draft === undefined) {
    return { stale: false, changes: null };
  }
  const stale = String(draft.baseHash || "") !== String(baseHash || "");
  if (!stale) return { stale: false, changes: null };
  const omitted = baselineOmitted === undefined
    ? draft.baselineOmitted : baselineOmitted;
  if (omitted === true) return { stale: true, changes: null };
  const base = draft.baseline;
  if (base === null || typeof base !== "object") {
    return { stale: true, changes: null };
  }
  if (baseline === null || typeof baseline !== "object") {
    return { stale: true, changes: null };
  }
  const rowChanges = diffDocs(base.row, baseline.row).map(
    (change) => Object.assign({}, change, {
      label: `catalog.${change.label}`,
    }));
  const lines = plainLines(diffDocs(base.doc, baseline.doc).concat(rowChanges));
  return { stale: true, changes: lines.length ? lines : null };
}

// describeChanges writes Markdown, because its other reader is the merge
// request description; the banner is plain text nodes, so the emphasis and
// the backticks come back off.
export function plainLines(changes) {
  const text = describeChanges(changes);
  if (!text) return [];
  return text.split("\n")
    .map((line) => line.replace(/^- /, "").replace(/\*\*/g, "")
      .replace(/`/g, ""))
    .filter((line) => line !== "");
}

/**
 * Attach a record that arrived from outside the form, and write the draft.
 *
 * Every edit made through a widget schedules an autosave; a record attached
 * from Analyze arrives without one, so nothing would persist it until the
 * admin happened to type something else.  The draft is therefore written
 * straight away - unless a stored draft is still waiting for Resume or
 * Discard (`draft` holds it), when writing would overwrite the very draft
 * the admin has not decided about.
 *
 * Returns the draft record written, or null when nothing was written.
 */
export function attachExample(store, record, draft) {
  store.addExample(record);
  if (draft !== null && draft !== undefined) return null;
  return store.saveDraft();
}

// --- the autosave queue ------------------------------------------------
//
// One pending draft save for the whole application, not one per view: the
// editor for technology B must flush A's last edit rather than drop it, and
// A's view is already gone by the time B renders.

export const AUTOSAVE_MS = 500;

const REAL_TIMER = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle),
};

const pending = { id: null, run: null, handle: null, clear: null };

function takePending() {
  const run = pending.run;
  pending.id = null;
  pending.run = null;
  pending.handle = null;
  pending.clear = null;
  return run;
}

// Debounces `run` for `id`.  A save already pending for a *different* id is
// flushed first, so switching technologies never loses the last edit.
export function scheduleAutosave(id, run, { delay = AUTOSAVE_MS,
                                            timer = REAL_TIMER } = {}) {
  if (pending.handle !== null && pending.id !== id) flushAutosave();
  else cancelAutosave();
  pending.id = id;
  pending.run = run;
  pending.clear = timer.clear;
  pending.handle = timer.set(() => {
    const job = takePending();
    if (job) job();
  }, delay);
  return id;
}

export function flushAutosave() {
  if (pending.handle === null) return false;
  const handle = pending.handle;
  const clear = pending.clear;
  const run = takePending();
  if (clear) clear(handle);
  if (run) run();
  return true;
}

export function cancelAutosave() {
  if (pending.handle === null) return false;
  const handle = pending.handle;
  const clear = pending.clear;
  takePending();
  if (clear) clear(handle);
  return true;
}

export function pendingAutosave() {
  return pending.id;
}

// The editor's rule for when an edit may be autosaved.  While a stored draft
// is still waiting for Resume or Discard, `draft` holds it and nothing is
// scheduled: the document on screen is the published file, and saving it
// would overwrite the very draft the admin has not decided about.  Resume or
// Discard sets `draft` to null and saving resumes.
export function autosaveUnlessPending(draft, id, run, options) {
  if (draft !== null && draft !== undefined) return false;
  scheduleAutosave(id, run, options);
  return true;
}
