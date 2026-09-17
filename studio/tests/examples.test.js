// The sidecar layout, and what has to be true of a record before Studio will
// commit it.  The rules here mirror datamaps/examples.py: a stem Studio
// composes has to be one the build resolves back to the same dataset.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_BYTES, LABEL_RE, EXAMPLES_DIR, exampleStem, examplePath, isExamplePath,
  byteLength, oversize, formatSize, publishedList, validateExample,
  isExcluded, resolveStem, publishedFor, withCommitted,
} from "../lib/examples.js";
import { SCHEMA, goodTech } from "./fixtures.js";

const EXCLUDED = SCHEMA.examples.excluded;

test("a stem is the dataset id, or the dataset id and the label", () => {
  assert.equal(exampleStem("connection-events", ""), "connection-events");
  assert.equal(exampleStem("connection-events", "vpn"),
               "connection-events-vpn");
  // Whitespace around either half is never part of a filename.
  assert.equal(exampleStem("  d  ", "  x  "), "d-x");
  assert.equal(exampleStem("d", null), "d");
  assert.equal(exampleStem("d", undefined), "d");
});

test("the path is the directory the build reads", () => {
  assert.equal(examplePath("cisco-asa", "connection-events"),
               "data/examples/cisco-asa/connection-events.log");
  assert.equal(EXAMPLES_DIR, "data/examples");
  assert.ok(isExamplePath("data/examples/cisco-asa/d.log"));
  assert.ok(!isExamplePath("data/technologies/cisco-asa.yml"));
  assert.ok(!isExamplePath("data/examples-of-things/x"));
});

test("the size is UTF-8 bytes, not characters", () => {
  assert.equal(byteLength("abc"), 3);
  assert.equal(byteLength("é"), 2);
  assert.equal(byteLength("€"), 3);
  // One astral character is four bytes, not two three-byte halves.
  assert.equal(byteLength("😀"), 4);
  assert.equal(byteLength(""), 0);
  assert.equal(byteLength(null), 0);
});

test("the size cap is the build's, and it is a warning", () => {
  assert.equal(MAX_BYTES, 262144);
  assert.equal(oversize("x".repeat(MAX_BYTES)), false);
  assert.equal(oversize("x".repeat(MAX_BYTES + 1)), true);
  // Bytes: half as many two-byte characters is exactly the cap.
  assert.equal(oversize("é".repeat(MAX_BYTES / 2)), false);
  assert.equal(oversize("é".repeat(MAX_BYTES / 2 + 1)), true);
});

test("sizes read as bytes below a kilobyte and as KB above it", () => {
  assert.equal(formatSize(1), "1 byte");
  assert.equal(formatSize(912), "912 bytes");
  assert.equal(formatSize(2048), "2.0 KB");
  assert.equal(formatSize(MAX_BYTES), "256.0 KB");
  assert.equal(formatSize("nonsense"), "unknown size");
});

test("the published listing flattens examples.json for one technology", () => {
  const rows = publishedList({
    "connection-events": [
      { label: "", path: "examples/cisco-asa/connection-events.log",
        size: 120 },
      { label: "vpn", path: "examples/cisco-asa/connection-events-vpn.log",
        size: 240 },
    ],
    "admin-audit": [
      { label: "", path: "examples/cisco-asa/admin-audit.log", size: 10 },
    ],
  });
  assert.deepEqual(rows.map((row) => row.stem),
                   ["admin-audit", "connection-events",
                    "connection-events-vpn"]);
  assert.deepEqual(rows[1],
                   { dataset: "connection-events", label: "",
                     path: "examples/cisco-asa/connection-events.log",
                     size: 120, stem: "connection-events" });
  assert.deepEqual(publishedList(null), []);
  assert.deepEqual(publishedList({ d: "not a list" }), []);
});

test("the label pattern is the one the build's stems can carry", () => {
  for (const good of ["vpn", "a", "0", "studio-test", "x-1-2"]) {
    assert.ok(LABEL_RE.test(good), good);
  }
  for (const bad of ["-x", "X", "a b", "a_b", "a.", "", "ä"]) {
    assert.ok(!LABEL_RE.test(bad), bad);
  }
});

// --- validation -----------------------------------------------------------

function check(entry, { doc = goodTech(), published = {}, pending = [],
                        excluded = EXCLUDED } = {}) {
  return validateExample(entry, doc, published, pending, excluded);
}

function messages(issues) {
  return issues.map((issue) => issue.message);
}

