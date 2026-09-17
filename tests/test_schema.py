import copy
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import schema

ECS = {"ecs_version": "8.11.0", "fields": {
    "@timestamp": {"type": "date", "short": "t"},
    "source.ip": {"type": "ip", "short": "s"},
    "destination.ip": {"type": "ip", "short": "d"},
    "event.action": {"type": "keyword", "short": "a"},
    "event.outcome": {"type": "keyword", "short": "o"},
    "user.name": {"type": "keyword", "short": "u"},
    "host.name": {"type": "keyword", "short": "h"},
}}

PROFILES = {"profiles": {
    "network": {"required": ["source.ip", "destination.ip",
                             "event.action"]},
    "authentication": {"required": ["user.name", "event.outcome"]},
}}


def catalog(rows=None):
    return {"technologies": rows if rows is not None else [
        {"id": "paloalto-ngfw", "name": "Palo Alto NGFW",
         "vendor": "Palo Alto Networks", "category": "network-security",
         "status": "in-progress", "priority": "core"}]}


def tech(**overrides):
    doc = {
        "id": "paloalto-ngfw", "name": "Palo Alto NGFW",
        "vendor": "Palo Alto Networks",
        "datasets": [{
            "id": "traffic", "name": "Traffic",
            "event_categories": ["network"],
            "route": {
                "guarded": [
                    {"hop": "cribl", "location": "edge"},
                    {"hop": "guard", "device": "HSG",
                     "constraints": "policy pending"},
                    {"hop": "cribl", "location": "core"},
                    {"hop": "elastic",
                     "data_stream": "logs-panw.traffic"}],
                "direct": [
                    {"hop": "cribl", "location": "core"},
                    {"hop": "elastic",
                     "data_stream": "logs-panw.traffic"}],
            },
            "formats": [fmt_entry()],
        }],
    }
    doc.update(overrides)
    return doc


def run_all(catalog_doc=None, techs=None, profiles=None):
    return schema.validate_all(
        catalog_doc if catalog_doc is not None else catalog(),
        techs if techs is not None else {"paloalto-ngfw": tech()},
        profiles if profiles is not None else copy.deepcopy(PROFILES),
        ECS)


class TestKeyTables(unittest.TestCase):
    """KEY_ORDER/REQUIRED are the one definition; the rest are views."""

    def test_every_node_has_both_tables(self):
        self.assertEqual(sorted(schema.KEY_ORDER), sorted(schema.REQUIRED))
        self.assertEqual(sorted(schema.KEY_ORDER), sorted(schema.OPTIONAL))

    def test_required_keys_are_all_named_by_key_order(self):
        for node, required in schema.REQUIRED.items():
            order = schema.KEY_ORDER[node]
            allowed = set()
            if isinstance(order, dict):
                for keys in order.values():
                    allowed.update(keys)
            else:
                allowed.update(order)
            for key in required:
                self.assertIn(key, allowed, "%s: %s" % (node, key))

    def test_optional_is_key_order_minus_required(self):
        for node, order in schema.KEY_ORDER.items():
            required = schema.REQUIRED[node]
            optional = schema.OPTIONAL[node]
            if isinstance(order, dict):
                for kind, keys in order.items():
                    self.assertEqual(
                        optional[kind],
                        tuple(k for k in keys if k not in required))
            else:
                self.assertEqual(
                    optional, tuple(k for k in order if k not in required))

    def test_hop_keys_is_a_view_over_the_tables(self):
        self.assertEqual(sorted(schema.HOP_KEYS), sorted(schema.HOPS))
        self.assertEqual(schema.HOP_KEYS["guard"],
                         (("hop",), ("device", "constraints", "notes")))
        self.assertEqual(schema.HOP_KEYS["cribl"],
                         (("hop",), ("location", "notes")))

    def test_rec_keys_is_a_view_over_the_tables(self):
        self.assertEqual(schema.REC_KEYS, {
            "guarded": ("parse_location", "cribl", "elastic", "relay"),
            "direct": ("parse_location", "cribl", "elastic")})

    def test_a_key_the_table_does_not_name_is_unknown(self):
        """The tables really are what validation reads.

        Dropping a key from KEY_ORDER has to make that key unknown; if a
        call site still carried its own literal list, this would pass.
        """
        saved = schema.KEY_ORDER["dataset"]
        schema.KEY_ORDER["dataset"] = tuple(k for k in saved
                                            if k != "description")
        try:
            schema.OPTIONAL.update(schema._build_optional())
            doc = tech()
            doc["datasets"][0]["description"] = "Session end records."
            errors = run_all(techs={"paloalto-ngfw": doc})
            self.assertTrue(any("unknown key 'description'" in e
                                for e in errors), errors)
        finally:
            schema.KEY_ORDER["dataset"] = saved
            schema.OPTIONAL.update(schema._build_optional())
        doc = tech()
        doc["datasets"][0]["description"] = "Session end records."
        self.assertEqual(run_all(techs={"paloalto-ngfw": doc}), [])


