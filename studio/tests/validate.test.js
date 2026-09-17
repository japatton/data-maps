import test from "node:test";
import assert from "node:assert/strict";

import {
  validateCatalog, validateTechnology, validateAll, isSlug,
} from "../lib/validate.js";
import { SCHEMA, goodTech } from "./fixtures.js";

// --- local fixtures, translated from tests/test_schema.py -------------------

function fmtEntry(overrides = {}) {
  return Object.assign({
    format: "syslog-cef",
    parsing: { mechanism: "cribl-pack" },
    recommendations: {
      guarded: { parse_location: "low", relay: "thin envelope" },
      direct: { parse_location: "low" },
    },
    fields: [{ vendor: "src", ecs: "source.ip", status: "mapped" }],
  }, overrides);
}

function techDoc(overrides = {}) {
  return Object.assign({
    id: "paloalto-ngfw",
    name: "Palo Alto NGFW",
    vendor: "Palo Alto Networks",
    datasets: [{
      id: "traffic",
      name: "Traffic",
      event_categories: ["network"],
      route: {
        guarded: [
          { hop: "cribl", location: "edge" },
          { hop: "guard", device: "HSG", constraints: "policy pending" },
          { hop: "cribl", location: "core" },
          { hop: "elastic", data_stream: "logs-panw.traffic" },
        ],
        direct: [
          { hop: "cribl", location: "core" },
          { hop: "elastic", data_stream: "logs-panw.traffic" },
        ],
      },
      formats: [fmtEntry()],
    }],
  }, overrides);
}

function catalogDoc(rows) {
  return {
    technologies: rows === undefined ? [{
      id: "paloalto-ngfw", name: "Palo Alto NGFW",
      vendor: "Palo Alto Networks", category: "network-security",
      status: "in-progress", priority: "core",
    }] : rows,
  };
}

function run(doc, id = "paloalto-ngfw") {
  return validateTechnology(doc, id, SCHEMA);
}

function msgs(issues) {
  return issues.map((i) => i.message);
}

// Apply overrides to the single dataset of the standard fixture.
function dsRun(overrides) {
  const doc = techDoc();
  Object.assign(doc.datasets[0], overrides);
  return run(doc);
}

function hasMsg(issues, needle) {
  return msgs(issues).some((m) => m.includes(needle));
}

// --- the fixtures themselves are valid -------------------------------------

test("the standard technology fixture is clean", () => {
  assert.deepEqual(run(techDoc()), []);
});

test("goodTech() is a valid document", () => {
  assert.deepEqual(validateTechnology(goodTech(), "t", SCHEMA), []);
});

test("the standard catalog fixture is clean", () => {
  assert.deepEqual(validateCatalog(catalogDoc(), SCHEMA), []);
});

// --- catalog ----------------------------------------------------------------

test("catalog: missing key", () => {
  const rows = catalogDoc().technologies;
  delete rows[0].vendor;
  const issues = validateCatalog({ technologies: rows }, SCHEMA);
  assert.ok(msgs(issues).includes("catalog[0]: missing key 'vendor'"),
            JSON.stringify(issues));
  assert.deepEqual(issues[0].path, ["technologies", 0]);
});

test("catalog: unknown category vocab", () => {
  const rows = catalogDoc().technologies;
  rows[0].category = "networking";
  const issues = validateCatalog({ technologies: rows }, SCHEMA);
  assert.ok(msgs(issues).some((m) => m.includes("networking")),
            JSON.stringify(issues));
  assert.deepEqual(issues[0].path, ["technologies", 0, "category"]);
});

test("catalog: bad status", () => {
  const rows = catalogDoc().technologies;
  rows[0].status = "shipped";
  const issues = validateCatalog({ technologies: rows }, SCHEMA);
  assert.ok(msgs(issues).includes(
    "catalog[0]: 'status' value 'shipped' not one of: "
    + "planned, in-progress, mapped, deprecated"), JSON.stringify(issues));
});

