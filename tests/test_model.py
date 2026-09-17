import copy
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import model

ECS = {"ecs_version": "8.11.0", "fields": {
    "source.ip": {"type": "ip", "short": "src"},
    "destination.ip": {"type": "ip", "short": "dst"},
    "event.action": {"type": "keyword", "short": "act"},
    "user.name": {"type": "keyword", "short": "user"},
    "event.outcome": {"type": "keyword", "short": "out"},
}}

PROFILES = {"profiles": {
    "network": {"required": ["source.ip", "destination.ip",
                             "event.action"]},
    "authentication": {"required": ["user.name", "event.outcome"]},
}}


def row(tech_id, status="in-progress", name=None):
    return {"id": tech_id, "name": name or tech_id.title(),
            "vendor": "V", "category": "network-security",
            "status": status, "priority": "core"}


def catalog(rows=None):
    return {"technologies": rows if rows is not None else [
        {"id": "paloalto-ngfw", "name": "Palo Alto NGFW",
         "vendor": "Palo Alto Networks", "category": "network-security",
         "status": "in-progress", "priority": "core"}]}


def fmt_entry(format="syslog-cef", mechanism="cribl-pack",
              fields=None, **extra):
    entry = {
        "format": format,
        "parsing": {"mechanism": mechanism},
        "recommendations": {"direct": {"parse_location": "low"}},
        "fields": fields if fields is not None else [
            {"vendor": "src", "ecs": "source.ip", "status": "mapped"}],
    }
    entry.update(extra)
    return entry


def field(vendor, ecs, status="mapped", custom=None):
    out = {"vendor": vendor, "ecs": ecs, "status": status}
    if custom:
        out["custom"] = custom
    return out


def dataset(ds_id="traffic", cats=("network",), fields=None, route=None,
            mechanism="cribl-pack", formats=None):
    if formats is None:
        formats = [fmt_entry(mechanism=mechanism,
                             fields=fields if fields is not None else [])]
    return {"id": ds_id, "name": ds_id.title(),
            "event_categories": list(cats),
            "route": route if route is not None else {
                "direct": [{"hop": "cribl"},
                           {"hop": "elastic",
                            "data_stream": "logs-x." + ds_id}]},
            "formats": formats}


def tech():
    doc = {"id": "paloalto-ngfw", "name": "Palo Alto NGFW", "vendor": "V",
           "datasets": [dataset()]}
    return doc


def tech_doc(tech_id, datasets, draft=False):
    doc = {"id": tech_id, "name": tech_id.title(), "vendor": "V",
           "datasets": datasets}
    if draft:
        doc["draft"] = True
    return doc


def build(rows, techs):
    return model.build_model({"technologies": rows}, techs,
                             copy.deepcopy(PROFILES), ECS)


class TestCoverageAndAlerting(unittest.TestCase):
    def test_derived_alerting_and_required_pct(self):
        doc = tech_doc("fw", [dataset(fields=[
            field("src", "source.ip"),
            field("dst", "destination.ip", status="partial"),
            field("act", "event.action"),
            field("misc", None, status="unmapped"),
        ])])
        m = build([row("fw")], {"fw": doc})
        view = m["technologies"][0]
        ds = view["datasets"][0]
        self.assertEqual(ds["required"],
                         ["destination.ip", "event.action", "source.ip"])
        # partial does not count toward required coverage
        self.assertEqual(ds["required_mapped"],
                         ["event.action", "source.ip"])
        self.assertEqual(ds["required_pct"], 67)
        alerting = dict((fv["field"]["vendor"], fv["alerting"])
                        for fv in ds["fields"])
        self.assertTrue(alerting["src"])
        self.assertTrue(alerting["dst"])
        self.assertFalse(alerting["misc"])
        self.assertEqual(view["required_pct"], 67)
        self.assertEqual(view["fields_mapped"], 2)
        self.assertEqual(view["fields_total"], 4)

    def test_multi_category_union(self):
        doc = tech_doc("vpn", [dataset(cats=("network", "authentication"),
                                       fields=[field("u", "user.name")])])
        m = build([row("vpn")], {"vpn": doc})
        ds = m["technologies"][0]["datasets"][0]
        self.assertEqual(len(ds["required"]), 5)
        self.assertEqual(ds["required_mapped"], ["user.name"])

    def test_stub_technology_zeroes(self):
        m = build([row("stub", status="planned")], {})
        view = m["technologies"][0]
        self.assertIsNone(view["doc"])
        self.assertEqual(view["required_pct"], 0)
        self.assertEqual(view["datasets"], [])


