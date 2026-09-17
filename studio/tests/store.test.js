import test from "node:test";
import assert from "node:assert/strict";
import { createStore, hashDoc } from "../lib/store.js";
import { SCHEMA, goodTech } from "./fixtures.js";

function shim() { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; }
const row = () => ({ id: "t", name: "T", vendor: "V", category: "endpoint", status: "in-progress", priority: "core" });

test("load, edit, dirty, changes", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  assert.equal(s.isDirty(), false);
  s.set(["datasets", 0, "name"], "Renamed");
  assert.equal(s.isDirty(), true);
  assert.equal(s.changes()[0].label, "datasets[d].name");
  s.set(["row", "status"], "mapped");
  assert.ok(s.changes().some(c => c.label === "catalog.status"));
});

test("list mutators", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  const p = ["datasets", 0, "formats", 0, "fields"];
  const n = s.get(p).length;
  s.insert(p, 0, { vendor: "new", ecs: null, status: "unmapped" });
  assert.equal(s.get(p).length, n + 1);
  s.move(p, 0, 1);
  assert.equal(s.get(p)[1].vendor, "new");
  s.remove(p, 1);
  assert.equal(s.get(p).length, n);
});

test("errors come from the validator with row errors re-pathed", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  assert.deepEqual(s.errors(), []);
  s.set(["row", "status"], "bogus");
  const e = s.errors();
  assert.equal(e.length, 1);
  assert.deepEqual(e[0].path, ["row", "status"]);
});

test("drafts round-trip with base hash", () => {
  const storage = shim();
  const s = createStore({ schema: SCHEMA, storage });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.set(["name"], "Edited");
  s.saveDraft();
  assert.equal(s.hasDraft("t"), true);
  const d = s.loadDraft("t");
  assert.equal(d.doc.name, "Edited");
  assert.equal(d.baseHash, hashDoc({ doc: goodTech(), row: row() }));
  s.clearDraft("t");
  assert.equal(s.hasDraft("t"), false);
});

test("new technology skeleton", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.newTechnology("new-thing");
  assert.equal(s.isNew, true);
  assert.equal(s.doc.id, "new-thing");
  assert.equal(s.row.status, "planned");
  assert.ok(s.errors().length > 0);
});

test("the id is validated against the id the document was loaded under", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.set(["id"], "other");
  const e = s.errors();
  assert.equal(e.length, 1);
  assert.deepEqual(e[0].path, ["id"]);
  assert.match(e[0].message, /id 'other' does not match filename/);
});

test("row messages do not leak the one-row wrapper's index", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.set(["row", "category"], "nonsense");
  const e = s.errors();
  assert.equal(e.length, 1);
  assert.match(e[0].message, /^catalog: /);
  assert.doesNotMatch(e[0].message, /catalog\[0\]/);
});

test("unset deletes an object key and splices an array item", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  const field = ["datasets", 0, "formats", 0, "fields", 0];
  s.set(field.concat("notes"), "hi");
  assert.equal(s.get(field.concat("notes")), "hi");
  s.unset(field.concat("notes"));
  assert.equal(s.get(field.concat("notes")), undefined);
  assert.equal("notes" in s.get(field), false);

  const list = ["datasets", 0, "formats", 0, "fields"];
  assert.equal(s.get(list).length, 2);
  s.unset(list.concat(0));
  assert.equal(s.get(list).length, 1);
  assert.equal(s.get(list)[0].vendor, "act");

  s.unset(["row", "vendor"]);
  assert.equal("vendor" in s.row, false);
});

test("subscribers are called by every mutator until they unsubscribe", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  const seen = [];
  const off = s.subscribe(store => seen.push(store));
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.set(["name"], "E");
  s.insert(["datasets"], 0, { id: "z" });
  s.move(["datasets"], 0, 1);
  s.remove(["datasets"], 1);
  s.unset(["name"]);
  assert.equal(seen.length, 6);
  assert.equal(seen.every(store => store === s), true);
  off();
  s.set(["vendor"], "Q");
  assert.equal(seen.length, 6);
  assert.throws(() => s.subscribe("nope"), TypeError);
});

