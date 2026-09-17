// Deterministic YAML emitter for the authored catalog documents.
//
// The emitter reproduces the block style PyYAML writes (two-space indent,
// sequence items at the parent key's indent, folded prose) so that a
// Studio edit re-writes only the lines it actually changed. Its
// correctness criterion is semantic: for every document under data/,
// yaml.safe_load(emit(doc)) == doc. tests/test_studio_yaml.py checks that
// over every authored file; studio/tests/yaml-emit.test.js pins the
// quoting and folding rules case by case.

// String.prototype.trimEnd is ES2019; Studio's floor is ES2018.
function trimEnd(text) {
  return String(text).replace(/\s+$/, "");
}

const INDENT = "  ";
const WIDTH = 78;
const FOLD_ABOVE = 80;
// "=" is YAML 1.1's value key: PyYAML resolves a bare "=" to
// tag:yaml.org,2002:value, which SafeConstructor cannot construct.
const RESERVED = /^(y|yes|n|no|true|false|on|off|null|~|=)$/i;
const NUMERIC = [
  /^[-+]?(\.[0-9]+|[0-9][0-9_]*(\.[0-9_]*)?)([eE][-+]?[0-9]+)?$/,
  /^0x[0-9a-fA-F_]+$/, /^0o?[0-7_]+$/,
  /^[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+(\.[0-9_]*)?$/,
  /^[-+]?\.(inf|Inf|INF)$/, /^\.(nan|NaN|NAN)$/,
];
// PyYAML's timestamp resolver also accepts a single-digit month or day
// when a time follows ("2026-9-1 10:00:00"), so the guard is loose - but it
// stops at the end of the date: the resolver needs the date to be the whole
// scalar or to be followed by "T"/"t" or a space, so "1234-56-789abc" is a
// plain string and must not be quoted as if it were a timestamp.
const DATE = /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}([Tt]|\s|$)/;
// A number written out in full: no exponent, so PyYAML reads it as a number
// rather than as a string.
const PLAIN_DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const LEAD = "-?:,[]{}#&*!|>'\"%@` ";
// A plain scalar in flow context also ends at "?".
const FLOW_UNSAFE = ",?[]{}";
// Characters that cannot appear raw in any scalar: the ASCII and C1
// control ranges other than tab (\x09) and newline (\x0a), which the
// string emitter handles explicitly, plus the Unicode line and
// paragraph separators - PyYAML reads U+0085, U+2028 and U+2029 as line
// breaks in plain, single-quoted and double-quoted scalars alike.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/;
// JSON.stringify escapes \x00-\x1f but leaves these raw, so the
// double-quoted form escapes them itself.
const ESCAPE_RAW = /[\x7f-\x9f\u2028\u2029]/g;

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A string that cannot survive as a plain or single-quoted scalar (it
// carries a tab, a newline or a control character) is written with
// double quotes and JSON escapes, which YAML reads back identically.
function needsEscapes(s) {
  return s.includes("\n") || s.includes("\t") || CONTROL.test(s);
}

// JSON escaping plus the characters JSON leaves raw but YAML reads as a
// line break or a non-printable: DEL, the C1 range (NEL included) and
// U+2028 / U+2029.
function doubleQuote(s) {
  return JSON.stringify(s).replace(ESCAPE_RAW, (ch) =>
    "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

function plainSafe(s, flow) {
  if (s === "") return false;
  if (s !== s.trim()) return false;
  if (LEAD.includes(s[0])) return false;
  if (s.includes(": ") || s.includes(" #") || s.endsWith(":")) return false;
  // An apostrophe is legal mid-plain-scalar, but quoting it keeps the
  // emitted form unambiguous for a reader (and for the tests).
  if (s.includes("'")) return false;
  if (needsEscapes(s)) return false;
  if (RESERVED.test(s)) return false;
  for (const pattern of NUMERIC) if (pattern.test(s)) return false;
  if (DATE.test(s)) return false;
  if (flow) {
    for (const ch of FLOW_UNSAFE) if (s.includes(ch)) return false;
  }
  return true;
}

// The full decimal form of a number JavaScript stringifies with an exponent.
// The locale is pinned: an unknown or non-Latin default locale would answer
// with grouping separators or non-ASCII digits, and a host with no Intl
// ignores the options altogether - the result is checked rather than trusted.
// A denormal so small that 20 fraction digits round it to zero cannot be
// written this way at all, and is refused rather than silently emitted as 0.
function decimalText(value) {
  const text = value.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: 20,
  });
  if (!PLAIN_DECIMAL.test(text) || Number(text) !== value) {
    throw new Error("cannot emit number without an exponent " + String(value));
  }
  return text;
}

export function quoteScalar(value, flow = false) {
  if (typeof value === "string") {
    if (needsEscapes(value)) return doubleQuote(value);
    return plainSafe(value, flow)
      ? value : "'" + value.replace(/'/g, "''") + "'";
  }
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("cannot emit non-finite number " + String(value));
    }
    // JSON cannot distinguish 2.0 from 2, so an integral float emits as
    // an integer; the round-trip test is the arbiter and the data files
    // carry no numbers at all.
    const text = String(value);
    // 1e21 and 1e-7 stringify with an exponent, and PyYAML's float resolver
    // wants a "." and a signed exponent, so "1e+21" would load back as the
    // string "1e+21".  Writing the decimal out in full keeps it a number.
    return text.indexOf("e") === -1 && text.indexOf("E") === -1
      ? text : decimalText(value);
  }
  throw new Error("unsupported scalar " + typeof value);
}