test("catalog: duplicate technology id", () => {
  const row = catalogDoc().technologies[0];
  const issues = validateCatalog(
    { technologies: [row, Object.assign({}, row)] }, SCHEMA);
  assert.ok(msgs(issues).includes(
    "catalog[1]: duplicate technology id 'paloalto-ngfw'"),
            JSON.stringify(issues));
});

test("catalog: id must be a slug", () => {
  const rows = catalogDoc().technologies;
  rows[0].id = "Palo Alto";
  const issues = validateCatalog({ technologies: rows }, SCHEMA);
  assert.ok(msgs(issues).includes(
    "catalog[0]: 'id' value 'Palo Alto' is not a valid slug"),
            JSON.stringify(issues));
});

test("catalog: technologies must be a non-empty list", () => {
  const issues = validateCatalog({ technologies: [] }, SCHEMA);
  assert.deepEqual(msgs(issues),
                   ["catalog: 'technologies' must be a non-empty list"]);
});

test("catalog: unknown top-level key", () => {
  const doc = catalogDoc();
  doc.notes = "hi";
  const issues = validateCatalog(doc, SCHEMA);
  assert.ok(msgs(issues).includes("catalog: unknown key 'notes'"),
            JSON.stringify(issues));
});

// --- technology-level -------------------------------------------------------

test("unknown ECS field is rejected", () => {
  const doc = techDoc();
  doc.datasets[0].formats[0].fields[0].ecs = "sorce.ip";
  const issues = run(doc);
  assert.ok(msgs(issues).includes(
    "paloalto-ngfw dataset 'traffic' format 'syslog-cef' field 'src': "
    + "ecs field 'sorce.ip' is not in the vendored ECS dictionary"),
            JSON.stringify(issues));
  assert.deepEqual(issues[0].path,
                   ["datasets", 0, "formats", 0, "fields", 0, "ecs"]);
});

test("null ecs is allowed", () => {
  const doc = techDoc();
  doc.datasets[0].formats[0].fields[0] = {
    vendor: "flags", ecs: null, custom: "panw.panos.flags", status: "unmapped",
  };
  assert.deepEqual(run(doc), []);
});

test("non-string ecs is rejected", () => {
  const doc = techDoc();
  doc.datasets[0].formats[0].fields[0].ecs = 7;
  assert.ok(hasMsg(run(doc), "'ecs' must be a string or null"));
});

test("unknown key on a dataset is rejected", () => {
  const doc = techDoc();
  doc.datasets[0].colour = "red";
  const issues = run(doc);
  assert.ok(msgs(issues).includes(
    "paloalto-ngfw dataset 'traffic': unknown key 'colour'"),
            JSON.stringify(issues));
  assert.deepEqual(issues[0].path, ["datasets", 0, "colour"]);
});

test("unknown key on the technology is rejected", () => {
  const doc = techDoc({ owner: "me" });
  assert.ok(msgs(run(doc)).includes(
    "technology 'paloalto-ngfw': unknown key 'owner'"));
});

test("unknown key on a field is rejected", () => {
  const doc = techDoc();
  doc.datasets[0].formats[0].fields[0].colour = "red";
  assert.ok(msgs(run(doc)).includes(
    "paloalto-ngfw dataset 'traffic' format 'syslog-cef' field 'src': "
    + "unknown key 'colour'"));
});

test("unknown key on a hop is rejected", () => {
  const doc = techDoc();
  doc.datasets[0].route.direct[0].device = "HSG";
  assert.ok(msgs(run(doc)).includes(
    "paloalto-ngfw dataset 'traffic' route.direct[0]: unknown key 'device'"));
});

test("unknown key on recommendations is rejected", () => {
  const doc = techDoc();
  doc.datasets[0].formats[0].recommendations = { guard: "notes here" };
  assert.ok(hasMsg(run(doc), "unknown key 'guard'"));
});

test("unknown key inside a recommendation side is rejected", () => {
  const doc = techDoc();
  doc.datasets[0].formats[0].recommendations.direct.hop = "x";
  assert.ok(msgs(run(doc)).includes(
    "paloalto-ngfw dataset 'traffic' format 'syslog-cef' "
    + "recommendations.direct: unknown key 'hop'"));
});

