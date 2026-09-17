// Exporting one dataset format for someone who is not going to open Studio:
// a spreadsheet, a diff, or a paste into a ticket.  The emitters are pure
// string functions so these run under plain Node, like every other suite here.
import test from "node:test";
import assert from "node:assert/strict";
import { toJson, toCsv, toYaml, CSV_COLUMNS, exportName } from "../lib/export.js";

function sample() {
  return {
    techId: "paloalto-ngfw",
    dataset: { id: "traffic", name: "Traffic log" },
    format: {
      format: "syslog-csv",
      fields: [
        { vendor: "src", type: "ip", description: "source IP",
          ecs: "source.ip", status: "mapped" },
        { vendor: "act", type: "keyword", description: "allow, or deny",
          ecs: "event.action", status: "partial", custom: "pan.act",
          transform: "lower()", notes: "line one\nline two" },
      ],
    },
  };
}

function rows(csv) {
  // Split on newlines that are not inside quotes, so a quoted cell keeps its
  // own newline instead of being read as the end of the record.
  const out = [];
  let cell = "", row = [], quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const c = csv[i];
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); out.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out;
}

test("the CSV header is the agreed column list", () => {
  assert.deepEqual(rows(toCsv(sample()))[0], CSV_COLUMNS);
});

test("every field becomes one CSV row carrying its identifying context", () => {
  const parsed = rows(toCsv(sample()));
  assert.equal(parsed.length, 3);
  const first = parsed[1];
  assert.equal(first[CSV_COLUMNS.indexOf("technology")], "paloalto-ngfw");
  assert.equal(first[CSV_COLUMNS.indexOf("dataset")], "traffic");
  assert.equal(first[CSV_COLUMNS.indexOf("format")], "syslog-csv");
  assert.equal(first[CSV_COLUMNS.indexOf("#")], "1");
  assert.equal(first[CSV_COLUMNS.indexOf("vendor")], "src");
  assert.equal(first[CSV_COLUMNS.indexOf("ecs")], "source.ip");
});

test("a value with a comma survives the round trip", () => {
  const parsed = rows(toCsv(sample()));
  assert.equal(parsed[2][CSV_COLUMNS.indexOf("description")], "allow, or deny");
});

test("a value with a newline survives the round trip", () => {
  const parsed = rows(toCsv(sample()));
  assert.equal(parsed[2][CSV_COLUMNS.indexOf("notes")], "line one\nline two");
});

test("a value with a quote is doubled, not dropped", () => {
  const doc = sample();
  doc.format.fields[0].description = 'the "src" column';
  const parsed = rows(toCsv(doc));
  assert.equal(parsed[1][CSV_COLUMNS.indexOf("description")], 'the "src" column');
  assert.match(toCsv(doc), /"the ""src"" column"/);
});

test("absent optional columns are empty, not undefined", () => {
  const parsed = rows(toCsv(sample()));
  assert.equal(parsed[1][CSV_COLUMNS.indexOf("custom")], "");
  assert.equal(parsed[1][CSV_COLUMNS.indexOf("transform")], "");
  assert.equal(parsed[1][CSV_COLUMNS.indexOf("notes")], "");
  assert.ok(!toCsv(sample()).includes("undefined"));
});

test("a format with no fields still exports its header", () => {
  const doc = sample();
  doc.format.fields = [];
  assert.deepEqual(rows(toCsv(doc)), [CSV_COLUMNS]);
});

test("unicode is carried through rather than escaped", () => {
  const doc = sample();
  doc.format.fields[0].description = "naïve — ⧉";
  assert.ok(toCsv(doc).includes("naïve — ⧉"));
  assert.ok(toJson(doc).includes("naïve — ⧉"));
});

test("the JSON names the technology, dataset and format around the fields", () => {
  const parsed = JSON.parse(toJson(sample()));
  assert.equal(parsed.technology, "paloalto-ngfw");
  assert.equal(parsed.dataset, "traffic");
  assert.equal(parsed.format, "syslog-csv");
  assert.equal(parsed.fields.length, 2);
  assert.equal(parsed.fields[0].vendor, "src");
});

test("the JSON is pretty-printed rather than one long line", () => {
  assert.ok(toJson(sample()).includes("\n  "));
});

test("the YAML carries the same context and every vendor field", () => {
  const text = toYaml(sample());
  assert.match(text, /^technology: paloalto-ngfw$/m);
  assert.match(text, /^dataset: traffic$/m);
  assert.match(text, /^format: syslog-csv$/m);
  assert.match(text, /vendor: src/);
  assert.match(text, /vendor: act/);
});

test("the YAML quotes a value the emitter must not leave bare", () => {
  const doc = sample();
  doc.format.fields[0].description = "yes";
  // Bare `yes` reads back as a boolean in YAML 1.1; the shared emitter is
  // what stops that, and this proves the export goes through it.
  assert.match(toYaml(doc), /description: ['"]yes['"]/);
});

test("the filename names the technology, dataset and format", () => {
  assert.equal(exportName(sample(), "csv"), "paloalto-ngfw-traffic-syslog-csv.csv");
});