// Split on single spaces only: a run of two or more spaces is carried
// inside a segment so folding never eats it.
function segments(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === " " && text[i - 1] !== " " && text[i + 1] !== " ") {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

// Greedy fill to WIDTH columns (indent included). Returns the finished
// lines, or null when a line would start or end with whitespace - such
// text cannot be folded without changing its value.
function wrap(text, indent) {
  const parts = segments(text);
  const lines = [];
  let current = null;
  for (const part of parts) {
    if (part === "") return null;
    if (current === null) current = part;
    else if (indent.length + current.length + 1 + part.length <= WIDTH) {
      current += " " + part;
    } else {
      lines.push(indent + current);
      current = part;
    }
  }
  if (current === null) return null;
  lines.push(indent + current);
  for (const line of lines) {
    const body = line.slice(indent.length);
    if (body !== body.trim()) return null;
  }
  return lines;
}

// Block scalar for a string carrying newlines: literal when the breaks
// are interior, folded when the only break is a trailing run. Returns
// null to ask for double-quoted output instead.
function blockScalar(s, indent) {
  if (s.includes("\t") || CONTROL.test(s)) return null;
  const trailing = /\n*$/.exec(s)[0].length;
  const core = s.slice(0, s.length - trailing);
  if (core === "") return null;
  const bodyLines = core.split("\n");
  for (const line of bodyLines) if (line !== trimEnd(line)) return null;
  const chomp = trailing === 0 ? "-" : trailing === 1 ? "" : "+";
  let style;
  let lines;
  if (core.includes("\n")) {
    style = "|";
    for (const line of bodyLines) if (line.startsWith(" ")) return null;
    lines = bodyLines.map((line) => (line === "" ? "" : indent + line));
  } else {
    style = ">";
    lines = wrap(core, indent);
    if (lines === null) return null;
  }
  for (let i = 1; i < trailing; i++) lines.push("");
  return { header: style + chomp, lines: lines };
}

// The block form of a string, or null when it belongs on the key's line.
function stringBlock(s, indent) {
  if (s.includes("\n")) return blockScalar(s, indent);
  if (s.length <= FOLD_ABOVE) return null;
  if (s.includes("\t") || CONTROL.test(s) || s !== s.trim()) return null;
  const lines = wrap(s, indent);
  return lines === null ? null : { header: ">-", lines: lines };
}

function flowMapping(item) {
  if (!isMapping(item)) {
    throw new Error("flow rows must be mappings, got " + typeof item);
  }
  const pairs = [];
  for (const key of Object.keys(item)) {
    const value = item[key];
    if (Array.isArray(value) || isMapping(value)) {
      throw new Error("flow row value must be a scalar: " + key);
    }
    pairs.push(quoteScalar(key, true) + ": " + quoteScalar(value, true));
  }
  return "{" + pairs.join(", ") + "}";
}

function emitScalar(prefix, value, indent, lines) {
  if (typeof value === "string") {
    const block = stringBlock(value, indent + INDENT);
    if (block !== null) {
      lines.push(indent + prefix + block.header);
      for (const line of block.lines) lines.push(line);
      return;
    }
  }
  lines.push(indent + prefix + quoteScalar(value));
}

function emitEntry(prefix, value, indent, lines) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(indent + prefix + "[]");
      return;
    }
    lines.push(trimEnd(indent + prefix));
    emitSequence(value, indent, lines, false);
    return;
  }
  if (isMapping(value)) {
    if (Object.keys(value).length === 0) {
      lines.push(indent + prefix + "{}");
      return;
    }
    lines.push(trimEnd(indent + prefix));
    emitMapping(value, indent + INDENT, lines);
    return;
  }
  emitScalar(prefix, value, indent, lines);
}

function emitMapping(map, indent, lines) {
  for (const key of Object.keys(map)) {
    emitEntry(quoteScalar(key) + ": ", map[key], indent, lines);
  }
}

// Render an item into its own line buffer indented one unit in, then
// overwrite that unit with "- " so the first key lands on the dash line.
function withDash(sub, indent, lines) {
  sub[0] = indent + "- " + sub[0].slice(indent.length + INDENT.length);
  for (const line of sub) lines.push(line);
}

function emitItem(item, indent, lines) {
  const inner = indent + INDENT;
  if (Array.isArray(item)) {
    if (item.length === 0) {
      lines.push(indent + "- []");
      return;
    }
    const sub = [];
    emitSequence(item, inner, sub, false);
    withDash(sub, indent, lines);
    return;
  }
  if (isMapping(item)) {
    if (Object.keys(item).length === 0) {
      lines.push(indent + "- {}");
      return;
    }
    const sub = [];
    emitMapping(item, inner, sub);
    withDash(sub, indent, lines);
    return;
  }
  if (typeof item === "string") {
    const block = stringBlock(item, inner);
    if (block !== null) {
      lines.push(indent + "- " + block.header);
      for (const line of block.lines) lines.push(line);
      return;
    }
  }
  lines.push(indent + "- " + quoteScalar(item));
}

function emitSequence(seq, indent, lines, flow) {
  for (const item of seq) {
    if (flow) lines.push(indent + "- " + flowMapping(item));
    else emitItem(item, indent, lines);
  }
}

export function emit(doc, options = {}) {
  if (!isMapping(doc)) throw new Error("emit expects a mapping document");
  const flowRows = options.flowRows || [];
  const lines = [];
  for (const key of Object.keys(doc)) {
    const value = doc[key];
    if (flowRows.includes(key) && Array.isArray(value) && value.length > 0) {
      lines.push(quoteScalar(key) + ":");
      emitSequence(value, "", lines, true);
    } else {
      emitEntry(quoteScalar(key) + ": ", value, "", lines);
    }
  }
  if (lines.length === 0) return "{}\n";
  return lines.join("\n") + "\n";
}

export function emitTechnology(doc) {
  return emit(doc);
}

export function emitCatalog(doc) {
  return emit(doc, { flowRows: ["technologies"] });
}