class TestValidateAll(unittest.TestCase):
    def test_clean_data_no_errors(self):
        self.assertEqual(run_all(), [])

    def test_unknown_ecs_field_fails(self):
        bad = tech()
        bad["datasets"][0]["formats"][0]["fields"][0]["ecs"] = "sorce.ip"
        errors = run_all(techs={"paloalto-ngfw": bad})
        self.assertTrue(any("sorce.ip" in e and "ECS" in e for e in errors))

    def test_null_ecs_allowed(self):
        doc = tech()
        doc["datasets"][0]["formats"][0]["fields"][0] = {
            "vendor": "flags", "ecs": None,
            "custom": "panw.panos.flags", "status": "unmapped"}
        self.assertEqual(run_all(techs={"paloalto-ngfw": doc}), [])

    def test_unknown_category_vocab(self):
        rows = catalog()["technologies"]
        rows[0]["category"] = "networking"
        errors = run_all(catalog_doc={"technologies": rows})
        self.assertTrue(any("networking" in e for e in errors))

    def test_unknown_key_rejected(self):
        doc = tech()
        doc["datasets"][0]["colour"] = "red"
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("unknown key 'colour'" in e for e in errors))

    def test_event_category_without_profile(self):
        doc = tech()
        doc["datasets"][0]["event_categories"] = ["dns"]
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("dns" in e and "profile" in e for e in errors))

    def test_profile_requires_real_ecs_fields(self):
        profiles = copy.deepcopy(PROFILES)
        profiles["profiles"]["network"]["required"].append("bogus.field")
        errors = run_all(profiles=profiles)
        self.assertTrue(any("bogus.field" in e for e in errors))

    def test_duplicate_vendor_field(self):
        doc = tech()
        doc["datasets"][0]["formats"][0]["fields"].append(
            {"vendor": "src", "ecs": "destination.ip", "status": "mapped"})
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("duplicate vendor field" in e for e in errors))

    def test_file_id_mismatch(self):
        errors = run_all(techs={"panw": tech()})
        self.assertTrue(any("does not match filename" in e
                            for e in errors))

    def test_non_planned_needs_file(self):
        errors = run_all(techs={})
        self.assertTrue(any("in-progress" in e and "no" in e
                            for e in errors))

    def test_planned_row_without_file_ok(self):
        rows = catalog()["technologies"]
        rows[0]["status"] = "planned"
        self.assertEqual(
            run_all(catalog_doc={"technologies": rows}, techs={}), [])

    def test_file_without_catalog_row(self):
        errors = run_all(catalog_doc={"technologies": [
            {"id": "other", "name": "Other", "vendor": "X",
             "category": "endpoint", "status": "planned",
             "priority": "edge"}]})
        self.assertTrue(any("no catalog row" in e for e in errors))

    def test_bad_hop_vocab(self):
        doc = tech()
        doc["datasets"][0]["route"]["direct"][0]["hop"] = "teleport"
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("teleport" in e for e in errors))

    def test_guard_hop_keys(self):
        doc = tech()
        doc["datasets"][0]["route"]["guarded"].insert(1, {
            "hop": "guard", "device": "Everfox HSG",
            "constraints": "syslog only"})
        self.assertEqual(run_all(techs={"paloalto-ngfw": doc}), [])

    def test_bad_field_status(self):
        doc = tech()
        doc["datasets"][0]["formats"][0]["fields"][0]["status"] = "done"
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("'done'" in e or "done" in e for e in errors))

    def test_versions_list_rejected(self):
        doc = tech(versions=["PAN-OS 10.2", "PAN-OS 11.1"])
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("versions" in e and "non-empty string" in e
                            for e in errors))

    def test_recommendations_valid(self):
        doc = tech()
        doc["datasets"][0]["formats"][0]["recommendations"] = {
            "guarded": {
                "parse_location": "hybrid",
                "cribl": "Add a Cribl Pack for envelope parsing",
                "elastic": "Enrich with an ingest pipeline",
                "relay": "Forward via the syslog relay"},
            "direct": {
                "parse_location": "hybrid",
                "cribl": "Add a Cribl Pack for envelope parsing",
                "elastic": "Enrich with an ingest pipeline"}}
        self.assertEqual(run_all(techs={"paloalto-ngfw": doc}), [])

    def test_recommendations_empty_rejected(self):
        doc = tech()
        doc["datasets"][0]["formats"][0]["recommendations"] = {}
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("must not be empty" in e for e in errors))

    def test_recommendations_bad_parse_location(self):
        doc = tech()
        doc["datasets"][0]["formats"][0]["recommendations"] = {
            "direct": {"parse_location": "medium"}}
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("medium" in e and "low" in e and "high" in e
                            and "hybrid" in e for e in errors))

    def test_recommendations_unknown_key(self):
        doc = tech()
        doc["datasets"][0]["formats"][0]["recommendations"] = {
            "guard": "notes here"}
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("unknown key 'guard'" in e for e in errors))