test("a plain record against a real dataset is valid", () => {
  assert.deepEqual(check({ dataset: "d", label: "", content: "a line\n" }), []);
  assert.deepEqual(check({ dataset: "d", label: "vpn", content: "x" }), []);
});

test("the dataset has to be one this document has", () => {
  const issues = check({ dataset: "nope", content: "x" });
  assert.deepEqual(issues.map((issue) => issue.path), [["dataset"]]);
  assert.match(issues[0].message, /not a dataset of this technology/);
  assert.match(messages(check({ dataset: "", content: "x" }))[0],
               /Name the dataset/);
});

test("a label outside the pattern is reported on the label", () => {
  const issues = check({ dataset: "d", label: "VPN Traffic", content: "x" });
  assert.deepEqual(issues.map((issue) => issue.path), [["label"]]);
  assert.match(issues[0].message, /lowercase letters, digits and hyphens/);
});

test("an empty record is not a record", () => {
  const issues = check({ dataset: "d", label: "", content: "   \n " });
  assert.deepEqual(issues.map((issue) => issue.path), [["content"]]);
  assert.match(issues[0].message, /empty/);
});

test("a stem already published collides", () => {
  const published = {
    d: [{ label: "", path: "examples/t/d.log", size: 10 }],
  };
  const issues = check({ dataset: "d", label: "", content: "x" },
                       { published });
  assert.deepEqual(issues.map((issue) => issue.path), [["label"]]);
  assert.match(issues[0].message, /already a record at d\.log/);
  // With no label yet, taking one is the way out and the message says so.
  assert.match(issues[0].message, /give this one a label/);
  // A label is the way out, and it is the way the message points.
  assert.deepEqual(check({ dataset: "d", label: "vpn", content: "x" },
                         { published }), []);
});

test("two pending records may not land on the same file", () => {
  const pending = [{ dataset: "d", label: "vpn", content: "y" }];
  const clash = messages(check({ dataset: "d", label: "vpn", content: "x" },
                               { pending }))[0];
  assert.match(clash, /already a record at d-vpn\.log/);
  // This record already has a label, so it is not told to take one.
  assert.match(clash, /choose a different label/);
  assert.ok(!/give this one a label/.test(clash), clash);
  assert.deepEqual(check({ dataset: "d", label: "web", content: "x" },
                         { pending }), []);
});

// The one rule that is not about shape: everfox-hsg's documentation is
// controlled, the build rejects a record for it, and Studio must not offer to
// commit one that would fail the build on merge.
test("an excluded technology takes no records at all", () => {
  const doc = { ...goodTech(), id: "everfox-hsg" };
  const issues = check({ dataset: "d", label: "", content: "x" }, { doc });
  assert.deepEqual(issues.map((issue) => issue.path), [["technology"]]);
  assert.match(issues[0].message, /takes no example records/);
  assert.ok(isExcluded(SCHEMA, "everfox-hsg"));
  assert.ok(!isExcluded(SCHEMA, "cisco-asa"));
  // A schema from a site built before the key existed excludes nothing.
  assert.ok(!isExcluded({}, "everfox-hsg"));
  assert.ok(!isExcluded(null, "everfox-hsg"));
});

test("every problem is reported, not just the first", () => {
  const issues = check({ dataset: "nope", label: "Nope", content: "" });
  assert.deepEqual(issues.map((issue) => issue.path[0]).sort(),
                   ["content", "dataset", "label"]);
});

// --- the build's stem rule ------------------------------------------------
//
// Composing a stem and reading one back are not inverses, and the pairs
// below are real: aws-guardduty ships `findings` and `findings-s3-export`,
// cyberark-pam ships `psm-session` and `psm-session-activity`.

test("a stem resolves to the longest dataset id that fits", () => {
  const ids = ["findings", "findings-s3-export"];
  assert.deepEqual(resolveStem("findings", ids),
                   { dataset: "findings", label: "example" });
  assert.deepEqual(resolveStem("findings-s3-export", ids),
                   { dataset: "findings-s3-export", label: "example" });
  // The label is the remainder, hyphens read as spaces - examples.py's
  // display form.
  assert.deepEqual(resolveStem("findings-runtime-monitoring", ids),
                   { dataset: "findings", label: "runtime monitoring" });
});

test("a prefix has to end at the stem's end or at a hyphen", () => {
  assert.deepEqual(resolveStem("nx-alerts", ["nx-alert"]),
                   { dataset: null, label: null });
  assert.deepEqual(resolveStem("nx-alert-web", ["nx-alert"]),
                   { dataset: "nx-alert", label: "web" });
  assert.deepEqual(resolveStem("whatever", []),
                   { dataset: null, label: null });
  assert.deepEqual(resolveStem("d", null), { dataset: null, label: null });
});

