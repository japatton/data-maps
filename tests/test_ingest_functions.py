import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps.ingest import functions as fx
from datamaps.ingest.expr import Untranslatable

D = "why this step exists"


def fn(fid, conf=None, filt="true"):
    return {"id": fid, "filter": filt, "conf": conf or {}, "description": D}


class TestCondition(unittest.TestCase):
    def test_true_is_none(self):
        self.assertIsNone(fx.condition_for(fn("drop")))
        self.assertIsNone(fx.condition_for({"id": "drop", "conf": {}}))

    def test_filter_translates(self):
        c = fx.condition_for(fn("drop", filt="__e['ProviderName'] !== 'AD FS'"))
        self.assertEqual(c.source, "(ctx.ProviderName != 'AD FS')")


class TestSerde(unittest.TestCase):
    def test_json_to_root(self):
        r = fx.translate_function(
            fn("serde", {"mode": "extract", "type": "json", "srcField": "_raw"}), D)
        self.assertEqual(r.processors, [{"json": {
            "field": "message", "add_to_root": True, "ignore_failure": True,
            "description": D}}])
        self.assertIsNone(r.manual)

    def test_json_to_target(self):
        r = fx.translate_function(
            fn("serde", {"mode": "extract", "type": "json", "srcField": "detail",
                         "dstField": "aws"}), D)
        self.assertEqual(r.processors[0]["json"]["target_field"], "aws")
        self.assertNotIn("add_to_root", r.processors[0]["json"])

    def test_kvp_defaults_and_delims(self):
        r = fx.translate_function(
            fn("serde", {"mode": "extract", "type": "kvp", "srcField": "extension"}), D)
        script = r.processors[0]["script"]
        self.assertEqual(script["lang"], "painless")
        self.assertEqual(script["description"], D)
        self.assertIn('/([^\\s=]+?)=(?:"([^"]*)"|([^\\s]*))/', script["source"])
        self.assertIn("String.valueOf(ctx.extension)", script["source"])
        self.assertIn("ctx[k] = v", script["source"])
        self.assertIs(r.regex, True)
        r = fx.translate_function(
            fn("serde", {"mode": "extract", "type": "kvp", "srcField": "x",
                         "kvDelim": ":", "pairDelim": "|"}), D)
        self.assertIn('/([^\\|:]+?):(?:"([^"]*)"|([^\\|]*))/',
                      r.processors[0]["script"]["source"])
        self.assertTrue(any("quoted" in n or "space" in n for n in r.notes))
        r = fx.translate_function(
            fn("serde", {"mode": "extract", "type": "kvp", "srcField": "x",
                         "dstField": "tanium_fields"}), D)
        source = r.processors[0]["script"]["source"]
        self.assertIn("if (ctx.tanium_fields == null) { ctx.tanium_fields = [:]; }",
                      source)
        self.assertIn("ctx.tanium_fields[k] = v", source)
        self.assertNotIn("ctx[k] = v", source)
        self.assertIs(r.regex, True)

    def test_kvp_multichar_delimiter_untranslatable(self):
        with self.assertRaises(Untranslatable):
            fx.translate_function(
                fn("serde", {"mode": "extract", "type": "kvp", "srcField": "x",
                             "pairDelim": "||"}), D)

    def test_csv_and_delim(self):
        r = fx.translate_function(
            fn("serde", {"mode": "extract", "type": "csv", "srcField": "_raw",
                         "fields": ["a", "b"]}), D)
        csv = r.processors[0]["csv"]
        self.assertEqual(csv["field"], "message")
        self.assertEqual(csv["target_fields"], ["a", "b"])
        self.assertEqual(csv["separator"], ",")
        self.assertEqual(csv["quote"], '"')
        r = fx.translate_function(
            fn("serde", {"mode": "extract", "type": "delim", "srcField": "_raw",
                         "delimChar": "\t", "fields": ["a"]}), D)
        self.assertEqual(r.processors[0]["csv"]["separator"], "\t")
        with self.assertRaises(Untranslatable):
            fx.translate_function(
                fn("serde", {"mode": "extract", "type": "csv", "srcField": "_raw"}), D)

    def test_other_modes_untranslatable(self):
        with self.assertRaises(Untranslatable):
            fx.translate_function(
                fn("serde", {"mode": "reserialize", "type": "json", "srcField": "_raw"}), D)


