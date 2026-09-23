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
        if fid in ("regex_extract", "regex_filter"):
            rx = c.get("regex")
            if isinstance(rx, str) and rx and not rx.startswith("/"):
                out.append(("bare-regex", rx[:40]))
    if not has_dataset:
        out.append(("no-event-dataset", ""))
    return out


def lint_all(pipelines):
    """{code: [detail lines]} over a {(tech, ds, fmt): doc} mapping."""
    findings = defaultdict(list)
    ids = defaultdict(list)
    for key in sorted(pipelines):
        doc = pipelines[key]
        rel = "%s/%s__%s" % key
        ids[doc.get("id", "")].append(rel)
        for code, detail in lint_pipeline(doc):
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
