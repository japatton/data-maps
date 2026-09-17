"""The Python/JavaScript validator parity corpus and its expected answers.

studio/lib/validate.js is a hand-written port of schema.py whose messages
Studio shows the operator as "what the build would say".  This module is
what keeps that promise checkable without Python and Node in one process:
it builds a corpus of documents - a synthetic technology and catalog that
exercise every optional key, then one breakage at a time on top of each -
and records what schema.py says about every one.  `python3 -m
datamaps.studio --write-fixture` writes the corpus and the answers to
studio/tests/fixtures/parity.json; tests/test_studio_parity.py fails when
that file is stale, and studio/tests/parity.test.js fails when the
JavaScript validator disagrees with it.

The answers are computed against the reduced fixture schema (the ECS
dictionary cut down to the tested fields), which is exactly what the
JavaScript test hands its validator, so both sides read the same inputs.

Stdlib only: datamaps.studio imports this, and studio is a seam that must
not pull yaml or jinja2 in.
"""
import copy

from datamaps import schema


def _format(fmt="syslog-cef"):
    return {
        "format": fmt,
        "enable": "set system setting logging cef",
        "references": ["https://example.invalid/cef"],
        "parsing": {"mechanism": "cribl-pack", "artifact": "panw-cef",
                    "notes": "Envelope parsed at the edge."},
        "fields": [
            {"vendor": "src", "type": "ip", "description": "Source address",
             "ecs": "source.ip", "status": "mapped"},
            {"vendor": "flags", "ecs": None, "status": "unmapped",
             "custom": "panw.panos.flags", "notes": "Bit string."},
        ],
        "recommendations": {
            "guarded": {"parse_location": "low", "cribl": "Envelope only",
                        "elastic": "Enrich on ingest",
                        "relay": "Syslog relay"},
            "direct": {"parse_location": "low", "cribl": "Envelope only",
                       "elastic": "Enrich on ingest"},
        },
    }


def _tech():
    """A valid technology document exercising every optional key."""
    return {
        "id": "paloalto-ngfw",
        "name": "Palo Alto NGFW",
        "vendor": "Palo Alto Networks",
        "versions": "PAN-OS 11.1",
        "references": ["https://example.invalid/panos"],
        "datasets": [{
            "id": "traffic",
            "name": "Traffic",
            "description": "Session end records.",
            "event_categories": ["network"],
            "route": {
                "guarded": [
                    {"hop": "cribl", "location": "edge"},
                    {"hop": "guard", "device": "HSG",
                     "constraints": "syslog only"},
                    {"hop": "cribl", "location": "core"},
                    {"hop": "elastic", "data_stream": "logs-panw.traffic"},
                ],
                "direct": [
                    {"hop": "cribl", "location": "core"},
                    {"hop": "elastic", "data_stream": "logs-panw.traffic"},
                ],
            },
            "formats": [_format()],
        }],
    }


def _catalog():
    return {"technologies": [
        {"id": "paloalto-ngfw", "name": "Palo Alto NGFW",
         "vendor": "Palo Alto Networks", "category": "network-security",
         "status": "in-progress", "priority": "core"},
        {"id": "cisco-asa", "name": "Cisco ASA", "vendor": "Cisco",
         "category": "network-security", "status": "mapped",
         "priority": "standard"},
    ]}


def _ds(doc):
    return doc["datasets"][0]


def _fmt(doc):
    return _ds(doc)["formats"][0]


class _Replace(object):
    """Returned by a mutation that swaps the whole document out.

    In-place mutations return whatever the mutating call returns - `pop`
    hands back the popped value - so a replacement has to be marked rather
    than inferred, and None has to be expressible.
    """

    def __init__(self, value):
        self.value = value


def _pop(obj, key):
    """dict.pop as a statement: mutations must not return their leftovers."""
    obj.pop(key)


