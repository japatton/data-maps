// The analyze workbench's decisions, driven end to end with fake clients:
// what a run does with an answer, a failure, an abort and a timeout; which
// finished steps still describe what is on screen; and which buttons may be
// pressed.  views/analyze.js only paints what these answers say.

import test from "node:test";
import assert from "node:assert/strict";
import { SCHEMA, goodTech } from "./fixtures.js";
import {
  createState, idleStep, cancelledStep, clipToBytes, clipEdit, setText,
  inputStamp, shown, identifyRules, assessRules, elasticRules, llmReady,
  pick, loadSources, runIdentify, runAssess, runElastic, reportInput,
  startRun, ensureDoc, prefill, MAX_INPUT,
} from "../lib/analysis-state.js";

// --- a workbench with nothing real behind it ------------------------------

const CATALOG = [
  { id: "t", name: "Test Technology", status: "mapped" },
  { id: "planned-one", name: "Planned", status: "planned" },
];

// The document cache the state module reads through, with a record of every
// load so a test can say which technologies were fetched.
function fakeDocs(docs, options) {
  const opts = options || {};
  const store = new Map();
  const loaded = [];
  return {
    loaded,
    store,
    has: (id) => store.has(id),
    get: (id) => store.get(id),
    load(id) {
      loaded.push(id);
      if (opts.fail && opts.fail[id]) {
        return Promise.reject(new Error(opts.fail[id]));
      }
      const doc = docs[id] === undefined ? null : docs[id];
      store.set(id, doc);
      return Promise.resolve(doc);
    },
  };
}

function painter() {
  const keys = [];
  const repaint = (...names) => { for (const name of names) keys.push(name); };
  repaint.keys = keys;
  return repaint;
}

// A run whose timeout can be fired by hand, and which listens to nothing.
function fakeRun() {
  const fired = [];
  const run = () => startRun({
    setTimer: (fn) => { fired.push(fn); return fired.length; },
    clearTimer: () => {},
    events: null,
  });
  run.fire = () => { fired.forEach((fn) => fn()); };
  return run;
}

function ready(state) {
  return {
    state,
    catalog: CATALOG,
    repaint: painter(),
    sampleInfo: () => ({ sample: state.text, lines: 1, bytes: 3, totalLines: 1 }),
  };
}

// --- the sample and its cap -----------------------------------------------

test("the cap counts bytes, not characters", () => {
  // Four two-byte characters: three fit in six bytes, the fourth does not.
  assert.equal(clipToBytes("ααα", 6), "ααα");
  assert.equal(clipToBytes("αααα", 6), "ααα");
  assert.equal(clipToBytes("abc", 10), "abc");
});

test("the cap never cuts a surrogate pair in half", () => {
  // One emoji is four bytes; four bytes of budget must not keep half of it.
  const text = "a😀b";
  assert.equal(clipToBytes(text, 4), "a");
  assert.equal(clipToBytes(text, 5), "a😀");
});

test("setText records what was kept and where it came from", () => {
  const state = createState();
  setText(state, "one line", "export.log");
  assert.equal(state.text, "one line");
  assert.equal(state.clipped, false);
  assert.equal(state.fileName, "export.log");
  setText(state, "x".repeat(MAX_INPUT + 10), null);
  assert.equal(state.clipped, true);
  assert.equal(state.text.length, MAX_INPUT);
});

test("only a clipped edit is written back to the box", () => {
  assert.equal(clipEdit("abc", "abc", 1), null);
  assert.deepEqual(clipEdit("abcdef", "abcde", 3), { value: "abcde", caret: 3 });
});

// --- stamps and staleness -------------------------------------------------

function doneStep(state) {
  return { ...idleStep(), status: "done", result: { ok: true },
           stamp: inputStamp(state) };
}

