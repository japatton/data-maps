// The editor's mutation logic: what an edit does to the document, tested
// against the real store rather than through a DOM.
//
// `env` is the object the forms are handed by views/editor.js; here it is
// the same two writers over a real store, so the tests exercise the exact
// code path the widgets take.

import test from "node:test";
import assert from "node:assert/strict";
import { SCHEMA, goodTech } from "./fixtures.js";
import { createStore } from "../lib/store.js";
import { validateTechnology } from "../lib/validate.js";
import {
  keysAfter, orderedInsert, orderedSet, keyOrder, hopAfterKind, setRec,
  pruneRecs, setRecommended, newFormat,
} from "../views/editor-forms.js";
// The queue, from where it lives: editor-forms.js only re-exports it.
import {
  cancelAutosave, pendingAutosave, autosaveUnlessPending,
} from "../lib/editor-state.js";

// The published key order the editor now works from: the same table
// datamaps/schema.py defines and the validator reads.
const ORDER = SCHEMA.vocab.key_order;

// A memory-backed store holding the fixture document, plus the env the
// forms mutate through.
function open(doc = goodTech()) {
  const storage = new Map();
  const store = createStore({
    schema: SCHEMA,
    storage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
  });
  store.loadTechnology("t", { source: doc, catalogRow: null });
  const env = {
    schema: SCHEMA,
    store,
    set: (path, value) =>
      orderedSet(store, path, value, keyOrder(path, store, SCHEMA)),
    unset: (path) => store.unset(path),
  };
  return { store, env, storage };
}

// --- canonical key order -----------------------------------------------

test("keysAfter names the existing keys a new key must precede", () => {
  const format = { format: "json", parsing: {}, fields: [] };
  assert.deepEqual(keysAfter(format, "enable", ORDER.format),
                   ["parsing", "fields"]);
  assert.deepEqual(keysAfter(format, "recommendations", ORDER.format), []);
  assert.deepEqual(keysAfter(format, "unknown-key", ORDER.format), []);
  assert.deepEqual(keysAfter(null, "enable", ORDER.format), []);
  assert.deepEqual(keysAfter([1, 2], "enable", ORDER.format), []);
});

test("orderedInsert places a new key where an author would write it", () => {
  const route = { direct: [] };
  assert.deepEqual(
    Object.keys(orderedInsert(route, "guarded", [], ORDER.route)),
    ["guarded", "direct"]);
  const ds = { id: "d", name: "D", event_categories: [], route: {}, formats: [] };
  assert.deepEqual(
    Object.keys(orderedInsert(ds, "description", "why", ORDER.dataset)),
    ["id", "name", "description", "event_categories", "route", "formats"]);
  const field = { vendor: "v", ecs: null, status: "unmapped" };
  assert.deepEqual(Object.keys(orderedInsert(field, "type", "ip", ORDER.field)),
                   ["vendor", "type", "ecs", "status"]);
});

test("orderedInsert leaves an existing key where it already is", () => {
  const odd = { name: "n", id: "i" };
  const out = orderedInsert(odd, "id", "j", ORDER.technology);
  assert.deepEqual(Object.keys(out), ["name", "id"]);
  assert.equal(out.id, "j");
  // and the original is untouched
  assert.equal(odd.id, "i");
});

test("orderedInsert appends a key the order does not name", () => {
  const out = orderedInsert({ id: "i", name: "n" }, "bogus", 1,
                            ORDER.technology);
  assert.deepEqual(Object.keys(out), ["id", "name", "bogus"]);
});

