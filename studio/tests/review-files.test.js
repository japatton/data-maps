import test from "node:test";
import assert from "node:assert/strict";

import {
  CATALOG_PATH, TRAILER, technologyPath, touchesCatalog, catalogRows,
  commitFiles, defaultBranchName, defaultCommitMessage, defaultDescription,
  baselineFiles, driftedPaths, driftMessage, driftReason, exampleNotice,
  catalogRowsWithout, deleteFiles,
} from "../lib/review-files.js";
import { goodTech } from "./fixtures.js";

const CATALOG = [
  { id: "a1", name: "A1", vendor: "V", category: "network-security",
    status: "mapped", priority: "core" },
  { id: "b1", name: "B1", vendor: "V", category: "endpoint",
    status: "planned", priority: "standard" },
  { id: "a2", name: "A2", vendor: "V", category: "network-security",
    status: "planned", priority: "edge" },
  { id: "c1", name: "C1", vendor: "V", category: "cloud",
    status: "planned", priority: "edge" },
];

test("touchesCatalog follows the catalog.* labels and the new flag", () => {
  assert.equal(touchesCatalog([{ label: "name" }], false), false);
  assert.equal(touchesCatalog([{ label: "catalog.status" }], false), true);
  assert.equal(touchesCatalog([], true), true);
  assert.equal(touchesCatalog(undefined, false), false);
  // A "catalog" key inside the document is not a row change.
  assert.equal(touchesCatalog([{ label: "catalogue" }], false), false);
});

test("catalogRows replaces an existing row in place", () => {
  const row = { ...CATALOG[2], status: "mapped" };
  const rows = catalogRows(CATALOG, row);
  assert.equal(rows.length, CATALOG.length);
  assert.equal(rows[2], row);
  assert.deepEqual(rows.map((r) => r.id), ["a1", "b1", "a2", "c1"]);
  // The input list is left alone.
  assert.equal(CATALOG[2].status, "planned");
});

// Recategorising a technology is an edit to the row that is already there,
// not a new row: moving it into its new category's block would rewrite two
// unrelated stretches of catalog.yml and bury the change in the diff.
test("catalogRows keeps a recategorised row at its old index", () => {
  const row = { ...CATALOG[2], category: "cloud" };
  const rows = catalogRows(CATALOG, row);
  assert.equal(rows.length, CATALOG.length);
  assert.equal(rows[2], row);
  assert.deepEqual(rows.map((r) => r.id), ["a1", "b1", "a2", "c1"]);
  // Not moved next to c1, the only other cloud row.
  assert.equal(rows[3].id, "c1");
  assert.equal(CATALOG[2].category, "network-security");
});

test("catalogRows inserts a new row after the last of its category", () => {
  const row = { id: "a3", name: "A3", vendor: "V",
                category: "network-security", status: "planned",
                priority: "edge" };
  assert.deepEqual(catalogRows(CATALOG, row).map((r) => r.id),
                   ["a1", "b1", "a2", "a3", "c1"]);
});

test("catalogRows appends when the category is new, and handles an empty catalog", () => {
  const row = { id: "z", name: "Z", vendor: "V", category: "mainframe",
                status: "planned", priority: "edge" };
  assert.deepEqual(catalogRows(CATALOG, row).map((r) => r.id),
                   ["a1", "b1", "a2", "c1", "z"]);
  assert.deepEqual(catalogRows([], row), [row]);
  assert.deepEqual(catalogRows(undefined, row), [row]);
});

test("commitFiles writes the technology file alone for a document-only change", () => {
  const doc = goodTech();
  const files = commitFiles({
    id: "t", doc, row: CATALOG[0], catalog: CATALOG, isNew: false,
    changes: [{ label: "name" }],
  });
  assert.equal(files.length, 1);
  assert.deepEqual(files.map((f) => f.path), [technologyPath("t")]);
  assert.equal(files[0].path, "data/technologies/t.yml");
  assert.equal(files[0].exists, true);
  assert.match(files[0].content, /^id: t\n/);
});