test("event category without a profile is rejected", () => {
  const doc = techDoc();
  doc.datasets[0].event_categories = ["telemetry"];
  const issues = run(doc);
  assert.ok(msgs(issues).includes(
    "paloalto-ngfw dataset 'traffic': event category 'telemetry' has no "
    + "alerting profile"), JSON.stringify(issues));
});

test("event_categories must be a non-empty list", () => {
  assert.ok(hasMsg(dsRun({ event_categories: [] }),
                   "'event_categories' must be a non-empty list"));
});

test("duplicate vendor field is rejected", () => {
  const doc = techDoc();
  doc.datasets[0].formats[0].fields.push(
    { vendor: "src", ecs: "destination.ip", status: "mapped" });
  assert.ok(msgs(run(doc)).includes(
    "paloalto-ngfw dataset 'traffic' format 'syslog-cef' field 'src': "
    + "duplicate vendor field"));
});

test("id that does not match the filename is rejected", () => {
  const issues = validateTechnology(techDoc(), "panw", SCHEMA);
  assert.ok(msgs(issues).includes(
    "technology 'panw': id 'paloalto-ngfw' does not match filename"),
            JSON.stringify(issues));
  assert.deepEqual(issues[0].path, ["id"]);
});

test("bad hop vocab is rejected", () => {
  const doc = techDoc();
  doc.datasets[0].route.direct[0].hop = "teleport";
  assert.ok(msgs(run(doc)).includes(
    "paloalto-ngfw dataset 'traffic' route.direct[0]: hop 'teleport' "
    + "not one of: cribl, guard, elastic, other"));
});

test("a hop without a 'hop' key is rejected", () => {
  const doc = techDoc();
  doc.datasets[0].route.direct[0] = { location: "core" };
  assert.ok(hasMsg(run(doc), "each hop needs a 'hop' key"));
});

test("guard hop keys are accepted", () => {
  const doc = techDoc();
  doc.datasets[0].route.guarded.splice(1, 0, {
    hop: "guard", device: "Everfox HSG", constraints: "syslog only",
  });
  assert.deepEqual(run(doc), []);
});

test("bad field status is rejected", () => {
  const doc = techDoc();
  doc.datasets[0].formats[0].fields[0].status = "done";
  assert.ok(msgs(run(doc)).includes(
    "paloalto-ngfw dataset 'traffic' format 'syslog-cef' field 'src': "
    + "'status' value 'done' not one of: mapped, partial, unmapped"));
});

test("versions as a list is rejected", () => {
  const doc = techDoc({ versions: ["PAN-OS 10.2", "PAN-OS 11.1"] });
  assert.ok(msgs(run(doc)).includes(
    "technology 'paloalto-ngfw': 'versions' must be a non-empty string"));
});

test("versions as a string is accepted", () => {
  assert.deepEqual(run(techDoc({ versions: "PAN-OS 11.1" })), []);
});

test("draft must be true or false", () => {
  assert.ok(msgs(run(techDoc({ draft: "yes" }))).includes(
    "technology 'paloalto-ngfw': 'draft' must be true or false"));
});

test("technology references must be a list of strings", () => {
  assert.ok(msgs(run(techDoc({ references: [1] }))).includes(
    "technology 'paloalto-ngfw': 'references' must be a list of strings"));
});

test("datasets must be a non-empty list", () => {
  assert.ok(msgs(run(techDoc({ datasets: [] }))).includes(
    "technology 'paloalto-ngfw': 'datasets' must be a non-empty list"));
});

test("duplicate dataset id is rejected", () => {
  const doc = techDoc();
  doc.datasets.push(JSON.parse(JSON.stringify(doc.datasets[0])));
  assert.ok(msgs(run(doc)).includes(
    "paloalto-ngfw dataset 'traffic': duplicate dataset id"));
});

// --- recommendations --------------------------------------------------------

