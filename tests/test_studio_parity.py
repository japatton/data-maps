"""Prove studio/lib/validate.js is still a rule-for-rule port of schema.py.

The JS validator is a hand-written port whose messages Studio shows the
operator as "what the build would say".  Two things keep that promise, and
neither needs Python and Node on the same machine:

  * TestParityFixture, below, needs no Node.  It holds the committed
    studio/tests/fixtures/parity.json - the synthetic corpus from
    datamaps.parity and schema.py's answer for every case - to a fresh
    generation, so the answers the JavaScript test checks against are
    always the current build's.  studio/tests/parity.test.js then runs the
    port over the same file and demands the same messages in the same
    order.  CI runs each half on its own image.
  * TestPythonJavaScriptParity runs both implementations in one process
    over everything - every authored document, the catalog, and the
    corpus - and is skipped when node is not on PATH.  It is the local
    check, and the one that reaches the real data.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import build, parity, schema, studio

NODE = shutil.which("node")

# ROOT reaches the import as a file: URL: a repository checked out under a
# path with a space, a '#' or a Windows drive letter is not a legal module
# specifier spelled as a bare path.
VALIDATE_URL = pathlib.Path(ROOT, "studio", "lib", "validate.js").as_uri()

SCRIPT = r"""
import { readFileSync } from "node:fs";
import { validateCatalog, validateTechnology }
  from "%s";
const input = JSON.parse(readFileSync(0, "utf8"));
const out = input.cases.map((item) => (
  item.kind === "catalog"
    ? validateCatalog(item.doc, input.schema).map((i) => i.message)
    : validateTechnology(item.doc, item.id, input.schema).map((i) => i.message)
));
process.stdout.write(JSON.stringify(out));
"""


class TestParityFixture(unittest.TestCase):
    """studio/tests/fixtures/parity.json is generated, not hand-copied."""

    @classmethod
    def setUpClass(cls):
        catalog, techs, profiles_doc, ecs = build.load_inputs(
            os.path.join(ROOT, "data"))
        cls.fresh = studio.fixture_parity(profiles_doc, ecs)

    def test_committed_fixture_equals_a_fresh_generation(self):
        path = os.path.join(ROOT, studio.PARITY_FIXTURE_PATH)
        with open(path, encoding="utf-8") as fh:
            committed = json.load(fh)
        self.assertEqual(
            committed, self.fresh,
            "studio/tests/fixtures/parity.json is out of date - "
            "run: python3 -m datamaps.studio --write-fixture")

    def test_the_corpus_covers_every_mutation_once(self):
        labels = [case["label"] for case in self.fresh["cases"]]
        self.assertEqual(len(labels), len(set(labels)))
        self.assertEqual(
            sorted(labels),
            sorted(["base/technology", "base/catalog"]
                   + list(parity.MUTATION_LABELS)))
        self.assertEqual(len(self.fresh["expected"]), len(labels))

    def test_the_mutations_actually_break_something(self):
        """A mutation that validates clean would prove nothing."""
        by_label = dict(zip([c["label"] for c in self.fresh["cases"]],
                            self.fresh["expected"]))
        for label in parity.MUTATION_LABELS:
            if label in parity.CLEAN_MUTATIONS:
                self.assertEqual(by_label[label], [], label)
            else:
                self.assertTrue(by_label[label], label)

    def test_the_base_documents_are_valid(self):
        by_label = dict(zip([c["label"] for c in self.fresh["cases"]],
                            self.fresh["expected"]))
        self.assertEqual(by_label["base/technology"], [])
        self.assertEqual(by_label["base/catalog"], [])

    def test_the_answers_are_json_strings(self):
        """The JS test compares strings; anything else would never match."""
        for answer in self.fresh["expected"]:
            for message in answer:
                self.assertIsInstance(message, str)


@unittest.skipIf(NODE is None, "node not available")
class TestPythonJavaScriptParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        catalog, techs, profiles_doc, ecs = build.load_inputs(
            os.path.join(ROOT, "data"))
        cls.schema_doc = studio.schema_json(profiles_doc, ecs)
        cls.profiles = profiles_doc["profiles"]
        cls.ecs_fields = ecs["fields"]
        cases = []
        # Every authored document, unaltered: the parity that matters most
        # is the one the operator meets on real data.
        for tech_id in sorted(techs):
            cases.append({"kind": "technology", "id": tech_id,
                          "doc": techs[tech_id], "label": "real/" + tech_id})
        cases.append({"kind": "catalog", "doc": catalog,
                      "label": "real/catalog"})
        # Then the synthetic corpus, here against the full dictionary.
        cases.extend(parity.corpus())
        cls.cases = cases
        proc = subprocess.run(
            [NODE, "--input-type=module", "-e", SCRIPT % VALIDATE_URL],
            input=json.dumps({"cases": cases,
                              "schema": cls.schema_doc}).encode("utf-8"),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            # A node that never answers must fail the suite rather than
            # hang a CI job until the runner's own limit kills it.
            timeout=120)
        if proc.returncode != 0:
            raise AssertionError(proc.stderr.decode("utf-8"))
        cls.from_js = json.loads(proc.stdout.decode("utf-8"))

    def test_every_case_produces_the_same_messages_in_the_same_order(self):
        self.assertEqual(len(self.from_js), len(self.cases))
        for case, js in zip(self.cases, self.from_js):
            self.assertEqual(
                parity.messages(case, self.profiles, self.ecs_fields), js,
                case["label"])

    def test_the_corpus_reaches_the_real_data(self):
        labels = [case["label"] for case in self.cases]
        self.assertIn("real/catalog", labels)
        self.assertGreater(len([l for l in labels
                                if l.startswith("real/")]), 50)


class TestCsvColumnParity(unittest.TestCase):
    def test_python_csv_columns_equal_studios(self):
        from datamaps import export_text
        import re
        with open(os.path.join(ROOT, "studio", "lib", "export.js"),
                  encoding="utf-8") as fh:
            js = fh.read()
        block = re.search(r"export const CSV_COLUMNS = \[(.*?)\];", js, re.S).group(1)
        columns = re.findall(r'"([^"]+)"', block)
        self.assertEqual(columns, export_text.CSV_COLUMNS)


if __name__ == "__main__":
    unittest.main()
