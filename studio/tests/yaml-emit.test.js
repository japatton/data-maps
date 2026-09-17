import test from "node:test";
import assert from "node:assert/strict";
import { emit, emitCatalog, quoteScalar } from "../lib/yaml-emit.js";

test("nested mapping and list layout matches PyYAML block style", () => {
  const doc = { id: "x", datasets: [{ id: "a", fields: [] , route: { direct: [{ hop: "cribl" }] } }] };
  assert.equal(emit(doc),
`id: x
datasets:
- id: a
  fields: []
  route:
    direct:
    - hop: cribl
`);
});

// JSON (and JS) cannot tell 2.0 from 2, so an integral float emits as "2".
test("scalars: booleans, null, numbers", () => {
  assert.equal(emit({ a: true, b: null, c: 3, d: 1.5, e: 2.0 }),
    "a: true\nb: null\nc: 3\nd: 1.5\ne: 2\n");
});

test("plain strings that look like other types are quoted", () => {
  for (const v of ["yes", "No", "on", "null", "~", "12", "1e3", "0x1f", "1:30", "2026-09-01", ".inf", ""]) {
    assert.equal(quoteScalar(v), "'" + v + "'", v);
  }
  assert.equal(quoteScalar("it's"), "'it''s'");
  assert.equal(quoteScalar("a: b"), "'a: b'");
  assert.equal(quoteScalar("x #y"), "'x #y'");
  assert.equal(quoteScalar("- x"), "'- x'");
  assert.equal(quoteScalar("ends:"), "'ends:'");
  assert.equal(quoteScalar(" lead"), "' lead'");
  assert.equal(quoteScalar("{inbound | outbound}"), "'{inbound | outbound}'");
  assert.equal(quoteScalar("plain text"), "plain text");
  assert.equal(quoteScalar("logs-cisco_asa.log"), "logs-cisco_asa.log");
});

test("long single-line string folds at 78 columns", () => {
  const words = [];
  for (let i = 0; i < 40; i++) words.push("word" + i);
  const text = words.join(" ");
  const out = emit({ notes: text });
  assert.ok(out.startsWith("notes: >-\n  word0 "));
  for (const line of out.split("\n").slice(1)) {
    assert.ok(line.length <= 80, line);
    assert.ok(!line.startsWith("   "), line);
  }
});

test("trailing newline uses folded style with keep semantics", () => {
  const out = emit({ description: "Flow lifecycle records for every session.\n" });
  assert.equal(out, "description: >\n  Flow lifecycle records for every session.\n");
});

test("interior newlines use literal style with chomping", () => {
  assert.equal(emit({ a: "line1\nline2" }), "a: |-\n  line1\n  line2\n");
  assert.equal(emit({ a: "line1\nline2\n" }), "a: |\n  line1\n  line2\n");
  assert.equal(emit({ a: "line1\nline2\n\n" }), "a: |+\n  line1\n  line2\n\n");
});

test("block candidates with leading-space lines or tabs fall back to JSON quoting", () => {
  assert.equal(emit({ a: "x\n  y" }), 'a: "x\\n  y"\n');
  assert.equal(emit({ a: "tab\there" }), 'a: "tab\\there"\n');
});

test("catalog rows emit as flow mappings", () => {
  const out = emitCatalog({ technologies: [
    { id: "cisco-asa", name: "Cisco ASA", vendor: "Cisco", category: "network-security", status: "in-progress", priority: "core" },
    { id: "zeek", name: "Zeek / Corelight", vendor: "Zeek Project", category: "network-security", status: "in-progress", priority: "core" },
  ]});
  assert.equal(out,
`technologies:
- {id: cisco-asa, name: Cisco ASA, vendor: Cisco, category: network-security, status: in-progress, priority: core}
- {id: zeek, name: Zeek / Corelight, vendor: Zeek Project, category: network-security, status: in-progress, priority: core}
`);
});

test("flow context quotes commas and brackets", () => {
  const out = emitCatalog({ technologies: [{ id: "a", name: "X, Y [Z]" }] });
  assert.equal(out, "technologies:\n- {id: a, name: 'X, Y [Z]'}\n");
});

