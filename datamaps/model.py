"""Computed layer: coverage, derived alerting, reverse index, flags."""
import re
from collections import OrderedDict

from datamaps import examples as examples_mod

STATUS_RANK = {"in-progress": 0, "mapped": 1, "planned": 2,
               "deprecated": 3}
CUSTOM_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$")


def _pct(part, whole):
    return int(round(100.0 * part / whole)) if whole else 0


def _required_for(ds, profiles):
    required = set()
    for cat in ds["event_categories"]:
        required.update(profiles[cat]["required"])
    return sorted(required)


def _format_view(fmt, required, required_set):
    mapped_ecs = set(f["ecs"] for f in fmt["fields"]
                     if f.get("ecs") and f["status"] == "mapped")
    fields = [{"field": f,
               "alerting": bool(f.get("ecs")) and f["ecs"] in required_set}
              for f in fmt["fields"]]
    required_mapped = [name for name in required if name in mapped_ecs]
    doctrine = _parse_doctrine(fmt)
    parse_doctrine = {}
    parse_agrees = {}
    for side, body in (fmt.get("recommendations") or {}).items():
        parse_doctrine[side] = doctrine
        authored = body.get("parse_location")
        parse_agrees[side] = (None if doctrine is None or authored is None
                              else authored == doctrine)
    return {
        "data": fmt,
        "fields": fields,
        "required": required,
        "required_mapped": required_mapped,
        "required_pct": _pct(len(required_mapped), len(required)),
        "fields_total": len(fmt["fields"]),
        "fields_mapped": sum(1 for f in fmt["fields"]
                             if f["status"] == "mapped"),
        "parse_doctrine": parse_doctrine,
        "parse_agrees": parse_agrees,
    }


# CEF and LEEF are parsed out low-side everywhere per the relay doctrine.
_DOCTRINE_LOW_FORMATS = ("syslog-cef", "syslog-leef")


# A parser already exists for these mechanisms: the format arrives
# parsed rather than needing a pipeline written for it.
_PARSED_MECHANISMS = ("elastic-integration", "cribl-pack")


def _rank_formats(views):
    """Order format views best-first. Deterministic.

    Alerting-required coverage decides it; most datasets tie there, so an
    entry with a field inventory beats one without (61 entries document an
    empty inventory because the vendor publishes no field reference, and
    recommending one of those would be perverse), then an entry a parser
    already exists for (an Elastic integration or a Cribl pack) beats one
    that would need a pipeline written for it, then total mapped fields,
    then declaration order.
    """
    def sort_key(item):
        index, view = item
        mechanism = view["data"]["parsing"]["mechanism"]
        return (-len(view["required_mapped"]),
                0 if view["fields_total"] else 1,
                0 if mechanism in _PARSED_MECHANISMS else 1,
                -view["fields_mapped"],
                index)
    return [view for _, view in sorted(enumerate(views), key=sort_key)]


def _recommendation(views):
    """Return (recommended view, "computed"|"override"|"only-format")."""
    for view in views:
        if view["data"].get("recommended"):
            return view, "override"
    if len(views) == 1:
        return views[0], "only-format"
    return _rank_formats(views)[0], "computed"


def _switch_gain(formats, recommendation, source):
    """The best alternative and the required fields it would add.

    None when an override is in force: the override's stated reason is
    already the answer to "why not switch".
    """
    if source == "override" or len(formats) < 2:
        return None
    have = set(recommendation["required_mapped"])
    for view in _rank_formats(formats):
        if view is recommendation:
            continue
        extra = sorted(set(view["required_mapped"]) - have)
        if extra:
            return {"format": view["data"]["format"],
                    "count": len(extra), "fields": extra}
    return None


def _gap_split(formats, recommendation):
    have = set(recommendation["required_mapped"])
    anywhere = set()
    for view in formats:
        anywhere.update(view["required_mapped"])
    missing = [n for n in recommendation["required"] if n not in have]
    return ([n for n in missing if n in anywhere],
            [n for n in missing if n not in anywhere])