# The three places the two implementations could differ on input this
# corpus does not reach, and what was done about each:
#
#   * U+FEFF.  JavaScript's String.prototype.trim strips it; Python's
#     str.strip does not.  A name of "\ufeff" alone is therefore blank to
#     the browser and non-blank to the build.  Left as it is: a BOM inside
#     a scalar is a broken file, and the build is the stricter of the two.
#   * U+001C-U+001F.  The mirror image: Python's str.strip treats the file,
#     group, record and unit separators as whitespace and JavaScript's trim
#     does not, so a name of "\x1c" is blank to the build and non-blank to
#     the browser.  Left as it is, for the same reason.
#   * A trailing newline in a slug.  Python's `$` matches before it and
#     JavaScript's does not, so "traffic\n" used to be a valid dataset id
#     to the build alone.  Fixed: schema._check_str matches with fullmatch,
#     and the two mutations below hold it there.
#
# (label, mutate) pairs.  `mutate` edits a fresh deep copy in place, or
# returns _Replace(doc) for the cases where the document itself is the
# wrong shape.
_TECH_MUTATIONS = [
    # An unknown key at every level that has one.
    ("unknown/technology", lambda d: d.update({"colour": "red"})),
    ("unknown/dataset", lambda d: _ds(d).update({"colour": "red"})),
    ("unknown/route", lambda d: _ds(d)["route"].update({"sideways": []})),
    ("unknown/hop",
     lambda d: _ds(d)["route"]["direct"][0].update({"device": "HSG"})),
    ("unknown/format", lambda d: _fmt(d).update({"deployed": True})),
    ("unknown/parsing", lambda d: _fmt(d)["parsing"].update({"pack": "x"})),
    ("unknown/field", lambda d: _fmt(d)["fields"][0].update({"colour": "r"})),
    ("unknown/recommendations",
     lambda d: _fmt(d)["recommendations"].update({"guard": "notes"})),
    ("unknown/recommendation_side",
     lambda d: _fmt(d)["recommendations"]["direct"].update({"relay": "no"})),
    # A missing required key at every level that has one.
    ("missing/technology.name", lambda d: _pop(d, "name")),
    ("missing/technology.datasets", lambda d: _pop(d, "datasets")),
    ("missing/technology.all",
     lambda d: _Replace({"versions": "PAN-OS 11.1"})),
    ("missing/dataset.id", lambda d: _pop(_ds(d), "id")),
    ("missing/dataset.route", lambda d: _pop(_ds(d), "route")),
    ("missing/dataset.formats", lambda d: _pop(_ds(d), "formats")),
    ("missing/route.direct", lambda d: _pop(_ds(d)["route"], "direct")),
    ("missing/hop.hop",
     lambda d: _pop(_ds(d)["route"]["direct"][0], "hop")),
    ("missing/format.parsing", lambda d: _pop(_fmt(d), "parsing")),
    ("missing/format.fields", lambda d: _pop(_fmt(d), "fields")),
    ("missing/parsing.mechanism",
     lambda d: _pop(_fmt(d)["parsing"], "mechanism")),
    ("missing/field.ecs", lambda d: _pop(_fmt(d)["fields"][0], "ecs")),
    ("missing/field.status",
     lambda d: _pop(_fmt(d)["fields"][0], "status")),
    # A value outside its vocabulary, wherever one applies.
    ("vocab/format", lambda d: _fmt(d).update({"format": "carrier-pigeon"})),
    ("vocab/mechanism",
     lambda d: _fmt(d)["parsing"].update({"mechanism": "magic"})),
    ("vocab/hop",
     lambda d: _ds(d)["route"]["direct"][0].update({"hop": "teleport"})),
    ("vocab/hop-not-a-string",
     lambda d: _ds(d)["route"]["direct"][0].update({"hop": 7})),
    ("vocab/field-status",
     lambda d: _fmt(d)["fields"][0].update({"status": "done"})),
    ("vocab/parse-location",
     lambda d: _fmt(d)["recommendations"]["direct"].update(
         {"parse_location": "medium"})),
    ("vocab/event-category",
     lambda d: _ds(d).update({"event_categories": ["telepathy"]})),
    ("vocab/event-category-inherited",
     lambda d: _ds(d).update({"event_categories": ["constructor"]})),
    ("vocab/ecs-field",
     lambda d: _fmt(d)["fields"][0].update({"ecs": "sorce.ip"})),
    ("vocab/ecs-field-inherited",
     lambda d: _fmt(d)["fields"][0].update({"ecs": "hasOwnProperty"})),
    ("vocab/ecs-not-a-string",
     lambda d: _fmt(d)["fields"][0].update({"ecs": 7})),
    ("vocab/dataset-id-slug", lambda d: _ds(d).update({"id": "Traffic Logs"})),
    ("vocab/dataset-id-trailing-newline",
     lambda d: _ds(d).update({"id": "traffic\n"})),
    ("vocab/technology-id", lambda d: d.update({"id": "panw"})),
    # A non-mapping where a mapping belongs, at every level.
    ("shape/technology-is-a-string", lambda d: _Replace("paloalto-ngfw")),
    ("shape/technology-is-a-list", lambda d: _Replace([])),
    ("shape/technology-is-null", lambda d: _Replace(None)),
    ("shape/dataset-is-a-string",
     lambda d: d.update({"datasets": ["traffic"]})),
    ("shape/datasets-not-a-list", lambda d: d.update({"datasets": "traffic"})),
    ("shape/datasets-empty", lambda d: d.update({"datasets": []})),
    ("shape/route-is-a-number", lambda d: _ds(d).update({"route": 5})),
    ("shape/route-side-not-a-list",
     lambda d: _ds(d)["route"].update({"direct": {}})),
    ("shape/route-side-empty",
     lambda d: _ds(d)["route"].update({"guarded": []})),
    ("shape/hop-is-a-string",
     lambda d: _ds(d)["route"]["direct"].__setitem__(0, "cribl")),
    ("shape/format-is-a-string",
     lambda d: _ds(d).update({"formats": ["syslog-cef"]})),
    ("shape/formats-not-a-list", lambda d: _ds(d).update({"formats": {}})),
    ("shape/formats-empty", lambda d: _ds(d).update({"formats": []})),
    ("shape/parsing-is-a-string",
     lambda d: _fmt(d).update({"parsing": "cribl-pack"})),
    ("shape/field-is-a-string",
     lambda d: _fmt(d).update({"fields": ["source.ip"]})),
    ("shape/fields-not-a-list", lambda d: _fmt(d).update({"fields": {}})),
    ("shape/recommendations-is-a-number",
     lambda d: _fmt(d).update({"recommendations": 5})),
    ("shape/recommendations-empty",
     lambda d: _fmt(d).update({"recommendations": {}})),
    ("shape/recommendation-side-is-a-number",
     lambda d: _fmt(d)["recommendations"].update({"direct": 5})),
    ("shape/recommendation-side-empty",
     lambda d: _fmt(d)["recommendations"].update({"direct": {}})),
    ("shape/draft-not-a-bool", lambda d: d.update({"draft": "yes"})),
    ("shape/references-not-strings", lambda d: d.update({"references": [1]})),
    ("shape/format-references-not-strings",
     lambda d: _fmt(d).update({"references": [1]})),
    ("shape/versions-is-a-list",
     lambda d: d.update({"versions": ["11.1", "10.2"]})),
    ("shape/name-is-null", lambda d: d.update({"name": None})),
    ("shape/name-is-blank", lambda d: d.update({"name": "   "})),
    ("shape/enable-is-a-number", lambda d: _fmt(d).update({"enable": 5})),
    ("shape/event-categories-empty",
     lambda d: _ds(d).update({"event_categories": []})),
    # Duplicates.
    ("duplicate/dataset-id",
     lambda d: d["datasets"].append(copy.deepcopy(_ds(d)))),
    ("duplicate/vendor-field",
     lambda d: _fmt(d)["fields"].append(
         {"vendor": "src", "ecs": "destination.ip", "status": "mapped"})),
    ("duplicate/format",
     lambda d: _ds(d)["formats"].append(_format())),
    # The recommendation override.
    ("override/without-a-reason",
     lambda d: _fmt(d).update({"recommended": True})),
    ("override/reason-without-the-override",
     lambda d: _fmt(d).update({"recommended_because": "LEEF is unpublished"})),
    ("override/blank-reason",
     lambda d: _fmt(d).update({"recommended": True,
                               "recommended_because": "  "})),
    ("override/not-a-bool", lambda d: _fmt(d).update({"recommended": "yes"})),
    ("override/two-on-one-dataset", lambda d: _two_overrides(d)),
    # Route and recommendation agreement.
    ("route/guarded-recs-without-a-guarded-route",
     lambda d: _pop(_ds(d)["route"], "guarded")),
    ("route/guarded-without-a-guard-hop",
     lambda d: _ds(d)["route"].update({"guarded": [
         {"hop": "cribl", "location": "core"},
         {"hop": "elastic", "data_stream": "logs-panw.traffic"}]})),
    ("route/direct-with-a-guard-hop",
     lambda d: _ds(d)["route"]["direct"].insert(
         1, {"hop": "guard", "device": "HSG"})),
    # fields_omitted.
    ("omitted/with-fields",
     lambda d: _fmt(d).update({"fields_omitted": "Operator-defined."})),
    ("omitted/blank",
     lambda d: _fmt(d).update({"fields": [], "fields_omitted": "   "})),
    ("omitted/valid",
     lambda d: _fmt(d).update({"fields": [],
                               "fields_omitted": "Free-form."})),
]