test("a finished step goes stale when the sample changes", () => {
  const state = createState();
  setText(state, "first sample", null);
  state.identify = doneStep(state);
  assert.equal(shown(state, state.identify, "identify").status, "done");
  setText(state, "another sample", null);
  assert.equal(shown(state, state.identify, "identify").status, "stale");
});

test("a changed choice stales the assessment but not the identification", () => {
  const state = createState();
  setText(state, "sample", null);
  state.choice = { techId: "t", datasetId: "d", format: "syslog-cef" };
  state.identify = doneStep(state);
  state.assess = doneStep(state);
  state.choice.format = "json";
  assert.equal(shown(state, state.identify, "identify").status, "done");
  assert.equal(shown(state, state.assess, "assess").status, "stale");
});

test("the Elastic sample stales when the cluster URL changes", () => {
  const state = createState();
  state.choice = { techId: "t", datasetId: "d", format: "syslog-cef" };
  state.elasticUrl = "http://es.example:9200";
  state.elastic = doneStep(state);
  assert.equal(shown(state, state.elastic, "elastic").status, "done");
  state.elasticUrl = "";
  assert.equal(shown(state, state.elastic, "elastic").status, "stale");
});

test("a run still in flight is never called stale", () => {
  const state = createState();
  state.identify = { ...idleStep(), status: "running", stamp: inputStamp(state) };
  setText(state, "changed underneath it", null);
  assert.equal(shown(state, state.identify, "identify").status, "running");
});

// --- what may be pressed --------------------------------------------------

const CONFIG = { apiUrl: "http://model.example/v1", model: "m" };

test("identify needs an endpoint, a model and something to send", () => {
  const state = createState();
  assert.equal(llmReady(CONFIG), true);
  assert.equal(llmReady({ apiUrl: "u" }), false);
  const empty = identifyRules({ state, step: idleStep(), config: CONFIG });
  assert.deepEqual([empty.ready, empty.hasText, empty.enabled],
                   [true, false, false]);
  setText(state, "a line", null);
  assert.equal(identifyRules({ state, step: idleStep(), config: CONFIG })
    .enabled, true);
  assert.equal(identifyRules({ state, step: idleStep(), config: {} })
    .enabled, false);
  const running = { ...idleStep(), status: "running" };
  assert.equal(identifyRules({ state, step: running, config: CONFIG })
    .enabled, false);
});

test("assess waits for a chosen entry and for the identification", () => {
  const state = createState();
  setText(state, "a line", null);
  const picked = { row: {}, doc: {}, dataset: { id: "d" }, format: { format: "f" } };
  assert.equal(assessRules({ state, step: idleStep(), config: CONFIG, picked })
    .enabled, true);
  assert.equal(assessRules({ state, step: idleStep(), config: CONFIG,
                             picked: { dataset: null, format: null } }).enabled,
               false);
  state.identify = { ...idleStep(), status: "running" };
  const waiting = assessRules({ state, step: idleStep(), config: CONFIG, picked });
  assert.equal(waiting.identifying, true);
  assert.equal(waiting.enabled, false);
});

test("the Elastic panel appears only with a URL and a data stream", () => {
  const step = idleStep();
  assert.equal(elasticRules({ step, stream: "logs-x", url: "", format: {} })
    .visible, false);
  assert.equal(elasticRules({ step, stream: null, url: "http://es", format: {} })
    .visible, false);
  const on = elasticRules({ step, stream: "logs-x", url: "http://es",
                            format: { fields: [] } });
  assert.deepEqual([on.visible, on.enabled], [true, true]);
  assert.equal(elasticRules({ step, stream: "logs-x", url: "http://es",
                              format: null }).enabled, false);
});

// --- reading the catalog --------------------------------------------------

test("the catalog read skips planned rows and reports its progress", async () => {
  const state = createState();
  const repaint = painter();
  const docs = fakeDocs({ t: goodTech() });
  const sources = await loadSources({
    state, catalog: CATALOG, load: docs.load, repaint, signal: null,
  });
  assert.deepEqual(Object.keys(sources), ["t"]);
  assert.deepEqual(docs.loaded, ["t"]);
  assert.equal(state.progress, null);
  assert.ok(repaint.keys.length >= 1);
});