def fmt_entry(**overrides):
    entry = {
        "format": "syslog-cef",
        "parsing": {"mechanism": "cribl-pack"},
        "recommendations": {
            "guarded": {"parse_location": "low", "relay": "thin envelope"},
            "direct": {"parse_location": "low"},
        },
        "fields": [{"vendor": "src", "ecs": "source.ip",
                    "status": "mapped"}],
    }
    entry.update(overrides)
    return entry


class TestFormatValidators(unittest.TestCase):
    def check(self, entry, seen=None):
        errors = []
        result = schema._validate_format(
            entry, "t dataset 'd'", seen if seen is not None else set(),
            ECS["fields"], errors)
        return result, errors

    def test_valid_entry_returns_none(self):
        result, errors = self.check(fmt_entry())
        self.assertIsNone(result)
        self.assertEqual(errors, [])

    def test_fields_omitted_documents_an_empty_inventory(self):
        _, errors = self.check(fmt_entry(
            fields=[], fields_omitted="Operator-defined payload template."))
        self.assertEqual(errors, [])

    def test_fields_omitted_must_be_a_non_empty_string(self):
        _, errors = self.check(fmt_entry(fields=[], fields_omitted="   "))
        self.assertTrue(any("'fields_omitted' must be a non-empty string" in e
                            for e in errors))

    def test_fields_omitted_rejected_when_fields_are_present(self):
        _, errors = self.check(fmt_entry(fields_omitted="why"))
        self.assertTrue(any("fields_omitted" in e and "not empty" in e
                            for e in errors))

    def test_unknown_format_value(self):
        _, errors = self.check(fmt_entry(format="carrier-pigeon"))
        self.assertTrue(any("carrier-pigeon" in e for e in errors))

    def test_duplicate_format(self):
        seen = set(["syslog-cef"])
        _, errors = self.check(fmt_entry(), seen=seen)
        self.assertTrue(any("duplicate format" in e for e in errors))

    def test_relay_forbidden_under_direct(self):
        entry = fmt_entry(recommendations={
            "guarded": {"parse_location": "low"},
            "direct": {"parse_location": "low", "relay": "nope"}})
        _, errors = self.check(entry)
        self.assertTrue(any("unknown key 'relay'" in e for e in errors))

    def test_empty_fields_list_is_valid(self):
        _, errors = self.check(fmt_entry(fields=[]))
        self.assertEqual(errors, [])

    def test_bad_ecs_in_format_fields(self):
        entry = fmt_entry(fields=[{"vendor": "x", "ecs": "not.a.field",
                                   "status": "mapped"}])
        _, errors = self.check(entry)
        self.assertTrue(any("not.a.field" in e for e in errors))

    def test_references_must_be_string_list(self):
        _, errors = self.check(fmt_entry(references=[1]))
        self.assertTrue(any("references" in e for e in errors))


