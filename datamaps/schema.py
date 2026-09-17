"""Hard validation: vocabularies, structure, ECS dictionary lookups."""
import re

CATEGORIES = ["network-security", "network-infrastructure",
              "web-mail-gateway", "endpoint", "identity-pki",
              "application-platform", "cloud", "security-tooling",
              "physical-ot", "mainframe", "pipeline-self"]
STATUSES = ["planned", "in-progress", "mapped", "deprecated"]
PRIORITIES = ["core", "standard", "edge"]
SOURCE_FORMATS = ["syslog-csv", "syslog-cef", "syslog-leef", "syslog-kv",
                  "syslog-raw", "json", "windows-event", "api-pull",
                  "csv-file", "avro-kafka", "kafka-json", "eventbridge", "ocsf", "journald",
                  "asff", "parquet-s3", "netflow", "sflow", "snmp-trap", "snmp-poll", "estreamer", "webhook", "jdbc-sql", "xml-file", "otlp", "prometheus",
                  "other"]
MECHANISMS = ["elastic-integration", "cribl-pack", "cribl-pipeline",
              "elastic-ingest-pipeline", "none"]
HOPS = ["cribl", "guard", "elastic", "other"]
FIELD_STATUSES = ["mapped", "partial", "unmapped"]
# low = parse near the customer/source, high = parse near the SIEM,
# hybrid = envelope low + enrich high
PARSE_LOCATIONS = ["low", "high", "hybrid"]

# Matched with fullmatch, never match: Python's `$` also matches just
# before a trailing newline, so "traffic\n" would pass where the browser
# port's `RegExp("^[a-z0-9][a-z0-9-]*$").test` rejects it.  The pattern
# itself stays JavaScript-legal because studio.schema_json publishes it for
# that port to compile - which is why this is fullmatch rather than \Z.
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

# The single definition of which keys each node accepts and the order
# Studio writes them.  Every _check_keys call site below takes its allowed
# set from here and its required set from REQUIRED, studio.schema_json
# publishes both, and the browser validator and editor forms read them from
# the published schema - so a key is added or moved in exactly one place.
KEY_ORDER = {
    "technology": ("id", "name", "vendor", "versions", "draft",
                   "references", "datasets"),
    "catalog_row": ("id", "name", "vendor", "category", "status",
                    "priority"),
    "dataset": ("id", "name", "description", "event_categories",
                "route", "formats"),
    "route": ("guarded", "direct"),
    "hop": {"cribl": ("hop", "location", "notes"),
            "guard": ("hop", "device", "constraints", "notes"),
            "elastic": ("hop", "data_stream", "notes"),
            "other": ("hop", "name", "notes")},
    # `format`'s order is a choice, not a reading of the files: the authored
    # documents use two families - 246 formats read parsing, fields,
    # recommendations and 299 read parsing, recommendations, ... fields - and
    # neither is wrong.  cisco-asa.yml is the reference the table follows,
    # and orderedInsert leaves an author's existing keys where they are, so
    # the choice only ever decides where a *new* key is written.
    "format": ("format", "recommended", "recommended_because", "enable",
               "references", "parsing", "fields_omitted", "fields",
               "recommendations"),
    "parsing": ("mechanism", "artifact", "notes"),
    "field": ("vendor", "type", "description", "ecs", "status", "custom",
              "transform", "notes"),
    "recommendations": ("guarded", "direct"),
    "recommendation_side": {"guarded": ("parse_location", "cribl",
                                        "elastic", "relay"),
                            "direct": ("parse_location", "cribl",
                                       "elastic")},
}

# Which of a node's keys must be present.  The order is the order the
# "missing key" messages come out in, so it is part of the contract.  A
# node whose keys are all optional carries an empty tuple; the two nodes
# with per-kind key sets ("hop", "recommendation_side") require the same
# keys of every kind, so one tuple covers them.
REQUIRED = {
    "technology": ("id", "name", "vendor", "datasets"),
    "catalog_row": ("id", "name", "vendor", "category", "status",
                    "priority"),
    "dataset": ("id", "name", "event_categories", "route", "formats"),
    "route": ("direct",),
    "hop": ("hop",),
    "format": ("format", "parsing", "fields"),
    "parsing": ("mechanism",),
    "field": ("vendor", "ecs", "status"),
    "recommendations": (),
    "recommendation_side": (),
}


def _optional_keys(order, required):
    return tuple(key for key in order if key not in required)