test("one unreadable document does not stop the catalog read", async () => {
  const state = createState();
  const catalog = [{ id: "a", status: "mapped" }, { id: "b", status: "mapped" }];
  const docs = fakeDocs({ b: goodTech() }, { fail: { a: "500 Server Error" } });
  const sources = await loadSources({
    state, catalog, load: docs.load, repaint: painter(), signal: null,
  });
  assert.deepEqual(Object.keys(sources), ["b"]);
});

test("cancelling during the catalog read stops it and reports a cancellation",
     async () => {
  const state = createState();
  const catalog = [];
  for (let i = 0; i < 6; i += 1) catalog.push({ id: `t${i}`, status: "mapped" });
  const controller = new AbortController();
  const seen = [];
  const load = (id) => {
    seen.push(id);
    if (seen.length === 2) controller.abort();
    return Promise.resolve(goodTech());
  };
  await assert.rejects(
    loadSources({ state, catalog, load, repaint: painter(),
                  signal: controller.signal, width: 1 }),
    (err) => err.aborted === true);
  // The read stopped where it was told to rather than working through all six.
  assert.ok(seen.length < catalog.length, `read ${seen.length} of 6`);
  assert.equal(state.progress, null);
});

// --- step 1: identify -----------------------------------------------------

function identifyDeps(state, client, options) {
  const opts = options || {};
  const docs = opts.docs || fakeDocs({ t: goodTech() });
  const base = ready(state);
  return {
    ...base,
    docs,
    client,
    startRun: opts.startRun,
    loadSources: opts.loadSources
      || ((signal) => loadSources({
        state, catalog: CATALOG, load: docs.load, repaint: base.repaint, signal,
      })),
  };
}

test("an identification is recorded and prefills the chosen entry", async () => {
  const state = createState();
  setText(state, "%ASA-6-302013: Built outbound TCP connection", null);
  const asked = [];
  const client = {
    complete(request) {
      asked.push(request);
      return Promise.resolve({
        technology_id: "t", dataset_id: "d", format: "syslog-cef",
        confidence: "high", evidence: ["%ASA-"],
      });
    },
  };
  const deps = identifyDeps(state, client);
  const step = await runIdentify(deps);
  assert.equal(step.status, "done");
  assert.equal(step.result.technology_id, "t");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].schemaName, "identification");
  assert.ok(asked[0].signal, "the run's signal is passed to the client");
  // The choice follows the answer, down to the format.
  assert.deepEqual(state.choice,
                   { techId: "t", datasetId: "d", format: "syslog-cef" });
  assert.deepEqual(deps.repaint.keys.slice(0, 2), ["identify", "assess"]);
  assert.ok(deps.repaint.keys.includes("report"));
});

test("an answer naming a technology the catalog does not have clears the choice",
     async () => {
  const state = createState();
  setText(state, "something else", null);
  const client = { complete: () => Promise.resolve({ technology_id: "nope" }) };
  await runIdentify(identifyDeps(state, client));
  assert.deepEqual(state.choice, { techId: "", datasetId: "", format: "" });
});

test("a failed identification keeps the endpoint's own words", async () => {
  const state = createState();
  setText(state, "a line", null);
  const err = new Error("HTTP 500: upstream said no");
  err.body = "{\"error\": \"model not loaded\"}";
  const client = { complete: () => Promise.reject(err) };
  const step = await runIdentify(identifyDeps(state, client));
  assert.equal(step.status, "error");
  assert.equal(step.error.message, "HTTP 500: upstream said no");
  assert.match(step.error.detail, /model not loaded/);
  assert.equal(state.progress, null);
});