test("full recommendations are valid", () => {
  const doc = techDoc();
  doc.datasets[0].formats[0].recommendations = {
    guarded: {
      parse_location: "hybrid",
      cribl: "Add a Cribl Pack for envelope parsing",
      elastic: "Enrich with an ingest pipeline",
      relay: "Forward via the syslog relay",
    },
    direct: {
      parse_location: "hybrid",
      cribl: "Add a Cribl Pack for envelope parsing",
      elastic: "Enrich with an ingest pipeline",
    },
  };
  assert.deepEqual(run(doc), []);
});

test("empty recommendations are rejected", () => {
  const doc = techDoc();
  doc.datasets[0].formats[0].recommendations = {};
  assert.ok(msgs(run(doc)).includes(
    "paloalto-ngfw dataset 'traffic' format 'syslog-cef' recommendations: "
    + "must not be empty"));
});

test("an empty recommendation side is rejected", () => {
  const doc = techDoc();
  doc.datasets[0].formats[0].recommendations = { direct: {} };
  assert.ok(msgs(run(doc)).includes(
    "paloalto-ngfw dataset 'traffic' format 'syslog-cef' "
    + "recommendations.direct: must not be empty"));
});

test("bad parse location is rejected", () => {
  const doc = techDoc();
  doc.datasets[0].formats[0].recommendations = {
    direct: { parse_location: "medium" },
  };
  assert.ok(msgs(run(doc)).includes(
    "paloalto-ngfw dataset 'traffic' format 'syslog-cef' "
    + "recommendations.direct: 'parse_location' value 'medium' "
    + "not one of: low, high, hybrid"));
});

test("recommendation sides are visited in sorted order", () => {
  const doc = techDoc();
  doc.datasets[0].formats[0].recommendations = {
    guarded: { parse_location: "bad-g" },
    direct: { parse_location: "bad-d" },
  };
  const found = msgs(run(doc)).filter((m) => m.includes("parse_location"));
  assert.equal(found.length, 2);
  assert.ok(found[0].includes("recommendations.direct"), found[0]);
  assert.ok(found[1].includes("recommendations.guarded"), found[1]);
});

// --- format-level -----------------------------------------------------------

test("fields_omitted documents an empty inventory", () => {
  assert.deepEqual(dsRun({
    formats: [fmtEntry({
      fields: [], fields_omitted: "Operator-defined payload template.",
    })],
  }), []);
});

test("fields_omitted must be a non-empty string", () => {
  const issues = dsRun({
    formats: [fmtEntry({ fields: [], fields_omitted: "   " })],
  });
  assert.ok(hasMsg(issues, "'fields_omitted' must be a non-empty string"),
            JSON.stringify(issues));
});

test("fields_omitted is rejected when fields are present", () => {
  const issues = dsRun({ formats: [fmtEntry({ fields_omitted: "why" })] });
  assert.ok(msgs(issues).includes(
    "paloalto-ngfw dataset 'traffic' format 'syslog-cef': 'fields_omitted' "
    + "documents an empty inventory, but 'fields' is not empty"),
            JSON.stringify(issues));
});

test("unknown format value is rejected", () => {
  const issues = dsRun({ formats: [fmtEntry({ format: "carrier-pigeon" })] });
  assert.ok(hasMsg(issues, "carrier-pigeon"), JSON.stringify(issues));
});

test("duplicate format is rejected", () => {
  const issues = dsRun({ formats: [fmtEntry(), fmtEntry()] });
  assert.ok(msgs(issues).includes(
    "paloalto-ngfw dataset 'traffic' format 'syslog-cef': duplicate format"),
            JSON.stringify(issues));
});

test("relay is forbidden under direct", () => {
  const issues = dsRun({
    formats: [fmtEntry({
      recommendations: {
        guarded: { parse_location: "low" },
        direct: { parse_location: "low", relay: "nope" },
      },
    })],
  });
  assert.ok(hasMsg(issues, "unknown key 'relay'"), JSON.stringify(issues));
});

test("an empty fields list is valid", () => {
  assert.deepEqual(dsRun({ formats: [fmtEntry({ fields: [] })] }), []);
});

test("format references must be a list of strings", () => {
  const issues = dsRun({ formats: [fmtEntry({ references: [1] })] });
  assert.ok(msgs(issues).includes(
    "paloalto-ngfw dataset 'traffic' format 'syslog-cef': 'references' "
    + "must be a list of strings"), JSON.stringify(issues));
});

