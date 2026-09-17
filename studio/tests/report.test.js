import test from "node:test";
import assert from "node:assert/strict";
import { reportMarkdown, routeSummary, requiredEcs } from "../lib/report.js";
import { fieldPresence } from "../lib/elastic.js";

const IDENTIFY = {
  technology_id: "cisco-asa",
  dataset_id: "connection-events",
  format: "syslog-raw",
  confidence: 0.92,
  evidence: ["%ASA-6-302013", "Built inbound TCP connection"],
  alternatives: [
    { technology_id: "cisco-ftd", dataset_id: "connection-events", reason: "similar syslog header" },
  ],
  unknown: null,
};

const CHOICE = {
  technology: { id: "cisco-asa", name: "Cisco ASA", vendor: "Cisco" },
  dataset: { id: "connection-events", name: "Connection build/teardown events" },
  format: "syslog-raw",
};

const ASSESS = {
  summary: "The sample is a 302013 connection-build message and the entry covers it.",
  observed_fields: [
    {
      name: "src_ip",
      example: "203.0.113.5",
      in_inventory: true,
      inventory_vendor: "real-address (source)",
      suggested_ecs: "source.ip",
      suggested_status: "mapped",
      note: "Outside interface address.",
      ecs_known: true,
    },
    {
      name: "connection_id",
      example: "123456",
      in_inventory: true,
      inventory_vendor: "connection_id",
      suggested_ecs: "cisco.asa.connection_id",
      suggested_status: "unmapped",
      note: "No ECS home; keep in the custom namespace.",
      ecs_known: false,
    },
    {
      name: "direction",
      example: "inbound",
      in_inventory: false,
      inventory_vendor: null,
      suggested_ecs: null,
      suggested_status: null,
      note: "Pipe | in a note must not break the table.",
      ecs_known: null,
    },
  ],
  inventory_not_observed: [
    { vendor: "idfw_user", note: "Identity firewall is not enabled on this device." },
  ],
  alerting_gaps: [
    { ecs: "event.action", present_in_log: false, note: "Derived from the message id.", ecs_known: true },
    { ecs: "network.protocol.name", present_in_log: true, note: "Not a real target.", ecs_known: false },
  ],
  parsing: {
    mechanism: "elastic-integration",
    parse_location: "high",
    rationale: "The stock cisco_asa pipeline branches on the message id.",
  },
  catalog_edits: [
    { where: "connection-events / syslog-raw / fields", change: "Add a field row for the ACL name." },
  ],
  confidence: 0.8,
};

const ELASTIC = {
  dataStream: "logs-cisco_asa.log",
  docCount: 5,
  targets: [
    { vendor: "real-address (source)", ecs: "source.ip", present: true },
    { vendor: "idfw_user", ecs: "source.user.name", present: false },
  ],
  extras: ["event.dataset", "host.name"],
};

const HEADINGS = [
  "## Identification",
  "## Summary",
  "## Observed fields",
  "## Inventory fields not observed",
  "## Alerting-required targets",
  "## Parsing",
  "## Suggested catalog edits",
];

test("reportMarkdown renders every section heading", () => {
  const md = reportMarkdown({
    identify: IDENTIFY,
    choice: CHOICE,
    assess: ASSESS,
    elastic: ELASTIC,
    ecsVersion: "9.4.0",
  });
  for (const heading of HEADINGS) {
    assert.ok(md.includes("\n" + heading + "\n"), `missing heading ${heading}`);
  }
  assert.ok(md.includes("\n## Elasticsearch sample\n"));
  // Section order is the order the brief lists.
  const positions = HEADINGS.concat(["## Elasticsearch sample"]).map((s) => md.indexOf(s));
  assert.deepEqual(positions.slice().sort((a, b) => a - b), positions);
});

test("reportMarkdown carries the identification and the chosen entry", () => {
  const md = reportMarkdown({ identify: IDENTIFY, choice: CHOICE, assess: ASSESS, ecsVersion: "9.4.0" });
  assert.ok(md.includes("cisco-asa"));
  assert.ok(md.includes("connection-events"));
  assert.ok(md.includes("syslog-raw"));
  assert.ok(md.includes("0.92"));
  assert.ok(md.includes("%ASA-6-302013"));
  assert.ok(md.includes("cisco-ftd"));
  assert.ok(md.includes(ASSESS.summary));
  assert.ok(md.includes("elastic-integration"));
  assert.ok(md.includes("high"));
  assert.ok(md.includes("Add a field row for the ACL name."));
});

