"""One translator per Cribl function id, producing ingest processors.

Each translator returns a Result or raises Untranslatable.  A function's
own `filter` becomes an `if` on every processor it emits; when the filter
cannot be translated the whole step is manual, because running a step
unconditionally that Cribl ran conditionally would be a different
pipeline.
"""
import re

from datamaps.ingest import expr
from datamaps.ingest.expr import Untranslatable, map_field

MANUAL_FUNCTIONS = ("code", "distinct", "unroll", "xml_unroll", "flatten",
                    "rollup_metrics")
DATE_FORMATS = ["ISO8601", "UNIX", "UNIX_MS"]
KVP_NOTE = ("kvp: pairs are scanned key=value left to right as Cribl does; a "
            "quoted value keeps its spaces, an unquoted one ends at the next "
            "pair delimiter")
_REGEX_LITERAL = re.compile(r"^/(.*)/([a-z]*)$", re.S)
# Delimiters that carry no regex meaning inside or outside a character class.
_KV_SAFE = re.compile(r"^[A-Za-z0-9_=:]$")


class Result(object):
    def __init__(self, processors, notes=None, manual=None, regex=False):
        self.processors = processors
        self.notes = list(notes or [])
        self.manual = manual
        self.regex = regex


def condition_for(fn):
    filt = fn.get("filter", "true")
    if filt in (None, "", "true"):
        return None
    return expr.translate_condition(filt)


def _regex_parts(text, what):
    """(pattern, flags) from a Cribl "/pattern/flags" string."""
    if not isinstance(text, str):
        raise Untranslatable("%s: regex must be a string" % what)
    m = _REGEX_LITERAL.match(text)
    if not m:
        raise Untranslatable("%s: regex %r is not a /pattern/flags literal"
                             % (what, text[:40]))
    return m.group(1), m.group(2)


def _java_regex(pattern, flags):
    """Pattern with JS flags folded into Java inline flags; g is implicit."""
    inline = "".join(f for f in flags if f in "ims")
    bad = [f for f in flags if f not in "gims"]
    if bad:
        raise Untranslatable("regex flag %r has no Java equivalent" % bad[0])
    return ("(?%s)" % inline if inline else "") + pattern


def _grok_pattern(pattern, flags):
    # grok reads %{...} as a pattern reference; a literal one must be escaped.
    return _java_regex(pattern.replace("%{", "\\%\\{"), flags)


def _kv_regex(ch, what):
    """One delimiter character, safe to drop into a Painless regex.

    Elasticsearch reads both kv delimiters as regexes, so a bare `|` would
    match everywhere.  re.escape is not usable: it escapes `:` on Python 3.6
    but not on 3.7+, and the delimiter has to render identically on both.
    """
    if not isinstance(ch, str) or len(ch) != 1:
        raise Untranslatable("%s %r must be one character" % (what, ch))
    return ch if _KV_SAFE.match(ch) else "\\" + ch


def _kvp_script(c, src):
    """Painless that scans key=value pairs the way Cribl's kvp extractor does.

    The kv processor cannot stand in here: it throws as soon as a single
    field_split token lacks the kv delimiter, and an unquoted CEF value with
    spaces (`msg=User logged in cs1=x`) produces exactly such a token, so
    ignore_failure would silently drop the whole extraction.  This scan takes
    the pairs it finds and leaves the rest of the text alone.
    """
    pair = c.get("pairDelim")
    if not pair or (isinstance(pair, str) and pair.isspace()):
        pair_class = "\\s"
    else:
        pair_class = _kv_regex(pair, "kvp pairDelim")
    kv = _kv_regex(c.get("kvDelim") or "=", "kvp kvDelim")
    read = expr.read_path(src)
    pattern = "/([^%s%s]+?)%s(?:\"([^\"]*)\"|([^%s]*))/" % (pair_class, kv, kv,
                                                            pair_class)
    guard = ""
    assign = "ctx[k] = v;"
    if c.get("dstField"):
        guards, target = expr.write_target(map_field(c["dstField"]))
        guards = list(guards) + ["if (%s == null) { %s = [:]; }"
                                 % (target, target)]
        guard = " ".join(guards) + " "
        assign = "%s[k] = v;" % target
    return ("if (%s != null) { def m = %s.matcher(String.valueOf(%s)); "
            "%swhile (m.find()) { def k = m.group(1); "
            "def v = m.group(2) != null ? m.group(2) : m.group(3); %s } }"
            % (read, pattern, read, guard, assign))


