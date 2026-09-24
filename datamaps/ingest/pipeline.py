"""Cribl pipeline -> Elasticsearch ingest pipeline envelope."""
import copy
import json
import re
from collections import OrderedDict

from datamaps.ingest import expr, functions
from datamaps.ingest.expr import Untranslatable

_WS = re.compile(r"\s+")


def _clean(text):
    return _WS.sub(" ", str(text or "")).strip()


def _description(comments, fn):
    own = _clean(fn.get("description"))
    if comments:
        lead = " | ".join(_clean(c) for c in comments if _clean(c))
        return "%s — %s" % (lead, own) if own else lead
    return own


def translate_pipeline(cribl):
    conf = cribl.get("conf") or {}
    processors = []
    manual_steps = []
    notes = []
    counts = {"translated": 0, "partial": 0, "manual": 0, "total": 0}
    regex = False
    pending_comments = []
    index = 0
    for fn in conf.get("functions") or []:
        fid = fn.get("id")
        if fid == "comment":
            pending_comments.append((fn.get("conf") or {}).get("comment", ""))
            continue
        description = _description(pending_comments, fn)
        pending_comments = []
        counts["total"] += 1
        try:
            result = functions.translate_function(fn, description)
        except Untranslatable as exc:
            counts["manual"] += 1
            manual_steps.append({"index": index, "function": fid,
                                 "reason": exc.reason,
                                 "description": _clean(fn.get("description")),
                                 "original": fn})
            index += 1
            continue
        processors.extend(result.processors)
        regex = regex or result.regex
        for note in result.notes:
            # A note names its own function ("mask: ...") which the "<fid> #N"
            # prefix repeats; a note naming something else (serde's "kvp: ...")
            # keeps that qualifier.
            if note.startswith("%s: " % fid):
                note = note[len(fid) + 2:]
            notes.append("%s #%d: %s" % (fid, index, note))
        if result.manual:
            counts["partial"] += 1
            original = copy.deepcopy(fn)
            original["conf"] = result.manual["original"]
            manual_steps.append({"index": index, "function": fid,
                                 "reason": result.manual["reason"],
                                 "description": _clean(fn.get("description")),
                                 "original": original, "partial": True})
        else:
            counts["translated"] += 1
        index += 1
    if any(expr.SCRATCH_OBJECT in json.dumps(p) for p in processors):
        processors.append(OrderedDict([("remove", OrderedDict([
            ("field", expr.SCRATCH_OBJECT), ("ignore_missing", True)]))]))
    # A translator that emits the same note per rule (mask) says it once here.
    notes = list(OrderedDict.fromkeys(notes))
    summary = ("%s (translated from Cribl by data-maps: %d of %d steps "
               "translated, %d partial, %d manual)"
               % (_clean(conf.get("description")), counts["translated"],
                  counts["total"], counts["partial"], counts["manual"]))
    return OrderedDict([
        ("id", cribl.get("id")),
        ("pipeline", OrderedDict([("description", summary),
                                  ("processors", processors)])),
        ("coverage", OrderedDict([(k, counts[k]) for k in
                                  ("translated", "partial", "manual", "total")])),
        ("notes", notes),
        ("manual_steps", manual_steps),
        ("field_map", OrderedDict(sorted(expr.FIELD_MAP.items(), reverse=True))),
        ("requires", ["painless-regex"] if regex else []),
    ])


def translate_all(pipelines):
    out = OrderedDict()
    for key in sorted(pipelines):
        out[key] = translate_pipeline(pipelines[key])
    return out


def summarize(envelopes):
    total = {"translated": 0, "partial": 0, "manual": 0, "total": 0}
    for env in envelopes.values():
        for k in total:
            total[k] += env["coverage"][k]
    return total