test("fields must be a list", () => {
  const issues = dsRun({ formats: [fmtEntry({ fields: {} })] });
  assert.ok(hasMsg(issues, "'fields' must be a list"), JSON.stringify(issues));
});

test("bad parsing mechanism is rejected", () => {
  const issues = dsRun({
    formats: [fmtEntry({ parsing: { mechanism: "telepathy" } })],
  });
  assert.ok(msgs(issues).includes(
    "paloalto-ngfw dataset 'traffic' format 'syslog-cef' parsing: "
    + "'mechanism' value 'telepathy' not one of: elastic-integration, "
    + "cribl-pack, cribl-pipeline, elastic-ingest-pipeline, none"),
            JSON.stringify(issues));
});

test("source_format is now an unknown key", () => {
  assert.ok(hasMsg(dsRun({ source_format: "syslog-csv" }),
                   "unknown key 'source_format'"));
});

test("formats must be a non-empty list", () => {
  assert.ok(hasMsg(dsRun({ formats: [] }),
                   "'formats' must be a non-empty list"));
});

test("unknown key is rejected with schema.py wording", () => {
  const doc = goodTech();
  doc.datasets[0].formats[0].deployed = true;
  const issues = validateTechnology(doc, "t", SCHEMA);
  assert.ok(issues.some(
    (i) => i.message === "t dataset 'd' format 'syslog-cef': "
                       + "unknown key 'deployed'"), JSON.stringify(issues));
  assert.deepEqual(issues[0].path, ["datasets", 0, "formats", 0, "deployed"]);
});

// --- routes -----------------------------------------------------------------

test("route.direct is required", () => {
  const doc = techDoc();
  delete doc.datasets[0].route.direct;
  assert.ok(msgs(run(doc)).includes(
    "paloalto-ngfw dataset 'traffic' route: missing key 'direct'"));
});

test("route.guarded is optional", () => {
  const doc = techDoc();
  delete doc.datasets[0].route.guarded;
  delete doc.datasets[0].formats[0].recommendations.guarded;
  assert.deepEqual(run(doc), []);
});

test("guarded recommendations require a guarded route", () => {
  const doc = techDoc();
  delete doc.datasets[0].route.guarded;
  assert.ok(msgs(run(doc)).includes(
    "paloalto-ngfw dataset 'traffic' format 'syslog-cef': guarded "
    + "recommendations but route has no guarded side"));
});

test("non-mapping recommendations are reported as a mapping error", () => {
  const doc = techDoc();
  delete doc.datasets[0].route.guarded;
  doc.datasets[0].formats[0].recommendations = 5;
  assert.ok(hasMsg(run(doc), "must be a mapping"));
});

test("relay under direct at dataset level", () => {
  const doc = techDoc();
  doc.datasets[0].formats[0].recommendations.direct.relay = "nope";
  assert.ok(hasMsg(run(doc), "unknown key 'relay'"));
});

test("a guarded route needs a guard hop", () => {
  const doc = techDoc();
  doc.datasets[0].route.guarded = [{ hop: "cribl" }, { hop: "elastic" }];
  assert.ok(msgs(run(doc)).includes(
    "paloalto-ngfw dataset 'traffic' route.guarded: guarded route has no "
    + "guard hop"));
});

test("a direct route rejects a guard hop", () => {
  const doc = techDoc();
  doc.datasets[0].route.direct.splice(1, 0, { hop: "guard", device: "HSG" });
  assert.ok(msgs(run(doc)).includes(
    "paloalto-ngfw dataset 'traffic' route.direct: direct route must not "
    + "contain a guard hop"));
});

test("a route side must be a non-empty list", () => {
  const doc = techDoc();
  doc.datasets[0].route.direct = [];
  assert.ok(msgs(run(doc)).includes(
    "paloalto-ngfw dataset 'traffic' route.direct: must be a non-empty list"));
});

// --- recommendation override ------------------------------------------------