def _two_overrides(doc):
    first = _format()
    first.update({"recommended": True, "recommended_because": "one"})
    second = _format("syslog-leef")
    second.update({"recommended": True, "recommended_because": "two"})
    _ds(doc)["formats"] = [first, second]


_CATALOG_MUTATIONS = [
    ("catalog/unknown-top-key", lambda d: d.update({"colour": "red"})),
    ("catalog/missing-technologies", lambda d: _pop(d, "technologies")),
    ("catalog/not-a-mapping", lambda d: _Replace("technologies")),
    ("catalog/technologies-not-a-list",
     lambda d: d.update({"technologies": {}})),
    ("catalog/technologies-empty", lambda d: d.update({"technologies": []})),
    ("catalog/row-not-a-mapping",
     lambda d: d["technologies"].__setitem__(0, "paloalto-ngfw")),
    ("catalog/row-unknown-key",
     lambda d: d["technologies"][0].update({"owner": "csoc"})),
    ("catalog/row-missing-keys",
     lambda d: _pop(d["technologies"][0], "vendor")),
    ("catalog/row-missing-all",
     lambda d: d.update({"technologies": [{}]})),
    ("catalog/bad-category",
     lambda d: d["technologies"][0].update({"category": "networking"})),
    ("catalog/bad-status",
     lambda d: d["technologies"][0].update({"status": "done"})),
    ("catalog/bad-priority",
     lambda d: d["technologies"][0].update({"priority": "urgent"})),
    ("catalog/bad-slug",
     lambda d: d["technologies"][0].update({"id": "Palo Alto"})),
    ("catalog/slug-trailing-newline",
     lambda d: d["technologies"][0].update({"id": "paloalto-ngfw\n"})),
    ("catalog/id-not-a-string",
     lambda d: d["technologies"][0].update({"id": 7})),
    ("catalog/duplicate-id",
     lambda d: d["technologies"][1].update({"id": "paloalto-ngfw"})),
]