class TestOrderingAndSummary(unittest.TestCase):
    def test_status_then_name_order(self):
        rows = [row("zeta", status="mapped"),
                row("alpha", status="planned"),
                row("beta", status="in-progress")]
        techs = {"zeta": tech_doc("zeta", [dataset(fields=[
                    field("s", "source.ip")])]),
                 "beta": tech_doc("beta", [dataset()])}
        m = build(rows, techs)
        self.assertEqual([v["entry"]["id"] for v in m["technologies"]],
                         ["beta", "zeta", "alpha"])
        self.assertEqual(m["summary"]["by_status"]["planned"], 1)
        self.assertEqual(m["summary"]["technologies"], 3)

    def test_draft_rollup(self):
        techs = {"fw": tech_doc("fw", [dataset()], draft=True)}
        m = build([row("fw")], techs)
        self.assertTrue(m["technologies"][0]["draft"])
        self.assertEqual(m["summary"]["drafts"], 1)


class TestEcsIndex(unittest.TestCase):
    def test_reverse_index_and_gap_list(self):
        techs = {"fw": tech_doc("fw", [dataset(fields=[
            field("src", "source.ip"),
            field("act", "event.action", status="partial")])])}
        m = build([row("fw")], techs)
        index = dict((e["name"], e) for e in m["ecs_index"])
        self.assertIn("source.ip", index)
        usage = index["source.ip"]["usages"][0]
        self.assertEqual(usage["vendor"], "src")
        self.assertEqual(usage["dataset"], "traffic")
        # event.action only partial -> still required-unmapped
        self.assertIn("event.action", m["unmapped_required"])
        self.assertIn("user.name", m["unmapped_required"])
        self.assertNotIn("source.ip", m["unmapped_required"])

    def test_usage_names_its_format_and_whether_it_is_recommended(self):
        techs = {"fw": tech_doc("fw", [dataset(fields=[
            field("src", "source.ip")])])}
        m = build([row("fw")], techs)
        usage = m["ecs_index"][0]["usages"][0]
        self.assertEqual(usage["format"], "syslog-cef")
        self.assertTrue(usage["recommended"])

    def test_required_in_names_the_categories_that_require_the_field(self):
        techs = {"fw": tech_doc("fw", [dataset(
            cats=("network", "authentication"),
            fields=[field("src", "source.ip"),
                    field("u", "user.name"),
                    field("misc", "host.name")])])}
        m = build([row("fw")], techs)
        index = dict((e["name"], e) for e in m["ecs_index"])
        self.assertEqual(index["source.ip"]["required_in"], ["network"])
        self.assertEqual(index["user.name"]["required_in"],
                         ["authentication"])
        # a field no profile asks for carries an empty list, not a None
        self.assertEqual(index["host.name"]["required_in"], [])


def auth_dataset(ds_id, formats):
    return dataset(ds_id=ds_id, cats=("authentication",), formats=formats)


