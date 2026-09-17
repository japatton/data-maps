"""Hold every authored data file to the Studio emitter.

Two properties, and the second is the one that bites in the field:

  * Round-trip: emitting a document and reloading it gives the document
    back.  This proves the emitter is lossless.
  * Byte-identity: the file on disk IS what the emitter writes.  Studio's
    drift guard compares the repository's text against the text its emitter
    produces from the published snapshot, so a file that is merely
    equivalent - same content, different line wrapping - tells an admin the
    file "changed in the repository since this site was built" and blocks
    the merge request.  A hand edit to prose is enough to cause it:
    deleting a word from a folded block leaves the paragraph wrapped at the
    old width, and the emitter would re-wrap it.

Round-trip alone passed for months while 55 of 88 technology files were
not byte-identical, which is how a prose sweep broke Studio for most of the
catalog without failing a test.

Skipped when node is not on PATH (CI's python image); run locally
before merging any emitter change or any hand edit to data/.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import build, yamlio

NODE = shutil.which("node")
SCRIPT = r"""
import { readFileSync } from "node:fs";
import { emit, emitCatalog } from "%s/studio/lib/yaml-emit.js";
const input = JSON.parse(readFileSync(0, "utf8"));
const out = {};
for (const [name, doc] of Object.entries(input.docs)) {
  out[name] = name === "catalog" ? emitCatalog(doc) : emit(doc);
}
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipIf(NODE is None, "node not available")
class TestRoundTrip(unittest.TestCase):
    def test_every_data_file_round_trips(self):
        catalog, techs, profiles, ecs = build.load_inputs(
            os.path.join(ROOT, "data"))
        docs = dict(techs)
        docs["catalog"] = catalog
        proc = subprocess.run(
            [NODE, "--input-type=module", "-e", SCRIPT % ROOT],
            input=json.dumps({"docs": docs}).encode("utf-8"),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        emitted = json.loads(proc.stdout.decode("utf-8"))
        self.assertEqual(sorted(emitted), sorted(docs))
        work = tempfile.mkdtemp()
        try:
            tmp = os.path.join(work, "_roundtrip.yml")
            for name, text in sorted(emitted.items()):
                with open(tmp, "w", encoding="utf-8") as fh:
                    fh.write(text)
                loaded = yamlio.load(tmp)
                self.assertEqual(loaded, docs[name], name)
                self.assertTrue(text.endswith("\n"), name)
                if text.endswith("\n\n"):
                    # Only a keep-chomped ("|+") block as the document's
                    # last value may leave a blank line at the end, and
                    # then the value itself carries those newlines.
                    last = loaded
                    while isinstance(last, (dict, list)):
                        values = (list(last.values())
                                  if isinstance(last, dict) else last)
                        self.assertTrue(
                            values,
                            "%s: empty container where the trailing blank "
                            "line's value should be" % name)
                        last = values[-1]
                    self.assertTrue(
                        isinstance(last, str) and last.endswith("\n\n"), name)
        finally:
            shutil.rmtree(work)


@unittest.skipIf(NODE is None, "node not available")
class TestCanonicalOnDisk(unittest.TestCase):
    """Every data file is stored exactly as the emitter writes it.

    This is what Studio's drift guard actually compares, so a failure here
    is a merge request an admin cannot make.
    """

    def test_every_data_file_is_byte_identical_to_the_emitter(self):
        from tools import canonicalize
        paths = canonicalize.data_files(os.path.join(ROOT, "data"))
        stale, _ = canonicalize.differing(paths)
        self.assertEqual(
            [os.path.relpath(p, ROOT) for p in stale], [],
            "these files are not as the Studio emitter writes them, so "
            "Studio will refuse a merge request for them with 'changed in "
            "the repository since this site was built' - run: "
            "python3 tools/canonicalize.py")

    def test_the_comparison_matches_the_one_studio_makes(self):
        """normalize() here must equal review-files.js normalize()."""
        from tools import canonicalize
        self.assertEqual(canonicalize.normalize("a\r\nb  \n\n"), "a\nb")
        self.assertEqual(canonicalize.normalize("a\nb\n"), "a\nb")