// Each one is the published table's own array, so a key added to
// schema.py's KEY_ORDER reaches the editor without a second edit here.
test("keyOrder recognises every mapping the editor writes into", () => {
  const { store } = open();
  assert.equal(keyOrder(["versions"], store, SCHEMA), ORDER.technology);
  assert.equal(keyOrder(["row", "category"], store, SCHEMA),
               ORDER.catalog_row);
  assert.equal(keyOrder(["datasets", 0, "description"], store, SCHEMA),
               ORDER.dataset);
  assert.equal(keyOrder(["datasets", 0, "route", "guarded"], store, SCHEMA),
               ORDER.route);
  assert.equal(keyOrder(["datasets", 0, "formats", 0, "enable"], store, SCHEMA),
               ORDER.format);
  assert.deepEqual(
    keyOrder(["datasets", 0, "formats", 0, "parsing", "notes"], store, SCHEMA),
    ["mechanism", "artifact", "notes"]);
  assert.equal(
    keyOrder(["datasets", 0, "formats", 0, "fields", 1, "type"], store, SCHEMA),
    ORDER.field);
  assert.equal(
    keyOrder(["datasets", 0, "formats", 0, "recommendations", "guarded"],
             store, SCHEMA),
    ORDER.recommendations);
  assert.equal(
    keyOrder(["datasets", 0, "formats", 0, "recommendations", "direct",
              "cribl"], store, SCHEMA),
    ORDER.recommendation_side.direct);
  // a hop takes its order from its own kind
  assert.deepEqual(
    keyOrder(["datasets", 0, "route", "direct", 0, "notes"], store, SCHEMA),
    ["hop", "location", "notes"]);
  assert.deepEqual(keyOrder(["datasets", 0, "nowhere", "deep"], store, SCHEMA),
                   []);
});

test("orderedSet puts a guarded route before the direct one", () => {
  const { store, env } = open();
  env.set(["datasets", 0, "route", "guarded"], [{ hop: "guard" }]);
  assert.deepEqual(Object.keys(store.get(["datasets", 0, "route"])),
                   ["guarded", "direct"]);
});

test("orderedSet threads new keys through the whole document", () => {
  const { store, env } = open();
  env.set(["versions"], "1.0");
  assert.deepEqual(Object.keys(store.doc),
                   ["id", "name", "vendor", "versions", "datasets"]);
  env.set(["datasets", 0, "description"], "what it is");
  assert.deepEqual(Object.keys(store.get(["datasets", 0])),
                   ["id", "name", "description", "event_categories", "route",
                    "formats"]);
  env.set(["datasets", 0, "formats", 0, "enable"], "logging on");
  assert.deepEqual(Object.keys(store.get(["datasets", 0, "formats", 0])),
                   ["format", "enable", "parsing", "recommendations",
                    "fields"]);
  env.set(["datasets", 0, "formats", 0, "fields", 0, "type"], "ip");
  assert.deepEqual(
    Object.keys(store.get(["datasets", 0, "formats", 0, "fields", 0])),
    ["vendor", "type", "ecs", "status"]);
});

test("orderedSet updating an existing key moves nothing", () => {
  const { store, env } = open();
  const before = Object.keys(store.get(["datasets", 0]));
  env.set(["datasets", 0, "name"], "Renamed");
  assert.deepEqual(Object.keys(store.get(["datasets", 0])), before);
  assert.equal(store.get(["datasets", 0, "name"]), "Renamed");
});

test("orderedSet writing into a list element is a plain write", () => {
  const { store, env } = open();
  env.set(["datasets", 0, "route", "direct", 0], { hop: "elastic" });
  assert.deepEqual(store.get(["datasets", 0, "route", "direct", 0]),
                   { hop: "elastic" });
  assert.equal(store.get(["datasets", 0, "route", "direct"]).length, 2);
});

test("orderedSet refuses a path with no key", () => {
  const { store } = open();
  assert.throws(() => orderedSet(store, [], 1, ORDER.technology), TypeError);
});

// --- hop kind ----------------------------------------------------------

test("hopAfterKind keeps only what the new kind allows", () => {
  const hop = { hop: "guard", device: "HSG", constraints: "none",
                notes: "n" };
  // device and constraints belong to `guard` alone; notes is shared, so it
  // survives both moves
  assert.deepEqual(hopAfterKind(SCHEMA, hop, "elastic"),
                   { hop: "elastic", notes: "n" });
  assert.deepEqual(hopAfterKind(SCHEMA, hop, "cribl"),
                   { hop: "cribl", notes: "n" });
  assert.deepEqual(hopAfterKind(SCHEMA, { hop: "guard", device: "HSG" },
                                "elastic"), { hop: "elastic" });
  // the surviving keys come back in the new kind's own order
  assert.deepEqual(
    Object.keys(hopAfterKind(SCHEMA, { hop: "other", notes: "n", name: "x" },
                             "other")),
    ["hop", "name", "notes"]);
});

