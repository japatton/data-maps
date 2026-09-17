// The editor's decisions: how a technology gets into the store, what the
// stale-draft banner has to say, and when an edit may be autosaved.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA, goodTech } from "./fixtures.js";
import { createStore } from "../lib/store.js";
import {
  resolveLoad, draftDecision, plainLines, autosaveUnlessPending,
  scheduleAutosave, flushAutosave, cancelAutosave, pendingAutosave,
  attachExample, AUTOSAVE_MS,
} from "../lib/editor-state.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- getting a document open ---------------------------------------------

test("a document already open is kept rather than fetched again", () => {
  // Coming back from Review: refetching would throw away the edits.
  assert.deepEqual(
    resolveLoad({ storeHas: true, source: null, row: null }),
    { action: "keep" });
});

test("a published file is loaded", () => {
  assert.deepEqual(
    resolveLoad({ storeHas: false, source: goodTech(), row: { id: "t" } }),
    { action: "load" });
});

test("a catalog row with no map file yet opens on the row alone", () => {
  assert.deepEqual(
    resolveLoad({ storeHas: false, source: null, row: { id: "t" } }),
    { action: "row-only" });
});

test("neither a file nor a row is a brand new technology", () => {
  assert.deepEqual(
    resolveLoad({ storeHas: false, source: null, row: null }),
    { action: "new" });
  assert.deepEqual(resolveLoad({ storeHas: false }), { action: "new" });
});

// --- the draft banner -----------------------------------------------------

function draftOf(doc, row, hash) {
  return {
    id: "t", savedAt: "2026-09-01T10:00:00.000Z", baseHash: hash,
    baseline: { doc, row },
  };
}

test("no draft is nothing to decide", () => {
  assert.deepEqual(draftDecision({ draft: null, baseHash: "abc" }),
                   { stale: false, changes: null });
});

test("a draft taken from the baseline on screen is not stale", () => {
  const decision = draftDecision({
    draft: draftOf(goodTech(), { id: "t" }, "abc"),
    baseHash: "abc",
    baseline: { doc: goodTech(), row: { id: "t" } },
  });
  assert.deepEqual(decision, { stale: false, changes: null });
});

test("a moved published file makes the draft stale and says what moved", () => {
  const was = goodTech();
  const now = goodTech();
  now.name = "Renamed Technology";
  const decision = draftDecision({
    draft: draftOf(was, { id: "t", status: "mapped" }, "old-hash"),
    baseHash: "new-hash",
    baseline: { doc: now, row: { id: "t", status: "planned" } },
  });
  assert.equal(decision.stale, true);
  assert.ok(Array.isArray(decision.changes));
  const text = decision.changes.join("\n");
  assert.match(text, /name/);
  // A catalog row change is labelled as one, so the two lists do not read
  // as edits to the same file.
  assert.match(text, /catalog\.status/);
  // Plain text: the Markdown the merge request description uses is stripped.
  assert.ok(!text.includes("**"), text);
  assert.ok(!text.includes("`"), text);
});

test("a draft whose baseline was too large to store is stale with no list",
     () => {
  const draft = draftOf(goodTech(), { id: "t" }, "old");
  delete draft.baseline;
  draft.baselineOmitted = true;
  assert.deepEqual(
    draftDecision({ draft, baseHash: "new",
                    baseline: { doc: goodTech(), row: { id: "t" } } }),
    { stale: true, changes: null });
});

test("a draft from before Studio recorded baselines is stale on its own", () => {
  const draft = { id: "t", savedAt: "2026-08-01T10:00:00.000Z",
                  baseHash: "old" };
  assert.deepEqual(draftDecision({ draft, baseHash: "new", baseline: null }),
                   { stale: true, changes: null });
});

test("nothing to list is null rather than an empty list", () => {
  // The hashes differ (a reformat, say) but the documents read the same.
  const decision = draftDecision({
    draft: draftOf(goodTech(), { id: "t" }, "old"),
    baseHash: "new",
    baseline: { doc: goodTech(), row: { id: "t" } },
  });
  assert.deepEqual(decision, { stale: true, changes: null });
});

test("plainLines drops the Markdown the description needs", () => {
  assert.deepEqual(plainLines([]), []);
  const lines = plainLines([
    { kind: "changed", label: "name", before: "a", after: "b" },
  ]);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].startsWith("- "), lines[0]);
});

// --- the autosave rules ---------------------------------------------------

function fakeTimer() {
  let queued = null;
  return {
    set(fn) { queued = fn; return 1; },
    clear() { queued = null; },
    fire() {
      const fn = queued;
      queued = null;
      if (fn) fn();
    },
  };
}

test("an edit while a stored draft waits for an answer saves nothing", () => {
  const timer = fakeTimer();
  let saves = 0;
  assert.equal(
    autosaveUnlessPending({ id: "t" }, "t", () => { saves += 1; }, { timer }),
    false);
  assert.equal(pendingAutosave(), null);
  timer.fire();
  assert.equal(saves, 0);
});

test("an edit with the draft question settled is scheduled", () => {
  const timer = fakeTimer();
  let saves = 0;
  assert.equal(
    autosaveUnlessPending(null, "t", () => { saves += 1; }, { timer }),
    true);
  assert.equal(pendingAutosave(), "t");
  timer.fire();
  assert.equal(saves, 1);
  assert.equal(pendingAutosave(), null);
});

