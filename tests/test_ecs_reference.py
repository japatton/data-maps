import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


class TestEcsReference(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(ROOT, "data", "reference", "ecs.json"),
                  encoding="utf-8") as fh:
            cls.ecs = json.load(fh)

    def test_shape_and_version(self):
        self.assertEqual(self.ecs["ecs_version"], "9.4.0")
        self.assertIsInstance(self.ecs["fields"], dict)

    def test_core_fields_present(self):
        for name in ("@timestamp", "source.ip", "destination.ip",
                     "user.name", "event.action", "event.outcome",
                     "process.command_line", "host.name"):
            self.assertIn(name, self.ecs["fields"], name)

    def test_substantial(self):
        self.assertGreater(len(self.ecs["fields"]), 800)
        entry = self.ecs["fields"]["source.ip"]
        self.assertEqual(entry["type"], "ip")
        self.assertTrue(entry["short"])