test("resumeDraft replaces the working copy but keeps the baseline", () => {
  const storage = shim();
  const s = createStore({ schema: SCHEMA, storage });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.set(["name"], "Edited");
  s.saveDraft();
  const before = s.baseHash();

  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  assert.equal(s.isDirty(), false);
  s.resumeDraft(s.loadDraft("t"));
  assert.equal(s.doc.name, "Edited");
  assert.equal(s.isDirty(), true);
  assert.equal(s.baseHash(), before);
  assert.equal(s.baseline.doc.name, goodTech().name);
  assert.deepEqual(s.changes().map(c => c.label), ["name"]);
  assert.equal(s.resumeDraft(null), s);
});

test("hashDoc is eight lowercase hex digits, zero-padded", () => {
  assert.match(hashDoc({ a: 1 }), /^[0-9a-f]{8}$/);
  assert.equal(hashDoc({ n: 3360 }), "008196e5");
  assert.equal(hashDoc({ a: 1 }), hashDoc({ a: 1 }));
  assert.notEqual(hashDoc({ a: 1 }), hashDoc({ a: 2 }));
});

test("draft calls degrade quietly when storage is unavailable", () => {
  const s = createStore({ schema: SCHEMA });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  assert.equal(s.saveDraft(), null);
  assert.equal(s.loadDraft("t"), null);
  assert.equal(s.hasDraft("t"), false);
  assert.equal(s.clearDraft("t"), s);
});

test("a throwing storage cannot break autosave", () => {
  const angry = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("quota"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  const s = createStore({ schema: SCHEMA, storage: angry });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  assert.equal(s.saveDraft(), null);
  assert.equal(s.loadDraft("t"), null);
  assert.equal(s.hasDraft("t"), false);
  assert.equal(s.clearDraft("t"), s);
});

// hasDraft is asked once per row by the picker, so it looks for the record
// rather than parsing it: a corrupt one counts as a draft until something
// reads it.  loadDraft is that reader, and it clears what it cannot use, so
// the badge does not outlive the draft it stands for.
test("a corrupt draft counts as one until loadDraft clears it", () => {
  const storage = shim();
  storage.setItem("datamaps-studio-draft:t", "{not json");
  const s = createStore({ schema: SCHEMA, storage });
  assert.equal(s.hasDraft("t"), true);
  assert.equal(s.loadDraft("t"), null);
  assert.equal(s.hasDraft("t"), false);
  assert.equal(s.hasDraft("other"), false);
});

// JSON the record parses to, but that is no draft at all.
test("loadDraft clears a record that is not a mapping", () => {
  const storage = shim();
  const s = createStore({ schema: SCHEMA, storage });
  for (const text of ["null", "5", "\"draft\""]) {
    storage.setItem("datamaps-studio-draft:t", text);
    assert.equal(s.loadDraft("t"), null, text);
    assert.equal(s.hasDraft("t"), false, text);
  }
  // A real draft is left exactly where it is.
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.saveDraft();
  assert.equal(s.loadDraft("t").id, "t");
  assert.equal(s.hasDraft("t"), true);
});

test("hasDraft does not parse the record", () => {
  const storage = shim();
  const s = createStore({ schema: SCHEMA, storage });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.saveDraft();
  let parsed = 0;
  const saved = JSON.parse;
  JSON.parse = (...args) => { parsed += 1; return saved(...args); };
  try {
    assert.equal(s.hasDraft("t"), true);
  } finally {
    JSON.parse = saved;
  }
  assert.equal(parsed, 0);
});

// The record carries the baseline as well as the edit; a document large
// enough to push the pair past the limit drops the baseline, not the draft.
test("an oversized draft is stored without its baseline", () => {
  const storage = shim();
  const s = createStore({ schema: SCHEMA, storage });
  const big = { ...goodTech(), notes: "x".repeat(2.5 * 1024 * 1024) };
  s.loadTechnology("t", { source: big, catalogRow: row() });
  s.set(["name"], "Edited");
  const written = s.saveDraft();
  assert.equal(written.baselineOmitted, true);
  assert.equal("baseline" in written, false);
  const draft = s.loadDraft("t");
  assert.equal(draft.baselineOmitted, true);
  assert.equal(draft.doc.name, "Edited");
  // The hash still marks the draft stale if the files moved on.
  assert.equal(draft.baseHash, s.baseHash());
  // A document that fits keeps its baseline.
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  const small = s.saveDraft();
  assert.equal(small.baselineOmitted, undefined);
  assert.deepEqual(small.baseline, { doc: goodTech(), row: row() });
});

test("set refuses a numeric segment past the end of a list", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  const fields = ["datasets", 0, "formats", 0, "fields"];
  assert.equal(s.get(fields).length, 2);
  // One past the end appends; further out would leave a hole.
  s.set(fields.concat(2), { vendor: "new", ecs: null, status: "unmapped" });
  assert.equal(s.get(fields).length, 3);
  assert.throws(() => s.set(fields.concat(5), {}), RangeError);
  assert.throws(() => s.set(fields.concat(-1), {}), RangeError);
  // A hole in an intermediate container is refused too.
  assert.throws(() => s.set(["datasets", 4, "id"], "x"), RangeError);
  assert.equal(s.get(fields).length, 3);
  assert.equal(s.get(["datasets"]).length, 1);
});