test("override with a reason is valid", () => {
  const a = fmtEntry({
    recommended: true, recommended_because: "LEEF keys are unpublished",
  });
  const b = fmtEntry({ format: "syslog-leef" });
  assert.deepEqual(dsRun({ formats: [a, b] }), []);
});

test("override without a reason is fatal", () => {
  const issues = dsRun({ formats: [fmtEntry({ recommended: true })] });
  assert.ok(msgs(issues).includes(
    "paloalto-ngfw dataset 'traffic' format 'syslog-cef': "
    + "'recommended_because' must be a non-empty string"),
            JSON.stringify(issues));
});

test("a reason without the override is fatal", () => {
  const issues = dsRun({
    formats: [fmtEntry({ recommended_because: "why" })],
  });
  assert.ok(msgs(issues).includes(
    "paloalto-ngfw dataset 'traffic' format 'syslog-cef': "
    + "'recommended_because' requires 'recommended: true' - a reason with "
    + "nothing to justify"), JSON.stringify(issues));
});

test("recommended must be true or false", () => {
  const issues = dsRun({ formats: [fmtEntry({ recommended: "yes" })] });
  assert.ok(hasMsg(issues, "'recommended' must be true or false"));
});

test("two overrides on one dataset", () => {
  const doc = goodTech();
  doc.datasets[0].formats.push({
    format: "json", recommended: true, recommended_because: "x",
    parsing: { mechanism: "none" }, fields: [],
  });
  doc.datasets[0].formats[0].recommended = true;
  doc.datasets[0].formats[0].recommended_because = "y";
  const found = msgs(validateTechnology(doc, "t", SCHEMA));
  assert.ok(found.includes(
    "t dataset 'd': at most one format may set 'recommended: true' (found 2)"),
            JSON.stringify(found));
});

// --- cross-file checks ------------------------------------------------------

test("validateAll: a file without a catalog row", () => {
  const issues = validateAll({
    catalog: catalogDoc([{
      id: "other", name: "Other", vendor: "X", category: "endpoint",
      status: "planned", priority: "edge",
    }]),
    technologies: { "paloalto-ngfw": techDoc() },
  }, SCHEMA);
  assert.ok(msgs(issues).includes(
    "technology 'paloalto-ngfw' has a file but no catalog row"),
            JSON.stringify(issues));
});

test("validateAll: a non-planned row without a file", () => {
  const issues = validateAll(
    { catalog: catalogDoc(), technologies: {} }, SCHEMA);
  assert.ok(msgs(issues).includes(
    "catalog: 'paloalto-ngfw' is in-progress but has no "
    + "data/technologies/paloalto-ngfw.yml"), JSON.stringify(issues));
});

test("validateAll: a planned row without a file is fine", () => {
  const rows = catalogDoc().technologies;
  rows[0].status = "planned";
  assert.deepEqual(
    validateAll({ catalog: { technologies: rows }, technologies: {} }, SCHEMA),
    []);
});

test("validateAll: matching catalog and files is clean", () => {
  assert.deepEqual(validateAll({
    catalog: catalogDoc(),
    technologies: { "paloalto-ngfw": techDoc() },
  }, SCHEMA), []);
});

// schema.py builds its row map with `dict((row["id"], row) for row in ...)`,
// so the last row with an id wins.  The duplicate itself is validateCatalog's
// to report; validateAll must simply agree with Python on which row a
// technology file is checked against.
test("validateAll: a duplicate catalog id keeps the last row, as Python does", () => {
  const rows = [
    { id: "paloalto-ngfw", name: "First", vendor: "X",
      category: "network-security", status: "in-progress", priority: "core" },
    { id: "paloalto-ngfw", name: "Second", vendor: "X",
      category: "network-security", status: "planned", priority: "core" },
  ];
  // The last row is planned, so its missing file is not an error...
  assert.deepEqual(
    validateAll({ catalog: { technologies: rows }, technologies: {} }, SCHEMA),
    []);
  // ...and the index reported for the row is the last one's.
  const flipped = [rows[1], rows[0]];
  const issues = validateAll(
    { catalog: { technologies: flipped }, technologies: {} }, SCHEMA);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].path, ["catalog", "technologies", 1]);
  assert.match(issues[0].message, /is in-progress but has no/);
});