test("an aborted identification is a cancellation, not an error", async () => {
  const state = createState();
  setText(state, "a line", null);
  const client = {
    complete: () => {
      const err = new Error("The run was cancelled.");
      err.aborted = true;
      return Promise.reject(err);
    },
  };
  const step = await runIdentify(identifyDeps(state, client));
  assert.equal(step.status, "cancelled");
  assert.equal(step.note, "Cancelled.");
});

test("a run cut off by the timeout says so", async () => {
  const state = createState();
  setText(state, "a line", null);
  const run = fakeRun();
  const client = {
    complete: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.aborted = true;
        reject(err);
      });
      // The twenty minutes are up while the model is still thinking.
      run.fire();
    }),
  };
  const step = await runIdentify(
    identifyDeps(state, client, { startRun: run }));
  assert.equal(step.status, "cancelled");
  assert.match(step.note, /no answer after 20 minutes/);
});

test("cancelling the catalog read leaves a cancelled step", async () => {
  const state = createState();
  setText(state, "a line", null);
  const client = { complete: () => assert.fail("the model must not be asked") };
  const step = await runIdentify(identifyDeps(state, client, {
    loadSources: () => {
      const err = new Error("The run was cancelled.");
      err.aborted = true;
      return Promise.reject(err);
    },
  }));
  assert.equal(step.status, "cancelled");
});

// --- step 2: assess -------------------------------------------------------

function assessDeps(state, client, choice) {
  return {
    ...ready(state),
    schema: SCHEMA,
    client,
    choice,
  };
}

test("assessing with no entry chosen complains instead of asking", async () => {
  const state = createState();
  setText(state, "a line", null);
  const client = { complete: () => assert.fail("the model must not be asked") };
  const step = await runAssess(assessDeps(state, client,
                                          { row: null, dataset: null, format: null }));
  assert.equal(step.status, "error");
  assert.match(step.error.message, /Choose a technology, dataset and format/);
  // Stamped like any other outcome, so choosing an entry retires it.
  assert.ok(step.stamp);
});

test("a choice cleared under a retry is caught when the retry runs", async () => {
  const state = createState();
  setText(state, "a line", null);
  let entry = { row: { id: "t" }, dataset: goodTech().datasets[0],
                format: goodTech().datasets[0].formats[0] };
  const client = { complete: () => Promise.resolve({ summary: "fine" }) };
  const deps = assessDeps(state, client, () => entry);
  assert.equal((await runAssess(deps)).status, "done");
  entry = { row: null, dataset: null, format: null };
  assert.equal((await runAssess(deps)).status, "error");
});

test("an assessment marks the ECS names the dictionary does not know",
     async () => {
  const state = createState();
  setText(state, "a line", null);
  state.choice = { techId: "t", datasetId: "d", format: "syslog-cef" };
  const dataset = goodTech().datasets[0];
  const asked = [];
  const client = {
    complete(request) {
      asked.push(request);
      return Promise.resolve({
        summary: "covered", confidence: "high",
        observed_fields: [
          { name: "src", suggested_ecs: "source.ip" },
          { name: "made_up", suggested_ecs: "not.a.real.field" },
        ],
      });
    },
  };
  const step = await runAssess(assessDeps(state, client, {
    row: { id: "t" }, dataset, format: dataset.formats[0],
  }));
  assert.equal(step.status, "done");
  assert.equal(asked[0].schemaName, "assessment");
  const fields = step.result.observed_fields;
  assert.equal(fields[0].ecs_known, true);
  assert.equal(fields[1].ecs_known, false);
});

// --- step 3: the Elasticsearch sample -------------------------------------

function elasticDeps(state, client, picked) {
  return {
    ...ready(state),
    config: { url: "http://es.example:9200" },
    client,
    choice: picked,
  };
}

