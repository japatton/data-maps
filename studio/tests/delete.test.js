import test from "node:test";
import assert from "node:assert/strict";
import { deleteReady, deleteSummary, removalChecklist } from "../views/delete.js";

test("the delete button stays shut until the id is typed exactly", () => {
  assert.equal(deleteReady("", "acme-fw"), false);
  assert.equal(deleteReady("acme", "acme-fw"), false);
  assert.equal(deleteReady("ACME-FW", "acme-fw"), false);
  assert.equal(deleteReady("acme-fw", "acme-fw"), true);
  assert.equal(deleteReady("  acme-fw  ", "acme-fw"), true);
});

test("the summary counts what will go", () => {
  const s = deleteSummary([
    { path: "data/technologies/x.yml", remove: true },
    { path: "data/catalog.yml", content: "y", exists: true },
    { path: "data/examples/x/a.log", remove: true },
    { path: "data/examples/x/b.log", remove: true },
  ]);
  assert.equal(s.removed, 3);
  assert.equal(s.rewritten, 1);
  assert.deepEqual(s.examples, ["data/examples/x/a.log", "data/examples/x/b.log"]);
});

test("the checklist names every path to remove by hand", () => {
  const text = removalChecklist([
    { path: "data/technologies/x.yml", remove: true },
    { path: "data/catalog.yml", content: "y", exists: true },
    { path: "data/examples/x/a.log", remove: true },
  ]);
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines.indexOf("data/technologies/x.yml") !== -1);
  assert.ok(lines.indexOf("data/examples/x/a.log") !== -1);
  assert.ok(text.indexOf("data/catalog.yml") === -1);
});
