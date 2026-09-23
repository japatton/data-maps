import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps.ingest import evaluate
from datamaps.ingest.expr import Untranslatable

D = "d"


class TestEval(unittest.TestCase):
    def test_constant_row_is_set(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "event.dataset", "value": "'ad.account'"}]}, D)
        self.assertEqual(r.processors, [{"set": {
            "field": "event.dataset", "value": "ad.account",
            "ignore_failure": True, "description": D}}])
        self.assertIsNone(r.manual)

    def test_quoted_name_and_remove(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "'event.dataset'", "value": "'ad.account'"}],
             "remove": ["'a.b'"]}, D)
        self.assertEqual(r.processors[0]["set"]["field"], "event.dataset")
        self.assertEqual(r.processors[1]["remove"]["field"], ["a.b"])

    def test_array_and_number_constants(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "event.category", "value": "['network','dns']"},
                     {"name": "event.severity", "value": "3"}]}, D)
        self.assertEqual(r.processors[0]["set"]["value"], ["network", "dns"])
        self.assertEqual(r.processors[1]["set"]["value"], 3)

    def test_field_copy(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "host.name", "value": "__e['Computer']"},
                     {"name": "message", "value": "__e['_raw']"}]}, D)
        self.assertEqual(r.processors, [
            {"set": {"field": "host.name", "copy_from": "Computer",
                     "ignore_empty_value": True, "ignore_failure": True,
                     "description": D}},
            {"set": {"field": "message", "copy_from": "message",
                     "ignore_empty_value": True, "ignore_failure": True,
                     "description": D}}])

    def test_expression_rows_share_one_script(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "adfs.n", "value": "parseInt(__e['n'], 10)"},
                     {"name": "x", "value": "__e['a'] || __e['b']"}]}, D)
        self.assertEqual(len(r.processors), 1)
        script = r.processors[0]["script"]
        self.assertEqual(script["lang"], "painless")
        self.assertEqual(script["description"], D)
        lines = script["source"].split("\n")
        self.assertEqual(lines[0],
                         "try { def v = (long) Double.parseDouble(String.valueOf(ctx.n).trim()); "
                         "if (v != null) { if (ctx.adfs == null) { ctx.adfs = [:]; } "
                         "ctx.adfs.n = v; } } catch (Exception e) { }")
        self.assertTrue(lines[1].startswith("try { def v = ((ctx.a != null"))
        self.assertTrue(lines[1].endswith("ctx.x = v; } } catch (Exception e) { }"))

    def test_order_is_preserved_across_kinds(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "a", "value": "'1'"},
                     {"name": "b", "value": "__e['a'] === '1' ? 2 : 3"},
                     {"name": "c", "value": "'3'"}]}, D)
        kinds = [list(p)[0] for p in r.processors]
        self.assertEqual(kinds, ["set", "script", "set"])

    def test_null_constant_is_a_noop_with_note(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "unmapped", "value": "undefined"}]}, D)
        self.assertEqual(r.processors, [])
        self.assertTrue(any("unmapped" in n for n in r.notes))

    def test_remove(self):
        r = evaluate.translate_eval({"remove": ["a", "b.c", "_raw"]}, D)
        self.assertEqual(r.processors, [{"remove": {
            "field": ["a", "b.c", "message"], "ignore_missing": True,
            "description": D}}])

    def test_wildcard_remove_is_a_partial_step(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "a", "value": "'1'"}],
             "remove": ["tmp_*", "b"]}, D)
        kinds = [list(p)[0] for p in r.processors]
        self.assertEqual(kinds, ["set", "remove"])
        self.assertEqual(r.processors[1]["remove"]["field"], ["b"])
        self.assertEqual(r.manual["original"], {"remove": ["tmp_*"]})
        self.assertIn("tmp_*", r.manual["reason"])

    def test_wildcard_only_remove_raises(self):
        with self.assertRaises(Untranslatable):
            evaluate.translate_eval({"remove": ["tmp_*"]}, D)

    def test_internal_remove_entry_is_skipped_with_note(self):
        r = evaluate.translate_eval({"remove": ["__ctrl", "a"]}, D)
        self.assertEqual(r.processors, [{"remove": {
            "field": ["a"], "ignore_missing": True, "description": D}}])
        self.assertTrue(any("__ctrl" in n for n in r.notes))
        self.assertIsNone(r.manual)

    def test_only_internal_removes_emit_nothing(self):
        r = evaluate.translate_eval({"remove": ["__ctrl"]}, D)
        self.assertEqual(r.processors, [])
        self.assertIsNone(r.manual)

    def test_keep_is_untranslatable(self):
        with self.assertRaises(Untranslatable):
            evaluate.translate_eval({"keep": ["a"]}, D)

    def test_partial_step_keeps_good_rows(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "ok", "value": "'x'"},
                     {"name": "bad", "value": "JSON.parse(__e['j'])"},
                     {"name": "also_bad", "value": "__e['a'] + __e['b']"}]}, D)
        self.assertEqual(len(r.processors), 1)
        self.assertEqual(r.manual["function"], "eval")
        self.assertEqual([row["name"] for row in r.manual["original"]["add"]],
                         ["bad", "also_bad"])
        self.assertIn("JSON.parse", r.manual["reason"])

    def test_all_rows_failing_raises(self):
        with self.assertRaises(Untranslatable):
            evaluate.translate_eval({"add": [{"name": "b", "value": "foo(1)"}]}, D)

    def test_internal_target_is_skipped_with_note(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "__tmp", "value": "'x'"},
                     {"name": "ok", "value": "'y'"}]}, D)
        self.assertEqual(len(r.processors), 1)
        self.assertTrue(any("__tmp" in n for n in r.notes))

    def test_regex_flag_propagates(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "a", "value": "__e['s'].replace(/x/g, '')"}]}, D)
        self.assertTrue(r.regex)


if __name__ == "__main__":
    unittest.main()