// A path carrying its index as a string indexes the array exactly as the
// number does, so it must not slip past the bounds check and write the hole
// the number is refused for.
test("set holds a numeric-string segment to the same bounds", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  const fields = ["datasets", 0, "formats", 0, "fields"];
  assert.equal(s.get(fields).length, 2);
  // One past the end still appends.
  s.set(fields.concat("2"), { vendor: "new", ecs: null, status: "unmapped" });
  assert.equal(s.get(fields).length, 3);
  assert.equal(s.get(fields)[2].vendor, "new");
  assert.throws(() => s.set(fields.concat("5"), {}), RangeError);
  assert.throws(() => s.set(fields.concat("-1"), {}), RangeError);
  assert.throws(() => s.set(["datasets", "4", "id"], "x"), RangeError);
  assert.equal(s.get(fields).length, 3);
  assert.equal(s.get(["datasets"]).length, 1);
  // A segment that is not a number at all still addresses a key.
  s.set(["datasets", 0, "notes", "x"], 1);
  assert.deepEqual(s.get(["datasets", 0, "notes"]), { x: 1 });
});

test("saveDraft refuses to write a draft with no id", () => {
  const storage = shim();
  const s = createStore({ schema: SCHEMA, storage });
  assert.equal(s.saveDraft(), null);
  assert.equal(storage.getItem("datamaps-studio-draft:null"), null);
});

test("mutators refuse to run before a document is loaded", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  assert.equal(s.get(["name"]), undefined);
  assert.equal(s.isDirty(), false);
  assert.deepEqual(s.changes(), []);
  for (const call of [
    () => s.set(["name"], "x"),
    () => s.unset(["name"]),
    () => s.insert(["datasets"], 0, {}),
    () => s.remove(["datasets"], 0),
    () => s.move(["datasets"], 0, 1),
  ]) {
    assert.throws(call, /load a technology before editing it/);
  }
});

test("move lands the item on the index it names after the lift-out", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.set(["datasets"], [{ id: "a" }, { id: "b" }, { id: "c" }]);
  const p = ["datasets"];
  s.move(p, 0, 1);
  assert.deepEqual(s.get(p).map(d => d.id), ["b", "a", "c"]);
  s.move(p, 2, 0);
  assert.deepEqual(s.get(p).map(d => d.id), ["c", "b", "a"]);
  assert.throws(() => s.move(p, 3, 0), RangeError);
});

test("list mutators reject a missing or non-integer index", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  const p = ["datasets", 0, "formats", 0, "fields"];
  assert.throws(() => s.remove(p), RangeError);
  assert.throws(() => s.remove(p, "0"), RangeError);
  assert.throws(() => s.move(p, undefined, 0), RangeError);
  assert.equal(s.get(p).length, 2);
  assert.throws(() => s.insert(["name"], 0, {}), /is not a list/);
});

test("set creates the intermediate containers a path implies", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.set(["references", 0], "https://example.test");
  assert.deepEqual(s.get(["references"]), ["https://example.test"]);
  s.set(["datasets", 0, "notes", "x"], 1);
  assert.deepEqual(s.get(["datasets", 0, "notes"]), { x: 1 });
  assert.throws(() => s.set(["row"], {}), /must name a key/);
});

