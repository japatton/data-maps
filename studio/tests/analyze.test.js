// The analyze view's pure helpers: what an input event has to write back
// into the sample box once the 200 KB cap has been reached, and the line
// that says which endpoint a run will use.  The panels themselves need a DOM
// and are exercised by hand against the dev server.

import test from "node:test";
import assert from "node:assert/strict";
import { clipEdit, endpointHost, endpointLabel } from "../views/analyze.js";

test("nothing is written back when the input was not clipped", () => {
  // The common case, and the one that mattered: reassigning the value on
  // every keystroke is what used to drag the caret to the end of the box.
  assert.equal(clipEdit("abc", "abc", 1), null);
  assert.equal(clipEdit("", "", 0), null);
  assert.equal(clipEdit(null, "", null), null);
});

test("a clipped input is written back with the caret where it was", () => {
  // Typing at position 2 of a sample already at the cap: the character goes
  // in, the tail falls off the end, and the caret stays where it was typing.
  assert.deepEqual(clipEdit("abcdef", "abcde", 3), { value: "abcde", caret: 3 });
  assert.deepEqual(clipEdit("abcdef", "abcde", 0), { value: "abcde", caret: 0 });
});

test("a caret inside the cut lands on the new end", () => {
  assert.deepEqual(clipEdit("abcdef", "abc", 6), { value: "abc", caret: 3 });
  // No caret to preserve (an input with no selection API): the end will do.
  assert.deepEqual(clipEdit("abcdef", "abc", null), { value: "abc", caret: 3 });
  assert.deepEqual(clipEdit("abcdef", "abc", -1), { value: "abc", caret: 3 });
});

// --- the endpoint line ----------------------------------------------------
//
// Shown next to Identify whether or not the site pins the endpoint: on a
// locked site Settings draws no analysis fields, so this is the only place
// the answer to "where is this going" appears.

test("the host is the authority, without the scheme or the path", () => {
  assert.equal(endpointHost("http://192.0.2.10:11434/v1"), "192.0.2.10:11434");
  assert.equal(endpointHost("https://api.openai.com/v1/chat/completions"), "api.openai.com");
  assert.equal(endpointHost("https://host:443"), "host:443");
  assert.equal(endpointHost("https://host?x=1"), "host");
  assert.equal(endpointHost("  https://host/v1  "), "host");
});

// An endpoint written with a credential in it must not put that credential
// on the page.
test("userinfo is dropped from the host", () => {
  assert.equal(endpointHost("https://user:secret@host:8443/v1"), "host:8443");
});

// The dev proxy is a path on this site; there is no other host to name.
// A schemeless value whose first segment could not be an authority - no dot
// and no port - is that same relative path written without the slash.
test("a relative endpoint reads as this site", () => {
  assert.equal(endpointHost("/llm/v1"), "this site");
  assert.equal(endpointHost("https://"), "this site");
  assert.equal(endpointHost("llm/v1"), "this site");
  assert.equal(endpointHost("proxy"), "this site");
  // ...but a bare host or host:port is still a host.
  assert.equal(endpointHost("es.example/v1"), "es.example");
  assert.equal(endpointHost("localhost:11434/v1"), "localhost:11434");
});

test("nothing configured is an empty host, not the word undefined", () => {
  assert.equal(endpointHost(""), "");
  assert.equal(endpointHost("   "), "");
  assert.equal(endpointHost(null), "");
  assert.equal(endpointHost(undefined), "");
});

test("the label names the model and where it runs", () => {
  assert.equal(
    endpointLabel({ model: "llama3.1:8b", api_url: "http://192.0.2.10:11434/v1" }),
    "Model: llama3.1:8b at 192.0.2.10:11434");
});

test("a half-configured endpoint says the half it has", () => {
  assert.equal(endpointLabel({ model: "m" }), "Model: m");
  assert.equal(endpointLabel({ api_url: "https://host/v1" }), "Endpoint: host");
  assert.equal(endpointLabel({}), "");
  assert.equal(endpointLabel(null), "");
  assert.equal(endpointLabel({ model: "  ", api_url: "" }), "");
});