test("a data stream the cluster does not have is reported with its status",
     async () => {
  const state = createState();
  const dataset = goodTech().datasets[0];
  const client = {
    sample: () => Promise.resolve({
      ok: false, docs: [], status: 404,
      body: "{\"error\":\"no such index\"}", cors: false,
    }),
  };
  const step = await runElastic(elasticDeps(state, client, {
    dataset, format: dataset.formats[0],
  }));
  assert.equal(step.status, "error");
  assert.match(step.error.message, /HTTP 404/);
  assert.match(step.error.message, /no such index/);
  assert.equal(step.dataStream, "logs-test.d");
  // The URL the answer was about, so changing it stales this step.
  assert.equal(state.elasticUrl, "http://es.example:9200");
});

test("a sampled data stream says which mapped targets are populated",
     async () => {
  const state = createState();
  const dataset = goodTech().datasets[0];
  const client = {
    sample: (config, stream, size) => {
      assert.equal(stream, "logs-test.d");
      assert.equal(size, 5);
      return Promise.resolve({
        ok: true,
        docs: [{ source: { ip: "10.0.0.1" }, event: { kind: "event" } }],
      });
    },
  };
  const step = await runElastic(elasticDeps(state, client, {
    dataset, format: dataset.formats[0],
  }));
  assert.equal(step.status, "done");
  assert.equal(step.result.docCount, 1);
  const targets = step.result.targets;
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map((row) => [row.ecs, row.present]),
                   [["source.ip", true], ["event.action", false]]);
});

test("a thrown sampler is an error step, not an unhandled rejection",
     async () => {
  const state = createState();
  const dataset = goodTech().datasets[0];
  const client = { sample: () => Promise.reject(new Error("boom")) };
  const step = await runElastic(elasticDeps(state, client, {
    dataset, format: dataset.formats[0],
  }));
  assert.equal(step.status, "error");
  assert.equal(step.error.message, "boom");
});

// --- the report -----------------------------------------------------------

test("the report carries only the steps still current on screen", () => {
  const state = createState();
  setText(state, "a line", null);
  state.choice = { techId: "t", datasetId: "d", format: "syslog-cef" };
  const dataset = goodTech().datasets[0];
  state.identify = { ...doneStep(state), result: { technology_id: "t" } };
  state.assess = { ...doneStep(state), result: { summary: "covered" } };
  const picked = { row: { id: "t", name: "Test Technology" }, dataset,
                   format: dataset.formats[0] };
  const input = reportInput({ state, picked, schema: SCHEMA });
  assert.equal(input.identify.technology_id, "t");
  assert.equal(input.assess.summary, "covered");
  assert.equal(input.choice.dataset.id, "d");
  assert.equal(input.ecsVersion, SCHEMA.ecs_version);
  // The sample changes: the assessment is about the old one, so it is left out.
  setText(state, "a different line", null);
  const after = reportInput({ state, picked, schema: SCHEMA });
  assert.equal(after.assess, null);
  assert.equal(after.identify, null);
  assert.equal(after.choice.dataset.id, "d");
});

test("a failed Elastic step still reaches the report as its message", () => {
  const state = createState();
  state.choice = { techId: "t", datasetId: "d", format: "syslog-cef" };
  state.elastic = {
    ...idleStep(), status: "error", stamp: inputStamp(state),
    dataStream: "logs-test.d", error: { message: "HTTP 404", detail: null },
  };
  const dataset = goodTech().datasets[0];
  const input = reportInput({
    state, picked: { row: null, dataset, format: dataset.formats[0] },
    schema: SCHEMA,
  });
  assert.deepEqual(input.elastic,
                   { dataStream: "logs-test.d", error: "HTTP 404" });
});

// --- the pieces the panels read -------------------------------------------

test("the choice resolves to a row, a dataset and a format", () => {
  const state = createState();
  state.choice = { techId: "t", datasetId: "d", format: "syslog-cef" };
  const docs = fakeDocs({});
  docs.store.set("t", goodTech());
  const picked = pick({ state, catalog: CATALOG, docs });
  assert.equal(picked.row.name, "Test Technology");
  assert.equal(picked.dataset.id, "d");
  assert.equal(picked.format.format, "syslog-cef");
  // A technology whose document has not been fetched resolves to nothing.
  state.choice = { techId: "planned-one", datasetId: "d", format: "" };
  const missing = pick({ state, catalog: CATALOG, docs });
  assert.equal(missing.doc, null);
  assert.equal(missing.dataset, null);
});