def _apply(doc, mutate):
    """A deep copy with `mutate` applied, or the document it replaced it by."""
    copied = copy.deepcopy(doc)
    result = mutate(copied)
    return result.value if isinstance(result, _Replace) else copied


def _mutations(doc):
    """One-mutation-at-a-time breakages of a technology document."""
    return [(label, _apply(doc, mutate)) for label, mutate in _TECH_MUTATIONS]


def _catalog_mutations(doc):
    return [(label, _apply(doc, mutate)) for label, mutate in
            _CATALOG_MUTATIONS]


def corpus():
    """Every synthetic case, in the order the fixture and the tests use.

    A case is {kind, id?, doc, label}: `id` is the expected technology id
    and is absent on a catalog case.
    """
    cases = [
        {"kind": "technology", "id": "paloalto-ngfw", "doc": _tech(),
         "label": "base/technology"},
        {"kind": "catalog", "doc": _catalog(), "label": "base/catalog"},
    ]
    for label, doc in _mutations(_tech()):
        cases.append({"kind": "technology", "id": "paloalto-ngfw",
                      "doc": doc, "label": label})
    for label, doc in _catalog_mutations(_catalog()):
        cases.append({"kind": "catalog", "doc": doc, "label": label})
    return cases


# Mutations that validate clean on purpose; every other one must break
# something, or it proves nothing.
CLEAN_MUTATIONS = ("omitted/valid",)

MUTATION_LABELS = ([label for label, _ in _TECH_MUTATIONS]
                   + [label for label, _ in _CATALOG_MUTATIONS])


def messages(case, profiles, ecs_fields):
    """What schema.py says about one case, as the JS port would list it."""
    if case["kind"] == "catalog":
        return schema.validate_catalog(case["doc"])
    return schema.validate_technology(case["doc"], case["id"], profiles,
                                      ecs_fields)


def fixture(schema_doc):
    """{cases, expected} for studio/tests/fixtures/parity.json.

    `schema_doc` is the reduced fixture schema: its `profiles` are the
    {name: [required]} lists the browser reads, and its `ecs` is the cut-down
    dictionary, so the answers here are the answers the JavaScript test
    must reproduce from the same file.
    """
    profiles = dict((name, {"required": list(required)})
                    for name, required in schema_doc["profiles"].items())
    cases = corpus()
    return {
        "cases": cases,
        "expected": [messages(case, profiles, schema_doc["ecs"])
                     for case in cases],
    }
