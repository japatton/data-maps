import test from "node:test";
import assert from "node:assert/strict";
import { takeSample, buildCatalogDigest, stripThink, createClient, LlmError, IDENTIFY_SCHEMA, ASSESS_SCHEMA, checkEcsNames, identifyPrompt, assessPrompt } from "../lib/llm.js";
import { globalObject } from "../lib/global.js";

test("takeSample limits lines then bytes at a line boundary", () => {
  const text = Array.from({ length: 200 }, (_, i) => "line " + i).join("\n");
  const s = takeSample(text, { maxLines: 80, maxBytes: 100 });
  assert.equal(s.totalLines, 200); assert.equal(s.truncated, true);
  assert.ok(s.bytes <= 100); assert.ok(!s.sample.endsWith("lin"));
  assert.equal(s.sample.split("\n").length, s.lines);
});

test("digest lists datasets with formats and first sentence", () => {
  const rows = [{ id: "a", name: "A", vendor: "V", category: "endpoint" }, { id: "b", name: "B", vendor: "W", category: "cloud" }];
  const sources = { a: { datasets: [{ id: "d1", name: "D1", description: "First sentence. Second.", formats: [{ format: "json" }, { format: "syslog-cef" }] }] } };
  const d = buildCatalogDigest(rows, sources);
  assert.ok(d.includes("a | A | V | endpoint"));
  assert.ok(d.includes("  d1 | D1 | formats: json, syslog-cef | First sentence."));
  assert.ok(d.includes("b | B | W | cloud\n  (no map yet)"));
});

test("stripThink removes a leading think block", () => {
  assert.equal(stripThink("<think>\nreasoning\n</think>\n{\"a\":1}"), '{"a":1}');
  assert.equal(stripThink('{"a":1}'), '{"a":1}');
});

test("client sends json_schema and parses content", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init: JSON.parse(init.body), headers: init.headers }); return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ choices: [{ message: { content: '<think>x</think>{"technology_id":"cisco-asa"}' } }] }) }; };
  const c = createClient({ apiKind: "openai", apiUrl: "https://o/v1", model: "m", apiKey: "K", fetchImpl });
  const out = await c.complete({ system: "s", user: "u", schemaName: "identify", schema: IDENTIFY_SCHEMA });
  assert.equal(out.technology_id, "cisco-asa");
  assert.equal(calls[0].url, "https://o/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer K");
  assert.equal(calls[0].init.response_format.type, "json_schema");
  assert.equal(calls[0].init.response_format.json_schema.strict, true);
  assert.equal(calls[0].init.temperature, 0);
});

test("azure url and header", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, headers: init.headers }; return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ choices: [{ message: { content: "{}" } }] }) }; };
  const c = createClient({ apiKind: "azure", apiUrl: "https://a.openai.azure.us", model: "dep", apiVersion: "2024-10-21", apiKey: "K", fetchImpl });
  await c.complete({ system: "s", user: "u", schemaName: "x", schema: { type: "object" } });
  assert.equal(seen.url, "https://a.openai.azure.us/openai/deployments/dep/chat/completions?api-version=2024-10-21");
  assert.equal(seen.headers["api-key"], "K");
});

test("falls back to json_object when json_schema is rejected", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => { const b = JSON.parse(init.body); bodies.push(b); if (b.response_format.type === "json_schema") return { ok: false, status: 400, headers: { get: () => "application/json" }, text: async () => '{"error":"response_format json_schema unsupported"}' }; return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }) }; };
  const c = createClient({ apiKind: "openai", apiUrl: "https://o/v1", model: "m", apiKey: "", fetchImpl });
  const out = await c.complete({ system: "s", user: "u", schemaName: "x", schema: { type: "object" } });
  assert.equal(out.ok, true); assert.equal(bodies.length, 2); assert.equal(bodies[1].response_format.type, "json_object");
  assert.ok(bodies[1].messages[0].content.includes('"type"'));
});

