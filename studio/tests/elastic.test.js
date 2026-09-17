import test from "node:test";
import assert from "node:assert/strict";
import { dataStreamOf, sampleDataStream, flattenKeys, fieldPresence } from "../lib/elastic.js";
import { globalObject } from "../lib/global.js";

const DATASET = {
  id: "connection-events",
  route: {
    guarded: [
      { hop: "cribl", location: "edge" },
      { hop: "guard", device: "Everfox High Speed Guard" },
      { hop: "elastic", data_stream: "logs-guarded.log" },
    ],
    direct: [
      { hop: "cribl", location: "edge" },
      { hop: "elastic", data_stream: "logs-cisco_asa.log" },
    ],
  },
};

test("dataStreamOf prefers the direct route", () => {
  assert.equal(dataStreamOf(DATASET), "logs-cisco_asa.log");
});

test("dataStreamOf falls back to the guarded route, then null", () => {
  const guardedOnly = { route: { guarded: DATASET.route.guarded } };
  assert.equal(dataStreamOf(guardedOnly), "logs-guarded.log");
  const noElastic = { route: { direct: [{ hop: "cribl" }] } };
  assert.equal(dataStreamOf(noElastic), null);
  assert.equal(dataStreamOf({}), null);
  assert.equal(dataStreamOf({ route: { direct: [{ hop: "elastic" }], guarded: [{ hop: "elastic", data_stream: "logs-g" }] } }), "logs-g");
});

test("flattenKeys returns dotted leaf paths", () => {
  const keys = flattenKeys({
    "@timestamp": "2026-09-01T00:00:00Z",
    source: { ip: "10.0.0.1", port: 4444 },
    related: { ip: ["10.0.0.1", "10.0.0.2"] },
    dns: { answers: [{ name: "a.example", type: "A" }, { name: "b.example", type: "A" }] },
    empty: {},
  });
  assert.ok(keys instanceof Set);
  assert.deepEqual([...keys].sort(), [
    "@timestamp", "dns.answers.name", "dns.answers.type",
    "related.ip", "source.ip", "source.port",
  ]);
});

test("fieldPresence reports inventory targets and ECS extras", () => {
  const docs = [
    { "@timestamp": "t0", source: { ip: "10.0.0.1" }, event: { outcome: "success" }, vendorish: { thing: 1 } },
    { "@timestamp": "t1", source: { ip: "10.0.0.2" }, destination: { ip: "10.0.0.9" }, event: { outcome: "failure" } },
  ];
  const fields = [
    { vendor: "src_ip", ecs: "source.ip" },
    { vendor: "dst_ip", ecs: "destination.ip" },
    { vendor: "username", ecs: "user.name" },
    { vendor: "free_text" },
  ];
  const out = fieldPresence(docs, fields);
  assert.deepEqual(out.targets, [
    { vendor: "src_ip", ecs: "source.ip", present: true },
    { vendor: "dst_ip", ecs: "destination.ip", present: true },
    { vendor: "username", ecs: "user.name", present: false },
  ]);
  assert.deepEqual(out.extras, ["event.outcome"]);
});

test("sampleDataStream posts the search body with an ApiKey header", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ hits: { hits: [{ _source: { a: 1 } }, { _source: { a: 2 } }] } }) };
  };
  const out = await sampleDataStream({ url: "https://es:9200", apiKey: "KEY", fetchImpl }, "logs-cisco_asa.log");
  assert.equal(seen.url, "https://es:9200/logs-cisco_asa.log/_search");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.credentials, "omit");
  assert.equal(seen.init.headers.Authorization, "ApiKey KEY");
  assert.deepEqual(seen.body, { size: 5, sort: [{ "@timestamp": "desc" }], query: { match_all: {} } });
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  assert.deepEqual(out.docs, [{ a: 1 }, { a: 2 }]);
});

test("sampleDataStream maps a thrown TypeError to a CORS result", async () => {
  const fetchImpl = async () => { throw new TypeError("Failed to fetch"); };
  const out = await sampleDataStream({ url: "https://es:9200", apiKey: "", fetchImpl }, "logs-x");
  assert.equal(out.ok, false);
  assert.equal(out.status, 0);
  assert.equal(out.cors, true);
  assert.equal(out.body, "Failed to fetch");
  assert.deepEqual(out.docs, []);
});

test("sampleDataStream reports a non-2xx body without throwing", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => '{"error":"index_not_found_exception"}' });
  const out = await sampleDataStream({ url: "https://es:9200/", fetchImpl }, "logs-missing");
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal(out.cors, false);
  assert.ok(out.body.includes("index_not_found_exception"));
  assert.deepEqual(out.docs, []);
});

test("sampleDataStream omits the Authorization header without a key", async () => {
  let headers;
  const fetchImpl = async (url, init) => { headers = init.headers; return { ok: true, status: 200, text: async () => JSON.stringify({ hits: { hits: [] } }) }; };
  await sampleDataStream({ url: "https://es:9200", fetchImpl }, "logs-x", 2);
  assert.equal("Authorization" in headers, false);
});

// The path the browser actually takes: no fetchImpl, so the module has to
// reach the host's fetch through the shim it imports. A module that names
// globalObject without importing it throws a ReferenceError here, before
// its own try/catch, and the panel is dead on a real page.
test("sampleDataStream falls back to the host's fetch", async () => {
  const seen = [];
  const saved = globalObject.fetch;
  globalObject.fetch = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, headers: { get: () => "application/json" },
             text: async () => JSON.stringify({ hits: { hits: [{ _source: { "source.ip": "10.0.0.1" } }] } }) };
  };
  try {
    const res = await sampleDataStream({ url: "https://es:9200/", apiKey: "K" },
                                       "logs-x.log", 3);
    assert.equal(res.ok, true);
    assert.deepEqual(res.docs, [{ "source.ip": "10.0.0.1" }]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://es:9200/logs-x.log/_search");
    assert.equal(seen[0].init.headers.Authorization, "ApiKey K");
  } finally {
    globalObject.fetch = saved;
  }
});

// The data stream name is authored in a route hop, so it is encoded: a "/"
// in it would otherwise address a different endpoint entirely.  Encoding is
// not a filter: "*" is legal in a path and comes through untouched, so an
// authored wildcard still reaches Elasticsearch as an index pattern.
test("sampleDataStream encodes the data stream in the url", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ hits: { hits: [] } }) };
  };
  await sampleDataStream({ url: "https://es:9200", fetchImpl }, "logs-a/b_search");
  await sampleDataStream({ url: "https://es:9200", fetchImpl }, "logs-cisco_asa.log");
  await sampleDataStream({ url: "https://es:9200", fetchImpl }, "logs-a b*");
  assert.deepEqual(seen, [
    "https://es:9200/logs-a%2Fb_search/_search",
    // An ordinary name is untouched, so no existing url changes.
    "https://es:9200/logs-cisco_asa.log/_search",
    // The space is escaped; the "*" is not, and is still a wildcard.
    "https://es:9200/logs-a%20b*/_search",
  ]);
});