class TestAlertingMatrix(unittest.TestCase):
    """One row per required field, read on the recommended format alone."""

    def matrix(self):
        full = auth_dataset("full", [fmt_entry(fields=[
            field("u", "user.name"), field("o", "event.outcome")])])
        # the recommended entry reaches event.outcome only partially; the
        # entry that maps it cleanly is not the one we recommend
        part = auth_dataset("part", [
            fmt_entry(recommended=True, fields=[
                field("u", "user.name"),
                field("o", "event.outcome", status="partial")]),
            fmt_entry(format="syslog-leef", fields=[
                field("o", "event.outcome")])])
        gap = auth_dataset("gap", [fmt_entry(fields=[
            field("u", "user.name")])])
        m = build([row("fw")], {"fw": tech_doc("fw", [full, part, gap])})
        return m, dict((c["category"], c) for c in m["alerting_matrix"])

    def test_one_entry_per_category_in_profile_order(self):
        m, _ = self.matrix()
        self.assertEqual([c["category"] for c in m["alerting_matrix"]],
                         ["network", "authentication"])

    def test_counts_datasets_and_the_ones_that_satisfy_everything(self):
        _, by_cat = self.matrix()
        auth = by_cat["authentication"]
        self.assertEqual(auth["datasets"], 3)
        self.assertEqual(auth["all_satisfied"], 1)
        # no dataset carries the network category at all
        self.assertEqual(by_cat["network"]["datasets"], 0)
        self.assertEqual(by_cat["network"]["all_satisfied"], 0)

    def test_required_fields_are_listed_in_profile_order(self):
        _, by_cat = self.matrix()
        self.assertEqual([r["field"]
                          for r in by_cat["authentication"]["required"]],
                         ["user.name", "event.outcome"])

    def test_buckets_split_satisfied_partial_and_missing(self):
        _, by_cat = self.matrix()
        rows = dict((r["field"], r)
                    for r in by_cat["authentication"]["required"])
        outcome = rows["event.outcome"]
        self.assertEqual(outcome["satisfied"],
                         [{"tech": "fw", "dataset": "full"}])
        self.assertEqual(outcome["partial"],
                         [{"tech": "fw", "dataset": "part"}])
        self.assertEqual(outcome["missing"],
                         [{"tech": "fw", "dataset": "gap"}])
        self.assertEqual([c["dataset"]
                          for c in rows["user.name"]["satisfied"]],
                         ["full", "part", "gap"])
        self.assertEqual(rows["user.name"]["missing"], [])


class TestFlags(unittest.TestCase):
    def codes(self, rows, techs):
        return [f["code"] for f in build(rows, techs)["flags"]]

    def test_empty_dataset_flag(self):
        techs = {"fw": tech_doc("fw", [dataset(fields=[])])}
        self.assertIn("empty-dataset", self.codes([row("fw")], techs))

    def test_unparsed_mapped_flag(self):
        techs = {"fw": tech_doc("fw", [dataset(
            mechanism="none", fields=[field("s", "source.ip")])])}
        self.assertIn("unparsed-mapped",
                      self.codes([row("fw", status="mapped")], techs))
        self.assertNotIn("unparsed-mapped",
                         self.codes([row("fw")], techs))

    def test_guard_without_constraints(self):
        ds = dataset(fields=[field("s", "source.ip")],
                     route={"guarded": [{"hop": "guard", "device": "HSG"},
                                        {"hop": "elastic"}],
                            "direct": [{"hop": "cribl"},
                                       {"hop": "elastic"}]})
        techs = {"fw": tech_doc("fw", [ds])}
        self.assertIn("guard-no-constraints", self.codes([row("fw")], techs))

    def test_custom_namespace_shape(self):
        techs = {"fw": tech_doc("fw", [dataset(fields=[
            field("x", None, status="unmapped", custom="Bad Namespace")])])}
        self.assertIn("custom-namespace-shape",
                      self.codes([row("fw")], techs))
        techs2 = {"fw": tech_doc("fw", [dataset(fields=[
            field("x", None, status="unmapped",
                  custom="panw.panos.flags")])])}
        self.assertNotIn("custom-namespace-shape",
                         self.codes([row("fw")], techs2))


