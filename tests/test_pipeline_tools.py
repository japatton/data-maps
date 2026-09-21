import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools", "pipelines")


class TestGenerateThin(unittest.TestCase):
    def test_idempotent_on_current_catalog(self):
        before = subprocess.check_output(["git", "status", "--porcelain",
                                          "data/pipelines"], cwd=ROOT)
        subprocess.check_call([sys.executable,
                               os.path.join(TOOLS, "generate_thin.py")],
                              cwd=ROOT, stdout=subprocess.DEVNULL)
        after = subprocess.check_output(["git", "status", "--porcelain",
                                         "data/pipelines"], cwd=ROOT)
        self.assertEqual(before, after,
                         "generate_thin.py changed committed pipelines")


class TestBuildWorkorders(unittest.TestCase):
    def test_writes_manifest(self):
        subprocess.check_call([sys.executable,
                               os.path.join(TOOLS, "build_workorders.py")],
                              cwd=ROOT, stdout=subprocess.DEVNULL)
        manifest = os.path.join(TOOLS, "workorders", "_manifest.json")
        self.assertTrue(os.path.exists(manifest))


if __name__ == "__main__":
    unittest.main()
