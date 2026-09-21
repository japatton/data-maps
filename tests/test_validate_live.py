import importlib.util
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

SPEC = importlib.util.spec_from_file_location(
    "validate_live", os.path.join(ROOT, "tools", "validate_live", "validate.py"))
vl = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vl)


class TestBodies(unittest.TestCase):
    def test_simulate_body(self):
        self.assertEqual(vl.SIMULATE_BODY, {"docs": [{"_source": {"message": ""}}]})

    def test_env_targets(self):
        env = {"CRIBL_URL": "http://c:19000", "CRIBL_USER": "u", "CRIBL_PASSWORD": "p"}
        t = vl.targets(env)
        self.assertEqual(t["cribl"], ("http://c:19000", "u", "p"))
        self.assertIsNone(t["es"])


class TestReport(unittest.TestCase):
    def test_report_lists_failures_verbatim(self):
        out = tempfile.mkdtemp()
        path = os.path.join(out, "r.md")
        cribl = [{"id": "dm_a", "key": "a/b__c", "ok": True, "status": 200, "detail": ""},
                 {"id": "dm_d", "key": "d/e__f", "ok": False, "status": 400,
                  "detail": '{"message":"bad conf"}'}]
        es = [{"id": "dm_a", "key": "a/b__c", "ok": False, "status": 400,
               "detail": "compile error at line 1"}]
        vl.write_report(path, cribl, es, {"date": "2026-09-30",
                                          "cribl": "http://c:19000",
                                          "es": "http://e:9200",
                                          "cribl_version": "4.19.0",
                                          "es_version": "8.15.0"})
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("# Live validation — 2026-09-30", text)
        self.assertIn("Cribl: 1 of 2 accepted", text)
        self.assertIn("Elasticsearch: 0 of 1 accepted", text)
        self.assertIn("bad conf", text)
        self.assertIn("compile error at line 1", text)
        self.assertIn("4.19.0", text)

    def test_report_with_skipped_target(self):
        out = tempfile.mkdtemp()
        path = os.path.join(out, "r.md")
        vl.write_report(path, None, [], {"date": "d", "cribl": None, "es": "http://e",
                                         "cribl_version": None, "es_version": "8"})
        with open(path, encoding="utf-8") as fh:
            self.assertIn("Cribl: skipped (CRIBL_URL unset)", fh.read())


if __name__ == "__main__":
    unittest.main()