def _format_choice(datasets):
    """Per-format cost across a technology, for one-export-config devices."""
    names = set()
    for view in datasets:
        for fv in view["formats"]:
            names.add(fv["data"]["format"])
    if len(names) < 2:
        return None
    rows = []
    universal = []
    for name in sorted(names):
        satisfied = offering = 0
        for view in datasets:
            match = [fv for fv in view["formats"]
                     if fv["data"]["format"] == name]
            if match:
                offering += 1
                satisfied += len(match[0]["required_mapped"])
        if offering == len(datasets):
            universal.append(name)
        rows.append({"format": name, "required_mapped": satisfied,
                     "datasets_offering": offering,
                     "datasets_missing": len(datasets) - offering})
    return {"rows": rows, "universal": universal}


def _parse_doctrine(fmt):
    """The parse location the relay doctrine settles, or None to abstain.

    Abstention is a published result, not a failure: the doctrine treats
    the majority of cases as judgment calls and the page says so.
    """
    mechanism = fmt["parsing"]["mechanism"]
    if mechanism == "elastic-integration":
        return "high"
    if fmt["format"] in _DOCTRINE_LOW_FORMATS:
        return "low"
    if mechanism == "none":
        return "low"
    return None


def _dataset_view(ds, profiles, records):
    required = _required_for(ds, profiles)
    required_set = set(required)
    formats = [_format_view(f, required, required_set)
               for f in ds["formats"]]
    recommendation, source = _recommendation(formats)
    # Mark the winner on the format view itself: Jinja's `is` is the test
    # operator, not identity, so the template cannot compare views.
    for fv in formats:
        fv["recommended"] = fv is recommendation
        fv["recommended_source"] = source if fv is recommendation else None
    coverage_favours = None
    if source == "override":
        top = _rank_formats(formats)[0]
        if top is not recommendation:
            coverage_favours = top
    view = {"data": ds, "formats": formats,
            "recommendation": recommendation,
            "recommendation_source": source,
            "coverage_favours": coverage_favours,
            "examples": records}
    for key in ("fields", "required", "required_mapped", "required_pct",
                "fields_total", "fields_mapped"):
        view[key] = recommendation[key]
    view["switch_gain"] = _switch_gain(formats, recommendation, source)
    view["closable"], view["unobtainable"] = _gap_split(formats,
                                                        recommendation)
    return view


def _target_statuses(view):
    """{ECS target: satisfied/partial/missing} for one format view.

    "satisfied" needs a field row at status mapped; a target that only
    ever appears as partial is reported as such rather than counted.  A
    target the format does not carry at all is absent from the mapping,
    which _alerting_matrix reads as "missing".

    Built in one pass per format rather than rescanning the field list for
    every required target: the matrix asks about each of a profile's
    targets in turn, and a dataset's fields do not change between them.
    """
    ranked = {}
    for fv in view["fields"]:
        name = fv["field"].get("ecs")
        if not name:
            continue
        status = fv["field"]["status"]
        if status == "mapped":
            ranked[name] = "satisfied"
        elif status == "partial" and ranked.get(name) != "satisfied":
            ranked[name] = "partial"
        else:
            ranked.setdefault(name, "missing")
    return ranked