test("a cancelled step reports how long it ran and why it stopped", () => {
  const step = cancelledStep(Date.now() - 5, { sample: "x" }, true);
  assert.equal(step.status, "cancelled");
  assert.match(step.note, /20 minutes/);
  assert.ok(step.ms >= 0);
  assert.equal(cancelledStep(Date.now(), null, false).note, "Cancelled.");
});

// --- a run's teardown -----------------------------------------------------
//
// A run listens for hashchange so that navigating away aborts it.  The
// listener has to come off again when the run ends, or twenty of them
// accumulate over a session and each one aborts a controller nobody holds.

function fakeEvents() {
  const bound = [];
  return {
    bound,
    addEventListener(name, fn) { bound.push([name, fn]); },
    removeEventListener(name, fn) {
      const at = bound.findIndex(([n, f]) => n === name && f === fn);
      if (at !== -1) bound.splice(at, 1);
    },
  };
}

test("a run drops its hashchange listener and its timer when it ends", () => {
  const events = fakeEvents();
  const cleared = [];
  const run = startRun({
    setTimer: () => 7,
    clearTimer: (handle) => cleared.push(handle),
    events,
  });
  assert.equal(events.bound.length, 1);
  assert.equal(events.bound[0][0], "hashchange");
  // Navigating away is what the listener is for.
  assert.equal(run.controller.signal.aborted, false);
  events.bound[0][1]();
  assert.equal(run.controller.signal.aborted, true);

  run.done();
  assert.deepEqual(events.bound, [], "the listener is removed");
  assert.deepEqual(cleared, [7], "the timeout is cleared");
  // Ending twice must not throw or unbind someone else's listener.
  run.done();
  assert.deepEqual(events.bound, []);
});

test("a host with no event target is simply not watched", () => {
  const run = startRun({ setTimer: () => 1, clearTimer: () => {},
                         events: null });
  run.done();
  assert.equal(run.timedOut(), false);
  // An object that is not an event target either.
  const odd = startRun({ setTimer: () => 1, clearTimer: () => {},
                         events: {} });
  odd.done();
});

// --- a document that will not load ----------------------------------------
//
// "No map file yet" and "the fetch failed" are different answers, and the
// choice panel reads state.docErrors to say which.

test("ensureDoc records a load failure and repaints", async () => {
  const state = createState();
  const docs = fakeDocs({}, { fail: { t: "source/t.json: HTTP 500" } });
  const repaint = painter();
  ensureDoc("t", { state, docs, repaint });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(state.docErrors.t, /HTTP 500/);
  assert.ok(repaint.keys.includes("choice"));
});

test("a load that succeeds clears the failure it recorded", async () => {
  const state = createState();
  state.docErrors.t = "an earlier failure";
  const docs = fakeDocs({ t: goodTech() });
  ensureDoc("t", { state, docs, repaint: painter() });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal("t" in state.docErrors, false);
  // Nothing is fetched twice.
  ensureDoc("t", { state, docs, repaint: painter() });
  assert.deepEqual(docs.loaded, ["t"]);
});

test("prefill records the failure and stops at the technology", async () => {
  const state = createState();
  const docs = fakeDocs({}, { fail: { t: "source/t.json: network error" } });
  await prefill({ technology_id: "t", dataset_id: "d", format: "syslog-cef" },
                { state, catalog: CATALOG, docs });
  assert.match(state.docErrors.t, /network error/);
  // The technology is still the one the model named; the dataset and format
  // could not be checked against a document nobody has.
  assert.deepEqual(state.choice, { techId: "t", datasetId: "", format: "" });
});