// Issues are handed to the editor, which keeps them; two issues sharing one
// array would let a caller's edit to one path rewrite the other's.
test("no two issues share a path array", () => {
  const doc = techDoc();
  doc.name = "";
  doc.vendor = "";
  doc.datasets[0].formats[0].parsing = { mechanism: "nope", bogus: 1 };
  doc.datasets[0].formats[0].fields = [
    { vendor: "", ecs: 12, status: "sideways" },
  ];
  const issues = validateTechnology(doc, "paloalto-ngfw", SCHEMA);
  assert.ok(issues.length > 4, JSON.stringify(issues));
  const seen = new Set();
  for (const issue of issues) {
    assert.equal(seen.has(issue.path), false, JSON.stringify(issue));
    seen.add(issue.path);
  }
});

// The whole message list, in order: a check that fires out of turn, or one
// that stops reporting, shows up here rather than in a substring match.
test("errors at every level are reported in document order", () => {
  const doc = techDoc();
  doc.name = "";
  doc.datasets[0].event_categories = ["nonesuch"];
  doc.datasets[0].route.direct = [{ hop: "guard", device: "HSG" }];
  doc.datasets[0].formats[0].format = "not-a-format";
  doc.datasets[0].formats[0].fields = [
    { vendor: "src", ecs: "source.ip", status: "mapped" },
    { vendor: "src", ecs: "no.such.field", status: "mapped" },
  ];
  assert.deepEqual(msgs(validateTechnology(doc, "paloalto-ngfw", SCHEMA)), [
    "technology 'paloalto-ngfw': 'name' must be a non-empty string",
    "paloalto-ngfw dataset 'traffic': event category 'nonesuch' has no "
      + "alerting profile",
    "paloalto-ngfw dataset 'traffic' route.direct: direct route must not "
      + "contain a guard hop",
    "paloalto-ngfw dataset 'traffic' format 'not-a-format': 'format' value "
      + "'not-a-format' not one of: " + SCHEMA.vocab.source_formats.join(", "),
    "paloalto-ngfw dataset 'traffic' format 'not-a-format' field 'src': "
      + "duplicate vendor field",
    "paloalto-ngfw dataset 'traffic' format 'not-a-format' field 'src': ecs "
      + "field 'no.such.field' is not in the vendored ECS dictionary",
  ]);
});

// --- isSlug -----------------------------------------------------------------

test("isSlug accepts and rejects", () => {
  assert.equal(isSlug("paloalto-ngfw", SCHEMA), true);
  assert.equal(isSlug("a", SCHEMA), true);
  assert.equal(isSlug("0-9", SCHEMA), true);
  assert.equal(isSlug("-leading", SCHEMA), false);
  assert.equal(isSlug("Upper", SCHEMA), false);
  assert.equal(isSlug("has space", SCHEMA), false);
  assert.equal(isSlug("", SCHEMA), false);
  assert.equal(isSlug(null, SCHEMA), false);
});

// The whole point of reading schema.vocab.key_order rather than keeping a
// copy here: a key removed from the published table stops being accepted,
// with no edit to validate.js.  The schema is deep-cloned so the caches
// keyed on the object do not carry the real table's answer over.
test("the published key table is what decides an unknown key", () => {
  const trimmed = JSON.parse(JSON.stringify(SCHEMA));
  trimmed.vocab.key_order.dataset =
    trimmed.vocab.key_order.dataset.filter((key) => key !== "description");
  const doc = techDoc();
  doc.datasets[0].description = "Session end records.";
  // Accepted while the table names it...
  assert.ok(!hasMsg(validateTechnology(doc, "paloalto-ngfw", SCHEMA),
                    "unknown key 'description'"));
  // ...and rejected the moment it does not.
  assert.ok(msgs(validateTechnology(doc, "paloalto-ngfw", trimmed)).includes(
    "paloalto-ngfw dataset 'traffic': unknown key 'description'"));
});
