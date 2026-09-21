"""Cribl `eval` -> set / copy_from / script / remove.

A constant becomes `set`, a single field read becomes `set` with
`copy_from`, and every other row becomes one try/catch block in a single
`script` processor.  The try/catch is what gives Cribl's per-row
semantics: an expression that throws leaves its field unset and the event
continues.  Rows that cannot be translated are returned as a manual step
alongside the rows that could, so a partially translatable eval still
emits everything it can.
"""
from datamaps.ingest import expr
from datamaps.ingest.expr import Untranslatable, map_field
from datamaps.ingest.functions import Result

_ROW = "try { def v = %s; if (v != null) { %s%s = v; } } catch (Exception e) { }"


def _row_script(value, target_name):
    guards, target = expr.write_target(target_name)
    prefix = "".join(g + " " for g in guards)
    return _ROW % (value, prefix, target)


def translate_eval(conf, description):
    if conf.get("keep"):
        raise Untranslatable("eval keep has no processor equivalent")
    procs = []
    notes = []
    failing = []
    reasons = []
    regex = False
    pending_script = []

    def flush_script():
        if pending_script:
            procs.append({"script": {"lang": "painless",
                                     "source": "\n".join(pending_script),
                                     "description": description}})
            del pending_script[:]

    for row in conf.get("add") or []:
        name = str(row.get("name", ""))
        value = str(row.get("value", ""))
        if name.startswith("__"):
            notes.append("eval: %s is a Cribl internal field; row skipped" % name)
            continue
        try:
            target = map_field(name)
            result = expr.translate_value(value)
        except Untranslatable as exc:
            failing.append(row)
            reasons.append("%s: %s" % (name, exc.reason))
            continue
        regex = regex or result.regex
        if result.is_constant:
            if result.constant is None:
                notes.append("eval: %s is set to undefined/null; no processor "
                             "emitted" % name)
                continue
            flush_script()
            procs.append({"set": {"field": target, "value": result.constant,
                                  "description": description}})
        elif result.is_field:
            flush_script()
            procs.append({"set": {"field": target, "copy_from": result.is_field,
                                  "ignore_empty_value": True,
                                  "description": description}})
        else:
            pending_script.append(_row_script(result.source, target))
    flush_script()

    remove = conf.get("remove") or []
    if remove:
        if any("*" in str(f) for f in remove):
            raise Untranslatable("eval remove with a wildcard")
        procs.append({"remove": {"field": [map_field(str(f)) for f in remove],
                                 "ignore_missing": True,
                                 "description": description}})

    manual = None
    if failing:
        if not procs:
            raise Untranslatable("; ".join(reasons))
        manual = {"function": "eval", "reason": "; ".join(reasons),
                  "original": {"add": failing}}
    return Result(procs, notes, manual=manual, regex=regex)