test("reportMarkdown strikes through ECS names that are not in the dictionary", () => {
  const md = reportMarkdown({ identify: IDENTIFY, choice: CHOICE, assess: ASSESS, ecsVersion: "9.4.0" });
  assert.ok(md.includes("~~cisco.asa.connection_id~~ (not in ECS 9.4.0)"));
  assert.ok(md.includes("~~network.protocol.name~~ (not in ECS 9.4.0)"));
  // A known name is never struck through.
  assert.ok(!md.includes("~~source.ip~~"));
  assert.ok(md.includes("source.ip"));
});

test("reportMarkdown omits the Elasticsearch section when the sample was not run", () => {
  const md = reportMarkdown({
    identify: IDENTIFY, choice: CHOICE, assess: ASSESS, elastic: null, ecsVersion: "9.4.0",
  });
  assert.ok(!md.includes("Elasticsearch sample"));
  assert.ok(!md.includes("logs-cisco_asa.log"));
});

// The success path the demo deployment cannot show: there is no logs-cisco_asa.log
// data stream there, so the presence table is proved from sampled documents.
test("reportMarkdown renders a fieldPresence result over sampled documents", () => {
  const docs = [
    {
      "@timestamp": "2026-09-01T00:00:00Z",
      source: { ip: "203.0.113.5", port: 44321 },
      destination: { ip: "10.1.2.3", port: 443 },
      event: { code: "302013", dataset: "cisco_asa.log" },
      cisco: { asa: { connection_id: "123456" } },
    },
    {
      "@timestamp": "2026-09-01T00:00:01Z",
      source: { ip: "203.0.113.9", port: 51000 },
      event: { code: "302014", dataset: "cisco_asa.log" },
    },
  ];
  const fields = [
    { vendor: "real-address (source)", ecs: "source.ip" },
    { vendor: "real-port (source)", ecs: "source.port" },
    { vendor: "idfw_user", ecs: "source.user.name" },
    { vendor: "connection_id" },
  ];
  const presence = fieldPresence(docs, fields);
  const md = reportMarkdown({
    identify: IDENTIFY,
    choice: CHOICE,
    assess: ASSESS,
    elastic: {
      dataStream: "logs-cisco_asa.log",
      docCount: docs.length,
      targets: presence.targets,
      extras: presence.extras,
    },
    ecsVersion: "9.4.0",
  });
  const section = md.slice(md.indexOf("## Elasticsearch sample"));
  assert.ok(section.includes("2 documents sampled."));
  // The presence table is exactly the three fields that name a target, in
  // inventory order: a field with no ECS target is not a presence row.
  assert.deepEqual(section.split("\n").filter((line) => line.startsWith("|")), [
    "| inventory field | ECS target | present |",
    "| --- | --- | --- |",
    "| `real-address (source)` | `source.ip` | yes |",
    "| `real-port (source)` | `source.port` | yes |",
    "| `idfw_user` | `source.user.name` | no |",
  ]);
  assert.ok(!section.includes("connection_id"));
  // Populated ECS-looking fields the inventory does not map.
  assert.ok(section.includes("- `destination.ip`"));
  assert.ok(section.includes("- `event.dataset`"));
});

test("reportMarkdown renders an Elasticsearch failure as its explanation", () => {
  const md = reportMarkdown({
    identify: IDENTIFY,
    choice: CHOICE,
    assess: ASSESS,
    elastic: { dataStream: "logs-cisco_asa.log", error: "HTTP 404: index_not_found_exception" },
    ecsVersion: "9.4.0",
  });
  assert.ok(md.includes("## Elasticsearch sample"));
  assert.ok(md.includes("HTTP 404: index_not_found_exception"));
  assert.ok(!md.includes("| present |"));
});

test("reportMarkdown escapes pipes and newlines inside table cells", () => {
  const md = reportMarkdown({ identify: IDENTIFY, choice: CHOICE, assess: ASSESS, ecsVersion: "9.4.0" });
  assert.ok(md.includes("Pipe \\| in a note must not break the table."));
  const multiline = reportMarkdown({
    identify: null,
    choice: CHOICE,
    assess: {
      ...ASSESS,
      observed_fields: [{
        name: "message", example: "line one\nline two", in_inventory: false,
        inventory_vendor: null, suggested_ecs: null, suggested_status: null,
        note: "two\nlines", ecs_known: null,
      }],
    },
    ecsVersion: "9.4.0",
  });
  // The whole row, on one line: a cell's newline must have been folded, and
  // an absent value must read as an em dash rather than as "undefined".
  const rows = multiline.split("\n").filter((line) => line.startsWith("|"));
  assert.deepEqual(rows.slice(0, 3), [
    "| field | example | in inventory | inventory field | suggested ECS "
      + "| status | note |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| `message` | `line one line two` | no | — | — | — | two lines |",
  ]);
});