class TestFormatViews(unittest.TestCase):
    def view(self, formats):
        doc = tech()
        doc["datasets"][0]["formats"] = formats
        m = model.build_model(catalog(), {"paloalto-ngfw": doc},
                              copy.deepcopy(PROFILES), ECS)
        return m, m["technologies"][0]["datasets"][0]

    def test_per_format_coverage_and_recommendation_rollup(self):
        cef = fmt_entry()  # maps source.ip only
        leef = fmt_entry(format="syslog-leef", fields=[
            {"vendor": "src", "ecs": "source.ip", "status": "mapped"},
            {"vendor": "dst", "ecs": "destination.ip",
             "status": "mapped"}])
        m, ds = self.view([cef, leef])
        self.assertEqual(len(ds["formats"]), 2)
        # leef covers more required fields, so it is the recommendation
        self.assertIs(ds["recommendation"], ds["formats"][1])
        by_fmt = dict((fv["data"]["format"], fv) for fv in ds["formats"])
        self.assertEqual(by_fmt["syslog-cef"]["fields_mapped"], 1)
        # dataset-level keys mirror the recommended entry only
        self.assertEqual(ds["fields_mapped"], 2)
        self.assertEqual(ds["fields_total"], 2)

    def test_fields_omitted_suppresses_the_no_fields_flag(self):
        leef = fmt_entry(format="syslog-leef", fields=[])
        leef["fields_omitted"] = ("Same columns as the deployed JSON, "
                                  "serialized as flat pairs.")
        m, _ = self.view([fmt_entry(), leef])
        codes = [f["code"] for f in m["flags"]]
        self.assertNotIn("format-no-fields", codes)

    def test_ecs_index_reads_every_entry_and_marks_the_recommended_one(self):
        # tied required-coverage; declaration order keeps cef recommended
        leef = fmt_entry(format="syslog-leef", fields=[
            {"vendor": "dst", "ecs": "destination.ip",
             "status": "mapped"}])
        m, _ = self.view([fmt_entry(), leef])
        index = dict((row["name"], row) for row in m["ecs_index"])
        self.assertIn("source.ip", index)
        # the alternative format is listed, flagged as not recommended
        self.assertIn("destination.ip", index)
        recommended = dict(
            (name, [u["recommended"] for u in index[name]["usages"]])
            for name in index)
        self.assertEqual(recommended["source.ip"], [True])
        self.assertEqual(recommended["destination.ip"], [False])
        self.assertEqual(index["destination.ip"]["usages"][0]["format"],
                         "syslog-leef")

    def test_a_non_recommended_mapping_does_not_close_a_gap(self):
        """destination.ip lives on the entry nobody was told to use."""
        leef = fmt_entry(format="syslog-leef", fields=[
            {"vendor": "dst", "ecs": "destination.ip",
             "status": "mapped"}])
        m, _ = self.view([fmt_entry(), leef])
        self.assertNotIn("destination.ip", m["unmapped_required"])
        self.assertIn("destination.ip", m["closable_required"])

    def test_format_no_fields_flag_on_non_recommended_format(self):
        leef = fmt_entry(format="syslog-leef", fields=[])
        m, _ = self.view([fmt_entry(), leef])
        codes = [f["code"] for f in m["flags"]]
        self.assertIn("format-no-fields", codes)
        self.assertNotIn("empty-dataset", codes)


def example_rec(label="example", size=10, dataset="traffic"):
    return {"tech": "paloalto-ngfw", "dataset": dataset, "label": label,
            "path": "/tmp/x.log",
            "relpath": "paloalto-ngfw/traffic.log",
            "size": size, "text": "x", "truncated": False}


class TestExamplesInModel(unittest.TestCase):
    def build(self, examples=None):
        doc = tech()
        return model.build_model(catalog(), {"paloalto-ngfw": doc},
                                 copy.deepcopy(PROFILES), ECS, examples)

    def test_datasets_default_to_no_examples(self):
        m = self.build()
        self.assertEqual(m["technologies"][0]["datasets"][0]["examples"],
                         [])

    def test_examples_attach_to_their_dataset(self):
        m = self.build({("paloalto-ngfw", "traffic"): [example_rec()]})
        ds = m["technologies"][0]["datasets"][0]
        self.assertEqual(len(ds["examples"]), 1)
        self.assertEqual(ds["examples"][0]["label"], "example")

    def test_empty_example_is_flagged(self):
        m = self.build({("paloalto-ngfw", "traffic"):
                        [example_rec(size=0)]})
        codes = [f["code"] for f in m["flags"]]
        self.assertIn("example-empty", codes)

    def test_oversize_example_is_flagged(self):
        m = self.build({("paloalto-ngfw", "traffic"):
                        [example_rec(size=300000)]})
        codes = [f["code"] for f in m["flags"]]
        self.assertIn("example-oversize", codes)

    def test_ordinary_example_raises_no_flag(self):
        m = self.build({("paloalto-ngfw", "traffic"): [example_rec()]})
        codes = [f["code"] for f in m["flags"]]
        self.assertNotIn("example-empty", codes)
        self.assertNotIn("example-oversize", codes)