test("hopAfterKind tolerates a broken hop and an unknown kind", () => {
  assert.deepEqual(hopAfterKind(SCHEMA, null, "cribl"), { hop: "cribl" });
  assert.deepEqual(hopAfterKind(SCHEMA, { hop: "cribl", location: "edge" },
                                "nonesuch"), { hop: "nonesuch" });
});

// --- recommendations ---------------------------------------------------

test("setRec writes a recommendation and prunes when it is cleared", () => {
  const { store, env } = open();
  const fp = ["datasets", 0, "formats", 0];
  setRec(env, fp, "direct", "cribl", "  do the thing  ");
  assert.equal(store.get(fp.concat("recommendations", "direct", "cribl")),
               "do the thing");
  setRec(env, fp, "direct", "cribl", "");
  // parse_location is still there, so only the one key went
  assert.deepEqual(store.get(fp.concat("recommendations", "direct")),
                   { parse_location: "low" });
});

test("clearing the last key of a side removes the side and the block", () => {
  const { store, env } = open();
  const fp = ["datasets", 0, "formats", 0];
  // the fixture's only direct key is parse_location: clearing it must not
  // leave `direct: {}` behind, which the validator rejects
  setRec(env, fp, "direct", "parse_location", "");
  assert.equal(store.get(fp.concat("recommendations")), undefined);
  assert.equal(validateTechnology(store.doc, "t", SCHEMA).length, 0);
});

test("clearing one side leaves the other alone", () => {
  const { store, env } = open();
  const fp = ["datasets", 0, "formats", 0];
  env.set(["datasets", 0, "route", "guarded"], [{ hop: "guard" }]);
  setRec(env, fp, "guarded", "relay", "over the guard");
  setRec(env, fp, "direct", "parse_location", "");
  assert.deepEqual(store.get(fp.concat("recommendations")),
                   { guarded: { relay: "over the guard" } });
});

test("a recommendations side is written in recommendation_side order", () => {
  const { store, env } = open();
  const fp = ["datasets", 0, "formats", 0];
  setRec(env, fp, "direct", "elastic", "e");
  setRec(env, fp, "direct", "cribl", "c");
  assert.deepEqual(Object.keys(store.get(fp.concat("recommendations",
                                                   "direct"))),
                   ["parse_location", "cribl", "elastic"]);
});

test("pruneRecs removes a side and the block once it is empty", () => {
  const { store, env } = open();
  const fp = ["datasets", 0, "formats", 0];
  env.set(["datasets", 0, "route", "guarded"], [{ hop: "guard" }]);
  setRec(env, fp, "guarded", "cribl", "c");
  pruneRecs(env, fp, "guarded");
  assert.deepEqual(store.get(fp.concat("recommendations")),
                   { direct: { parse_location: "low" } });
  pruneRecs(env, fp, "direct");
  assert.equal(store.get(fp.concat("recommendations")), undefined);
});

// --- the recommended flag ----------------------------------------------

test("setRecommended moves the flag and takes the reason with it", () => {
  const { store, env } = open();
  const base = ["datasets", 0];
  env.set(["datasets", 0, "formats", 0, "recommended"], true);
  env.set(["datasets", 0, "formats", 0, "recommended_because"], "it wins");
  env.set(["datasets", 0, "formats"], store.get(base.concat("formats"))
    .concat(newFormat("json")));

  const formats = store.get(base.concat("formats"));
  setRecommended(env, base, formats, 1, true);

  assert.equal(store.get(base.concat("formats", 0, "recommended")), undefined);
  assert.equal(store.get(base.concat("formats", 0, "recommended_because")),
               undefined);
  assert.equal(store.get(base.concat("formats", 1, "recommended")), true);
  // one override at most - the rule the validator enforces
  const overrides = store.get(base.concat("formats"))
    .filter((entry) => entry.recommended).length;
  assert.equal(overrides, 1);
});