class TestDatasetFormats(unittest.TestCase):
    def ds(self, **overrides):
        doc = tech()
        doc["datasets"][0].update(overrides)
        return run_all(techs={"paloalto-ngfw": doc})

    def test_new_shape_valid(self):
        self.assertEqual(self.ds(), [])

    def test_source_format_now_unknown_key(self):
        errors = self.ds(source_format="syslog-csv")
        self.assertTrue(any("unknown key 'source_format'" in e
                            for e in errors))

    def test_formats_required_nonempty(self):
        errors = self.ds(formats=[])
        self.assertTrue(any("'formats' must be a non-empty list" in e
                            for e in errors))

    def test_at_most_one_recommended_override(self):
        a = fmt_entry(recommended=True, recommended_because="one")
        b = fmt_entry(format="syslog-leef", recommended=True,
                      recommended_because="two")
        errors = self.ds(formats=[a, b])
        self.assertTrue(any("at most one" in e for e in errors))

    def test_route_direct_required(self):
        doc = tech()
        del doc["datasets"][0]["route"]["direct"]
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("missing key 'direct'" in e for e in errors))

    def test_route_guarded_optional(self):
        doc = tech()
        del doc["datasets"][0]["route"]["guarded"]
        rec = doc["datasets"][0]["formats"][0]["recommendations"]
        del rec["guarded"]
        self.assertEqual(run_all(techs={"paloalto-ngfw": doc}), [])

    def test_guarded_recs_require_guarded_route(self):
        doc = tech()
        del doc["datasets"][0]["route"]["guarded"]
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("guarded recommendations but route has no "
                            "guarded side" in e for e in errors))

    def test_non_mapping_recs_no_guarded_route(self):
        doc = tech()
        del doc["datasets"][0]["route"]["guarded"]
        doc["datasets"][0]["formats"][0]["recommendations"] = 5
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("must be a mapping" in e for e in errors))

    def test_relay_under_direct_dataset_level(self):
        doc = tech()
        rec = doc["datasets"][0]["formats"][0]["recommendations"]
        rec["direct"]["relay"] = "nope"
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("unknown key 'relay'" in e for e in errors))

    def test_guarded_route_needs_guard_hop(self):
        doc = tech()
        doc["datasets"][0]["route"]["guarded"] = [
            {"hop": "cribl"}, {"hop": "elastic"}]
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("no guard hop" in e for e in errors))

    def test_direct_route_rejects_guard_hop(self):
        doc = tech()
        doc["datasets"][0]["route"]["direct"].insert(
            1, {"hop": "guard", "device": "HSG"})
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("must not contain a guard hop" in e
                            for e in errors))


class TestNonMappingEntries(unittest.TestCase):
    """A bare string where a mapping belongs is a message, not a crash.

    YAML makes this easy to author (a field name typed straight under
    ``fields:``), so every 'where' label has to survive it.
    """

    def test_string_in_fields_list(self):
        doc = tech()
        doc["datasets"][0]["formats"][0]["fields"] = ["source.ip"]
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("must be a mapping" in e for e in errors), errors)

    def test_string_format_entry(self):
        doc = tech()
        doc["datasets"][0]["formats"] = ["syslog-cef"]
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("must be a mapping" in e for e in errors), errors)

    def test_string_dataset(self):
        doc = tech()
        doc["datasets"] = ["traffic"]
        errors = run_all(techs={"paloalto-ngfw": doc})
        self.assertTrue(any("must be a mapping" in e for e in errors), errors)


class TestRecommendationOverride(unittest.TestCase):
    def ds(self, formats):
        doc = tech()
        doc["datasets"][0]["formats"] = formats
        return run_all(techs={"paloalto-ngfw": doc})

    def test_override_with_a_reason_is_valid(self):
        a = fmt_entry(recommended=True,
                      recommended_because="LEEF keys are unpublished")
        b = fmt_entry(format="syslog-leef")
        self.assertEqual(self.ds([a, b]), [])

    def test_override_without_a_reason_is_fatal(self):
        errors = self.ds([fmt_entry(recommended=True)])
        self.assertTrue(any("recommended_because" in e for e in errors))

    def test_reason_without_the_override_is_fatal(self):
        errors = self.ds([fmt_entry(recommended_because="why")])
        self.assertTrue(any("recommended_because" in e
                            and "recommended" in e for e in errors))

    def test_two_overrides_on_one_dataset_is_fatal(self):
        a = fmt_entry(recommended=True, recommended_because="one")
        b = fmt_entry(format="syslog-leef", recommended=True,
                      recommended_because="two")
        errors = self.ds([a, b])
        self.assertTrue(any("at most one" in e for e in errors))

    def test_deployed_is_now_an_unknown_key(self):
        errors = self.ds([fmt_entry(deployed=True)])
        self.assertTrue(any("unknown key 'deployed'" in e for e in errors))
