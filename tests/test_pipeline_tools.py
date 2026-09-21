import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools", "pipelines")
PIPELINES = os.path.join(ROOT, "data", "pipelines")


class TestGenerateThin(unittest.TestCase):
    def test_reproduces_the_committed_thin_pipelines(self):
        """Regenerating into a scratch dir must reproduce the committed bytes.

        The suite never writes into data/pipelines: a test run that leaves the
        working tree dirty cannot tell a real regression from its own output.
        """
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out, True)
        subprocess.check_call([sys.executable,
                               os.path.join(TOOLS, "generate_thin.py"),
                               "--out", out],
                              cwd=ROOT, stdout=subprocess.DEVNULL)
        written = 0
        for dirpath, _dirnames, filenames in os.walk(out):
            for name in sorted(filenames):
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, out)
                committed = os.path.join(PIPELINES, rel)
                self.assertTrue(os.path.exists(committed),
                                "%s has no committed counterpart" % rel)
                with open(path, "rb") as fh:
                    generated_bytes = fh.read()
                with open(committed, "rb") as fh:
                    committed_bytes = fh.read()
                self.assertEqual(generated_bytes, committed_bytes,
                                 "generate_thin.py would change %s" % rel)
                written += 1
        self.assertGreaterEqual(written, 200,
                                "only %d thin pipelines generated" % written)


class TestBuildWorkorders(unittest.TestCase):
    def test_writes_manifest(self):
        subprocess.check_call([sys.executable,
                               os.path.join(TOOLS, "build_workorders.py")],
                              cwd=ROOT, stdout=subprocess.DEVNULL)
        manifest = os.path.join(TOOLS, "workorders", "_manifest.json")
        self.assertTrue(os.path.exists(manifest))


if __name__ == "__main__":
    unittest.main()