test("unparseable content throws LlmError with raw", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ choices: [{ message: { content: "not json" } }] }) });
  const c = createClient({ apiKind: "openai", apiUrl: "https://o/v1", model: "m", apiKey: "", fetchImpl });
  await assert.rejects(c.complete({ system: "s", user: "u", schemaName: "x", schema: {} }), e => e instanceof LlmError && e.raw === "not json");
});

test("schemas are strict objects and prompts mention the sample size", () => {
  assert.equal(IDENTIFY_SCHEMA.additionalProperties, false);
  assert.ok(IDENTIFY_SCHEMA.required.includes("technology_id"));
  assert.ok(ASSESS_SCHEMA.required.includes("parsing"));
  const p = identifyPrompt("digest", { sample: "x", lines: 3, bytes: 5, totalLines: 9, truncated: true });
  assert.ok(p.user.includes("first 3 lines (5 bytes) of a 9-line export"));
});

test("checkEcsNames marks unknown targets", () => {
  const r = checkEcsNames({ observed_fields: [{ suggested_ecs: "source.ip" }, { suggested_ecs: "source.bogus" }, { suggested_ecs: null }], alerting_gaps: [{ ecs: "event.action" }] }, { "source.ip": {}, "event.action": {} });
  assert.deepEqual(r.observed_fields.map(f => f.ecs_known), [true, false, null]);
  assert.equal(r.alerting_gaps[0].ecs_known, true);
});

// Annotating never edits what it was handed: a caller that keeps the model's
// own answer still has it unmarked, whatever it does with the copy.
test("checkEcsNames answers with a copy and leaves the result alone", () => {
  const result = {
    observed_fields: [{ suggested_ecs: "source.ip" }],
    alerting_gaps: [{ ecs: "event.action" }],
  };
  const marked = checkEcsNames(result, { "source.ip": {} });
  assert.notEqual(marked, result);
  assert.notEqual(marked.observed_fields[0], result.observed_fields[0]);
  assert.equal(marked.observed_fields[0].ecs_known, true);
  assert.equal("ecs_known" in result.observed_fields[0], false);
  assert.equal("ecs_known" in result.alerting_gaps[0], false);
  // Nothing else about the result moved.
  assert.equal(marked.observed_fields[0].suggested_ecs, "source.ip");
  // A non-object is handed straight back.
  assert.equal(checkEcsNames(null, {}), null);
  assert.equal(checkEcsNames("x", {}), "x");
});

// A model asked for one target sometimes answers with several; as one string
// that is never in the dictionary and would be struck through whole.
test("checkEcsNames splits a comma-separated suggestion and marks each name", () => {
  const r = checkEcsNames({
    observed_fields: [
      { suggested_ecs: "source.ip, source.bogus , client.ip" },
      { suggested_ecs: "source.ip" },
      { suggested_ecs: " , " },
    ],
    alerting_gaps: [{ ecs: "event.action,event.nope" }],
  }, { "source.ip": {}, "client.ip": {}, "event.action": {} });
  assert.deepEqual(r.observed_fields[0].ecs_list,
                   ["source.ip", "source.bogus", "client.ip"]);
  assert.deepEqual(r.observed_fields[0].ecs_known, [true, false, true]);
  // One name keeps the plain boolean and gets no list.
  assert.equal(r.observed_fields[1].ecs_known, true);
  assert.equal(r.observed_fields[1].ecs_list, undefined);
  // Commas and nothing else is nothing to check.
  assert.equal(r.observed_fields[2].ecs_known, null);
  assert.deepEqual(r.alerting_gaps[0].ecs_list, ["event.action", "event.nope"]);
  assert.deepEqual(r.alerting_gaps[0].ecs_known, [true, false]);
});

