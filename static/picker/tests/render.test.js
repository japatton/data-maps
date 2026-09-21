import test from "node:test";
import assert from "node:assert/strict";
import { headerHtml, artifactHtml, downloadsHtml, esc } from "../render.js";

const FULL = { format: "snmp-trap", mechanism: "cribl-pipeline", artifact: null,
               has_cribl_pipeline: true, path: "asa/dev__snmp-trap",
               ingest: { translated: 3, partial: 1, manual: 1, total: 5 } };
const THIN = { format: "syslog-raw", mechanism: "elastic-integration",
               artifact: "Cisco ASA integration (cisco_asa)", has_cribl_pipeline: true,
               path: "asa/dev__syslog-raw", ingest: { translated: 1, partial: 0, manual: 0, total: 1 } };
const NONE = { format: "json", mechanism: "none", artifact: null, has_cribl_pipeline: false,
               path: "arkime/sessions__json", ingest: null };
const MISSING = { format: "api-pull", mechanism: "cribl-pipeline", artifact: null,
                  has_cribl_pipeline: false, path: "x/y__api-pull", ingest: null };
const SEL = (format) => ({ tech: { id: "asa", name: "Cisco <ASA>" },
                           dataset: { id: "dev", name: "Device admin" }, format });
const CRIBL = { id: "dm_asa_dev_snmp_trap", conf: { functions: [] } };
const ENV = { id: "dm_asa_dev_snmp_trap",
              pipeline: { description: "d", processors: [{ set: { field: "a", value: "b" } }] },
              coverage: { translated: 3, partial: 1, manual: 1, total: 5 },
              notes: ["regex_extract #2: iterations ignored"],
              manual_steps: [{ index: 4, function: "code", reason: "no equivalent",
                               description: "hand-written", original: { id: "code" } }],
              field_map: { _time: "@timestamp", _raw: "message" },
              requires: ["painless-regex"] };

test("esc escapes html", () => {
  assert.equal(esc('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
});

test("header names the selection and escapes it", () => {
  const html = headerHtml(SEL(FULL));
  assert.match(html, /Cisco &lt;ASA&gt;/);
  assert.match(html, /Device admin/);
  assert.match(html, /snmp-trap/);
  assert.match(html, /cribl-pipeline/);
});

test("downloads link to the three map exports", () => {
  const html = downloadsHtml("asa/dev__snmp-trap");
  for (const ext of ["json", "md", "csv"]) {
    assert.match(html, new RegExp('href="exports/map/asa/dev__snmp-trap\\.' + ext + '"'));
  }
});

test("cribl on, full block: pipeline json with copy and download", () => {
  const html = artifactHtml(SEL(FULL), { cribl: true, dest: "elastic" }, { cribl: CRIBL, ingest: ENV });
  assert.match(html, /dm_asa_dev_snmp_trap/);
  assert.match(html, /href="exports\/cribl\/asa\/dev__snmp-trap\.json"/);
  assert.match(html, /data-copy="cribl"/);
  assert.doesNotMatch(html, /Parsing happens downstream/);
});

test("cribl on, thin block: downstream note", () => {
  const html = artifactHtml(SEL(THIN), { cribl: true, dest: "elastic" }, { cribl: CRIBL, ingest: ENV });
  assert.match(html, /Parsing happens downstream in Cisco ASA integration \(cisco_asa\); this pipeline only identifies the event and tags event\.dataset\./);
});

test("cribl off: coverage badge, requires, manual steps, download hook", () => {
  const html = artifactHtml(SEL(FULL), { cribl: false, dest: "elastic" }, { cribl: CRIBL, ingest: ENV });
  assert.match(html, /3 of 5 steps translated, 1 partial, 1 manual/);
  assert.match(html, /painless-regex/);
  assert.match(html, /hand-written/);
  assert.match(html, /no equivalent/);
  assert.match(html, /iterations ignored/);
  assert.match(html, /data-download="ingest"/);
  assert.match(html, /data-copy="ingest"/);
  assert.match(html, /"processors"/);
});

test("cribl off, thin block: note first, no manual list", () => {
  const html = artifactHtml(SEL(THIN), { cribl: false, dest: "elastic" }, { cribl: CRIBL, ingest: Object.assign({}, ENV, { manual_steps: [], coverage: THIN.ingest, notes: [] }) });
  assert.match(html, /Parsing happens downstream/);
  assert.match(html, /1 of 1 steps translated/);
  assert.doesNotMatch(html, /Manual steps/);
});

// A block that has a pipeline but whose artifacts did not arrive is a failed
// fetch, not an unauthored block: saying "not authored" there would send the
// reader to a technology page that has nothing more to tell them.
test("authored pipeline whose artifacts failed to load says so", () => {
  const on = artifactHtml(SEL(FULL), { cribl: true, dest: "elastic" }, { cribl: null, ingest: null });
  assert.match(on, /The pipeline files could not be loaded from this site; try again\./);
  assert.doesNotMatch(on, /No pipeline has been authored/);
  const off = artifactHtml(SEL(FULL), { cribl: false, dest: "elastic" }, { cribl: CRIBL, ingest: null });
  assert.match(off, /The pipeline files could not be loaded from this site; try again\./);
  assert.doesNotMatch(off, /No pipeline has been authored/);
});

test("mechanism none and missing pipeline", () => {
  assert.match(artifactHtml(SEL(NONE), { cribl: true, dest: "elastic" }, { cribl: null, ingest: null }),
               /Cribl is not in this path for this feed\./);
  assert.match(artifactHtml(SEL(MISSING), { cribl: false, dest: "elastic" }, { cribl: null, ingest: null }),
               /No pipeline has been authored for this block yet\./);
  assert.match(artifactHtml(SEL(MISSING), { cribl: false, dest: "elastic" }, { cribl: null, ingest: null }),
               /href="tech\/asa\.html"/);
});