test("a draft records the baseline it was taken from", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.set(["name"], "Edited");
  s.set(["row", "status"], "mapped");
  const written = s.saveDraft();
  const draft = s.loadDraft("t");
  assert.deepEqual(Object.keys(draft).sort(),
                   ["baseHash", "baseline", "doc", "examples", "id", "isNew",
                    "row", "savedAt"]);
  assert.deepEqual(written, draft);
  // The published document and row, not the edited ones.
  assert.deepEqual(draft.baseline, { doc: goodTech(), row: row() });
  assert.equal(draft.doc.name, "Edited");
  assert.equal(draft.row.status, "mapped");
  assert.equal(draft.baseHash, hashDoc(draft.baseline));
  // A copy: editing on turns the draft's baseline into a stale record, not
  // a live view of the store.
  s.set(["vendor"], "Other");
  assert.deepEqual(s.loadDraft("t").baseline.doc, goodTech());
});

// --- example records ------------------------------------------------------

test("attached records are dirty, listed and validated", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  assert.deepEqual(s.examples, []);
  s.addExample({ dataset: "d", label: "vpn", content: "a line\n" });
  assert.equal(s.isDirty(), true);
  assert.deepEqual(s.examples,
                   [{ dataset: "d", label: "vpn", content: "a line\n" }]);
  const added = s.changes().filter(c => c.kind === "added"
                                     && c.label.startsWith("examples["));
  assert.equal(added.length, 1);
  assert.equal(added[0].label, "examples[d-vpn]");
  assert.deepEqual(added[0].path, ["examples", 0]);
  assert.deepEqual(s.errors(), []);
  s.removeExample(0);
  assert.deepEqual(s.examples, []);
  assert.equal(s.isDirty(), false);
});

test("example issues arrive under ['examples', i, key]", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.addExample({ dataset: "d", label: "", content: "x" });
  s.addExample({ dataset: "nope", label: "", content: "" });
  const paths = s.errors().map(issue => issue.path);
  assert.deepEqual(paths, [["examples", 1, "dataset"],
                           ["examples", 1, "content"]]);
});

test("a record colliding with a published stem is an error", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", {
    source: goodTech(), catalogRow: row(),
    published: { d: [{ label: "", path: "examples/t/d.log", size: 4 }] },
  });
  s.addExample({ dataset: "d", label: "", content: "x" });
  assert.deepEqual(s.errors().map(i => i.path), [["examples", 0, "label"]]);
  s.removeExample(0);
  s.addExample({ dataset: "d", label: "later", content: "x" });
  assert.deepEqual(s.errors(), []);
});

test("loading another technology drops the records and the published list", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", {
    source: goodTech(), catalogRow: row(),
    published: { d: [{ label: "", path: "examples/t/d.log", size: 4 }] },
  });
  s.addExample({ dataset: "d", label: "vpn", content: "x" });
  s.loadTechnology("other", { source: goodTech(), catalogRow: null });
  assert.deepEqual(s.examples, []);
  assert.deepEqual(s.publishedExamples, {});
  s.newTechnology("fresh");
  assert.deepEqual(s.examples, []);
});

// Deleting a dataset must take its records with it: a record naming a
// dataset that is gone can only be reported as an error, and the panel it
// would be removed from went with the dataset.
test("deleting a dataset drops the records that named it", () => {
  const doc = goodTech();
  doc.datasets.push({
    id: "e", name: "Other", event_categories: ["network"],
    route: { direct: [{ hop: "elastic", data_stream: "logs-test.e" }] },
    formats: [{ format: "json", parsing: { mechanism: "none" }, fields: [] }],
  });
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: doc, catalogRow: row() });
  s.addExample({ dataset: "d", label: "", content: "x" });
  s.addExample({ dataset: "e", label: "", content: "y" });
  s.addExample({ dataset: "d", label: "vpn", content: "z" });
  s.remove(["datasets"], 0);
  assert.deepEqual(s.examples.map(e => e.dataset + "/" + e.label), ["e/"]);
  // Nothing is orphaned, so nothing is reported.
  assert.deepEqual(s.errors().filter(i => i.path[0] === "examples"), []);
});

test("deleting a dataset leaves the records of every other one", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.addExample({ dataset: "d", label: "", content: "x" });
  // Removing something that is not a dataset touches no record.
  s.remove(["datasets", 0, "formats", 0, "fields"], 0);
  assert.equal(s.examples.length, 1);
  // Nor does a dataset with no id yet, which no record can have named.
  s.insert(["datasets"], 1, { name: "Unnamed" });
  s.remove(["datasets"], 1);
  assert.equal(s.examples.length, 1);
});