class TestRankingAndDoctrine(unittest.TestCase):
    def fv(self, name, req, total=1, mapped=1, **data):
        entry = {"format": name, "parsing": {"mechanism": "cribl-pipeline"},
                 "fields": []}
        entry.update(data)
        return {"data": entry, "required_mapped": req,
                "fields_total": total, "fields_mapped": mapped}

    def test_ranks_by_alerting_coverage(self):
        a = self.fv("syslog-cef", ["source.ip"])
        b = self.fv("json", ["source.ip", "user.name"])
        self.assertEqual(
            [v["data"]["format"] for v in model._rank_formats([a, b])],
            ["json", "syslog-cef"])

    def test_inventory_beats_empty_on_a_tie(self):
        empty = self.fv("syslog-leef", [], total=0, mapped=0)
        full = self.fv("json", [], total=9, mapped=4)
        self.assertEqual(
            [v["data"]["format"] for v in model._rank_formats([empty, full])],
            ["json", "syslog-leef"])

    def test_existing_parser_breaks_a_coverage_and_inventory_tie(self):
        pipeline = self.fv("syslog-cef", ["source.ip"], total=9, mapped=7)
        packed = self.fv("json", ["source.ip"], total=9, mapped=4,
                         parsing={"mechanism": "cribl-pack"})
        self.assertEqual(
            [v["data"]["format"]
             for v in model._rank_formats([pipeline, packed])],
            ["json", "syslog-cef"])
        integration = self.fv("ndjson", ["source.ip"], total=9, mapped=4,
                              parsing={"mechanism": "elastic-integration"})
        self.assertEqual(
            [v["data"]["format"]
             for v in model._rank_formats([pipeline, integration])],
            ["ndjson", "syslog-cef"])

    def test_existing_parser_does_not_beat_higher_coverage(self):
        covering = self.fv("syslog-cef", ["source.ip", "user.name"])
        packed = self.fv("json", ["source.ip"],
                         parsing={"mechanism": "cribl-pack"})
        self.assertEqual(
            [v["data"]["format"]
             for v in model._rank_formats([packed, covering])],
            ["syslog-cef", "json"])

    def test_existing_parser_does_not_beat_a_field_inventory(self):
        empty = self.fv("json", [], total=0, mapped=0,
                        parsing={"mechanism": "elastic-integration"})
        full = self.fv("syslog-cef", [], total=9, mapped=4)
        self.assertEqual(
            [v["data"]["format"] for v in model._rank_formats([empty, full])],
            ["syslog-cef", "json"])

    def test_total_mapped_breaks_a_further_tie(self):
        few = self.fv("syslog-cef", [], total=9, mapped=2)
        many = self.fv("json", [], total=9, mapped=7)
        self.assertEqual(
            [v["data"]["format"] for v in model._rank_formats([few, many])],
            ["json", "syslog-cef"])

    def test_declaration_order_is_the_final_tiebreak(self):
        a = self.fv("syslog-cef", [], total=2, mapped=1)
        b = self.fv("json", [], total=2, mapped=1)
        self.assertEqual(
            [v["data"]["format"] for v in model._rank_formats([a, b])],
            ["syslog-cef", "json"])

    def test_single_format_is_only_format(self):
        only = self.fv("json", ["source.ip"])
        rec, source = model._recommendation([only])
        self.assertIs(rec, only)
        self.assertEqual(source, "only-format")

    def test_computed_recommendation_is_the_top_rank(self):
        a = self.fv("syslog-cef", ["source.ip"])
        b = self.fv("json", ["source.ip", "user.name"])
        rec, source = model._recommendation([a, b])
        self.assertIs(rec, b)
        self.assertEqual(source, "computed")

    def test_override_wins_over_the_ranking(self):
        a = self.fv("syslog-cef", ["source.ip"], recommended=True,
                    recommended_because="LEEF keys are unpublished")
        b = self.fv("json", ["source.ip", "user.name"])
        rec, source = model._recommendation([a, b])
        self.assertIs(rec, a)
        self.assertEqual(source, "override")

    def test_doctrine_rules(self):
        integ = {"format": "json", "parsing": {"mechanism":
                                               "elastic-integration"}}
        cef = {"format": "syslog-cef", "parsing": {"mechanism":
                                                   "cribl-pipeline"}}
        leef = {"format": "syslog-leef", "parsing": {"mechanism":
                                                     "cribl-pack"}}
        none = {"format": "json", "parsing": {"mechanism": "none"}}
        self.assertEqual(model._parse_doctrine(integ), "high")
        self.assertEqual(model._parse_doctrine(cef), "low")
        self.assertEqual(model._parse_doctrine(leef), "low")
        self.assertEqual(model._parse_doctrine(none), "low")

    def test_doctrine_abstains_on_a_judgment_call(self):
        pipeline = {"format": "json",
                    "parsing": {"mechanism": "cribl-pipeline"}}
        self.assertIsNone(model._parse_doctrine(pipeline))


