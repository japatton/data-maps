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
_REGEX_LITERAL = re.compile(r"^/(.*)/([a-z]*)$", re.S)


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
        pair = c.get("pairDelim")
        body = {"field": src,
                "field_split": re.escape(pair) if pair else "\\s+",
                "value_split": c.get("kvDelim") or "=",
                "ignore_missing": True, "ignore_failure": True,
                "trim_value": "\"", "strip_brackets": True,
                "description": d}
        if c.get("dstField"):
            body["target_field"] = map_field(c["dstField"])
        notes.append("kv: values containing the pair delimiter (spaces in a "
                     "quoted CEF extension value) split differently from "
                     "Cribl's kvp extractor")
        return Result([{"kv": body}], notes)
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
                                   "ignore_missing": True, "description": d}})
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
