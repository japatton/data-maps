// Elasticsearch presence check for the Studio analysis workbench.
//
// Browser ES module: no dependencies, no DOM access at import time. The only
// request it makes is a read-only `_search` against the data stream named by
// the dataset's route; `fetchImpl` is injectable for the tests.

import { globalObject } from "./global.js";

/** ECS top-level namespaces, used to tell ECS-looking fields from vendor ones. */
const ECS_NAMESPACES = new Set([
  "event", "source", "destination", "host", "user", "network", "url", "http",
  "file", "process", "dns", "observer", "rule", "log", "related", "client",
  "server", "tls", "error", "threat", "cloud", "container", "orchestrator",
  "agent", "ecs", "data_stream", "message", "tags", "labels",
]);

function firstElasticStream(hops) {
  for (const hop of hops || []) {
    if (hop && hop.hop === "elastic" && hop.data_stream) return hop.data_stream;
  }
  return null;
}

/**
 * The data stream a dataset lands in: the first `elastic` hop on the direct
 * route, else on the guarded route, else null.
 */
export function dataStreamOf(dataset) {
  const route = (dataset && dataset.route) || {};
  return firstElasticStream(route.direct) || firstElasticStream(route.guarded) || null;
}

/**
 * Sample the most recent documents in a data stream.
 *
 * Returns {ok, docs, status, body, cors} — never throws for a network or HTTP
 * failure, so the panel can always render an explanation.
 */
export async function sampleDataStream({ url, apiKey, fetchImpl } = {}, dataStream, size = 5) {
  const doFetch = fetchImpl || ((...args) => globalObject.fetch(...args));
  const base = String(url || "").replace(/\/+$/, "");
  // The name comes out of an authored route hop, so it is encoded rather
  // than trusted: a "/" in it would otherwise reach a different endpoint
  // altogether, and a space would make a malformed URL.  Encoding leaves "*"
  // alone - it is legal in a path - so an authored name with a wildcard in it
  // still reaches Elasticsearch as the index pattern it looks like.
  const target = base + "/" + encodeURIComponent(dataStream) + "/_search";
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = "ApiKey " + apiKey;

  let res;
  try {
    res = await doFetch(target, {
      method: "POST",
      headers,
      credentials: "omit",
      body: JSON.stringify({
        size,
        sort: [{ "@timestamp": "desc" }],
        query: { match_all: {} },
      }),
    });
  } catch (err) {
    // A blocked cross-origin request surfaces as a TypeError with no status.
    if (err instanceof TypeError) {
      return { ok: false, docs: [], status: 0, body: err.message, cors: true };
    }
    throw err;
  }

  const body = await res.text();
  if (!res.ok) {
    return { ok: false, docs: [], status: res.status, body, cors: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return { ok: false, docs: [], status: res.status, body, cors: false };
  }
  const hits = (parsed && parsed.hits && parsed.hits.hits) || [];
  return {
    ok: true,
    docs: hits.map((hit) => hit._source),
    status: res.status,
    body,
    cors: false,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Dotted leaf paths of a document. Arrays of objects flatten each element
 * under the same path; an array of scalars is itself the leaf.
 */
export function flattenKeys(obj, prefix = "") {
  const keys = new Set();
  const walk = (value, path) => {
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        walk(child, path ? path + "." + key : key);
      }
      return;
    }
    if (Array.isArray(value)) {
      const objects = value.filter(isPlainObject);
      if (objects.length) {
        for (const item of objects) walk(item, path);
        return;
      }
      if (path) keys.add(path);
      return;
    }
    if (path) keys.add(path);
  };
  walk(obj, prefix);
  return keys;
}

function hasPath(keys, path) {
  if (keys.has(path)) return true;
  const nested = path + ".";
  for (const key of keys) if (key.startsWith(nested)) return true;
  return false;
}

/**
 * Which inventory ECS targets are populated in the sampled documents, and
 * which populated ECS-looking fields the inventory does not map to.
 *
 * `fields` is a format's field list; fields with no `ecs` target are skipped.
 */
export function fieldPresence(docs, fields) {
  const seen = new Set();
  for (const doc of docs || []) {
    for (const key of flattenKeys(doc)) seen.add(key);
  }

  const targets = [];
  const mapped = new Set();
  for (const field of fields || []) {
    if (!field || !field.ecs) continue;
    mapped.add(field.ecs);
    targets.push({ vendor: field.vendor, ecs: field.ecs, present: hasPath(seen, field.ecs) });
  }

  const extras = [];
  for (const key of seen) {
    if (mapped.has(key)) continue;
    if (!ECS_NAMESPACES.has(key.split(".")[0])) continue;
    extras.push(key);
  }
  extras.sort();

  return { targets, extras };
}
