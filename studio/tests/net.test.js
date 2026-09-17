import test from "node:test";
import assert from "node:assert/strict";
import { request, explain, credentialsFor } from "../lib/net.js";

function jsonResponse(status, payload, contentType = "application/json") {
  return {
    ok: status < 400,
    status,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
  };
}

test("returns parsed json on 200", async () => {
  const r = await request("https://x/y", { fetchImpl: async () => jsonResponse(200, { a: 1 }) });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.cors, false);
  assert.equal(r.body, '{"a":1}');
  assert.deepEqual(r.json, { a: 1 });
});

test("parses a json body even when the content type does not say so", async () => {
  const r = await request("https://x/y", { fetchImpl: async () => jsonResponse(200, { a: 1 }, "text/plain") });
  assert.deepEqual(r.json, { a: 1 });
});

test("json is null when the body is not json", async () => {
  const r = await request("https://x/y", { fetchImpl: async () => jsonResponse(200, "not json", "text/plain") });
  assert.equal(r.json, null);
  assert.equal(r.body, "not json");
});

test("a failing status is reported, not thrown", async () => {
  const r = await request("https://x/y", { fetchImpl: async () => jsonResponse(404, { message: "gone" }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { message: "gone" });
});

test("sends credentials omit, the method, headers and a JSON body", async () => {
  let seen = null;
  await request("https://x/y", {
    method: "POST",
    headers: { "PRIVATE-TOKEN": "T" },
    json: { branch: "b" },
    fetchImpl: async (url, init) => { seen = { url, init }; return jsonResponse(201, {}); },
  });
  assert.equal(seen.url, "https://x/y");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.credentials, "omit");
  assert.equal(seen.init.headers["PRIVATE-TOKEN"], "T");
  assert.equal(seen.init.headers["Content-Type"], "application/json");
  assert.equal(seen.init.body, '{"branch":"b"}');
});

test("a GET sends no body and no content type", async () => {
  let seen = null;
  await request("https://x/y", { fetchImpl: async (url, init) => { seen = init; return jsonResponse(200, {}); } });
  assert.equal(seen.method, "GET");
  assert.equal(seen.body, undefined);
  assert.equal(seen.headers["Content-Type"], undefined);
  assert.equal(seen.credentials, "omit");
});

test("a TypeError becomes the CORS result", async () => {
  const r = await request("https://x/y", { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  assert.deepEqual(r, { ok: false, status: 0, body: "Failed to fetch", json: null, cors: true });
});

test("explain wording", async () => {
  const cors = await request("https://x/y", { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  assert.equal(explain(cors), "The browser blocked this request (no response). The endpoint is unreachable or does not allow cross-origin requests from this site. Use the YAML fallback, or ask for CORS to be enabled.");
  const bad = await request("https://x/y", { fetchImpl: async () => jsonResponse(401, "401 Unauthorized", "text/plain") });
  assert.equal(explain(bad), "HTTP 401: 401 Unauthorized");
});

test("explain truncates a long body to 300 characters", async () => {
  const long = "x".repeat(500);
  const bad = await request("https://x/y", { fetchImpl: async () => jsonResponse(500, long, "text/plain") });
  assert.equal(explain(bad), "HTTP 500: " + "x".repeat(300));
});

// The published snapshot: schema.json, config.json and every source
// document.  A cached copy of one of those is a stale baseline, and a commit
// prepared from it undoes a rebuild the browser never saw.
test("noStore asks fetch for no-store, and nothing else does", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => { seen = init; return jsonResponse(200, {}); };
  await request("schema.json", { noStore: true, fetchImpl });
  assert.equal(seen.cache, "no-store");
  assert.equal(seen.method, "GET");
  // A snapshot read is same-origin, so it carries the site's own cookies:
  // an access-controlled Pages site would otherwise redirect it to the
  // sign-in page on another origin, which the browser reports as CORS.
  assert.equal(seen.credentials, "same-origin");
  // A POST to the repository API is not a snapshot read: no cache mode is
  // set at all, rather than one set to something else.
  await request("https://g/api/v4/x", { method: "POST", json: { a: 1 }, fetchImpl });
  assert.equal("cache" in seen, false);
  await request("https://x/y", { fetchImpl });
  assert.equal("cache" in seen, false);
});

// Credentials follow the origin: the site's own files carry its cookies, any
// other origin gets none.  The repository token and the model key travel in
// headers the caller sets, so nothing sensitive ever rides a cookie.
test("credentialsFor: relative paths are same-origin, other origins are omit", () => {
  assert.equal(credentialsFor("schema.json"), "same-origin");
  assert.equal(credentialsFor("source/cisco-asa.json"), "same-origin");
  assert.equal(credentialsFor("/data-maps/studio/config.json"), "same-origin");
  assert.equal(credentialsFor("https://gitlab.example/api/v4/projects"), "omit");
  assert.equal(credentialsFor("http://192.0.2.10:11434/v1/chat/completions"), "omit");
});

test("credentialsFor: an absolute URL on this site's origin is same-origin", () => {
  const origin = "https://pages.example.org";
  assert.equal(credentialsFor("https://pages.example.org/data-maps/studio/schema.json", origin), "same-origin");
  assert.equal(credentialsFor("HTTPS://PAGES.EXAMPLE.ORG/x", origin), "same-origin");
  assert.equal(credentialsFor("https://pages.example.org:8443/x", origin), "omit");
  assert.equal(credentialsFor("https://gitlab.example.org/api/v4", origin), "omit");
  assert.equal(credentialsFor("//pages.example.org/x", origin), "same-origin");
  assert.equal(credentialsFor("//gitlab.example.org/x", origin), "omit");
  // Under Node there is no location, so an absolute URL is never this site.
  assert.equal(credentialsFor("https://pages.example.org/x"), "omit");
});

test("request applies the origin rule and lets a caller pin the origin", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => { seen = init; return jsonResponse(200, {}); };
  await request("config.json", { fetchImpl });
  assert.equal(seen.credentials, "same-origin");
  await request("https://gitlab.example.org/api/v4/projects", { fetchImpl, origin: "https://pages.example.org" });
  assert.equal(seen.credentials, "omit");
  await request("https://pages.example.org/data-maps/studio/schema.json", { fetchImpl, origin: "https://pages.example.org" });
  assert.equal(seen.credentials, "same-origin");
});
