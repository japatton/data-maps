import test from "node:test";
import assert from "node:assert/strict";
import { parseHash, formatHash } from "../hash.js";

test("full hash round-trips", () => {
  const s = { tech: "cisco-asa", dataset: "device-admin", format: "snmp-trap",
              cribl: true, dest: "elastic" };
  assert.equal(formatHash(s), "#cisco-asa/device-admin/snmp-trap?cribl=1&dest=elastic");
  assert.deepEqual(parseHash(formatHash(s)), s);
});

test("defaults when parts are missing", () => {
  assert.deepEqual(parseHash(""), { tech: null, dataset: null, format: null, cribl: true, dest: "elastic" });
  assert.deepEqual(parseHash("#"), { tech: null, dataset: null, format: null, cribl: true, dest: "elastic" });
  assert.deepEqual(parseHash("#cisco-asa"), { tech: "cisco-asa", dataset: null, format: null, cribl: true, dest: "elastic" });
  assert.deepEqual(parseHash("#a/b?cribl=0"), { tech: "a", dataset: "b", format: null, cribl: false, dest: "elastic" });
});

test("partial state formats without trailing slashes", () => {
  assert.equal(formatHash({ tech: "a", dataset: null, format: null, cribl: false, dest: "elastic" }),
               "#a?cribl=0&dest=elastic");
  assert.equal(formatHash({ tech: null, dataset: null, format: null, cribl: true, dest: "elastic" }),
               "#?cribl=1&dest=elastic");
});

test("segments are URI-encoded", () => {
  const s = { tech: "a b", dataset: "c/d", format: "e", cribl: true, dest: "elastic" };
  assert.equal(formatHash(s), "#a%20b/c%2Fd/e?cribl=1&dest=elastic");
  assert.deepEqual(parseHash(formatHash(s)), s);
});

test("unknown query keys are ignored and bad cribl values default to true", () => {
  assert.equal(parseHash("#a?x=1&cribl=maybe").cribl, true);
});
