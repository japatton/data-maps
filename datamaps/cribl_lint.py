"""Semantic lint for the committed Cribl pipelines.

HTTP 200 from the Cribl API only proves the schema and every function conf
are well formed.  It does NOT prove the pipeline means anything: one agent
shipped `{"name":"name","value":"value"}` eval entries from a generator bug
and got 200.  These checks look for wrong-but-well-formed output.
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict

from datamaps import cribl_paths
from datamaps.cribl_paths import unquote

VALID_PATH = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$')
GARBAGE = {"name", "value", "field", "ecs", "vendor", "todo", "tbd",
           "placeholder"}
GLOBALS = ("Date", "Math", "String", "Number", "Boolean", "Array", "Object",
           "JSON", "RegExp", "parseInt", "parseFloat", "isNaN", "isFinite")

# Globals the eval/filter expression sandbox does not provide.  Probed on
# 4.19.0 (2026-09-23): `typeof parseInt` is 'undefined' there, so an
# expression calling it yields nothing - silently, and HTTP 200 on save.
# Number.parseInt / Number.parseFloat / Number.isNaN / Number.isFinite work,
# as do Date, Math, String, Number, JSON, RegExp, Map, Set and
# encodeURIComponent.  A `code` function has the full set.
EXPR_MISSING = ("parseInt", "parseFloat", "isNaN", "isFinite", "encodeURI",
                "decodeURI", "escape", "unescape", "atob", "btoa", "Symbol",
                "BigInt", "Buffer", "Intl", "Error", "Infinity", "NaN")
_MISSING_RE = re.compile(r"(?<![.\w$])(%s)\b" % "|".join(EXPR_MISSING))
_STRING_RE = re.compile(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"")


def missing_globals(expr):
    """Sandbox-missing globals an eval/filter expression uses, string
    literals ignored."""
    return sorted(set(_MISSING_RE.findall(_STRING_RE.sub("''", str(expr)))))


def _valid_name(name):
    # A quoted name is a literal key (a flat dotted key, `@timestamp`); only
    # an unquoted one is a path the accessor has to parse.
    if cribl_paths.is_quoted(name):
        return len(name) > 2
    return bool(VALID_PATH.match(name))


def lint_pipeline(doc):
    """[(code, detail)] for one pipeline document."""
    out = []
    _, changes, _ = cribl_paths.rewrite_pipeline(doc)
    for code, detail in changes:
        out.append(("renest-not-last" if code == "renest" else
                    "flat-key-rewrite-pending", detail[:160]))
    conf = doc.get("conf") or {}
    fns = conf.get("functions") or []
    if not fns:
        out.append(("empty-pipeline", ""))
    has_dataset = False
    for fn in fns:
        fid = fn.get("id")
        c = fn.get("conf") or {}
        if fid == "comment" and len(str(c.get("comment", ""))) > 1000:
            out.append(("comment-over-1000", ""))
        # event.dataset is legitimately set inside a `code` function by some
        # pipelines, not only via eval.add - checking eval alone produced
        # eight false positives.
        if fid == "code" and "event.dataset" in str(c.get("code", "")):
            has_dataset = True
        # A JS global read off the event: `__e['Date'].parse(x)` evaluates
        # to undefined.parse(x) and throws at runtime.  Schema-valid, so
        # Cribl returns 200.
        blob = json.dumps(c)
        for g in GLOBALS:
            if "__e['%s']." % g in blob or '__e["%s"].' % g in blob:
                out.append(("global-read-off-event", "__e['%s'].*" % g))
        exprs = [fn.get("filter", "")]
        if fid == "eval":
            exprs += [a.get("value", "") for a in c.get("add") or []]
        for expr in exprs:
            for g in missing_globals(expr):
                out.append(("eval-missing-global", "%s in %s" % (g, str(expr)[:80])))
        if fid == "eval":
            for add in c.get("add") or []:
                n = unquote(str(add.get("name", "")))
                v = str(add.get("value", ""))
                # Both sides generic - the observed bug was literally
                # {"name":"name","value":"value"}.  Either side alone
                # false-positives on maps whose own vendor fields are called
                # `value` (printers-mfd) or `NAME` (zos-acf2).
                if n.lower() in GARBAGE and v.strip("'\"").lower() in GARBAGE:
                    out.append(("echoed-placeholder", "{%s: %s}" % (n, v)))
                if n and v and n == v.strip("'\""):
                    out.append(("name-equals-value", n))
                if n == "event.dataset":
                    has_dataset = True
                    if "-" in v:
                        out.append(("dataset-has-hyphen", v))
                raw = str(add.get("name", ""))
                if raw and not _valid_name(raw):
                    out.append(("invalid-path-in-eval-add", raw))
            for rm in c.get("remove") or []:
                if isinstance(rm, str) and "*" not in rm and not _valid_name(rm):
                    out.append(("invalid-path-in-eval-remove", rm))
        if fid == "rename":
            # Cribl does NOT validate the rename conf: a bogus key set and
            # even an empty conf both return HTTP 200.  This check is the
            # only thing between a typo and a silently no-op rename.
            pairs = c.get("rename")
            if not isinstance(pairs, list) or not pairs:
                out.append(("rename-conf-malformed",
                            "conf keys=%s" % sorted(c)))
                pairs = []
            for pair in pairs:
                if (not isinstance(pair, dict) or "currentName" not in pair
                        or "newName" not in pair):
                    out.append(("rename-pair-malformed", str(pair)))
                    continue
                cn = str(pair.get("currentName", ""))
                nn = str(pair.get("newName", ""))
                if cn and unquote(cn) == unquote(nn):
                    out.append(("rename-noop", cn))
                for nm in (cn, nn):
                    if nm and not _valid_name(nm):
                        out.append(("invalid-path-in-rename", nm))
        # `distinct` is an aggregation: it emits one event per new groupBy
        # combination carrying ONLY the groupBy fields.  Probed on 4.19 it
        # turned {Identity, Op} into {Identity}.  Dedup is `suppress`.
        if fid == "distinct" and fn.get("disabled") is not True:
            out.append(("distinct-drops-fields", str(c.get("groupBy"))[:160]))
        if fid in ("regex_extract", "regex_filter"):
            rx = c.get("regex")
            if isinstance(rx, str) and rx and not rx.startswith("/"):
                out.append(("bare-regex", rx[:40]))
    if not has_dataset:
        out.append(("no-event-dataset", ""))
    return out


def lint_syslog_framing(doc):
    """[(code, detail)] for a syslog-* pipeline that parses the message body
    out of `_raw`.  A Cribl Syslog Source leaves the whole line, header
    included, in `_raw` (docs/verification/2026-09-23-cribl-syslog-source-
    framing.md): a `^CEF:` anchor never matches it, and a CSV parser folds
    the header into the first column."""
    out = []
    for fn in (doc.get("conf") or {}).get("functions") or []:
        if fn.get("disabled") is True:
            continue
        c = fn.get("conf") or {}
        if fn.get("id") == "regex_extract" and c.get("source", "_raw") == "_raw":
            rx = str(c.get("regex", ""))
            if rx.startswith("/^CEF:") or rx.startswith("/^LEEF:"):
                out.append(("syslog-anchored-on-raw", rx[:40]))
        if (fn.get("id") == "serde" and c.get("type") in ("kvp", "csv")
                and c.get("srcField", "_raw") == "_raw"):
            out.append(("syslog-serde-on-raw", c.get("type")))
    return out


# Fields a Cribl Syslog Source sets.  A regex_extract capture of the same
# name, without `overwrite`, turns the field into an array (probed on
# 4.19.0: severity 6 plus a captured '9' became [6, '9']).  serde overwrites.
SYSLOG_SOURCE_FIELDS = ("message", "host", "appname", "procid", "msgid",
                        "severity", "facility", "severityName",
                        "facilityName", "structuredData")


def lint_syslog_captures(doc):
    """[(code, detail)] for a syslog-* regex_extract that captures into a
    field the Syslog Source has already set, without overwrite."""
    out = []
    for fn in (doc.get("conf") or {}).get("functions") or []:
        c = fn.get("conf") or {}
        if (fn.get("id") != "regex_extract" or fn.get("disabled") is True
                or c.get("overwrite") is True):
            continue
        rxs = [c.get("regex", "")] + [r.get("regex", "") for r in c.get("regexList") or []]
        names = set(re.findall(r"\(\?<(\w+)>", " ".join(str(r) for r in rxs)))
        for g in sorted(names & set(SYSLOG_SOURCE_FIELDS)):
            out.append(("syslog-capture-collides", g))
    return out


def lint_all(pipelines):
    """{code: [detail lines]} over a {(tech, ds, fmt): doc} mapping."""
    findings = defaultdict(list)
    ids = defaultdict(list)
    for key in sorted(pipelines):
        doc = pipelines[key]
        rel = "%s/%s__%s" % key
        ids[doc.get("id", "")].append(rel)
        found = lint_pipeline(doc)
        if key[2].startswith("syslog-"):
            found += lint_syslog_framing(doc)
            found += lint_syslog_captures(doc)
        for code, detail in found:
            findings[code].append(("%s  %s" % (rel, detail)).rstrip())
    for pid, rels in ids.items():
        if len(rels) > 1:
            findings["duplicate-pipeline-id"].append(
                "%s  <- %s" % (pid, ", ".join(rels)))
    return dict(findings)


def format_report(findings):
    if not findings:
        return "no findings\n"
    lines = []
    for code in sorted(findings, key=lambda k: -len(findings[k])):
        items = findings[code]
        lines.append("%-28s %4d" % (code, len(items)))
        for item in items[:6]:
            lines.append("      %s" % item)
        if len(items) > 6:
            lines.append("      ... and %d more" % (len(items) - 6))
    return "\n".join(lines) + "\n"


def main(argv=None):
    from datamaps import pipelines as pipelines_mod
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser(prog="python3 -m datamaps.cribl_lint")
    parser.add_argument("--data", default=os.path.join(root, "data"))
    opts = parser.parse_args(argv)
    loaded = pipelines_mod.load_pipelines(opts.data)
    findings = lint_all(loaded)
    sys.stdout.write("linted %d pipeline files\n" % len(loaded))
    sys.stdout.write(format_report(findings))
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