test("setRecommended writes the flag in canonical position", () => {
  const { store, env } = open();
  const base = ["datasets", 0];
  setRecommended(env, base, store.get(base.concat("formats")), 0, true);
  assert.deepEqual(Object.keys(store.get(base.concat("formats", 0))),
                   ["format", "recommended", "parsing", "recommendations",
                    "fields"]);
});

test("unticking clears both keys rather than writing false", () => {
  const { store, env } = open();
  const base = ["datasets", 0];
  setRecommended(env, base, store.get(base.concat("formats")), 0, true);
  env.set(base.concat("formats", 0, "recommended_because"), "it wins");
  setRecommended(env, base, store.get(base.concat("formats")), 0, false);
  const entry = store.get(base.concat("formats", 0));
  assert.equal("recommended" in entry, false);
  assert.equal("recommended_because" in entry, false);
});

// --- the autosave queue ------------------------------------------------
//
// The queue itself lives in lib/editor-state.js and is tested there.  What
// belongs here is the one rule that needs a real store behind it: while the
// banner is still offering a stored draft, an edit schedules nothing,
// because the document on screen is the published file.

// A timer that fires only when the test says so.
function fakeTimer() {
  const jobs = new Map();
  let next = 1;
  return {
    set(fn) { const handle = next++; jobs.set(handle, fn); return handle; },
    clear(handle) { jobs.delete(handle); },
    fire() {
      const due = Array.from(jobs.entries());
      jobs.clear();
      for (const [, fn] of due) fn();
    },
    get size() { return jobs.size; },
  };
}

test("an edit made under the banner cannot overwrite the stored draft",
     (t) => {
  t.after(cancelAutosave);
  const timer = fakeTimer();
  const { store, storage } = open();
  // The draft an earlier session left behind.
  store.set(["name"], "From the draft");
  store.saveDraft();
  const stored = storage.get("datamaps-studio-draft:t");

  // Reopening loads the published file and finds that draft waiting.
  store.loadTechnology("t", { source: goodTech(), catalogRow: null });
  const draft = store.loadDraft("t");
  assert.ok(draft, "the draft is what the banner is offering");

  // An edit made before Resume or Discard: nothing is scheduled, and the
  // stored draft is untouched even once the timer fires.
  store.set(["name"], "Typed while the banner was up");
  assert.equal(
    autosaveUnlessPending(draft, "t", () => store.saveDraft(), { timer }),
    false);
  assert.equal(pendingAutosave(), null);
  timer.fire();
  assert.equal(storage.get("datamaps-studio-draft:t"), stored);
  assert.equal(JSON.parse(stored).doc.name, "From the draft");

  // Discard settles the question: the next edit does save.
  store.clearDraft("t");
  assert.equal(
    autosaveUnlessPending(null, "t", () => store.saveDraft(), { timer }),
    true);
  assert.equal(pendingAutosave(), "t");
  timer.fire();
  assert.equal(JSON.parse(storage.get("datamaps-studio-draft:t")).doc.name,
               "Typed while the banner was up");
});

test("orderedSet leaves the keys an author already wrote where they are",
     () => {
  // A format written in the other of the two published key families:
  // parsing, recommendations, fields.
  const doc = goodTech();
  doc.datasets[0].formats[0] = {
    format: "syslog",
    parsing: { mechanism: "none" },
    recommendations: {},
    fields: [],
  };
  const { store, env } = open(doc);
  env.set(["datasets", 0, "formats", 0, "enable"], "logging on");
  // `enable` lands where the canonical order puts it, and nothing else
  // moved: the merge request shows one added line.
  assert.deepEqual(Object.keys(store.get(["datasets", 0, "formats", 0])),
                   ["format", "enable", "parsing", "recommendations",
                    "fields"]);
});
