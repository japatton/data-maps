import glob
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import yaml

from datamaps import yamlio


def write(text):
    handle, path = tempfile.mkstemp(suffix=".yml")
    with os.fdopen(handle, "w") as fh:
        fh.write(text)
    return path


class TestLoad(unittest.TestCase):
    def test_loads_mapping(self):
        path = write("a: 1\nb:\n  - x\n  - y\n")
        self.assertEqual(yamlio.load(path), {"a": 1, "b": ["x", "y"]})

    def test_invalid_yaml_raises_dataerror_with_path(self):
        path = write("a: [unclosed\n")
        with self.assertRaises(yamlio.DataError) as ctx:
            yamlio.load(path)
        self.assertIn(path, str(ctx.exception))

    def test_missing_file_raises_dataerror(self):
        with self.assertRaises(yamlio.DataError):
            yamlio.load("/nonexistent/nope.yml")


class TestDump(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_dump_round_trips_and_keeps_order(self):
        doc = {"id": "x", "name": "X",
               "notes": "line one\nline two\n",
               "long": "word " * 40,
               "datasets": [{"id": "a", "n": 1}]}
        path = os.path.join(self.tmp, "out.yml")
        yamlio.dump(path, doc)
        again = yamlio.load(path)
        self.assertEqual(again, doc)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        self.assertLess(text.index("id:"), text.index("name:"))
        self.assertIn("|", text)


class TestLoaderEquivalence(unittest.TestCase):
    """The two loaders read this repository's data identically.

    yamlio picks CSafeLoader when PyYAML was built with libyaml, and falls
    back to SafeLoader otherwise - so a document could in principle be read
    one way locally and another way in CI.  The module comment says the
    values come out equal; this is what makes that a fact rather than a
    hope.  Only the *rejections* differ, which is documented there.
    """

    LOADERS = (yaml.SafeLoader, getattr(yaml, "CSafeLoader", None))

    def files(self):
        found = sorted(glob.glob(os.path.join(ROOT, "data", "technologies",
                                              "*.yml")))
        found.append(os.path.join(ROOT, "data", "catalog.yml"))
        found.append(os.path.join(ROOT, "data", "profiles", "alerting.yml"))
        found.append(os.path.join(ROOT, "data", "studio.yml"))
        return found

    @unittest.skipIf(getattr(yaml, "CSafeLoader", None) is None,
                     "PyYAML was built without libyaml")
    def test_both_loaders_read_every_authored_file_the_same(self):
        pure, fast = self.LOADERS
        paths = self.files()
        self.assertGreater(len(paths), 50, "the sweep found almost nothing")
        for path in paths:
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            self.assertEqual(yaml.load(text, Loader=pure),
                             yaml.load(text, Loader=fast),
                             path)

    def test_yamlio_uses_libyaml_when_it_is_there(self):
        """Which loader the module picked, stated rather than assumed."""
        expected = getattr(yaml, "CSafeLoader", yaml.SafeLoader)
        self.assertIs(yamlio._LOADER, expected)