// A list, a string or a null parses as JSON and then fails much later, in a
// view reading a property off it, with nothing left to show the operator.
test("content that is not a JSON object throws LlmError with the raw text", async () => {
  for (const content of ["[1,2]", '"a string"', "null", "7"]) {
    const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) });
    const c = createClient({ apiKind: "openai", apiUrl: "https://o/v1", model: "m", apiKey: "", fetchImpl });
    await assert.rejects(
      c.complete({ system: "s", user: "u", schemaName: "x", schema: {} }),
      (e) => e instanceof LlmError && e.raw === content
        && /not an object/.test(e.message), content);
  }
});

// Not every endpoint answers 400 for a body it cannot serve; the body still
// has to name the field, so a plain wrong-url 404 is not retried.
test("the json_object fallback fires on the other refusal statuses", async () => {
  const attempt = async (status, body) => {
    const bodies = [];
    const fetchImpl = async (url, init) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      if (b.response_format.type === "json_schema") {
        return { ok: false, status, headers: { get: () => "application/json" }, text: async () => body };
      }
      return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }) };
    };
    const c = createClient({ apiKind: "openai", apiUrl: "https://o/v1", model: "m", apiKey: "", fetchImpl });
    return { bodies, run: c.complete({ system: "s", user: "u", schemaName: "x", schema: { type: "object" } }) };
  };
  for (const status of [400, 404, 415, 422, 501]) {
    const a = await attempt(status, '{"error":"response_format is not supported"}');
    assert.deepEqual(await a.run, { ok: true }, String(status));
    assert.equal(a.bodies.length, 2, String(status));
    assert.equal(a.bodies[1].response_format.type, "json_object");
  }
  // A 404 that says nothing about the field is the wrong url, not a refusal.
  const plain = await attempt(404, '{"error":"model not found"}');
  await assert.rejects(plain.run, (e) => e instanceof LlmError && e.status === 404);
  assert.equal(plain.bodies.length, 1);
  // Nor is a 500 that happens to mention it.
  const boom = await attempt(500, "response_format exploded");
  await assert.rejects(boom.run, (e) => e instanceof LlmError && e.status === 500);
  assert.equal(boom.bodies.length, 1);
});

test("takeSample cuts an over-long single line on a codepoint boundary", () => {
  const s = takeSample("é".repeat(50), { maxLines: 80, maxBytes: 11 });
  assert.equal(s.lines, 1); assert.equal(s.totalLines, 1); assert.equal(s.truncated, true);
  assert.equal(s.bytes, 10); assert.equal(s.sample, "é".repeat(5));
  assert.ok(!s.sample.includes("�"));
});

const ASSESS_CTX = {
  technology: { id: "cisco-asa", name: "Cisco ASA", vendor: "Cisco" },
  dataset: { id: "connection-events", name: "Connection build/teardown events", description: "Flow lifecycle records. Highest volume by an order of magnitude.", event_categories: ["network"], route_summary: "cribl -> elastic (logs-cisco_asa.log)" },
  format: {
    format: "syslog-raw",
    parsing: { mechanism: "elastic-integration", artifact: "cisco_asa integration" },
    fields: [
      { vendor: "message_id", type: "string", ecs: "event.code", status: "mapped", description: "Six-digit ASA syslog message number", transform: "event.action, event.type and event.outcome all come from a static lookup on this ID; ASA emits no separate action token" },
      { vendor: "connection_id", type: "integer", ecs: null, status: "unmapped", custom: "cisco.asa.connection_id", notes: "joins the Built and Teardown records of one flow" },
      { vendor: "bare", ecs: "source.ip", status: "mapped" },
    ],
  },
  other_formats: ["netflow"],
  required_ecs: ["event.action", "source.ip"],
  ecs_version: "9.4.0",
  mechanisms: ["elastic-integration", "cribl-pack", "none"],
};
const ASSESS_SAMPLE = { sample: "%ASA-6-302013: Built", lines: 1, bytes: 20, totalLines: 4, truncated: true };