def _serde(c, d):
    if c.get("mode") != "extract":
        raise Untranslatable("serde mode %r (only extract is supported)" % c.get("mode"))
    src = map_field(c.get("srcField") or "_raw")
    kind = c.get("type")
    notes = []
    if kind == "json":
        body = {"field": src, "ignore_failure": True, "description": d}
        if c.get("dstField"):
            body["target_field"] = map_field(c["dstField"])
        else:
            body["add_to_root"] = True
        return Result([{"json": body}])
    if kind == "kvp":
        notes.append(KVP_NOTE)
        return Result([{"script": {"lang": "painless",
                                   "source": _kvp_script(c, src),
                                   "description": d}}], notes, regex=True)
    if kind in ("csv", "delim"):
        fields = c.get("fields")
        if not fields:
            raise Untranslatable("serde %s without a fields list" % kind)
        sep = c.get("delimChar") or c.get("delimiter") or ","
        if kind == "csv":
            sep = ","
        if len(sep) != 1:
            raise Untranslatable("csv separator %r must be one character" % sep)
        body = {"field": src, "target_fields": [map_field(f) for f in fields],
                "separator": sep, "quote": "\"", "trim": True,
                "ignore_missing": True, "ignore_failure": True,
                "description": d}
        return Result([{"csv": body}])
    raise Untranslatable("serde type %r" % kind)


def _regex_extract(c, d):
    src = map_field(c.get("source") or "_raw")
    regexes = [c.get("regex")] + [r.get("regex") for r in c.get("regexList") or []]
    procs = []
    notes = []
    for i, text in enumerate(regexes):
        pattern, flags = _regex_parts(text, "regex_extract #%d" % i)
        procs.append({"grok": {"field": src,
                               "patterns": [_grok_pattern(pattern, flags)],
                               "ignore_missing": True, "ignore_failure": True,
                               "description": d}})
    if c.get("iterations") not in (None, 1):
        notes.append("regex_extract: iterations=%s ignored; each named group "
                     "extracts once" % c["iterations"])
    return Result(procs, notes, regex=True)


def _rename(c, d):
    pairs = c.get("rename")
    if not isinstance(pairs, list) or not pairs:
        raise Untranslatable("rename conf has no rename list")
    procs = []
    for pair in pairs:
        if not isinstance(pair, dict) or "currentName" not in pair or "newName" not in pair:
            raise Untranslatable("rename pair %r is malformed" % (pair,))
        if "*" in pair["currentName"] or "*" in pair["newName"]:
            raise Untranslatable("wildcard rename")
        procs.append({"rename": {"field": map_field(pair["currentName"]),
                                 "target_field": map_field(pair["newName"]),
                                 "ignore_missing": True, "ignore_failure": True,
                                 "description": d}})
    return Result(procs)


def _drop(c, d):
    return Result([{"drop": {"description": d}}])


def _mask(c, d):
    fields = c.get("fields") or []
    rules = c.get("rules") or []
    if not fields or not rules:
        raise Untranslatable("mask without fields or rules")
    procs = []
    notes = []
    regex = False
    for rule in rules:
        pattern, flags = _regex_parts(rule.get("matchRegex"), "mask")
        repl = expr.translate_value(rule.get("replaceExpr", ""))
        if not repl.is_constant or not isinstance(repl.constant, str):
            raise Untranslatable("mask replaceExpr is not a string literal")
        if "g" not in flags:
            notes.append("mask: gsub replaces every match; the Cribl rule "
                         "had no g flag and replaced the first only")
        for field in fields:
            procs.append({"gsub": {"field": map_field(field),
                                   "pattern": _java_regex(pattern, flags),
                                   "replacement": repl.constant,
                                   "ignore_missing": True,
                                   "ignore_failure": True, "description": d}})
        regex = True
    return Result(procs, notes, regex=regex)


def _auto_timestamp(c, d):
    src = map_field(c.get("srcField") or "_raw")
    dst = map_field(c.get("dstField") or "_time")
    return Result([{"date": {"field": src, "target_field": dst,
                             "formats": list(DATE_FORMATS),
                             "ignore_failure": True, "description": d}}],
                  ["auto_timestamp: Cribl auto-detects the format; the date "
                   "processor tries %s" % ", ".join(DATE_FORMATS)])


def _numerify(c, d):
    fields = c.get("fields")
    if not fields:
        raise Untranslatable("numerify over all numeric-looking fields has no "
                             "processor equivalent")
    return Result([{"convert": {"field": map_field(f), "type": "auto",
                                "ignore_missing": True, "ignore_failure": True,
                                "description": d}} for f in fields])


_TRANSLATORS = {"serde": _serde, "regex_extract": _regex_extract,
                "rename": _rename, "drop": _drop, "mask": _mask,
                "auto_timestamp": _auto_timestamp, "numerify": _numerify}


def _apply_condition(result, cond):
    if cond is None:
        return result
    for proc in result.processors:
        body = proc[list(proc)[0]]
        body["if"] = cond.source
    result.regex = result.regex or cond.regex
    return result


def translate_function(fn, description):
    fid = fn.get("id")
    if fid in MANUAL_FUNCTIONS:
        raise Untranslatable("%s has no ingest-processor equivalent" % fid)
    if fid == "eval":
        from datamaps.ingest import evaluate
        return _apply_condition(evaluate.translate_eval(fn.get("conf") or {},
                                                        description),
                                condition_for(fn))
    if fid not in _TRANSLATORS:
        raise Untranslatable("function %r is not supported" % fid)
    cond = condition_for(fn)
    result = _TRANSLATORS[fid](fn.get("conf") or {}, description)
    return _apply_condition(result, cond)