test("a burst of edits writes one draft", () => {
  const timer = fakeTimer();
  let saves = 0;
  const run = () => { saves += 1; };
  scheduleAutosave("t", run, { timer });
  scheduleAutosave("t", run, { timer });
  scheduleAutosave("t", run, { timer });
  timer.fire();
  assert.equal(saves, 1);
  assert.equal(AUTOSAVE_MS, 500);
});

test("leaving a technology flushes its last edit rather than dropping it",
     () => {
  const timer = fakeTimer();
  const saved = [];
  scheduleAutosave("a", () => saved.push("a"), { timer });
  // The editor for b renders: a's save belongs to a, and is written now.
  scheduleAutosave("b", () => saved.push("b"), { timer });
  assert.deepEqual(saved, ["a"]);
  assert.equal(flushAutosave(), true);
  assert.deepEqual(saved, ["a", "b"]);
  assert.equal(flushAutosave(), false);
});

test("a discarded draft cancels the save that would write it back", () => {
  const timer = fakeTimer();
  let saves = 0;
  scheduleAutosave("t", () => { saves += 1; }, { timer });
  assert.equal(cancelAutosave(), true);
  timer.fire();
  assert.equal(saves, 0);
  assert.equal(cancelAutosave(), false);
});

// --- attaching a record from outside the form -----------------------------
//
// Every edit made through a widget schedules an autosave; a record attached
// from Analyze arrives without one, so the draft has to be written as the
// record lands or a reload loses it.

function opened(published) {
  const cells = new Map();
  const store = createStore({
    schema: SCHEMA,
    storage: {
      getItem: (k) => (cells.has(k) ? cells.get(k) : null),
      setItem: (k, v) => cells.set(k, String(v)),
      removeItem: (k) => cells.delete(k),
    },
  });
  store.loadTechnology("t", { source: goodTech(), catalogRow: null,
                              published: published || {} });
  return { store, cells };
}

test("a record attached from Analyze is written to the draft at once", () => {
  const { store, cells } = opened();
  const written = attachExample(
    store, { dataset: "d", label: "vpn", content: "a line\n" }, null);
  assert.ok(written, "the draft record is returned");
  const stored = JSON.parse(cells.get("datamaps-studio-draft:t"));
  assert.deepEqual(stored.examples,
                   [{ dataset: "d", label: "vpn", content: "a line\n" }]);
  assert.equal(written.savedAt, stored.savedAt);
});

test("a record attached under the draft banner does not overwrite it", () => {
  const { store, cells } = opened();
  // The draft an earlier session left behind.
  store.set(["name"], "From the draft");
  store.saveDraft();
  const before = cells.get("datamaps-studio-draft:t");
  store.loadTechnology("t", { source: goodTech(), catalogRow: null });
  const waiting = store.loadDraft("t");

  const written = attachExample(
    store, { dataset: "d", label: "vpn", content: "x" }, waiting);
  // The record is attached either way - it is the admin's edit - but the
  // stored draft is the one Resume still has to offer.
  assert.equal(written, null);
  assert.equal(store.examples.length, 1);
  assert.equal(cells.get("datamaps-studio-draft:t"), before);
});

// --- the load contract views/editor.js has to keep ------------------------
//
// `published` is what a new record's stem is checked against; a load that
// omitted it would leave the collision check with an empty list and Studio
// would happily commit a file that already exists.  There is no DOM here to
// drive the view through, so the call sites are read instead.
test("every editor load hands the store the published records", () => {
  let sites = 0;
  for (const view of ["editor.js", "review.js"]) {
    const source = readFileSync(path.join(HERE, "..", "views", view), "utf8");
    const calls = source.split("store.loadTechnology(").slice(1);
    assert.ok(calls.length >= 1, `${view}: no load call sites`);
    for (const call of calls) {
      const args = call.split(");")[0];
      assert.match(args, /published:/,
                   `${view}: a loadTechnology call omits published: ${args}`);
      sites += 1;
    }
    // And the listing is read through the one shared helper, not a copy
    // per view that could drift from it.
    assert.ok(!/function publishedFor\b/.test(source),
              `${view} keeps its own publishedFor`);
    assert.match(source, /publishedFor[^\n]*from "\.\.\/lib\/examples\.js"|import \{[^}]*publishedFor/,
                 `${view} does not import publishedFor`);
  }
  assert.ok(sites >= 3, `only ${sites} load call sites across the views`);
});

test("a store loaded without published records collides with nothing", () => {
  // Why the test above matters, at the store level.
  const published = { d: [{ label: "", path: "examples/t/d.log", size: 4 }] };
  const { store } = opened(published);
  const exampleIssues = () => store.errors().filter(
    (issue) => issue.path[0] === "examples");
  store.addExample({ dataset: "d", label: "", content: "x" });
  assert.deepEqual(exampleIssues().map((issue) => issue.path),
                   [["examples", 0, "label"]]);
  store.loadTechnology("t", { source: goodTech(), catalogRow: null });
  store.addExample({ dataset: "d", label: "", content: "x" });
  assert.deepEqual(exampleIssues(), [],
                   "the published stem is invisible once it is dropped");
});