def _build_optional():
    """KEY_ORDER minus REQUIRED, precomputed once per node."""
    table = {}
    for node, order in KEY_ORDER.items():
        required = REQUIRED[node]
        if isinstance(order, dict):
            table[node] = dict((kind, _optional_keys(keys, required))
                               for kind, keys in order.items())
        else:
            table[node] = _optional_keys(order, required)
    return table


OPTIONAL = _build_optional()

# Views over the tables above, kept under their old names: HOP_KEYS is
# {kind: (required, optional)} and REC_KEYS is {side: allowed keys}.
HOP_KEYS = dict((kind, (REQUIRED["hop"], OPTIONAL["hop"][kind]))
                for kind in KEY_ORDER["hop"])
REC_KEYS = dict((side, keys) for side, keys
                in KEY_ORDER["recommendation_side"].items())


def _label(obj, key):
    """A value for a 'where' label, or '?' when obj is not a mapping.

    Authoring a bare string where a mapping belongs (a name straight
    under fields:) must not raise while the label is built: let
    _check_keys report "must be a mapping" instead.
    """
    if not isinstance(obj, dict):
        return "?"
    return obj.get(key, "?")


def _check_keys(obj, required, optional, where, errors):
    if not isinstance(obj, dict):
        errors.append("%s: must be a mapping" % where)
        return False
    for key in obj:
        if key not in required and key not in optional:
            errors.append("%s: unknown key '%s'" % (where, key))
    ok = True
    for key in required:
        if key not in obj:
            errors.append("%s: missing key '%s'" % (where, key))
            ok = False
    return ok


def _check_str(obj, key, where, errors, vocab=None, pattern=None,
               optional=False):
    if key not in obj or obj[key] is None:
        if not optional:
            errors.append("%s: '%s' must be a non-empty string"
                          % (where, key))
        return
    value = obj[key]
    if not isinstance(value, str) or not value.strip():
        errors.append("%s: '%s' must be a non-empty string" % (where, key))
        return
    if vocab is not None and value not in vocab:
        errors.append("%s: '%s' value '%s' not one of: %s"
                      % (where, key, value, ", ".join(vocab)))
    if pattern is not None and not pattern.fullmatch(value):
        errors.append("%s: '%s' value '%s' is not a valid slug"
                      % (where, key, value))


def validate_catalog(doc):
    errors = []
    if not _check_keys(doc, ("technologies",), (), "catalog", errors):
        return errors
    rows = doc["technologies"]
    if not isinstance(rows, list) or not rows:
        return ["catalog: 'technologies' must be a non-empty list"]
    seen = set()
    for position, row in enumerate(rows):
        where = "catalog[%d]" % position
        if not _check_keys(row, REQUIRED["catalog_row"],
                           OPTIONAL["catalog_row"], where, errors):
            continue
        _check_str(row, "id", where, errors, pattern=SLUG_RE)
        _check_str(row, "name", where, errors)
        _check_str(row, "vendor", where, errors)
        _check_str(row, "category", where, errors, vocab=CATEGORIES)
        _check_str(row, "status", where, errors, vocab=STATUSES)
        _check_str(row, "priority", where, errors, vocab=PRIORITIES)
        key = row.get("id")
        if key in seen:
            errors.append("%s: duplicate technology id '%s'" % (where, key))
        seen.add(key)
    return errors


def validate_profiles(doc, ecs_fields):
    errors = []
    if not _check_keys(doc, ("profiles",), (), "profiles", errors):
        return errors
    profiles = doc["profiles"]
    if not isinstance(profiles, dict) or not profiles:
        return ["profiles: 'profiles' must be a non-empty mapping"]
    for name in sorted(profiles):
        where = "profiles.%s" % name
        body = profiles[name]
        if not _check_keys(body, ("required",), (), where, errors):
            continue
        required = body["required"]
        if not isinstance(required, list) or not required:
            errors.append("%s: 'required' must be a non-empty list" % where)
            continue
        for field in required:
            if field not in ecs_fields:
                errors.append("%s: required field '%s' is not in the "
                              "vendored ECS dictionary" % (where, field))
    return errors


def _validate_field(field, where_ds, seen_vendor, ecs_fields, errors):
    fw = "%s field '%s'" % (where_ds, _label(field, "vendor"))
    if not _check_keys(field, REQUIRED["field"], OPTIONAL["field"],
                       fw, errors):
        return
    _check_str(field, "vendor", fw, errors)
    _check_str(field, "status", fw, errors, vocab=FIELD_STATUSES)
    vendor = field.get("vendor")
    if vendor in seen_vendor:
        errors.append("%s: duplicate vendor field" % fw)
    seen_vendor.add(vendor)
    ecs_value = field.get("ecs")
    if ecs_value is not None:
        if not isinstance(ecs_value, str):
            errors.append("%s: 'ecs' must be a string or null" % fw)
        elif ecs_value not in ecs_fields:
            errors.append("%s: ecs field '%s' is not in the vendored ECS "
                          "dictionary" % (fw, ecs_value))