test("assess prompt carries every field's transform, notes and custom target", () => {
  const p = assessPrompt(ASSESS_CTX, ASSESS_SAMPLE);
  assert.ok(p.user.includes("Six-digit ASA syslog message number"));
  assert.ok(p.user.includes("static lookup on this ID"));
  assert.ok(p.user.includes("cisco.asa.connection_id"));
  assert.ok(p.user.includes("joins the Built and Teardown records of one flow"));
  assert.ok(p.user.includes("(no ECS target)"));
  assert.ok(p.user.includes("first 1 lines (20 bytes) of a 4-line export"));
  // The field list is tabulated, not also dumped inside the format JSON.
  assert.equal(p.user.split("static lookup on this ID").length - 1, 1);
});

test("assess prompt caps a long field value generously and says so", () => {
  const long = "x".repeat(900);
  const ctx = { ...ASSESS_CTX, format: { ...ASSESS_CTX.format, fields: [{ vendor: "v", ecs: null, status: "unmapped", transform: long }] } };
  const p = assessPrompt(ctx, ASSESS_SAMPLE);
  assert.ok(p.user.includes("transform: " + "x".repeat(600) + "…"));
  assert.ok(!p.user.includes("x".repeat(601)));
  assert.ok(p.user.includes(
    "Each value in the last column belongs to that field alone; "
    + "values longer than 600 characters end in \u2026."));
});

test("assess system names the passed mechanisms and ECS version", () => {
  const p = assessPrompt(ASSESS_CTX, ASSESS_SAMPLE);
  assert.ok(p.system.includes("Elastic\nCommon Schema (ECS) 9.4.0."));
  assert.ok(p.system.includes("real ECS 9.4.0 field names"));
  assert.ok(p.system.includes("from: elastic-integration, cribl-pack, none and a parse location"));
  const bare = assessPrompt({ ...ASSESS_CTX, ecs_version: undefined, mechanisms: undefined }, ASSESS_SAMPLE);
  assert.ok(!/ECS\)? ?\d/.test(bare.system));
  assert.ok(bare.system.includes("Common Schema (ECS). Answer only"));
  assert.ok(bare.system.includes("real ECS field names"));
});

test("complete hands the abort signal to fetch and reports an abort as cancelled", async () => {
  const controller = new AbortController();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.signal);
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  };
  const c = createClient({ apiKind: "openai", apiUrl: "https://o/v1", model: "m", apiKey: "K", fetchImpl });
  await assert.rejects(
    c.complete({ system: "s", user: "u", schemaName: "x", schema: {}, signal: controller.signal }),
    (e) => e instanceof LlmError && e.aborted === true && e.cors === false && /cancelled/i.test(e.message));
  assert.equal(seen[0], controller.signal);
});

test("a run with no signal sends none, and a live run is not marked aborted", async () => {
  const inits = [];
  const fetchImpl = async (url, init) => {
    inits.push(init);
    return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }) };
  };
  const c = createClient({ apiKind: "openai", apiUrl: "https://o/v1", model: "m", apiKey: "", fetchImpl });
  const out = await c.complete({ system: "s", user: "u", schemaName: "x", schema: {} });
  assert.equal(out.ok, true);
  assert.equal("signal" in inits[0], false);
  assert.equal(new LlmError("x").aborted, false);
});

// Same guard for the model client: with no fetchImpl it must reach the
// host's fetch through the imported shim, not through a bare global.
test("complete falls back to the host's fetch", async () => {
  const seen = [];
  const saved = globalObject.fetch;
  globalObject.fetch = async (url, init) => {
    seen.push(url);
    return { ok: true, status: 200, headers: { get: () => "application/json" },
             text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }) };
  };
  try {
    const c = createClient({ apiKind: "openai", apiUrl: "https://o/v1", model: "m", apiKey: "K" });
    const out = await c.complete({ system: "s", user: "u", schemaName: "x", schema: {} });
    assert.equal(out.ok, true);
    assert.deepEqual(seen, ["https://o/v1/chat/completions"]);
  } finally {
    globalObject.fetch = saved;
  }
});