test("a label that steals the record for a sibling dataset is refused", () => {
  const doc = {
    ...goodTech(),
    datasets: [{ id: "findings" }, { id: "findings-s3-export" }],
  };
  const issues = check({ dataset: "findings", label: "s3-export",
                         content: "x" }, { doc });
  assert.deepEqual(issues.map((issue) => issue.path), [["label"]]);
  assert.match(issues[0].message,
               /would read findings-s3-export\.log as a record of 'findings-s3-export'/);
  // The way out the message points at: any other label is fine.
  assert.deepEqual(check({ dataset: "findings", label: "runtime",
                           content: "x" }, { doc }), []);
  // And the sibling may of course have its own bare record.
  assert.deepEqual(check({ dataset: "findings-s3-export", label: "",
                           content: "x" }, { doc }), []);
});

test("the same rule catches the cyberark-pam pair", () => {
  const doc = {
    ...goodTech(),
    datasets: [{ id: "psm-session" }, { id: "psm-session-activity" }],
  };
  assert.match(
    messages(check({ dataset: "psm-session", label: "activity",
                     content: "x" }, { doc }))[0],
    /as a record of 'psm-session-activity'/);
  // A label that merely starts with the same word is not a collision.
  assert.deepEqual(check({ dataset: "psm-session", label: "activities",
                          content: "x" }, { doc }), []);
});

test("a whitespace-only difference is still committed bytes", () => {
  // byteLength measures what the commit writes, so the surrounding
  // whitespace counts even though validateExample trims to decide emptiness.
  assert.equal(byteLength("  a  "), 5);
  assert.equal(byteLength("a line\n"), 7);
});

// --- the shell's listing ---------------------------------------------------

test("publishedFor answers a mapping for anything it is handed", () => {
  const all = { t: { d: [{ label: "", path: "examples/t/d.log", size: 4 }] } };
  assert.deepEqual(publishedFor(all, "t"), all.t);
  // A technology with no records, a site built before examples.json
  // existed, and a document that is not one at all.
  assert.deepEqual(publishedFor(all, "other"), {});
  assert.deepEqual(publishedFor(null, "t"), {});
  assert.deepEqual(publishedFor({ t: "not a mapping" }, "t"), {});
  assert.deepEqual(publishedFor(all, null), {});
});

// After a merge request the branch holds a file per attached record, and
// examples.json is a snapshot of the last build - so the listing has to be
// told, or re-attaching the same stem looks free until the next deploy.
test("committed records join the published listing", () => {
  const published = { d: [{ label: "", path: "examples/t/d.log", size: 4 }] };
  const listing = withCommitted(published, "t", [
    { dataset: "d", label: "vpn", content: "a line\n" },
    { dataset: "e", label: "", content: "x" },
  ]);
  assert.deepEqual(publishedList(listing).map((row) => row.stem),
                   ["d", "d-vpn", "e"]);
  assert.deepEqual(listing.d[1], { label: "vpn",
                                   path: "examples/t/d-vpn.log", size: 7 });
  // Site-relative, the way the build writes it: no "data/" in front.
  for (const row of publishedList(listing)) {
    assert.ok(row.path.indexOf("examples/") === 0, row.path);
  }
  // The listing it was given is not edited.
  assert.equal(published.d.length, 1);
});

test("a committed stem then collides with a re-attach", () => {
  const listing = withCommitted({}, "t", [
    { dataset: "d", label: "", content: "x" },
  ]);
  const doc = goodTech();
  assert.match(messages(check({ dataset: "d", label: "", content: "x" },
                              { doc, published: listing }))[0],
               /already a record at d\.log/);
  // Only that stem: another label is still free.
  assert.deepEqual(check({ dataset: "d", label: "vpn", content: "x" },
                         { doc, published: listing }), []);
});

test("withCommitted ignores what it cannot file", () => {
  assert.deepEqual(withCommitted(null, "t", null), {});
  assert.deepEqual(withCommitted({}, "t", [null, { label: "x" }]), {});
  // A stem the listing already holds is left exactly as it was.
  const published = { d: [{ label: "", path: "examples/t/d.log", size: 4 }] };
  const listing = withCommitted(published, "t",
                                [{ dataset: "d", label: "", content: "yy" }]);
  assert.deepEqual(listing.d, [{ label: "", path: "examples/t/d.log",
                                 size: 4 }]);
});
