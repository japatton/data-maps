import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from tests.test_build import run_build, DATA


class TestBlockExports(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = tempfile.mkdtemp()
        try:
            cls.code, cls.report = run_build(cls.out)
        except BaseException:
            shutil.rmtree(cls.out, True)
            raise

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.out, True)

    def path(self, *parts):
        return os.path.join(self.out, "exports", *parts)

    def load(self, *parts):
        with open(self.path(*parts), encoding="utf-8") as fh:
            return json.load(fh)

    def test_build_ok(self):
        self.assertEqual(self.code, 0, self.report)

    def test_every_kind_exists_for_a_full_block(self):
        base = os.path.join("cisco-asa", "device-admin__snmp-trap")
        for kind, ext in (("map", ".json"), ("map", ".md"), ("map", ".csv"),
                          ("map", ".html"), ("cribl", ".json"), ("ingest", ".json")):
            self.assertTrue(os.path.exists(self.path(kind, base + ext)), kind + ext)

    def test_cribl_export_is_byte_identical(self):
        rel = os.path.join("cisco-asa", "device-admin__snmp-trap.json")
        with open(os.path.join(DATA, "pipelines", rel), "rb") as fh:
            src = fh.read()
        with open(self.path("cribl", rel), "rb") as fh:
            self.assertEqual(fh.read(), src)

    def test_ingest_envelope_shape(self):
        env = self.load("ingest", "cisco-asa", "device-admin__snmp-trap.json")
        self.assertEqual(env["id"], "dm_cisco_asa_device_admin_snmp_trap")
        for key in ("pipeline", "coverage", "notes", "manual_steps", "field_map", "requires"):
            self.assertIn(key, env)
        self.assertIn("processors", env["pipeline"])

    def test_map_json_shape(self):
        doc = self.load("map", "cisco-asa", "device-admin__snmp-trap.json")
        self.assertEqual(doc["technology"]["id"], "cisco-asa")
        self.assertEqual(doc["dataset"]["id"], "device-admin")
        self.assertEqual(doc["format"]["format"], "snmp-trap")
        self.assertEqual(doc["artifacts"]["cribl"],
                         "exports/cribl/cisco-asa/device-admin__snmp-trap.json")
        self.assertIn("fields", doc["format"])
        self.assertIn("alerting_required", doc["format"]["fields"][0])

    def test_none_block_has_no_artifacts(self):
        doc = self.load("map", "arkime", "sessions__json.json")
        self.assertEqual(doc["artifacts"], {"cribl": None, "ingest": None})
        self.assertFalse(os.path.exists(self.path("cribl", "arkime", "sessions__json.json")))

    def test_fragment_is_in_the_technology_page(self):
        with open(self.path("map", "cisco-asa", "device-admin__snmp-trap.html"),
                  encoding="utf-8") as fh:
            frag = fh.read().strip()
        with open(os.path.join(self.out, "tech", "cisco-asa.html"), encoding="utf-8") as fh:
            self.assertIn(frag, fh.read())

    def test_picker_index(self):
        idx = self.load("picker.json")
        self.assertEqual(idx["destinations"], ["elastic"])
        self.assertEqual(len(idx["technologies"]), 97)
        formats = [f for t in idx["technologies"] for d in t["datasets"] for f in d["formats"]]
        self.assertEqual(len(formats), 610)
        self.assertEqual(sum(1 for f in formats if f["has_cribl_pipeline"]), 605)
        none = [f for f in formats if f["mechanism"] == "none"]
        self.assertEqual(len(none), 5)
        for f in none:
            self.assertFalse(f["has_cribl_pipeline"])
            self.assertIsNone(f["ingest"])
        asa = [t for t in idx["technologies"] if t["id"] == "cisco-asa"][0]
        ds = [d for d in asa["datasets"] if d["id"] == "device-admin"][0]
        fmt = [f for f in ds["formats"] if f["format"] == "snmp-trap"][0]
        self.assertEqual(fmt["path"], "cisco-asa/device-admin__snmp-trap")
        self.assertEqual(set(fmt["ingest"]), {"translated", "partial", "manual", "total"})
        self.assertEqual(sum(1 for f in ds["formats"] if f["recommended"]), 1)

    def test_technology_ids_do_not_collide_with_export_dirs(self):
        idx = self.load("picker.json")
        ids = set(t["id"] for t in idx["technologies"])
        self.assertFalse(ids & {"map", "cribl", "ingest", "picker"})


if __name__ == "__main__":
    unittest.main()