class TestRecommendationDrivesRollups(unittest.TestCase):
    def build(self, formats):
        doc = tech()
        doc["datasets"][0]["formats"] = formats
        m = model.build_model(catalog(), {"paloalto-ngfw": doc},
                              copy.deepcopy(PROFILES), ECS)
        return m, m["technologies"][0]["datasets"][0]

    def test_view_exposes_the_recommendation(self):
        m, ds = self.build([fmt_entry()])
        self.assertEqual(ds["recommendation_source"], "only-format")
        self.assertIs(ds["recommendation"], ds["formats"][0])

    def test_rollups_follow_the_better_format(self):
        poor = fmt_entry(fields=[
            {"vendor": "src", "ecs": "source.ip", "status": "mapped"}])
        rich = fmt_entry(format="syslog-leef", fields=[
            {"vendor": "src", "ecs": "source.ip", "status": "mapped"},
            {"vendor": "dst", "ecs": "destination.ip", "status": "mapped"},
            {"vendor": "act", "ecs": "event.action", "status": "mapped"}])
        m, ds = self.build([poor, rich])
        self.assertEqual(ds["recommendation"]["data"]["format"],
                         "syslog-leef")
        self.assertEqual(len(ds["required_mapped"]), 3)

    def test_ecs_index_marks_which_usage_is_the_recommendation(self):
        poor = fmt_entry(fields=[
            {"vendor": "src", "ecs": "source.ip", "status": "mapped"}])
        rich = fmt_entry(format="syslog-leef", fields=[
            {"vendor": "dst", "ecs": "destination.ip", "status": "mapped"},
            {"vendor": "act", "ecs": "event.action", "status": "mapped"}])
        m, _ = self.build([poor, rich])
        index = dict((row["name"], row) for row in m["ecs_index"])
        self.assertEqual([u["recommended"]
                          for u in index["destination.ip"]["usages"]], [True])
        self.assertEqual([u["recommended"]
                          for u in index["source.ip"]["usages"]], [False])
        self.assertEqual(index["source.ip"]["usages"][0]["format"],
                         "syslog-cef")

    def test_format_no_fields_now_covers_every_format(self):
        only = fmt_entry(fields=[])
        m, _ = self.build([only])
        codes = [f["code"] for f in m["flags"]]
        self.assertIn("format-no-fields", codes)

    def test_rationale_still_silences_it(self):
        only = fmt_entry(fields=[])
        only["fields_omitted"] = "vendor publishes no field reference"
        m, _ = self.build([only])
        self.assertNotIn("format-no-fields",
                         [f["code"] for f in m["flags"]])