def _alerting_matrix(tech_views, profiles):
    """Per category, which datasets satisfy each required field.

    Read on the recommended format alone: the matrix answers "what would
    the CSOC get if every dataset were onboarded as recommended", not
    "what could it get from some format nobody ships".
    """
    matrix = []
    for category in profiles:
        required = profiles[category]["required"]
        members = [(view["entry"]["id"], d)
                   for view in tech_views for d in view["datasets"]
                   if category in d["data"]["event_categories"]]
        # One pass over each member's recommended format, not one per
        # required target.
        ranked = [_target_statuses(d["recommendation"]) for _, d in members]
        satisfied_counts = [0] * len(members)
        rows = []
        for name in required:
            buckets = {"satisfied": [], "partial": [], "missing": []}
            for pos, (tech_id, d) in enumerate(members):
                bucket = ranked[pos].get(name, "missing")
                buckets[bucket].append({"tech": tech_id,
                                        "dataset": d["data"]["id"]})
                if bucket == "satisfied":
                    satisfied_counts[pos] += 1
            rows.append({"field": name, "satisfied": buckets["satisfied"],
                         "partial": buckets["partial"],
                         "missing": buckets["missing"]})
        matrix.append({
            "category": category,
            "datasets": len(members),
            "all_satisfied": sum(1 for count in satisfied_counts
                                 if count == len(required)),
            "required": rows,
        })
    return matrix


def _required_in(profiles):
    """ECS field -> the profile categories that require it."""
    index = {}
    for category in profiles:
        for name in profiles[category]["required"]:
            index.setdefault(name, set()).add(category)
    return index


def _flag(code, subject, message):
    return {"code": code, "subject": subject, "message": message}


def _tech_flags(entry, datasets, flags):
    tech_id = entry["id"]
    for view in datasets:
        ds = view["data"]
        where = "%s/%s" % (tech_id, ds["id"])
        if entry["status"] != "planned" and view["fields_total"] == 0:
            flags.append(_flag("empty-dataset", where,
                               "dataset '%s' has no fields yet" % where))
        if (entry["status"] == "mapped"
                and view["recommendation"]["data"]["parsing"]["mechanism"]
                == "none"):
            flags.append(_flag("unparsed-mapped", where,
                               "dataset '%s' is on a mapped technology but "
                               "has no parsing mechanism" % where))
        for hop in ds["route"].get("guarded", []):
            if hop["hop"] == "guard" and not hop.get("constraints"):
                flags.append(_flag("guard-no-constraints", where,
                                   "dataset '%s' crosses a guard with no "
                                   "constraints documented" % where))
        for fv in view["formats"]:
            if (fv["fields_total"] == 0
                    and not fv["data"].get("fields_omitted")):
                flags.append(_flag(
                    "format-no-fields", where,
                    "dataset '%s' format '%s' has no field inventory and no "
                    "fields_omitted rationale"
                    % (where, fv["data"]["format"])))
        for rec in view["examples"]:
            if rec["size"] == 0:
                flags.append(_flag("example-empty", where,
                                   "dataset '%s' example '%s' is empty"
                                   % (where, rec["label"])))
            elif rec["size"] > examples_mod.MAX_BYTES:
                flags.append(_flag(
                    "example-oversize", where,
                    "dataset '%s' example '%s' is %d bytes; trim it to a "
                    "representative record"
                    % (where, rec["label"], rec["size"])))
        for fv in view["formats"]:
            for side in sorted(fv["parse_agrees"]):
                if fv["parse_agrees"][side] is False:
                    flags.append(_flag(
                        "parse-location-vs-doctrine", where,
                        "dataset '%s' format '%s' %s side parses %s but the "
                        "doctrine settles %s"
                        % (where, fv["data"]["format"], side,
                           fv["data"]["recommendations"][side]
                           ["parse_location"],
                           fv["parse_doctrine"][side])))
        for fmt_view in view["formats"]:
            for fv in fmt_view["fields"]:
                custom = fv["field"].get("custom")
                if custom and not CUSTOM_RE.match(custom):
                    flags.append(_flag(
                        "custom-namespace-shape",
                        "%s.%s" % (where, fv["field"]["vendor"]),
                        "field '%s' custom target '%s' is not a dotted "
                        "lowercase namespace" % (fv["field"]["vendor"],
                                                 custom)))