test("reportMarkdown reports steps that were not run", () => {
  const md = reportMarkdown({ identify: null, choice: null, assess: null, elastic: null, ecsVersion: "9.4.0" });
  for (const heading of HEADINGS) {
    assert.ok(md.includes("\n" + heading + "\n"), `missing heading ${heading}`);
  }
  assert.ok(md.includes("Not run."));
  assert.ok(!md.includes("undefined"));
  assert.ok(!md.includes("[object Object]"));
});

test("reportMarkdown renders an unrecognised product", () => {
  const md = reportMarkdown({
    identify: {
      technology_id: null, dataset_id: null, format: null, confidence: 0.1,
      evidence: [], alternatives: [],
      unknown: { name: "Widget Firewall", vendor: "Widgets Inc" },
    },
    choice: null, assess: null, elastic: null, ecsVersion: "9.4.0",
  });
  assert.ok(md.includes("Widget Firewall"));
  assert.ok(md.includes("Widgets Inc"));
});

// checkEcsNames splits a comma-separated suggestion; each name is then marked
// on its own rather than the whole answer being struck through as one string.
test("reportMarkdown renders a split ECS suggestion name by name", () => {
  const md = reportMarkdown({
    identify: null,
    choice: CHOICE,
    assess: {
      ...ASSESS,
      observed_fields: [{
        name: "src", example: "203.0.113.5", in_inventory: true,
        inventory_vendor: "real-address", suggested_ecs: "source.ip, source.nope",
        suggested_status: "mapped", note: "two targets",
        ecs_list: ["source.ip", "source.nope"], ecs_known: [true, false],
      }],
      alerting_gaps: [{
        ecs: "event.action,event.nope", present_in_log: false, note: "n",
        ecs_list: ["event.action", "event.nope"], ecs_known: [true, false],
      }],
    },
    ecsVersion: "9.4.0",
  });
  assert.ok(md.includes(
    "| `src` | `203.0.113.5` | yes | `real-address` | `source.ip`, "
    + "~~source.nope~~ (not in ECS 9.4.0) | mapped | two targets |"), md);
  assert.ok(md.includes(
    "| `event.action`, ~~event.nope~~ (not in ECS 9.4.0) | no | n |"), md);
});

test("routeSummary joins the hops of every side present", () => {
  assert.equal(routeSummary({
    direct: [{ hop: "cribl", location: "core" },
             { hop: "elastic", data_stream: "logs-cisco_asa.log" }],
    guarded: [{ hop: "cribl", location: "edge" },
              { hop: "guard", device: "HSG" },
              { hop: "elastic", data_stream: "logs-guarded" }],
  }), "direct: cribl (core) → elastic (logs-cisco_asa.log); "
    + "guarded: cribl (edge) → guard (HSG) → elastic (logs-guarded)");
  // A hop with no detail is named on its own.
  assert.equal(routeSummary({ direct: [{ hop: "other" }] }), "direct: other");
  assert.equal(routeSummary({ guarded: [] }), "");
  assert.equal(routeSummary({}), "");
  assert.equal(routeSummary(null), "");
  assert.equal(routeSummary({ direct: [null] }), "direct: ");
});

test("requiredEcs unions the profiles of a dataset's categories, in order", () => {
  const schema = { profiles: {
    network: ["source.ip", "destination.ip", "event.action"],
    authentication: ["user.name", "event.action"],
  } };
  assert.deepEqual(
    requiredEcs({ event_categories: ["network", "authentication"] }, schema),
    ["source.ip", "destination.ip", "event.action", "user.name"]);
  assert.deepEqual(requiredEcs({ event_categories: ["nonesuch"] }, schema), []);
  assert.deepEqual(requiredEcs({}, schema), []);
  assert.deepEqual(requiredEcs(null, schema), []);
  assert.deepEqual(requiredEcs({ event_categories: ["network"] }, {}), []);
  assert.deepEqual(requiredEcs({ event_categories: ["network"] }, null), []);
});