class TestParseDoctrineFlag(unittest.TestCase):
    def build(self, mechanism, parse_location, fmt="json"):
        doc = tech()
        entry = fmt_entry(format=fmt, mechanism=mechanism)
        entry["recommendations"].setdefault("guarded", {})
        for side in ("guarded", "direct"):
            entry["recommendations"][side]["parse_location"] = parse_location
        doc["datasets"][0]["formats"] = [entry]
        return model.build_model(catalog(), {"paloalto-ngfw": doc},
                                 copy.deepcopy(PROFILES), ECS)

    def test_agreement_raises_no_flag(self):
        m = self.build("elastic-integration", "high")
        self.assertNotIn("parse-location-vs-doctrine",
                         [f["code"] for f in m["flags"]])

    def test_disagreement_raises_the_flag(self):
        m = self.build("elastic-integration", "low")
        self.assertIn("parse-location-vs-doctrine",
                      [f["code"] for f in m["flags"]])

    def test_abstention_never_raises_the_flag(self):
        m = self.build("cribl-pipeline", "high")
        self.assertNotIn("parse-location-vs-doctrine",
                         [f["code"] for f in m["flags"]])

    def test_view_exposes_doctrine_and_agreement(self):
        m = self.build("elastic-integration", "low")
        fv = m["technologies"][0]["datasets"][0]["formats"][0]
        self.assertEqual(fv["parse_doctrine"]["guarded"], "high")
        self.assertFalse(fv["parse_agrees"]["guarded"])

    def test_abstention_reports_none_not_false(self):
        m = self.build("cribl-pipeline", "high")
        fv = m["technologies"][0]["datasets"][0]["formats"][0]
        self.assertIsNone(fv["parse_doctrine"]["guarded"])
        self.assertIsNone(fv["parse_agrees"]["guarded"])