test("commitFiles adds the catalog file when the row changed", () => {
  const row = { ...CATALOG[1], status: "in-progress" };
  const files = commitFiles({
    id: "b1", doc: goodTech(), row, catalog: CATALOG, isNew: false,
    changes: [{ label: "catalog.status" }],
  });
  assert.deepEqual(files.map((f) => f.path),
                   ["data/technologies/b1.yml", CATALOG_PATH]);
  assert.equal(files[1].exists, true);
  assert.match(files[1].content, /^technologies:\n/);
  assert.match(files[1].content, /\{id: b1, .*status: in-progress/);
  // Every row is still there, one flow mapping per line.
  assert.equal(files[1].content.trimEnd().split("\n").length,
               CATALOG.length + 1);
});

test("commitFiles marks a new technology's file as a create and rewrites the catalog", () => {
  const doc = { ...goodTech(), id: "new-thing" };
  const row = { id: "new-thing", name: "New", vendor: "V",
                category: "endpoint", status: "planned", priority: "edge" };
  const files = commitFiles({
    id: "new-thing", doc, row, catalog: CATALOG, isNew: true, changes: [],
  });
  assert.deepEqual(files.map((f) => f.path),
                   ["data/technologies/new-thing.yml", CATALOG_PATH]);
  assert.equal(files[0].exists, false);
  assert.equal(files[1].exists, true);
  assert.match(files[1].content, /b1.*\n.*new-thing/);
});

test("defaultBranchName stamps local date and time", () => {
  const when = new Date(2026, 8, 1, 9, 5);
  assert.equal(defaultBranchName("cisco-asa", when),
               "studio/cisco-asa-20260901-0905");
});

test("defaultCommitMessage counts and pluralises", () => {
  assert.equal(defaultCommitMessage("Cisco ASA", 1),
               "Cisco ASA: 1 change via Studio");
  assert.equal(defaultCommitMessage("Cisco ASA", 3),
               "Cisco ASA: 3 changes via Studio");
  assert.equal(defaultCommitMessage("Cisco ASA", 0),
               "Cisco ASA: 0 changes via Studio");
});

test("defaultDescription is the change list plus the trailer", () => {
  const body = defaultDescription([
    { label: "name", kind: "changed", before: "a", after: "b" },
  ]);
  assert.equal(body, "- **name** changed: `a` → `b`\n\n" + TRAILER);
  assert.equal(defaultDescription([]), TRAILER);
});

// A raw record is captured output; the reviewer approving the merge request
// is the last person who can look at it, so the description says so.
test("the description warns when the commit carries example records", () => {
  const changes = [{ label: "name", kind: "changed", before: "a", after: "b" }];
  const examples = [
    { dataset: "d", label: "", content: "one" },
    { dataset: "d", label: "vpn", content: "two" },
  ];
  const body = defaultDescription(changes, examples);
  assert.equal(body,
    "- **name** changed: `a` → `b`\n\n"
    + "Contains 2 example record(s): review for sensitive content before "
    + "merging.\n\n" + TRAILER);
  // With nothing else to say, the warning still stands above the trailer.
  assert.equal(defaultDescription([], examples.slice(0, 1)),
    "Contains 1 example record(s): review for sensitive content before "
    + "merging.\n\n" + TRAILER);
  // No records, no line - the old description exactly.
  assert.equal(defaultDescription(changes, []),
               defaultDescription(changes));
  assert.equal(exampleNotice(0), "");
  assert.equal(exampleNotice("nonsense"), "");
});

test("commitFiles creates one file per attached record, after the YAML", () => {
  const files = commitFiles({
    id: "cisco-asa", doc: goodTech(), row: CATALOG[0], catalog: CATALOG,
    isNew: false, changes: [{ label: "name" }],
    examples: [
      { dataset: "connection-events", label: "", content: "one line\n" },
      { dataset: "connection-events", label: "studio-test",
        content: "another\n" },
    ],
  });
  assert.deepEqual(files.map((f) => f.path), [
    "data/technologies/cisco-asa.yml",
    "data/examples/cisco-asa/connection-events.log",
    "data/examples/cisco-asa/connection-events-studio-test.log",
  ]);
  // Creates, so the upstream check skips them: there is nothing to drift.
  assert.deepEqual(files.slice(1).map((f) => f.exists), [false, false]);
  assert.deepEqual(driftedPaths(files, {}, {}), []);
  // Verbatim: nothing here reformats a record the build publishes byte for
  // byte.
  assert.equal(files[1].content, "one line\n");
  assert.equal(files[2].content, "another\n");
});

test("commitFiles without records is exactly what it was", () => {
  const args = { id: "t", doc: goodTech(), row: CATALOG[0], catalog: CATALOG,
                 isNew: false, changes: [{ label: "name" }] };
  assert.deepEqual(commitFiles({ ...args, examples: [] }),
                   commitFiles(args));
  assert.deepEqual(commitFiles({ ...args, examples: [null, 3] }),
                   commitFiles(args));
});

// --- the upstream check ---------------------------------------------------

test("baselineFiles emits the baseline document and the published rows", () => {
  const doc = goodTech();
  const expected = baselineFiles({ id: "t", doc, catalog: CATALOG });
  assert.deepEqual(Object.keys(expected).sort(),
                   [CATALOG_PATH, "data/technologies/t.yml"].sort());
  // The same text a commit of an unedited document would produce.
  assert.equal(expected["data/technologies/t.yml"],
               commitFiles({ id: "t", doc, row: CATALOG[0], catalog: CATALOG,
                             isNew: false, changes: [] })[0].content);
  assert.match(expected[CATALOG_PATH], /^technologies:\n/);
  // The row under review is not folded in: this is the published catalog.
  assert.equal(expected[CATALOG_PATH].trimEnd().split("\n").length,
               CATALOG.length + 1);
});

const FILES = [
  { path: "data/technologies/t.yml", content: "new\n", exists: true },
  { path: CATALOG_PATH, content: "newcat\n", exists: true },
];
const EXPECTED = {
  "data/technologies/t.yml": "id: t\n",
  [CATALOG_PATH]: "technologies: []\n",
};

test("driftedPaths passes an unchanged repository", () => {
  const remote = {
    "data/technologies/t.yml": { exists: true, content: "id: t\n" },
    [CATALOG_PATH]: { exists: true, content: "technologies: []\n" },
  };
  assert.deepEqual(driftedPaths(FILES, remote, EXPECTED), []);
});

test("driftedPaths names every file that moved on, including a deleted one", () => {
  const remote = {
    "data/technologies/t.yml": { exists: true, content: "id: t\nname: X\n" },
    [CATALOG_PATH]: { exists: false, content: "" },
  };
  assert.deepEqual(driftedPaths(FILES, remote, EXPECTED),
                   ["data/technologies/t.yml", CATALOG_PATH]);
});

test("driftedPaths ignores line endings and the trailing newline", () => {
  const remote = {
    "data/technologies/t.yml": { exists: true, content: "id: t\r\n\r\n" },
    [CATALOG_PATH]: { exists: true, content: "technologies: []" },
  };
  assert.deepEqual(driftedPaths(FILES, remote, EXPECTED), []);
});

test("driftedPaths compares only files that are updated, fetched and expected", () => {
  const created = [{ path: "data/technologies/new.yml", content: "x\n",
                     exists: false }];
  // A file this commit creates has no upstream copy to disagree with.
  assert.deepEqual(
    driftedPaths(created, { "data/technologies/new.yml": { exists: true, content: "other\n" } },
                 { "data/technologies/new.yml": "x\n" }), []);
  // Nothing fetched, or no baseline text: nothing claimed either way.
  assert.deepEqual(driftedPaths(FILES, {}, EXPECTED), []);
  assert.deepEqual(driftedPaths(FILES, { [CATALOG_PATH]: { exists: true, content: "z" } }, {}), []);
  assert.deepEqual(driftedPaths(undefined, undefined, undefined), []);
});

test("driftMessage names the files and offers no way to commit anyway", () => {
  const message = driftMessage(["data/technologies/x.yml"]);
  assert.match(message,
               /^data\/technologies\/x\.yml changed in the repository since this site was built\./);
  assert.match(message, /Wait for the site to rebuild/);
  assert.match(message, /YAML fallback/);
  assert.doesNotMatch(message, /anyway/i);
  assert.match(message, /reload Studio/);
  // The advice must not send the reader back to the draft: resuming it
  // puts back the values it was written against and undoes the newer
  // published edits, which is the exact loss this message exists to stop.
  assert.match(message, /Do not resume the older draft/);
  assert.match(driftMessage(["a", "b"]), /^a, b changed/);
});

// Studio reads the snapshot with no-store, so a reload really is enough once
// the site has rebuilt: the advice is on both call shapes, because the view
// picks the shape from what it managed to learn about the branch.
test("driftMessage tells the admin to reload once the site has rebuilt", () => {
  const tail = "Wait for the site to rebuild, then reload Studio — reopening "
    + "the technology is not enough, because Studio keeps the snapshot it "
    + "loaded at start-up. Make your change again by hand against the new "
    + "file. Do not resume the older draft: it would put back the values it "
    + "was written against and undo the newer published edits. The YAML "
    + "fallback and a merge by hand also work.";
  for (const message of [
    driftMessage(["a.yml"]),
    driftMessage(["a.yml"], { "a.yml": "missing" }, "main"),
    driftMessage(["a.yml", "b.yml"], { "b.yml": "missing" }, "main"),
    driftMessage([]),
  ]) {
    assert.ok(message.endsWith(tail), `missing the reload advice: ${message}`);
  }
  // Nothing drifted: the advice stands on its own, with no leading space.
  assert.equal(driftMessage([]).indexOf("Wait for the site to rebuild"), 0);
});

// A file that is not on the branch at all is a different problem from one a
// colleague edited: a token that cannot read it, or a base branch that is
// not the one the site was built from.
test("driftReason tells a missing file from a changed one", () => {
  assert.equal(driftReason({ exists: true, content: "x", status: 200 }),
               "changed");
  assert.equal(driftReason({ exists: false, content: "", status: 404 }),
               "missing");
  assert.equal(driftReason(undefined), "missing");
  assert.equal(driftReason(null), "missing");
});

test("driftMessage says which files are missing and on what branch", () => {
  const message = driftMessage(["a.yml"], { "a.yml": "missing" }, "main");
  assert.match(message, /^a\.yml does not exist on main —/);
  assert.match(message, /token may not be allowed to read it/);
  assert.match(message, /built from a different branch/);
  assert.doesNotMatch(message, /changed in the repository/);
  assert.match(message, /Wait for the site to rebuild/);
  assert.match(message, /Do not resume the older draft/);
  // No branch named: the message still reads.
  assert.match(driftMessage(["a.yml"], { "a.yml": "missing" }),
               /does not exist on the default branch/);
});

test("driftMessage groups the two reasons, changed first", () => {
  const message = driftMessage(["a.yml", "b.yml", "c.yml"],
                               { "b.yml": "missing" }, "main");
  assert.match(message,
               /^a\.yml, c\.yml changed in the repository since this site was built\. b\.yml does not exist on main/);
  // A path with no reason recorded reads as changed, which is what the
  // one-argument form has always meant.
  assert.equal(driftMessage(["a.yml"], {}, "main"), driftMessage(["a.yml"]));
});

test("catalogRowsWithout drops just the named row", () => {
  const rows = [{ id: "a", category: "x" }, { id: "b", category: "x" }, { id: "c", category: "y" }];
  assert.deepEqual(catalogRowsWithout(rows, "b"), [{ id: "a", category: "x" }, { id: "c", category: "y" }]);
});

test("catalogRowsWithout leaves a catalog without the id alone", () => {
  const rows = [{ id: "a" }];
  assert.deepEqual(catalogRowsWithout(rows, "zz"), [{ id: "a" }]);
});

// examples.json holds site-relative paths ("examples/<id>/<stem>.log", no
// "data/" in front - see examples.test.js's "committed records join the
// published listing" and datamaps/studio.py's examples_json()).  The fixture
// below uses that real shape; deleteFiles must turn it into the repository
// path itself rather than relaying the site-relative one verbatim.
test("deleteFiles removes the document, rewrites the catalog and removes each example", () => {
  const files = deleteFiles({
    id: "acme-fw",
    catalog: [{ id: "acme-fw", category: "network-security" }, { id: "keep", category: "endpoint" }],
    examples: { traffic: [{ label: "", path: "examples/acme-fw/traffic.log", size: 10 }], audit: [{ label: "b", path: "examples/acme-fw/audit-b.log", size: 20 }] },
  });
  assert.deepEqual(files[0], { path: "data/technologies/acme-fw.yml", remove: true });
  assert.equal(files[1].path, "data/catalog.yml");
  assert.equal(files[1].exists, true);
  assert.ok(files[1].content.includes("keep"));
  assert.ok(!files[1].content.includes("acme-fw"));
  // Built from the id and the stem, not the site-relative path examples.json
  // carries: the repository path always has "data/" in front.
  assert.deepEqual(files.slice(2).map((f) => f.path).sort(),
    ["data/examples/acme-fw/audit-b.log", "data/examples/acme-fw/traffic.log"]);
  for (const f of files.slice(2)) assert.equal(f.remove, true);
});

test("deleteFiles with no examples is just the document and the catalog", () => {
  const files = deleteFiles({ id: "acme-fw", catalog: [{ id: "acme-fw" }], examples: {} });
  assert.equal(files.length, 2);
});