def _validate_recommendations(recs, where, errors):
    rw = "%s recommendations" % where
    if not _check_keys(recs, REQUIRED["recommendations"],
                       OPTIONAL["recommendations"], rw, errors):
        return
    if not recs:
        errors.append("%s: must not be empty" % rw)
        return
    for side in sorted(recs):
        if side not in REC_KEYS:
            continue
        body = recs[side]
        sw = "%s.%s" % (rw, side)
        if not _check_keys(body, REQUIRED["recommendation_side"],
                           REC_KEYS[side], sw, errors):
            continue
        if not body:
            errors.append("%s: must not be empty" % sw)
            continue
        _check_str(body, "parse_location", sw, errors,
                   vocab=PARSE_LOCATIONS, optional=True)
        for key in ("cribl", "elastic", "relay"):
            if key in REC_KEYS[side]:
                _check_str(body, key, sw, errors, optional=True)


def _validate_format(entry, where_ds, seen_formats, ecs_fields, errors):
    """Validate one formats[] entry."""
    fw = "%s format '%s'" % (where_ds, _label(entry, "format"))
    if not _check_keys(entry, REQUIRED["format"], OPTIONAL["format"],
                       fw, errors):
        return
    _check_str(entry, "format", fw, errors, vocab=SOURCE_FORMATS)
    name = entry.get("format")
    if name in seen_formats:
        errors.append("%s: duplicate format" % fw)
    seen_formats.add(name)
    recommended = entry.get("recommended", False)
    if not isinstance(recommended, bool):
        errors.append("%s: 'recommended' must be true or false" % fw)
        recommended = False
    if recommended:
        _check_str(entry, "recommended_because", fw, errors)
    elif "recommended_because" in entry:
        errors.append("%s: 'recommended_because' requires 'recommended: "
                      "true' - a reason with nothing to justify" % fw)
    _check_str(entry, "enable", fw, errors, optional=True)
    if "references" in entry and not (
            isinstance(entry["references"], list)
            and all(isinstance(r, str) for r in entry["references"])):
        errors.append("%s: 'references' must be a list of strings" % fw)
    pw = "%s parsing" % fw
    if _check_keys(entry.get("parsing"), REQUIRED["parsing"],
                   OPTIONAL["parsing"], pw, errors):
        _check_str(entry["parsing"], "mechanism", pw, errors,
                   vocab=MECHANISMS)
    if "recommendations" in entry:
        _validate_recommendations(entry["recommendations"], fw, errors)
    fields = entry.get("fields")
    if not isinstance(fields, list):
        errors.append("%s: 'fields' must be a list" % fw)
    else:
        seen_vendor = set()
        for field in fields:
            _validate_field(field, fw, seen_vendor, ecs_fields, errors)
    # A deliberately empty inventory says so in prose; the rationale is
    # published in place of the table and silences the format-no-fields flag.
    if "fields_omitted" in entry:
        _check_str(entry, "fields_omitted", fw, errors)
        if isinstance(fields, list) and fields:
            errors.append("%s: 'fields_omitted' documents an empty inventory, "
                          "but 'fields' is not empty" % fw)


def _validate_hops(hops, sw, errors):
    guard_hops = 0
    for position, hop in enumerate(hops):
        hw = "%s[%d]" % (sw, position)
        if not isinstance(hop, dict) or "hop" not in hop:
            errors.append("%s: each hop needs a 'hop' key" % hw)
            continue
        kind = hop["hop"]
        if kind not in HOPS:
            errors.append("%s: hop '%s' not one of: %s"
                          % (hw, kind, ", ".join(HOPS)))
            continue
        required, optional = HOP_KEYS[kind]
        _check_keys(hop, required, optional, hw, errors)
        if kind == "guard":
            guard_hops += 1
    return guard_hops