class TestSwitchGainAndChoice(unittest.TestCase):
    def build(self, formats):
        doc = tech()
        doc["datasets"][0]["formats"] = formats
        m = model.build_model(catalog(), {"paloalto-ngfw": doc},
                              copy.deepcopy(PROFILES), ECS)
        return m, m["technologies"][0], m["technologies"][0]["datasets"][0]

    def test_no_gain_when_the_recommendation_is_best(self):
        rich = fmt_entry(fields=[
            {"vendor": "s", "ecs": "source.ip", "status": "mapped"},
            {"vendor": "d", "ecs": "destination.ip", "status": "mapped"}])
        poor = fmt_entry(format="syslog-leef", fields=[])
        poor["fields_omitted"] = "unpublished"
        _, _, ds = self.build([rich, poor])
        self.assertIsNone(ds["switch_gain"])

    def test_no_gain_reported_when_an_override_is_in_force(self):
        poor = fmt_entry(recommended=True,
                         recommended_because="only sourced option",
                         fields=[{"vendor": "s", "ecs": "source.ip",
                                  "status": "mapped"}])
        rich = fmt_entry(format="syslog-leef", fields=[
            {"vendor": "s", "ecs": "source.ip", "status": "mapped"},
            {"vendor": "d", "ecs": "destination.ip", "status": "mapped"}])
        _, _, ds = self.build([poor, rich])
        self.assertIsNone(ds["switch_gain"])  # override states the reason

    def test_coverage_favours_is_none_without_an_override(self):
        a = fmt_entry(fields=[
            {"vendor": "s", "ecs": "source.ip", "status": "mapped"}])
        b = fmt_entry(format="syslog-leef", fields=[])
        _, _, ds = self.build([a, b])
        self.assertIsNone(ds["coverage_favours"])

    def test_coverage_favours_names_the_better_format_under_an_override(self):
        poor = fmt_entry(recommended=True,
                         recommended_because="only sourced option",
                         fields=[])
        rich = fmt_entry(format="syslog-leef", fields=[
            {"vendor": "s", "ecs": "source.ip", "status": "mapped"}])
        _, _, ds = self.build([poor, rich])
        self.assertEqual(ds["coverage_favours"]["data"]["format"],
                         "syslog-leef")

    def test_gain_reported_when_the_ranking_picked(self):
        # equal alerting coverage, so declaration order decides; the
        # second entry maps a required field the first does not
        a = fmt_entry(fields=[
            {"vendor": "s", "ecs": "source.ip", "status": "mapped"}])
        b = fmt_entry(format="syslog-leef", fields=[
            {"vendor": "d", "ecs": "destination.ip", "status": "mapped"}])
        _, _, ds = self.build([a, b])
        self.assertEqual(ds["switch_gain"]["format"], "syslog-leef")
        self.assertEqual(ds["switch_gain"]["fields"], ["destination.ip"])

    def test_gain_skips_a_higher_ranked_format_that_adds_nothing(self):
        # three formats: the recommendation maps source.ip; the
        # second-ranked entry also maps only source.ip (a larger field
        # inventory keeps it genuinely ranked above the third, but it
        # adds nothing new); the third maps destination.ip. switch_gain
        # must name the third format, not stop at the second.
        rec = fmt_entry(fields=[
            {"vendor": "s", "ecs": "source.ip", "status": "mapped"}])
        second = fmt_entry(format="syslog-leef", fields=[
            {"vendor": "s", "ecs": "source.ip", "status": "mapped"},
            {"vendor": "x", "ecs": None, "status": "unmapped"}])
        third = fmt_entry(format="json", fields=[
            {"vendor": "d", "ecs": "destination.ip", "status": "mapped"}])
        _, _, ds = self.build([rec, second, third])
        self.assertEqual(ds["switch_gain"]["format"], "json")
        self.assertEqual(ds["switch_gain"]["fields"], ["destination.ip"])

    def test_gap_split(self):
        a = fmt_entry(fields=[
            {"vendor": "s", "ecs": "source.ip", "status": "mapped"}])
        b = fmt_entry(format="syslog-leef", fields=[
            {"vendor": "d", "ecs": "destination.ip", "status": "mapped"}])
        _, _, ds = self.build([a, b])
        self.assertIn("destination.ip", ds["closable"])
        self.assertIn("event.action", ds["unobtainable"])

    def test_closable_required_is_separate_from_unmapped(self):
        a = fmt_entry(fields=[
            {"vendor": "s", "ecs": "source.ip", "status": "mapped"}])
        b = fmt_entry(format="syslog-leef", fields=[
            {"vendor": "d", "ecs": "destination.ip", "status": "mapped"}])
        m, _, _ = self.build([a, b])
        self.assertIn("destination.ip", m["closable_required"])
        self.assertNotIn("destination.ip", m["unmapped_required"])
        self.assertIn("event.action", m["unmapped_required"])

    def test_format_choice_lists_every_format(self):
        a = fmt_entry()
        b = fmt_entry(format="syslog-leef")
        _, tech_view, _ = self.build([a, b])
        names = [r["format"] for r in tech_view["format_choice"]["rows"]]
        self.assertEqual(names, ["syslog-cef", "syslog-leef"])
        self.assertEqual(tech_view["format_choice"]["universal"],
                         ["syslog-cef", "syslog-leef"])

    def test_format_choice_is_none_for_a_single_format_technology(self):
        _, tech_view, _ = self.build([fmt_entry()])
        self.assertIsNone(tech_view["format_choice"])

    def test_format_choice_has_no_universal_when_formats_are_disjoint(self):
        ds_a = dataset(ds_id="a", formats=[fmt_entry(format="syslog-cef")])
        ds_b = dataset(ds_id="b", formats=[fmt_entry(format="json")])
        doc = tech_doc("paloalto-ngfw", [ds_a, ds_b])
        m = build([row("paloalto-ngfw")], {"paloalto-ngfw": doc})
        tech_view = m["technologies"][0]
        self.assertEqual(tech_view["format_choice"]["universal"], [])
        self.assertEqual(len(tech_view["format_choice"]["rows"]), 2)


if __name__ == "__main__":
    unittest.main()
