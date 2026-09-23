import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import examples

CATALOG = {"technologies": [{"id": "fireeye"}, {"id": "everfox-hsg"}]}
TECHS = {
    "fireeye": {"datasets": [{"id": "nx-alert"}, {"id": "nx-alert-detail"},
                             {"id": "cm-audit"}]},
    "everfox-hsg": {"datasets": [{"id": "transfer-audit"}]},
}


class TestResolveStem(unittest.TestCase):
    def resolve(self, stem):
        return examples.resolve_stem(
            stem, ["nx-alert", "nx-alert-detail", "cm-audit"])

    def test_bare_dataset_id_is_labelled_example(self):
        self.assertEqual(self.resolve("cm-audit"), ("cm-audit", "example"))

    def test_label_suffix_renders_hyphens_as_spaces(self):
        self.assertEqual(self.resolve("cm-audit-failed-login"),
                         ("cm-audit", "failed login"))

    def test_longest_prefix_wins_over_sibling_prefix(self):
        self.assertEqual(self.resolve("nx-alert-detail"),
                         ("nx-alert-detail", "example"))
        self.assertEqual(self.resolve("nx-alert-detail-raw"),
                         ("nx-alert-detail", "raw"))

    def test_prefix_must_end_at_a_boundary(self):
        # 'nx-alerts' must NOT match dataset 'nx-alert'
        self.assertEqual(self.resolve("nx-alerts"), (None, None))

    def test_unknown_stem_does_not_resolve(self):
        self.assertEqual(self.resolve("nope"), (None, None))