def _validate_route(route, where, errors):
    rw = "%s route" % where
    if not _check_keys(route, REQUIRED["route"], OPTIONAL["route"],
                       rw, errors):
        return
    for side in ("guarded", "direct"):
        if side not in route:
            continue
        hops = route[side]
        sw = "%s.%s" % (rw, side)
        if not isinstance(hops, list) or not hops:
            errors.append("%s: must be a non-empty list" % sw)
            continue
        guard_hops = _validate_hops(hops, sw, errors)
        if side == "guarded" and guard_hops == 0:
            errors.append("%s: guarded route has no guard hop" % sw)
        if side == "direct" and guard_hops:
            errors.append("%s: direct route must not contain a guard hop"
                          % sw)


def _validate_dataset(ds, tech_id, seen_ds, profiles, ecs_fields):
    errors = []
    where = "%s dataset '%s'" % (tech_id, _label(ds, "id"))
    if not _check_keys(ds, REQUIRED["dataset"], OPTIONAL["dataset"],
                       where, errors):
        return errors
    _check_str(ds, "id", where, errors, pattern=SLUG_RE)
    _check_str(ds, "name", where, errors)
    if ds.get("id") in seen_ds:
        errors.append("%s: duplicate dataset id" % where)
    seen_ds.add(ds.get("id"))
    cats = ds.get("event_categories")
    if not isinstance(cats, list) or not cats:
        errors.append("%s: 'event_categories' must be a non-empty list"
                      % where)
    else:
        for cat in cats:
            if cat not in profiles:
                errors.append("%s: event category '%s' has no alerting "
                              "profile" % (where, cat))
    _validate_route(ds.get("route"), where, errors)
    formats = ds.get("formats")
    if not isinstance(formats, list) or not formats:
        errors.append("%s: 'formats' must be a non-empty list" % where)
        return errors
    route = ds.get("route")
    no_guarded_route = isinstance(route, dict) and "guarded" not in route
    seen_formats = set()
    overrides = 0
    for entry in formats:
        _validate_format(entry, where, seen_formats, ecs_fields, errors)
        if isinstance(entry, dict) and entry.get("recommended"):
            overrides += 1
        recs = entry.get("recommendations") if isinstance(entry, dict) else None
        if no_guarded_route and isinstance(recs, dict) and "guarded" in recs:
            errors.append("%s format '%s': guarded recommendations but "
                          "route has no guarded side"
                          % (where, entry.get("format", "?")))
    if overrides > 1:
        errors.append("%s: at most one format may set 'recommended: true' "
                      "(found %d)" % (where, overrides))
    return errors


def validate_technology(doc, expected_id, profiles, ecs_fields):
    errors = []
    where = "technology '%s'" % expected_id
    if not _check_keys(doc, REQUIRED["technology"],
                       OPTIONAL["technology"], where, errors):
        return errors
    if doc.get("id") != expected_id:
        errors.append("%s: id '%s' does not match filename"
                      % (where, doc.get("id")))
    _check_str(doc, "name", where, errors)
    _check_str(doc, "vendor", where, errors)
    if "draft" in doc and not isinstance(doc["draft"], bool):
        errors.append("%s: 'draft' must be true or false" % where)
    if "references" in doc and not (
            isinstance(doc["references"], list)
            and all(isinstance(r, str) for r in doc["references"])):
        errors.append("%s: 'references' must be a list of strings" % where)
    _check_str(doc, "versions", where, errors, optional=True)
    datasets = doc.get("datasets")
    if not isinstance(datasets, list) or not datasets:
        errors.append("%s: 'datasets' must be a non-empty list" % where)
        return errors
    seen_ds = set()
    for ds in datasets:
        errors.extend(_validate_dataset(ds, expected_id, seen_ds,
                                        profiles, ecs_fields))
    return errors


def validate_all(catalog, technologies, profiles_doc, ecs):
    """technologies: {tech_id: parsed doc}. Empty return = valid."""
    ecs_fields = ecs.get("fields", {})
    errors = []
    errors.extend(validate_catalog(catalog))
    errors.extend(validate_profiles(profiles_doc, ecs_fields))
    if errors:
        return errors
    profiles = profiles_doc["profiles"]
    rows = dict((row["id"], row) for row in catalog["technologies"])
    for tech_id in sorted(technologies):
        errors.extend(validate_technology(technologies[tech_id], tech_id,
                                          profiles, ecs_fields))
        if tech_id not in rows:
            errors.append("technology '%s' has a file but no catalog row"
                          % tech_id)
    for tech_id in sorted(rows):
        row = rows[tech_id]
        if row["status"] != "planned" and tech_id not in technologies:
            errors.append("catalog: '%s' is %s but has no "
                          "data/technologies/%s.yml"
                          % (tech_id, row["status"], tech_id))
    return errors