test("empty containers inline", () => {
  assert.equal(emit({ a: [], b: {} }), "a: []\nb: {}\n");
});

// A plain scalar in flow context ends at "?" as well as at ",[]{}", so an
// unquoted "What? Yes" made catalog.yml unparseable.
test("flow context quotes a question mark", () => {
  assert.equal(emitCatalog({ technologies: [{ id: "a", name: "What? Yes" }] }),
    "technologies:\n- {id: a, name: 'What? Yes'}\n");
  assert.equal(quoteScalar("What? Yes", true), "'What? Yes'");
  assert.equal(quoteScalar("What? Yes"), "What? Yes");
});

// YAML 1.1 resolves a bare "=" to tag:yaml.org,2002:value, which
// SafeConstructor refuses to construct.
test("the value key '=' is quoted", () => {
  assert.equal(emit({ a: "=" }), "a: '='\n");
  assert.equal(quoteScalar("="), "'='");
});

// PyYAML reads U+0085, U+2028 and U+2029 as line breaks inside every
// scalar style, and JSON.stringify leaves them raw.
test("unicode line separators are escaped in the double-quoted form", () => {
  assert.equal(emit({ a: "x\u2028y" }), 'a: "x\\u2028y"\n');
  assert.equal(emit({ a: "x\u2029y" }), 'a: "x\\u2029y"\n');
  assert.equal(emit({ a: "x\u0085y" }), 'a: "x\\u0085y"\n');
  assert.equal(emit({ a: "x\u007fy" }), 'a: "x\\u007fy"\n');
  assert.equal(emitCatalog({ technologies: [{ id: "a", name: "x\u2028y" }] }),
    'technologies:\n- {id: a, name: "x\\u2028y"}\n');
});

// PyYAML's timestamp resolver accepts a single-digit month or day when a
// time follows, so the date guard cannot require zero padding.
test("YAML 1.1 timestamps without zero padding are quoted", () => {
  assert.equal(emit({ a: "2026-9-1 10:00:00" }), "a: '2026-9-1 10:00:00'\n");
  assert.equal(quoteScalar("2026-9-1"), "'2026-9-1'");
});

// String(1e21) is "1e+21", which PyYAML's float resolver rejects (it wants a
// "." and a signed exponent) and reads back as a string. The decimal is
// therefore written out in full.
test("numbers that stringify with an exponent are written out in full", () => {
  const out = emit({ a: 1e21 });
  assert.equal(out.includes("e"), false);
  assert.match(out, /^a: 1000000000000000000000$/m);
  assert.equal(typeof JSON.parse(out.slice(3)), "number");
  assert.equal(quoteScalar(1e21), "1000000000000000000000");
  assert.equal(quoteScalar(-1.5e21), "-1500000000000000000000");
  assert.equal(quoteScalar(1e-7), "0.0000001");
  // Ordinary numbers are untouched.
  assert.equal(quoteScalar(3), "3");
  assert.equal(quoteScalar(1.5), "1.5");
  // A denormal 20 fraction digits cannot hold is refused, not rounded to 0.
  assert.throws(() => quoteScalar(5e-324), /without an exponent/);
});

// The timestamp guard stops at the end of the date: "1234-56-789abc" is a
// plain string, and quoting it would be a needless diff.
test("a date-like prefix only quotes when the date ends there", () => {
  assert.equal(quoteScalar("1234-56-789abc"), "1234-56-789abc");
  assert.equal(quoteScalar("2026-09-011"), "2026-09-011");
  assert.equal(quoteScalar("2026-09-01"), "'2026-09-01'");
  assert.equal(quoteScalar("2026-09-01T10:00:00Z"), "'2026-09-01T10:00:00Z'");
  assert.equal(quoteScalar("2026-9-1 10:00:00"), "'2026-9-1 10:00:00'");
});

// A document whose last value is a keep-chomped block legitimately ends
// with two newlines; the round-trip test must not forbid that.
test("a trailing keep-chomped block leaves the document ending in a blank line", () => {
  const out = emit({ a: "x", b: "line1\nline2\n\n" });
  assert.equal(out, "a: x\nb: |+\n  line1\n  line2\n\n");
  assert.ok(out.endsWith("\n\n"));
});
