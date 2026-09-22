import test from "node:test";
import assert from "node:assert/strict";
import { resolve, select, options, current } from "../state.js";

const INDEX = { destinations: ["elastic"], technologies: [
  { id: "asa", name: "Cisco ASA", category: "network-security", datasets: [
    { id: "traffic", name: "Traffic", formats: [
      { format: "syslog-raw", recommended: false },
      { format: "syslog-cef", recommended: true } ] },
    { id: "vpn", name: "VPN", formats: [ { format: "syslog-raw", recommended: true } ] } ] },
  { id: "win", name: "Windows", category: "endpoint", datasets: [
    { id: "security", name: "Security", formats: [ { format: "windows-event", recommended: true } ] } ] } ] };

const EMPTY = { tech: null, dataset: null, format: null, cribl: true, dest: "elastic" };

test("resolve keeps a valid state and fills the recommended format", () => {
  const r = resolve(INDEX, { tech: "asa", dataset: "traffic", format: null, cribl: true, dest: "elastic" });
  assert.equal(r.notice, null);
  assert.equal(r.state.format, "syslog-cef");
});

test("resolve clears from the first invalid level", () => {
  const r = resolve(INDEX, { tech: "asa", dataset: "nope", format: "syslog-cef", cribl: false, dest: "elastic" });
  assert.deepEqual(r.state, { tech: "asa", dataset: null, format: null, cribl: false, dest: "elastic" });
  assert.match(r.notice, /nope/);
  const t = resolve(INDEX, { tech: "zzz", dataset: "x", format: "y", cribl: true, dest: "elastic" });
  assert.deepEqual(t.state, EMPTY);
});

test("resolve rejects an unknown destination", () => {
  const r = resolve(INDEX, { tech: null, dataset: null, format: null, cribl: true, dest: "splunk" });
  assert.equal(r.state.dest, "elastic");
  assert.match(r.notice, /splunk/);
});

test("select cascades", () => {
  let s = select(INDEX, EMPTY, "tech", "asa");
  assert.deepEqual(s, { tech: "asa", dataset: null, format: null, cribl: true, dest: "elastic" });
  s = select(INDEX, s, "dataset", "traffic");
  assert.equal(s.format, "syslog-cef");
  s = select(INDEX, s, "format", "syslog-raw");
  assert.equal(s.format, "syslog-raw");
  s = select(INDEX, s, "cribl", false);
  assert.equal(s.cribl, false);
  s = select(INDEX, s, "tech", "win");
  assert.deepEqual(s, { tech: "win", dataset: null, format: null, cribl: false, dest: "elastic" });
});

test("options list each level for the current state", () => {
  const o = options(INDEX, select(INDEX, EMPTY, "tech", "asa"));
  assert.deepEqual(o.techs.map((t) => t.id), ["asa", "win"]);
  assert.deepEqual(o.datasets.map((d) => d.id), ["traffic", "vpn"]);
  assert.deepEqual(o.formats, []);
  const o2 = options(INDEX, select(INDEX, select(INDEX, EMPTY, "tech", "asa"), "dataset", "traffic"));
  assert.deepEqual(o2.formats.map((f) => f.format), ["syslog-raw", "syslog-cef"]);
});

test("current returns the selected objects only when complete", () => {
  assert.equal(current(INDEX, EMPTY), null);
  const s = select(INDEX, select(INDEX, EMPTY, "tech", "asa"), "dataset", "vpn");
  const c = current(INDEX, s);
  assert.equal(c.tech.name, "Cisco ASA");
  assert.equal(c.dataset.id, "vpn");
  assert.equal(c.format.format, "syslog-raw");
});
