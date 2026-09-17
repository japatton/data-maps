import test from "node:test";
import assert from "node:assert/strict";
import { diffDocs, describeChanges, summarizeValue } from "../lib/diff.js";

const base = () => ({ id: "t", name: "T", datasets: [
  { id: "d", formats: [{ format: "json", fields: [
    { vendor: "src", ecs: "source.ip", status: "mapped" },
    { vendor: "dst", ecs: "destination.ip", status: "mapped" } ] }] } ] });

test("scalar change is labelled by identity keys", () => {
  const after = base(); after.datasets[0].formats[0].fields[1].status = "partial";
  const changes = diffDocs(base(), after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].label, "datasets[d].formats[json].fields[dst].status");
  assert.deepEqual(changes[0].path, ["datasets", 0, "formats", 0, "fields", 1, "status"]);
  assert.equal(changes[0].kind, "changed");
  assert.equal(changes[0].before, "mapped");
  assert.equal(changes[0].after, "partial");
});

test("added and removed list items and keys", () => {
  const after = base();
  after.datasets[0].formats[0].fields.push({ vendor: "proto", ecs: null, status: "unmapped" });
  delete after.name;
  const kinds = diffDocs(base(), after).map(c => c.kind + " " + c.label);
  assert.deepEqual(kinds.sort(), ["added datasets[d].formats[json].fields[proto]", "removed name"]);
});

test("reordering fields is one change", () => {
  const after = base(); after.datasets[0].formats[0].fields.reverse();
  const changes = diffDocs(base(), after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].label, "datasets[d].formats[json].fields (order)");
  // Marked as a reordering rather than left to be inferred from two
  // undefined values.
  assert.equal(changes[0].kind, "changed");
  assert.equal(changes[0].order, true);
  assert.deepEqual(changes[0].path, ["datasets", 0, "formats", 0, "fields"]);
  assert.equal(describeChanges(changes),
               "- **datasets[d].formats[json].fields (order)** changed");
});

// null is a value a document carries (an unmapped field's ecs); undefined is
// a key that was not there.
test("describeChanges prints a missing value as a dash and null as null", () => {
  assert.equal(
    describeChanges([{ label: "x", kind: "changed", before: null, after: 2 }]),
    "- **x** changed: `null` → `2`");
  assert.equal(
    describeChanges([{ label: "x", kind: "changed", after: 2 }]),
    "- **x** changed: — → `2`");
  assert.equal(
    describeChanges([{ label: "x", kind: "changed", before: 1 }]),
    "- **x** changed: `1` → —");
});

test("describeChanges renders markdown", () => {
  const after = base(); after.name = "T2";
  assert.equal(describeChanges(diffDocs(base(), after)), "- **name** changed: `T` → `T2`");
});

test("no changes", () => { assert.deepEqual(diffDocs(base(), base()), []); });

// A blank row is what the "add a field" button inserts: it has no identity
// yet, and it must not knock its identified siblings out of alignment.
test("a blank item does not degrade the rest of the list to index matching", () => {
  const after = base();
  after.datasets[0].formats[0].fields.unshift({ vendor: "", ecs: null, status: "unmapped" });
  const changes = diffDocs(base(), after);
  assert.deepEqual(changes.map(c => c.kind), ["added"]);
  assert.equal(changes[0].label, "datasets[d].formats[json].fields[0]");
  assert.deepEqual(changes[0].path, ["datasets", 0, "formats", 0, "fields", 0]);
});

test("blank items on both sides pair up by their position among blanks", () => {
  const before = base();
  before.datasets[0].formats[0].fields.unshift({ vendor: "", ecs: null, status: "unmapped" });
  const after = structuredClone(before);
  after.datasets[0].formats[0].fields[0].ecs = "host.name";
  const changes = diffDocs(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].label, "datasets[d].formats[json].fields[0].ecs");
  assert.equal(changes[0].kind, "changed");
});

test("lists of scalars still compare by index", () => {
  const changes = diffDocs({ tags: ["a", "b"] }, { tags: ["a", "c", "d"] });
  assert.deepEqual(changes.map(c => c.kind + " " + c.label),
                   ["changed tags[1]", "added tags[2]"]);
});

test("an identified item that moves past a blank is not reported as changed", () => {
  const before = base();
  const after = base();
  after.datasets[0].formats[0].fields.splice(1, 0, { vendor: "", ecs: null, status: "unmapped" });
  const changes = diffDocs(before, after);
  assert.deepEqual(changes.map(c => c.kind), ["added"]);
});

// One summary behind both the merge-request description and the review
// pane's change list, so the two cannot drift apart.
test("summarizeValue counts containers and pluralises", () => {
  assert.equal(summarizeValue([]), "(0 items)");
  assert.equal(summarizeValue(["a"]), "(1 item)");
  assert.equal(summarizeValue(["a", "b"]), "(2 items)");
  assert.equal(summarizeValue({}), "(0 keys)");
  assert.equal(summarizeValue({ a: 1 }), "(1 key)");
  assert.equal(summarizeValue({ a: 1, b: 2 }), "(2 keys)");
});

test("summarizeValue prints scalars as themselves, unquoted", () => {
  assert.equal(summarizeValue("mapped"), "mapped");
  assert.equal(summarizeValue(""), "");
  assert.equal(summarizeValue(0), "0");
  assert.equal(summarizeValue(false), "false");
  // A value the document can carry, against a key that was not there.
  assert.equal(summarizeValue(null), "null");
  assert.equal(summarizeValue(undefined), "—");
  // Cut short at 80 characters, the last of them an ellipsis.
  const long = summarizeValue("x".repeat(200));
  assert.equal(long.length, 80);
  assert.equal(long, "x".repeat(79) + "…");
  assert.equal(summarizeValue("x".repeat(80)), "x".repeat(80));
});

// describeChanges quotes a scalar and leaves a size summary bare: `(2 items)`
// in backticks would read as a value someone typed.
test("describeChanges quotes scalars but not summaries", () => {
  assert.equal(
    describeChanges([{ label: "fields", kind: "changed",
                       before: ["a"], after: ["a", "b"] }]),
    "- **fields** changed: (1 item) → (2 items)");
  assert.equal(
    describeChanges([{ label: "route", kind: "changed",
                       before: { direct: 1 }, after: {} }]),
    "- **route** changed: (1 key) → (0 keys)");
});
