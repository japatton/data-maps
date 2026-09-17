// The shell's pure pieces: the hash router, the render loop's generation
// counter, the JSON loader's reading of a response, and the source loader's
// rule that only a 404 means "this technology has no file yet".
import test from "node:test";
import assert from "node:assert/strict";
import {
  createSourceLoader, createJsonLoader, parseRoute, renderRoute,
} from "../studio.js";

function found(json) {
  return { ok: true, json, status: 200, cors: false, why: "" };
}
function failed(status, why, cors = false) {
  return { ok: false, json: null, status, cors, why };
}

function recorder(answers) {
  const calls = [];
  return {
    calls,
    fetchJson(path) {
      calls.push(path);
      const answer = answers.shift();
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer);
    },
  };
}

test("a found document is returned and cached", async () => {
  const doc = { id: "cisco-asa" };
  const net = recorder([found(doc)]);
  const load = createSourceLoader(net.fetchJson);
  assert.equal(await load("cisco-asa"), doc);
  assert.equal(await load("cisco-asa"), doc);
  assert.deepEqual(net.calls, ["source/cisco-asa.json"]);
});

test("only a 404 reads as 'no file yet', and it is cached", async () => {
  const net = recorder([failed(404, "HTTP 404: not found")]);
  const load = createSourceLoader(net.fetchJson);
  assert.equal(await load("brand-new"), null);
  assert.equal(await load("brand-new"), null);
  assert.deepEqual(net.calls, ["source/brand-new.json"]);
});

test("a blocked request rejects rather than reading as a new technology",
     async () => {
  const net = recorder([failed(0, "The browser blocked this request", true)]);
  const load = createSourceLoader(net.fetchJson);
  const err = await load("cisco-asa").then(() => null, (e) => e);
  assert.ok(err instanceof Error);
  assert.equal(err.status, 0);
  assert.equal(err.cors, true);
  assert.match(err.message, /source\/cisco-asa\.json: The browser blocked/);
});

test("a server error rejects and is not cached, so the next call retries",
     async () => {
  const doc = { id: "cisco-asa" };
  const net = recorder([failed(500, "HTTP 500: boom"), found(doc)]);
  const load = createSourceLoader(net.fetchJson);
  await assert.rejects(() => load("cisco-asa"), /HTTP 500/);
  assert.equal(await load("cisco-asa"), doc);
  assert.deepEqual(net.calls,
                   ["source/cisco-asa.json", "source/cisco-asa.json"]);
});

test("a thrown request does not wedge the id", async () => {
  const doc = { id: "zeek" };
  const net = recorder([new Error("fetch exploded"), found(doc)]);
  const load = createSourceLoader(net.fetchJson);
  await assert.rejects(() => load("zeek"), /fetch exploded/);
  assert.equal(await load("zeek"), doc);
});

test("racing callers share one request", async () => {
  const doc = { id: "zeek" };
  const net = recorder([found(doc)]);
  const load = createSourceLoader(net.fetchJson);
  const [a, b] = await Promise.all([load("zeek"), load("zeek")]);
  assert.equal(a, doc);
  assert.equal(b, doc);
  assert.deepEqual(net.calls, ["source/zeek.json"]);
});

test("the cache the shell shares as ctx.sourcesCache is the one used",
     async () => {
  const cache = new Map();
  const doc = { id: "zeek" };
  const load = createSourceLoader(recorder([found(doc)]).fetchJson, cache);
  await load("zeek");
  assert.equal(cache.get("zeek"), doc);
});

test("an id with an awkward character is escaped once", async () => {
  const net = recorder([failed(404, "HTTP 404: not found")]);
  const load = createSourceLoader(net.fetchJson);
  assert.equal(await load("a b"), null);
  assert.deepEqual(net.calls, ["source/a%20b.json"]);
});

test("parseRoute names every view", () => {
  assert.equal(parseRoute("#/").name, "picker");
  assert.equal(parseRoute("").name, "picker");
  assert.equal(parseRoute("#/settings").name, "settings");
  assert.equal(parseRoute("#/analyze").name, "analyze");
  assert.deepEqual(parseRoute("#/tech/cisco-asa").params, { id: "cisco-asa" });
  assert.equal(parseRoute("#/tech/cisco-asa").name, "editor");
  assert.equal(parseRoute("#/tech/cisco-asa/review").name, "review");
  assert.equal(parseRoute("#/tech/%zz").name, "notfound");
  assert.equal(parseRoute("#/nope").name, "notfound");
  assert.equal(parseRoute("#/tech/a/b/c").name, "notfound");
});

test("#/tech/<id>/delete routes to the delete view", () => {
  const route = parseRoute("#/tech/acme-fw/delete");
  assert.equal(route.name, "delete");
  assert.deepEqual(route.params, { id: "acme-fw" });
});