class TestRegexExtract(unittest.TestCase):
    def test_single_regex_becomes_grok(self):
        r = fx.translate_function(
            fn("regex_extract", {"regex": "/Activity ID:\\s*(?<ActivityId>\\S+)/",
                                 "source": "Message"}), D)
        self.assertEqual(r.processors, [{"grok": {
            "field": "Message", "patterns": ["Activity ID:\\s*(?<ActivityId>\\S+)"],
            "ignore_missing": True, "ignore_failure": True, "description": D}}])

    def test_flags_and_list_and_iterations(self):
        r = fx.translate_function(
            fn("regex_extract", {"regex": "/rt=(?<rt>\\S+)/i", "source": "_raw",
                                 "regexList": [{"regex": "/duser=(?<duser>\\S+)/"}],
                                 "iterations": 100}), D)
        self.assertEqual(len(r.processors), 2)
        self.assertEqual(r.processors[0]["grok"]["patterns"], ["(?i)rt=(?<rt>\\S+)"])
        self.assertEqual(r.processors[0]["grok"]["field"], "message")
        self.assertEqual(r.processors[1]["grok"]["patterns"], ["duser=(?<duser>\\S+)"])
        self.assertTrue(any("iterations" in n for n in r.notes))

    def test_percent_brace_is_escaped(self):
        r = fx.translate_function(
            fn("regex_extract", {"regex": "/%{(?<a>\\w+)}/", "source": "m"}), D)
        self.assertEqual(r.processors[0]["grok"]["patterns"], ["\\%\\{(?<a>\\w+)}"])

    def test_bare_regex_untranslatable(self):
        with self.assertRaises(Untranslatable):
            fx.translate_function(fn("regex_extract", {"regex": "abc", "source": "m"}), D)


class TestRenameDropMask(unittest.TestCase):
    def test_rename(self):
        r = fx.translate_function(
            fn("rename", {"rename": [{"currentName": "EventID", "newName": "event.code"},
                                     {"currentName": "_time", "newName": "ts"}]}), D)
        self.assertEqual(r.processors, [
            {"rename": {"field": "EventID", "target_field": "event.code",
                        "ignore_missing": True, "ignore_failure": True,
                        "description": D}},
            {"rename": {"field": "@timestamp", "target_field": "ts",
                        "ignore_missing": True, "ignore_failure": True,
                        "description": D}}])

    def test_drop_with_and_without_condition(self):
        r = fx.translate_function(fn("drop", filt="__e['a'] === 'x'"), D)
        self.assertEqual(r.processors, [{"drop": {"if": "(ctx.a == 'x')", "description": D}}])
        r = fx.translate_function(fn("drop"), D)
        self.assertEqual(r.processors, [{"drop": {"description": D}}])

    def test_mask_literal_replacement(self):
        r = fx.translate_function(
            fn("mask", {"rules": [{"matchRegex": "/[\\s\\S]+/",
                                   "replaceExpr": "'suppressed'"}],
                        "fields": ["Message", "_raw"]}), D)
        self.assertEqual(r.processors, [
            {"gsub": {"field": "Message", "pattern": "[\\s\\S]+", "replacement": "suppressed",
                      "ignore_missing": True, "ignore_failure": True,
                      "description": D}},
            {"gsub": {"field": "message", "pattern": "[\\s\\S]+", "replacement": "suppressed",
                      "ignore_missing": True, "ignore_failure": True,
                      "description": D}}])

    def test_mask_expression_replacement_is_manual(self):
        with self.assertRaises(Untranslatable):
            fx.translate_function(
                fn("mask", {"rules": [{"matchRegex": "/a/",
                                       "replaceExpr": "__e['x']"}],
                            "fields": ["m"]}), D)


class TestTimestampNumerifyManual(unittest.TestCase):
    def test_auto_timestamp(self):
        r = fx.translate_function(
            fn("auto_timestamp", {"srcField": "CreatedDateTime", "dstField": "_time"}), D)
        self.assertEqual(r.processors, [{"date": {
            "field": "CreatedDateTime", "target_field": "@timestamp",
            "formats": ["ISO8601", "UNIX", "UNIX_MS"], "ignore_failure": True,
            "description": D}}])
        self.assertTrue(r.notes)

    def test_numerify_all_fields_is_untranslatable(self):
        with self.assertRaises(Untranslatable):
            fx.translate_function(fn("numerify", {}), D)

    def test_numerify_listed_fields(self):
        r = fx.translate_function(fn("numerify", {"fields": ["a", "b"]}), D)
        self.assertEqual(r.processors[0], {"convert": {
            "field": "a", "type": "auto", "ignore_missing": True,
            "ignore_failure": True, "description": D}})

    def test_manual_functions(self):
        for fid in fx.MANUAL_FUNCTIONS:
            with self.assertRaises(Untranslatable, msg=fid):
                fx.translate_function(fn(fid, {"code": "x"}), D)

    def test_unknown_function(self):
        with self.assertRaises(Untranslatable):
            fx.translate_function(fn("lookup", {}), D)

    def test_filter_applies_to_every_processor(self):
        r = fx.translate_function(
            fn("rename", {"rename": [{"currentName": "a", "newName": "b"}]},
               filt="__e['x'] === 1"), D)
        self.assertEqual(r.processors[0]["rename"]["if"], "(ctx.x == 1)")

    def test_untranslatable_filter_fails_the_step(self):
        with self.assertRaises(Untranslatable):
            fx.translate_function(
                fn("rename", {"rename": [{"currentName": "a", "newName": "b"}]},
                   filt="foo(1)"), D)


if __name__ == "__main__":
    unittest.main()