def build_model(catalog, technologies, profiles_doc, ecs, examples=None):
    profiles = profiles_doc["profiles"]
    ecs_fields = ecs["fields"]
    grouped = examples or {}
    flags = []
    tech_views = []
    for row in catalog["technologies"]:
        doc = technologies.get(row["id"])
        datasets = ([_dataset_view(ds, profiles,
                                   grouped.get((row["id"], ds["id"]), []))
                     for ds in doc["datasets"]] if doc else [])
        required_total = sum(len(d["required"]) for d in datasets)
        required_mapped = sum(len(d["required_mapped"]) for d in datasets)
        tech_views.append({
            "entry": row,
            "doc": doc,
            "datasets": datasets,
            "required_total": required_total,
            "required_mapped": required_mapped,
            "required_pct": _pct(required_mapped, required_total),
            "fields_total": sum(d["fields_total"] for d in datasets),
            "fields_mapped": sum(d["fields_mapped"] for d in datasets),
            "draft": bool(doc and doc.get("draft")),
            "format_choice": _format_choice(datasets),
        })
        if doc:
            _tech_flags(row, tech_views[-1]["datasets"], flags)
    tech_views.sort(key=lambda v: (STATUS_RANK[v["entry"]["status"]],
                                   v["entry"]["name"].lower()))

    # Every format contributes a usage, not just the recommended one: the
    # CSOC asks "who can give me this field", and the answer includes the
    # entry it would have to switch a device to. The recommended flag is
    # what separates the two, here and in the page's filters.
    usages = {}
    for view in tech_views:
        for d in view["datasets"]:
            for fmt_view in d["formats"]:
                for fv in fmt_view["fields"]:
                    name = fv["field"].get("ecs")
                    if not name:
                        continue
                    usages.setdefault(name, []).append({
                        "tech": view["entry"],
                        "dataset": d["data"]["id"],
                        "format": fmt_view["data"]["format"],
                        "recommended": fmt_view["recommended"],
                        "vendor": fv["field"]["vendor"],
                        "status": fv["field"]["status"],
                    })
    required_in = _required_in(profiles)
    ecs_index = [{"name": name,
                  "type": ecs_fields.get(name, {}).get("type", ""),
                  "short": ecs_fields.get(name, {}).get("short", ""),
                  "required_in": sorted(required_in.get(name, ())),
                  "usages": usages[name]}
                 for name in sorted(usages)]

    all_required = set()
    for body in profiles.values():
        all_required.update(body["required"])
    # The gap lists are about what the site recommends onboarding, so a
    # mapping that only exists on a format nobody was told to use does
    # not close a gap - that is exactly what "closable" records instead.
    mapped_anywhere = set(
        name for name, rows in usages.items()
        if any(u["status"] == "mapped" and u["recommended"] for u in rows))
    closable = set()
    for view in tech_views:
        for d in view["datasets"]:
            closable.update(d["closable"])
    closable_required = sorted(closable - mapped_anywhere)
    unmapped_required = sorted(all_required - mapped_anywhere
                               - set(closable_required))

    by_status = OrderedDict(
        (status, sum(1 for v in tech_views
                     if v["entry"]["status"] == status))
        for status in ("mapped", "in-progress", "planned", "deprecated"))
    summary = {
        "technologies": len(tech_views),
        "datasets": sum(len(v["datasets"]) for v in tech_views),
        "drafts": sum(1 for v in tech_views if v["draft"]),
        "by_status": by_status,
        "required_total": sum(v["required_total"] for v in tech_views),
        "required_mapped": sum(v["required_mapped"] for v in tech_views),
    }
    summary["required_pct"] = _pct(summary["required_mapped"],
                                   summary["required_total"])
    return {"ecs_version": ecs["ecs_version"], "technologies": tech_views,
            "ecs_index": ecs_index, "unmapped_required": unmapped_required,
            "closable_required": closable_required,
            "alerting_matrix": _alerting_matrix(tech_views, profiles),
            "profiles": profiles, "summary": summary, "flags": flags}