// --- the JSON loader ------------------------------------------------------

// The shape lib/net.js's request() answers with.
function answered(status, body, json) {
  return { ok: status >= 200 && status < 300, status, body, json,
           cors: false };
}

test("getJson reports a JSON body as found", async () => {
  const asked = [];
  const getJson = createJsonLoader((url) => {
    asked.push(url);
    return Promise.resolve(answered(200, '{"a":1}', { a: 1 }));
  });
  assert.deepEqual(await getJson("schema.json"),
                   { ok: true, json: { a: 1 }, status: 200, cors: false,
                     why: "" });
  assert.deepEqual(asked, ["schema.json"]);
});

test("a 200 that is not JSON is a failure that says so", async () => {
  const getJson = createJsonLoader(
    () => Promise.resolve(answered(200, "<!doctype html>", null)));
  const result = await getJson("config.json");
  assert.equal(result.ok, false);
  assert.equal(result.json, null);
  assert.equal(result.status, 200);
  assert.equal(result.why, "HTTP 200: the response was not JSON");
});

test("a 404 keeps its status, so 'no file yet' stays tellable", async () => {
  const getJson = createJsonLoader(
    () => Promise.resolve(answered(404, "not found", null)));
  const result = await getJson("source/nope.json");
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.match(result.why, /^HTTP 404: not found/);
});

// Every document the loader fetches is part of the published snapshot the
// editor diffs against, so none of them may come from the browser cache.
// Asserted on the init the transport is handed, because that is the only
// place the rule is visible without a network.
test("getJson asks the transport for an uncached read", async () => {
  const seen = [];
  const getJson = createJsonLoader((url, init) => {
    seen.push({ url, init });
    return Promise.resolve(answered(200, "{}", {}));
  });
  await getJson("schema.json");
  await getJson("config.json");
  assert.deepEqual(seen.map((call) => call.url), ["schema.json", "config.json"]);
  for (const call of seen) assert.equal(call.init.noStore, true);
});

// The same rule reaches the technology documents through the source loader,
// which is the one that feeds the editor's baseline.
test("a source document is read uncached too", async () => {
  const seen = [];
  const getJson = createJsonLoader((url, init) => {
    seen.push({ url, init });
    return Promise.resolve(answered(200, '{"id":"zeek"}', { id: "zeek" }));
  });
  await createSourceLoader(getJson)("zeek");
  assert.deepEqual(seen.map((call) => call.url), ["source/zeek.json"]);
  assert.equal(seen[0].init.noStore, true);
});

test("a blocked request is explained as the browser blocking it", async () => {
  const getJson = createJsonLoader(() => Promise.resolve(
    { ok: false, status: 0, body: "Failed to fetch", json: null, cors: true }));
  const result = await getJson("schema.json");
  assert.equal(result.cors, true);
  assert.equal(result.status, 0);
  assert.match(result.why, /The browser blocked this request/);
});

// --- the render loop ------------------------------------------------------

// clear() only walks firstChild/removeChild, so a route render needs no DOM
// as long as the view is a fake one.
function fakeRoot() {
  return { firstChild: null, removeChild() {} };
}

test("every route render bumps the generation the views compare against",
     () => {
  const seen = [];
  const ctx = {};
  const route = {
    name: "fake",
    view: { render(root, context) { seen.push(context.generation); } },
    params: {},
  };
  renderRoute(fakeRoot(), ctx, route);
  renderRoute(fakeRoot(), ctx, route);
  renderRoute(fakeRoot(), ctx, route);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(ctx.generation, 3);
  // What a continuation started by the first render would compare: it is no
  // longer the view on screen, so it paints nothing.
  assert.notEqual(seen[0], ctx.generation);
});

test("the header hook is called with the route name before the view runs",
     () => {
  const calls = [];
  const ctx = { generation: 7 };
  renderRoute(fakeRoot(), ctx, {
    name: "settings",
    view: { render() { calls.push("view"); } },
    params: {},
  }, { header: (name, context) => calls.push(`header:${name}:${context.generation}`) });
  assert.deepEqual(calls, ["header:settings:8", "view"]);
});

test("a view that throws is reported through the hook and still rethrows",
     () => {
  const ctx = {};
  const boom = new Error("bad view");
  const seen = [];
  const root = fakeRoot();
  assert.throws(() => renderRoute(root, ctx, {
    name: "editor",
    view: { render() { throw boom; } },
    params: {},
  }, { onError: (err, node) => seen.push([err, node]) }), /bad view/);
  assert.deepEqual(seen, [[boom, root]]);
  // The counter still moved: the failed view is gone either way.
  assert.equal(ctx.generation, 1);
});