test("removeExample rejects an index that names no record", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  assert.throws(() => s.removeExample(0), RangeError);
  s.addExample({ dataset: "d", label: "", content: "x" });
  assert.throws(() => s.removeExample(1), RangeError);
  assert.throws(() => s.removeExample("0"), RangeError);
  // Anything that is not a record at all still lands as an empty one, which
  // the validator then reports rather than the store throwing mid-click.
  s.addExample(null);
  assert.deepEqual(s.examples[1], { dataset: "", label: "", content: "" });
});

test("addExample refuses to run before a document is loaded", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  assert.throws(() => s.addExample({ dataset: "d", content: "x" }),
                /load a technology before editing it/);
});

// A record attached from Analyze arrives after the draft was written, so
// resuming that draft must merge rather than replace - otherwise the trip
// through the editor silently loses it.
test("resuming a draft keeps records the draft never saw", () => {
  const s = createStore({ schema: SCHEMA, storage: shim() });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.addExample({ dataset: "d", label: "old", content: "from the draft" });
  s.saveDraft();
  const draft = s.loadDraft("t");
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.addExample({ dataset: "d", label: "new", content: "from analyze" });
  s.resumeDraft(draft);
  assert.deepEqual(s.examples.map(e => e.label), ["old", "new"]);
  // The same stem twice would try to create one file twice.
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.addExample({ dataset: "d", label: "old", content: "attached again" });
  s.resumeDraft(draft);
  assert.deepEqual(s.examples.map(e => e.content), ["from the draft"]);
});

test("a draft resumed after the file moved on records what it reverts", () => {
  const storage = shim();
  const s = createStore({ schema: SCHEMA, storage });

  // Draft written against the published file as it was.
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.set(["name"], "My edit");
  s.saveDraft();

  // A colleague publishes a change to a field this draft never touched.
  const moved = goodTech();
  moved.vendor = "Colleague's new vendor";
  s.loadTechnology("t", { source: moved, catalogRow: row() });
  s.resumeDraft(s.loadDraft("t"));

  // The draft's own copy of the published file is kept, so the review
  // screen can tell "my edit" from "silently undoing someone else".
  assert.ok(s.resumedFrom, "resumedFrom must survive the resume");
  assert.equal(s.resumedFrom.doc.vendor, goodTech().vendor);

  const labels = s.changes().map((c) => c.label);
  assert.ok(labels.includes("name"), "the user's own edit is still a change");
  assert.ok(labels.includes("vendor"),
    "the colleague's field reads as a change because the draft reverts it");
  assert.deepEqual(s.reverts().map((c) => c.label), ["vendor"],
    "only the colleague's field is a revert; the user's own edit is not");
});

test("reverts() is empty when the file did not move under the draft", () => {
  const storage = shim();
  const s = createStore({ schema: SCHEMA, storage });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.set(["name"], "My edit");
  s.saveDraft();
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.resumeDraft(s.loadDraft("t"));
  assert.deepEqual(s.reverts(), []);
});

test("reverts() is empty for a draft too large to have kept its baseline", () => {
  const storage = shim();
  const s = createStore({ schema: SCHEMA, storage });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.set(["name"], "My edit");
  s.saveDraft();
  const draft = s.loadDraft("t");
  delete draft.baseline;          // what saveDraft does over SIZE_LIMIT
  draft.baselineOmitted = true;
  const moved = goodTech();
  moved.vendor = "Colleague's new vendor";
  s.loadTechnology("t", { source: moved, catalogRow: row() });
  s.resumeDraft(draft);
  assert.deepEqual(s.reverts(), [],
    "no baseline means no claim can be made, not a wrong claim");
});

test("loading another technology clears the resumed baseline", () => {
  const storage = shim();
  const s = createStore({ schema: SCHEMA, storage });
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.set(["name"], "My edit");
  s.saveDraft();
  s.loadTechnology("t", { source: goodTech(), catalogRow: row() });
  s.resumeDraft(s.loadDraft("t"));
  s.loadTechnology("other", { source: goodTech(), catalogRow: row() });
  assert.equal(s.resumedFrom, null);
  assert.deepEqual(s.reverts(), []);
});