class TestDiscover(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def write(self, tech, name, data):
        directory = os.path.join(self.tmp, "examples", tech)
        if not os.path.isdir(directory):
            os.makedirs(directory)
        path = os.path.join(directory, name)
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def discover(self):
        return examples.discover(self.tmp, CATALOG, TECHS)

    def test_absent_directory_is_not_an_error(self):
        records, errors = self.discover()
        self.assertEqual(records, [])
        self.assertEqual(errors, [])

    def test_record_carries_label_size_and_text(self):
        self.write("fireeye", "cm-audit-failed-login.log", b"hello\n")
        records, errors = self.discover()
        self.assertEqual(errors, [])
        self.assertEqual(len(records), 1)
        rec = records[0]
        self.assertEqual(rec["tech"], "fireeye")
        self.assertEqual(rec["dataset"], "cm-audit")
        self.assertEqual(rec["label"], "failed login")
        self.assertEqual(rec["relpath"],
                         "fireeye/cm-audit-failed-login.log")
        self.assertEqual(rec["size"], 6)
        self.assertEqual(rec["text"], "hello\n")
        self.assertFalse(rec["truncated"])

    def test_records_are_sorted_deterministically(self):
        self.write("fireeye", "nx-alert-zulu.log", b"z")
        self.write("fireeye", "cm-audit.log", b"c")
        self.write("fireeye", "nx-alert-alpha.log", b"a")
        records, _ = self.discover()
        self.assertEqual([(r["dataset"], r["label"]) for r in records],
                         [("cm-audit", "example"), ("nx-alert", "alpha"),
                          ("nx-alert", "zulu")])

    def test_unknown_technology_directory_is_fatal(self):
        self.write("not-a-tech", "cm-audit.log", b"x")
        records, errors = self.discover()
        self.assertEqual(records, [])
        self.assertTrue(any("not-a-tech" in e and "technology" in e
                            for e in errors))

    def test_unresolvable_stem_is_fatal(self):
        self.write("fireeye", "nx-alerts.log", b"x")
        records, errors = self.discover()
        self.assertEqual(records, [])
        self.assertTrue(any("nx-alerts" in e and "dataset" in e
                            for e in errors))

    def test_excluded_technology_is_fatal(self):
        self.write("everfox-hsg", "transfer-audit.log", b"x")
        records, errors = self.discover()
        self.assertEqual(records, [])
        self.assertTrue(any("everfox-hsg" in e and "excluded" in e
                            for e in errors))

    def test_inline_text_is_truncated_but_size_is_the_real_size(self):
        blob = b"A" * (examples.INLINE_BYTES + 500)
        self.write("fireeye", "cm-audit.log", blob)
        records, errors = self.discover()
        self.assertEqual(errors, [])
        rec = records[0]
        self.assertTrue(rec["truncated"])
        self.assertEqual(len(rec["text"]), examples.INLINE_BYTES)
        self.assertEqual(rec["size"], examples.INLINE_BYTES + 500)

    def test_invalid_utf8_decodes_with_replacement(self):
        self.write("fireeye", "cm-audit.log", b"ok\xff\n")
        records, errors = self.discover()
        self.assertEqual(errors, [])
        self.assertIn(u"�", records[0]["text"])

    def test_by_dataset_groups_records(self):
        self.write("fireeye", "cm-audit.log", b"c")
        self.write("fireeye", "cm-audit-second.log", b"s")
        records, _ = self.discover()
        grouped = examples.by_dataset(records)
        self.assertEqual(len(grouped[("fireeye", "cm-audit")]), 2)

    def test_examples_need_no_provenance_manifest(self):
        self.write("fireeye", "cm-audit.log", b"x")
        records, errors = self.discover()
        self.assertEqual(errors, [])
        self.assertEqual(records[0]["root"], "examples")
        self.assertNotIn("source", records[0])

    def test_publish_copies_bytes_verbatim(self):
        blob = b"raw\xff\x00bytes"
        self.write("fireeye", "cm-audit.log", blob)
        records, _ = self.discover()
        out = os.path.join(self.tmp, "public")
        examples.publish(records, out)
        path = os.path.join(out, "examples", "fireeye", "cm-audit.log")
        with open(path, "rb") as fh:
            self.assertEqual(fh.read(), blob)


SOURCE = {"repo": "https://github.com/example/upstream", "commit": "abc123",
          "license": "MIT", "license_file": "LICENSES/MIT.txt"}


class TestDiscoverSamples(unittest.TestCase):
    """Third-party samples: data/samples/, every file attributed."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.manifest = {"sources": {"upstream": dict(SOURCE)}, "files": {}}

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def put(self, relpath, data):
        path = os.path.join(self.tmp, examples.SAMPLES, *relpath.split("/"))
        if not os.path.isdir(os.path.dirname(path)):
            os.makedirs(os.path.dirname(path))
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def write(self, tech, name, data, provenance=True):
        if provenance:
            self.manifest["files"]["%s/%s" % (tech, name)] = {
                "source": "upstream", "paths": ["fixtures/%s" % name]}
        return self.put("%s/%s" % (tech, name), data)

    def discover(self, manifest=True):
        if manifest:
            self.put("LICENSES/MIT.txt", b"MIT licence text\n")
            self.put(examples.MANIFEST,
                     json.dumps(self.manifest).encode("utf-8"))
        return examples.discover_samples(self.tmp, CATALOG, TECHS)

    def test_absent_directory_is_not_an_error(self):
        self.assertEqual(examples.discover_samples(self.tmp, CATALOG, TECHS),
                         ([], []))

    def test_record_carries_root_label_and_source(self):
        self.write("fireeye", "cm-audit-syslog-raw-upstream.log", b"x\n")
        records, errors = self.discover()
        self.assertEqual(errors, [])
        rec = records[0]
        self.assertEqual(rec["root"], "samples")
        self.assertEqual(rec["dataset"], "cm-audit")
        self.assertEqual(rec["label"], "syslog raw upstream")
        self.assertEqual(rec["source"], {
            "name": "upstream", "repo": SOURCE["repo"], "commit": "abc123",
            "license": "MIT",
            "paths": ["fixtures/cm-audit-syslog-raw-upstream.log"]})

    def test_missing_manifest_is_fatal(self):
        self.write("fireeye", "cm-audit.log", b"x")
        records, errors = self.discover(manifest=False)
        self.assertEqual(records, [])
        self.assertTrue(any(examples.MANIFEST in e for e in errors))

    def test_sample_without_provenance_is_fatal(self):
        self.write("fireeye", "cm-audit.log", b"x", provenance=False)
        records, errors = self.discover()
        self.assertEqual(records, [])
        self.assertTrue(any("cm-audit.log" in e and "provenance" in e
                            for e in errors))

    def test_unknown_source_is_fatal(self):
        self.write("fireeye", "cm-audit.log", b"x")
        self.manifest["files"]["fireeye/cm-audit.log"]["source"] = "nope"
        records, errors = self.discover()
        self.assertEqual(records, [])
        self.assertTrue(any("nope" in e and "source" in e for e in errors))

    def test_stale_provenance_row_is_fatal(self):
        self.write("fireeye", "cm-audit.log", b"x")
        self.manifest["files"]["fireeye/gone.log"] = {
            "source": "upstream", "paths": ["fixtures/gone.log"]}
        _, errors = self.discover()
        self.assertTrue(any("fireeye/gone.log" in e and "no such" in e
                            for e in errors))

    def test_source_licence_file_must_exist(self):
        self.write("fireeye", "cm-audit.log", b"x")
        self.manifest["sources"]["upstream"]["license_file"] = "LICENSES/X.txt"
        _, errors = self.discover()
        self.assertTrue(any("LICENSES/X.txt" in e for e in errors))

    def test_layout_rules_match_examples(self):
        self.write("fireeye", "nx-alerts.log", b"x")
        self.write("everfox-hsg", "transfer-audit.log", b"x")
        self.write("not-a-tech", "cm-audit.log", b"x")
        records, errors = self.discover()
        self.assertEqual(records, [])
        self.assertTrue(any("nx-alerts" in e for e in errors))
        self.assertTrue(any("everfox-hsg" in e and "excluded" in e
                            for e in errors))
        self.assertTrue(any("not-a-tech" in e for e in errors))

    def test_publish_ships_samples_with_notice_and_licences(self):
        self.write("fireeye", "cm-audit.log", b"raw\xff")
        self.put(examples.NOTICE, b"notice\n")
        records, errors = self.discover()
        self.assertEqual(errors, [])
        out = os.path.join(self.tmp, "public")
        examples.publish(records, out, self.tmp)
        with open(os.path.join(out, "samples", "fireeye", "cm-audit.log"),
                  "rb") as fh:
            self.assertEqual(fh.read(), b"raw\xff")
        for rel in (examples.NOTICE, examples.MANIFEST,
                    os.path.join("LICENSES", "MIT.txt")):
            self.assertTrue(os.path.isfile(
                os.path.join(out, "samples", rel)), rel)
        self.assertFalse(os.path.exists(os.path.join(out, "examples")))


if __name__ == "__main__":
    unittest.main()
