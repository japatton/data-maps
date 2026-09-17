// A thin wrapper over fetch that never throws for a network failure: every
// call returns {ok, status, body, json, cors} so the UI can render the
// status and the body text, and a distinct message for the CORS case.

import { globalObject } from "./global.js";

const CORS_MESSAGE =
  "The browser blocked this request (no response). The endpoint is unreachable " +
  "or does not allow cross-origin requests from this site. Use the YAML fallback, " +
  "or ask for CORS to be enabled.";

// Which credentials mode a URL gets.  The published snapshot (schema.json,
// config.json, source/*.json) is fetched from the site's own origin and must
// carry the site's cookies: on a GitLab Pages site with access control, a
// request without the Pages session cookie is redirected to the GitLab
// sign-in on another origin, and the browser reports that redirect as a
// CORS failure - Studio then dies at boot.  Every other origin (the
// repository API, the model, Elasticsearch) still gets nothing: a token or
// key travels in a header the caller sets, never in a cookie.
const ABSOLUTE = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)/i;

export function credentialsFor(url, origin = currentOrigin()) {
  const text = String(url || "");
  const match = ABSOLUTE.exec(text);
  if (!match) {
    // A scheme-relative URL (//host/path) is another origin unless the host
    // matches; everything else is a path on this site.
    if (text.startsWith("//")) {
      const host = text.slice(2).split(/[/?#]/)[0];
      return origin && origin.split("//")[1] === host.toLowerCase()
        ? "same-origin" : "omit";
    }
    return "same-origin";
  }
  const requested = (match[1] + "//" + match[2]).toLowerCase();
  return origin && requested === origin.toLowerCase() ? "same-origin" : "omit";
}

function currentOrigin() {
  const location = globalObject.location;
  return location && typeof location.origin === "string" ? location.origin : "";
}

export async function request(url, {
  method = "GET",
  headers = {},
  body = undefined,
  json = undefined,
  noStore = false,
  fetchImpl = globalObject.fetch,
  origin = undefined,
} = {}) {
  const sent = { ...headers };
  let payload = body;
  if (json !== undefined) {
    sent["Content-Type"] = "application/json";
    payload = JSON.stringify(json);
  }
  const credentials = origin === undefined
    ? credentialsFor(url) : credentialsFor(url, origin);
  const init = { method, headers: sent, credentials };
  if (payload !== undefined) init.body = payload;
  // The published snapshot asks for this: a cached schema.json or source
  // document is a stale baseline, and a commit made from one silently
  // reverts whatever the last rebuild published.
  if (noStore) init.cache = "no-store";

  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (err) {
    // A browser reports a blocked or unreachable request as a TypeError with
    // no further detail; anything else is a bug and stays thrown.
    if (err instanceof TypeError) {
      return { ok: false, status: 0, body: err.message, json: null, cors: true };
    }
    throw err;
  }

  const text = await response.text();
  return {
    ok: Boolean(response.ok),
    status: response.status,
    body: text,
    json: parseJson(text),
    cors: false,
  };
}

export function explain(result) {
  if (result.cors) return CORS_MESSAGE;
  return `HTTP ${result.status}: ${String(result.body || "").slice(0, 300)}`;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}
