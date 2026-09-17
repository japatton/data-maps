import contextlib
import copy
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import build, examples, schema, studio, yamlio

GOOD = {
    "repository": {"kind": "gitlab", "api_url": "https://g/api/v4",
                   "project": "soc/data-maps", "default_branch": "main",
                   "web_ide_url": "https://g/-/ide/project/{project}/edit/{branch}/-/{path}"},
    "analysis": {"api_kind": "openai", "api_url": "https://api.openai.com/v1",
                 "model": "gpt-4.1", "api_version": ""},
    "elastic": {"url": ""},
}


class TestConfig(unittest.TestCase):
    def test_good_config_has_no_errors(self):
        self.assertEqual(studio.validate_config(GOOD), [])

    def test_repo_file_is_valid(self):
        doc = yamlio.load(os.path.join(ROOT, "data", "studio.yml"))
        self.assertEqual(studio.validate_config(doc), [])

    def test_missing_section(self):
        doc = copy.deepcopy(GOOD)
        del doc["analysis"]
        self.assertIn("studio: missing key 'analysis'",
                      studio.validate_config(doc))

    def test_unknown_key_fatal(self):
        doc = copy.deepcopy(GOOD)
        doc["repository"]["token"] = "nope"
        self.assertIn("studio repository: unknown key 'token'",
                      studio.validate_config(doc))

    def test_bad_kind(self):
        doc = copy.deepcopy(GOOD)
        doc["repository"]["kind"] = "github"
        errors = studio.validate_config(doc)
        self.assertTrue(any("'kind' value 'github' not one of" in e
                            for e in errors), errors)

    def test_bad_api_kind(self):
        doc = copy.deepcopy(GOOD)
        doc["analysis"]["api_kind"] = "anthropic"
        self.assertTrue(any("'api_kind' value 'anthropic'" in e
                            for e in studio.validate_config(doc)))

    def test_empty_required_string(self):
        doc = copy.deepcopy(GOOD)
        doc["repository"]["project"] = ""
        self.assertIn("studio repository: 'project' must be a non-empty string",
                      studio.validate_config(doc))

    def test_elastic_url_must_be_string(self):
        doc = copy.deepcopy(GOOD)
        doc["elastic"]["url"] = None
        self.assertIn("studio elastic: 'url' must be a string",
                      studio.validate_config(doc))


class TestSchemaJson(unittest.TestCase):
    def setUp(self):
        self.catalog, self.techs, self.profiles, self.ecs = build.load_inputs(
            os.path.join(ROOT, "data"))
        self.doc = studio.schema_json(self.profiles, self.ecs)

    def test_vocabularies_match_schema_module(self):
        v = self.doc["vocab"]
        self.assertEqual(v["categories"], schema.CATEGORIES)
        self.assertEqual(v["statuses"], schema.STATUSES)
        self.assertEqual(v["priorities"], schema.PRIORITIES)
        self.assertEqual(v["source_formats"], schema.SOURCE_FORMATS)
        self.assertEqual(v["mechanisms"], schema.MECHANISMS)
        self.assertEqual(v["hops"], schema.HOPS)
        self.assertEqual(v["field_statuses"], schema.FIELD_STATUSES)
        self.assertEqual(v["parse_locations"], schema.PARSE_LOCATIONS)
        self.assertEqual(v["slug_pattern"], schema.SLUG_RE.pattern)
        self.assertEqual(v["hop_keys"]["guard"],
                         {"required": ["hop"],
                          "optional": ["device", "constraints", "notes"]})
        self.assertEqual(v["rec_keys"]["guarded"],
                         list(schema.REC_KEYS["guarded"]))

    def test_key_order_and_required_tables_are_published(self):
        """Studio reads the key tables; they must arrive whole.

        JSON has no tuples, so every entry - including the two per-kind
        tables - crosses as a list.
        """
        v = self.doc["vocab"]
        self.assertEqual(sorted(v["key_order"]), sorted(schema.KEY_ORDER))
        self.assertEqual(sorted(v["required"]), sorted(schema.REQUIRED))
        self.assertEqual(v["key_order"]["format"],
                         list(schema.KEY_ORDER["format"]))
        self.assertEqual(v["key_order"]["hop"]["guard"],
                         list(schema.KEY_ORDER["hop"]["guard"]))
        self.assertEqual(v["key_order"]["recommendation_side"]["direct"],
                         list(schema.KEY_ORDER["recommendation_side"]
                              ["direct"]))
        self.assertEqual(v["required"]["dataset"],
                         list(schema.REQUIRED["dataset"]))
        self.assertEqual(v["required"]["recommendations"], [])
        self.assertEqual(v["required"]["hop"], ["hop"])

    def test_excluded_examples_are_published(self):
        self.assertEqual(self.doc["examples"],
                         {"excluded": sorted(examples.EXCLUDED)})

    def test_profiles_and_ecs(self):
        self.assertEqual(self.doc["profiles"]["network"],
                         self.profiles["profiles"]["network"]["required"])
        self.assertEqual(self.doc["ecs_version"], self.ecs["ecs_version"])
        self.assertEqual(self.doc["ecs"]["source.ip"],
                         self.ecs["fields"]["source.ip"])
        self.assertGreater(len(self.doc["ecs"]), 2000)

    def test_ecs_is_a_deep_copy_of_the_loaded_dictionary(self):
        # Each field is itself a mapping, so a shallow copy would hand the
        # published document a live view of the loaded dictionary.
        field = self.doc["ecs"]["source.ip"]
        self.assertIsNot(field, self.ecs["fields"]["source.ip"])
        field["short"] = "edited"
        self.assertNotEqual(self.ecs["fields"]["source.ip"].get("short"),
                            "edited")
        del self.doc["ecs"]["source.ip"]
        self.assertIn("source.ip", self.ecs["fields"])


class TestFixture(unittest.TestCase):
    """studio/tests/fixtures/schema.json is generated, not hand-copied.

    The inputs are parsed once for the class: every case below only reads
    them, and re-parsing data/technologies for each was most of what this
    file cost to run.
    """

    @classmethod
    def setUpClass(cls):
        cls.catalog, cls.techs, cls.profiles, cls.ecs = build.load_inputs(
            os.path.join(ROOT, "data"))

    def test_committed_fixture_equals_a_fresh_generation(self):
        path = os.path.join(ROOT, studio.FIXTURE_PATH)
        with open(path, encoding="utf-8") as fh:
            committed = json.load(fh)
        self.assertEqual(
            committed, studio.fixture_schema(self.profiles, self.ecs),
            "studio/tests/fixtures/schema.json is out of date - "
            "run: python3 -m datamaps.studio --write-fixture")

    def test_fixture_keeps_every_profile_field_and_the_named_extras(self):
        doc = studio.fixture_schema(self.profiles, self.ecs)
        for name in studio.FIXTURE_ECS_EXTRA:
            self.assertIn(name, doc["ecs"])
        for required in doc["profiles"].values():
            for name in required:
                self.assertIn(name, doc["ecs"])
        # Reduced, not the whole dictionary: that is the point of it.
        self.assertLess(len(doc["ecs"]), 200)
        self.assertEqual(doc["vocab"], studio.schema_json(
            self.profiles, self.ecs)["vocab"])

    def test_fixture_omits_the_names_the_tests_need_absent(self):
        doc = studio.fixture_schema(self.profiles, self.ecs)
        for name in ("sorce.ip", "no.such.field", "source.bogus",
                     "event.nope", "panw.panos.flags"):
            self.assertNotIn(name, doc["ecs"])

    def test_write_fixture_cli_writes_both_fixtures(self):
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out)
        directory = os.path.join(out, "nested")
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = studio.main(["--write-fixture", directory])
        self.assertEqual(code, 0)
        for name, fresh in (
                ("schema.json",
                 studio.fixture_schema(self.profiles, self.ecs)),
                ("parity.json",
                 studio.fixture_parity(self.profiles, self.ecs))):
            path = os.path.join(directory, name)
            self.assertIn(path, stdout.getvalue())
            with open(path, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh), fresh, name)

    def test_committed_parity_fixture_reads_the_reduced_schema(self):
        """Both fixtures must agree, or the JS test checks stale answers."""
        doc = studio.fixture_parity(self.profiles, self.ecs)
        self.assertEqual(sorted(doc), ["cases", "expected"])
        self.assertEqual(len(doc["cases"]), len(doc["expected"]))


class TestExamplesJson(unittest.TestCase):
    """What Studio reads to know which records the site already carries."""

    def records(self):
        return [
            {"tech": "cisco-asa", "dataset": "connection-events",
             "label": "example", "relpath": "cisco-asa/connection-events.log",
             "size": 120},
            {"tech": "cisco-asa", "dataset": "connection-events",
             "label": "vpn",
             "relpath": "cisco-asa/connection-events-vpn.log", "size": 240},
            {"tech": "cisco-asa", "dataset": "admin-audit", "label": "example",
             "relpath": "cisco-asa/admin-audit.log", "size": 10},
        ]

    def test_grouped_by_technology_and_dataset(self):
        doc = studio.examples_json(self.records())
        self.assertEqual(sorted(doc), ["cisco-asa"])
        self.assertEqual(sorted(doc["cisco-asa"]),
                         ["admin-audit", "connection-events"])
        self.assertEqual(doc["cisco-asa"]["connection-events"], [
            {"label": "", "path": "examples/cisco-asa/connection-events.log",
             "size": 120},
            {"label": "vpn",
             "path": "examples/cisco-asa/connection-events-vpn.log",
             "size": 240},
        ])

    def test_the_label_is_the_stem_not_the_rendered_form(self):
        """Studio composes filenames from it, so it keeps its hyphens.

        discover() renders the label for the page ('example' for a bare
        stem, hyphens as spaces); feeding that back to Studio would have it
        propose a file the build resolves to a different name.
        """
        records = [{"tech": "t", "dataset": "d", "label": "two words",
                    "relpath": "t/d-two-words.log", "size": 1}]
        self.assertEqual(studio.examples_json(records)["t"]["d"][0]["label"],
                         "two-words")

    def test_nothing_discovered_is_an_empty_document(self):
        self.assertEqual(studio.examples_json([]), {})
        self.assertEqual(studio.examples_json(None), {})

    def test_a_real_tree_round_trips_through_discover(self):
        """The label survives the trip out of discover and back."""
        data = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, data, True)
        folder = os.path.join(data, "examples", "cisco-asa")
        os.makedirs(folder)
        for name in ("connection-events.log",
                     "connection-events-studio-test.log"):
            with open(os.path.join(folder, name), "w", encoding="utf-8") as fh:
                fh.write("%ASA-6-302013: Built inbound TCP connection\n")
        catalog, techs, _, _ = build.load_inputs(os.path.join(ROOT, "data"))
        records, errors = examples.discover(data, catalog, techs)
        self.assertEqual(errors, [])
        doc = studio.examples_json(records)
        listing = doc["cisco-asa"]["connection-events"]
        self.assertEqual([row["label"] for row in listing],
                         ["", "studio-test"])
        self.assertEqual([row["path"] for row in listing],
                         ["examples/cisco-asa/connection-events.log",
                          "examples/cisco-asa/connection-events-studio-test.log"])
        self.assertEqual(set(row["size"] for row in listing), set([44]))


class TestPublish(unittest.TestCase):
    def test_publish_writes_everything(self):
        catalog, techs, profiles, ecs = build.load_inputs(
            os.path.join(ROOT, "data"))
        out = tempfile.mkdtemp()
        try:
            studio.publish(ROOT, out, catalog, techs, profiles, ecs, GOOD)
            base = os.path.join(out, "studio")
            for rel in ("index.html", "schema.json", "config.json",
                        "examples.json",
                        os.path.join("source", "catalog.json"),
                        os.path.join("source", "cisco-asa.json")):
                self.assertTrue(os.path.exists(os.path.join(base, rel)), rel)
            self.assertFalse(os.path.exists(os.path.join(base, "tests")))
            # Always written, even with nothing to list: a 404 would look to
            # the browser like a site built before examples existed.
            with open(os.path.join(base, "examples.json"),
                      encoding="utf-8") as fh:
                self.assertEqual(json.load(fh), {})
            self.assertFalse(os.path.exists(os.path.join(base, "package.json")))
            with open(os.path.join(base, "config.json"), encoding="utf-8") as fh:
                self.assertEqual(json.load(fh), GOOD)
            with open(os.path.join(base, "source", "cisco-asa.json"),
                      encoding="utf-8") as fh:
                self.assertEqual(json.load(fh), techs["cisco-asa"])
            with open(os.path.join(base, "source", "catalog.json"),
                      encoding="utf-8") as fh:
                self.assertEqual(json.load(fh), catalog)
        finally:
            shutil.rmtree(out)

    def test_every_technology_document_is_published(self):
        """Studio reads source/<id>.json for every map that exists.

        A technology missing from source/ opens in Studio as a blank new
        document, and committing that would wipe the real file.
        """
        catalog, techs, profiles, ecs = build.load_inputs(
            os.path.join(ROOT, "data"))
        out = tempfile.mkdtemp()
        try:
            studio.publish(ROOT, out, catalog, techs, profiles, ecs, GOOD)
            source = os.path.join(out, "studio", "source")
            published = set(name[:-5] for name in os.listdir(source)
                            if name.endswith(".json"))
            self.assertEqual(published, set(techs) | set(["catalog"]))
            self.assertGreater(len(techs), 0)
            for tech_id in techs:
                with open(os.path.join(source, tech_id + ".json"),
                          encoding="utf-8") as fh:
                    self.assertEqual(json.load(fh), techs[tech_id])
            # Every catalog row with a map file is one of them.
            for row in catalog["technologies"]:
                if row["id"] in techs:
                    self.assertIn(row["id"], published)
        finally:
            shutil.rmtree(out)


def link_data(real, dest, skip=()):
    """Symlink every entry of `real` into `dest`, bar the names in `skip`.

    A skipped name is not linked at all, so a caller that then creates it
    gets a real file or directory of its own.  That is the whole point for
    `examples`: os.makedirs and open() follow a symlink, so a linked
    `examples` entry would put a test's record inside the repository's own
    data/examples/ on any checkout that has one.  This repository has none,
    which is exactly why the mistake is invisible here.
    """
    for name in os.listdir(real):
        if name in skip:
            continue
        os.symlink(os.path.join(real, name), os.path.join(dest, name))
    return dest


def linked_data(case, skip=()):
    """A temporary copy of this repository's data/, as symlinks."""
    root = tempfile.mkdtemp()
    case.addCleanup(shutil.rmtree, root, True)
    data = os.path.join(root, "data")
    os.makedirs(data)
    return link_data(os.path.join(ROOT, "data"), data, skip)


def build_into(case, data_dir=None, out_dir=None):
    """build.main in-process; returns (code, stderr, out_dir).

    The site goes to a temporary directory: no test writes ./public/.
    """
    if out_dir is None:
        out_dir = tempfile.mkdtemp()
        case.addCleanup(shutil.rmtree, out_dir, True)
    stderr = io.StringIO()
    stdout = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        with contextlib.redirect_stdout(stdout):
            code = build.main(data_dir=data_dir or os.path.join(ROOT, "data"),
                              out_dir=out_dir)
    return code, stderr.getvalue(), out_dir


class TestBuildIntegration(unittest.TestCase):
    def test_build_publishes_studio_and_links(self):
        code, stderr, public = build_into(self)
        self.assertEqual(code, 0, stderr)
        self.assertTrue(os.path.exists(
            os.path.join(public, "studio", "schema.json")))
        with open(os.path.join(public, "index.html"), encoding="utf-8") as fh:
            self.assertIn('href="studio/"', fh.read())
        with open(os.path.join(public, "tech", "cisco-asa.html"),
                  encoding="utf-8") as fh:
            html = fh.read()
        self.assertIn('href="../studio/"', html)
        self.assertIn('href="../studio/#/tech/cisco-asa"', html)
        self.assertIn("Edit in Studio", html)

    def test_load_studio_config(self):
        doc = build.load_studio_config(os.path.join(ROOT, "data"))
        self.assertIn("repository", doc)

    def test_the_built_site_publishes_the_example_listing(self):
        """Studio's examples.json is the listing the build found.

        Compared against what examples.discover finds in the same data
        directory, not against {}: this repository carries no
        data/examples/, but the work checkout does, and the published
        listing has to be right on both.  The empty case - the file is
        written even with nothing to list, so Studio can tell "no records"
        from "no such file" - is the test below, on a data directory that
        is guaranteed to have none.
        """
        data_dir = os.path.join(ROOT, "data")
        catalog, technologies, _profiles, _ecs = build.load_inputs(data_dir)
        records, errors = examples.discover(data_dir, catalog, technologies)
        self.assertEqual(errors, [])
        code, stderr, public = build_into(self)
        self.assertEqual(code, 0, stderr)
        with open(os.path.join(public, "studio", "examples.json"),
                  encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), studio.examples_json(records))

    def test_a_site_with_no_records_still_publishes_an_empty_listing(self):
        """The shape Studio needs when there is nothing to list.

        The data directory is this repository's with `examples` left
        unlinked, so it has no records whatever the checkout holds.
        """
        data = linked_data(self, skip=("examples",))
        self.assertFalse(os.path.exists(os.path.join(data, "examples")))
        code, stderr, public = build_into(self, data_dir=data)
        self.assertEqual(code, 0, stderr)
        listing = os.path.join(public, "studio", "examples.json")
        # Written, not absent: a 404 would look to the browser exactly like
        # a site built before examples existed.
        self.assertTrue(os.path.exists(listing))
        with open(listing, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), {})

    def test_a_record_on_disk_reaches_the_listing_and_the_site(self):
        # `examples` is deliberately not linked.  os.makedirs follows a
        # symlink, so a linked entry would create the folder and write the
        # record inside the repository's own data/examples/ - and the
        # assertion below, which names the whole listing, would then also
        # see whatever records that directory already held.
        data = linked_data(self, skip=("examples",))
        folder = os.path.join(data, "examples", "cisco-asa")
        os.makedirs(folder)
        body = "%ASA-6-302013: Built inbound TCP connection 1\n"
        with open(os.path.join(folder, "connection-events-studio-test.log"),
                  "w", encoding="utf-8") as fh:
            fh.write(body)
        code, stderr, public = build_into(self, data_dir=data)
        self.assertEqual(code, 0, stderr)
        with open(os.path.join(public, "studio", "examples.json"),
                  encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertEqual(doc, {"cisco-asa": {"connection-events": [
            {"label": "studio-test",
             "path": "examples/cisco-asa/connection-events-studio-test.log",
             "size": len(body)}]}})
        # The path the listing names is the one the site actually serves,
        # which is what the editor's link resolves against.
        self.assertTrue(os.path.exists(os.path.join(
            public, "examples", "cisco-asa",
            "connection-events-studio-test.log")))


class TestLinkedDataNeverWritesIntoTheRepository(unittest.TestCase):
    """A temp data directory of symlinks must not be a way back into data/.

    os.makedirs and open() both follow a symlink, so a test that links
    `examples` and then creates data/examples/<tech>/ writes its record into
    the checkout.  This repository ships no data/examples/, so the mistake
    cannot show up in its own suite - it shows up on a checkout that has
    one, by committing a test record.  The two cases below stand in a fake
    repository that does have the directory.
    """

    def fake_repo(self):
        """A 'repository' data dir with a real examples/ already in it.

        The technology it holds is not the one the record below is written
        for, so os.makedirs succeeds and the write goes through - which is
        the damaging case.  (Where the folder does exist, makedirs raises
        instead: also a failure, just a louder one.)
        """
        real = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, real, True)
        kept = os.path.join(real, "examples", "paloalto-ngfw")
        os.makedirs(kept)
        with open(os.path.join(kept, "already-here.log"), "w",
                  encoding="utf-8") as fh:
            fh.write("a record the repository already had\n")
        os.makedirs(os.path.join(real, "technologies"))
        return real

    def temp_data(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        data = os.path.join(root, "data")
        os.makedirs(data)
        return data

    def write_a_record(self, data):
        """What the listing test does once it has its data directory."""
        folder = os.path.join(data, "examples", "cisco-asa")
        os.makedirs(folder)
        with open(os.path.join(folder, "connection-events-studio-test.log"),
                  "w", encoding="utf-8") as fh:
            fh.write("%ASA-6-302013\n")

    def technologies_under(self, base):
        return sorted(os.listdir(os.path.join(base, "examples")))

    def test_skipping_examples_keeps_the_write_inside_the_temp_dir(self):
        real = self.fake_repo()
        data = link_data(real, self.temp_data(), skip=("examples",))
        self.write_a_record(data)
        # The repository is untouched...
        self.assertEqual(self.technologies_under(real), ["paloalto-ngfw"])
        # ...the record went into the temp directory, which owns its own
        # examples/ rather than pointing at the repository's...
        self.assertFalse(os.path.islink(os.path.join(data, "examples")))
        self.assertEqual(self.technologies_under(data), ["cisco-asa"])
        self.assertTrue(os.path.exists(os.path.join(
            data, "examples", "cisco-asa",
            "connection-events-studio-test.log")))
        # ...and everything not skipped is still shared by symlink.
        self.assertTrue(os.path.islink(os.path.join(data, "technologies")))

    def test_linking_examples_is_what_writes_through_the_symlink(self):
        """The bug the skip exists for, shown rather than described."""
        real = self.fake_repo()
        data = link_data(real, self.temp_data())
        self.assertTrue(os.path.islink(os.path.join(data, "examples")))
        self.write_a_record(data)
        self.assertEqual(
            self.technologies_under(real), ["cisco-asa", "paloalto-ngfw"],
            "linking examples writes into the repository - which is why "
            "the listing test skips it")
        self.assertTrue(os.path.exists(os.path.join(
            real, "examples", "cisco-asa",
            "connection-events-studio-test.log")))

    def test_the_listing_test_skips_examples(self):
        """Read from the source: the skip is the whole fix."""
        with open(os.path.join(ROOT, "tests", "test_studio.py"),
                  encoding="utf-8") as fh:
            body = fh.read()
        call = body.split(
            "def test_a_record_on_disk_reaches_the_listing_and_the_site")[1]
        self.assertIn('linked_data(self, skip=("examples",))',
                      call.split("build_into")[0])


class TestConfigIsWiredIntoTheBuild(unittest.TestCase):
    """A bad studio.yml must fail the build, not ship to the site.

    validate_config is exercised directly above; this is about the wiring:
    build.main has to call it and treat what it returns as fatal.
    """

    def _data_with_studio_yml(self, body):
        """A data directory that is this repository's, bar studio.yml."""
        data = linked_data(self, skip=("studio.yml",))
        with open(os.path.join(data, "studio.yml"), "w",
                  encoding="utf-8") as fh:
            fh.write(body)
        return data

    def _run_build(self, data):
        """Build that data into a directory the build itself creates.

        The output path does not exist yet, so a run that stops at
        validation leaves nothing behind to find.
        """
        out = os.path.join(os.path.dirname(data), "public")
        code, stderr, _ = build_into(self, data_dir=data, out_dir=out)
        return code, stderr, out

    def _body(self, kind="gitlab", extra=""):
        good = yamlio.load(os.path.join(ROOT, "data", "studio.yml"))
        repo = good["repository"]
        return ("repository:\n"
                "  kind: %s\n"
                "  api_url: %s\n"
                "  project: %s\n"
                "  default_branch: %s\n"
                "  web_ide_url: '%s'\n"
                "%s"
                "analysis:\n"
                "  api_kind: openai\n"
                "  api_url: https://api.openai.com/v1\n"
                "  model: gpt-4.1\n"
                "elastic:\n"
                "  url: ''\n"
                % (kind, repo["api_url"], repo["project"],
                   repo["default_branch"], repo["web_ide_url"], extra))

    def test_unknown_studio_key_is_fatal(self):
        data = self._data_with_studio_yml(self._body(extra="  token: nope\n"))
        code, stderr, out = self._run_build(data)
        self.assertEqual(code, 1)
        self.assertIn("FATAL: studio repository: unknown key 'token'", stderr)
        # Nothing was written: the build stops before it renders.
        self.assertFalse(os.path.exists(out))

    def test_unknown_repository_kind_is_fatal(self):
        data = self._data_with_studio_yml(self._body(kind="github"))
        code, stderr, _ = self._run_build(data)
        self.assertEqual(code, 1)
        self.assertIn("FATAL: studio repository: 'kind' value 'github'",
                      stderr)

    def test_a_good_studio_yml_does_not_stop_the_build(self):
        data = self._data_with_studio_yml(self._body())
        code, stderr, out = self._run_build(data)
        self.assertEqual(code, 0, stderr)
        self.assertTrue(os.path.exists(
            os.path.join(out, "studio", "config.json")))


class TestAllowOverride(unittest.TestCase):
    """analysis.allow_override: optional, boolean, true when absent."""

    def test_absent_is_valid(self):
        self.assertNotIn("allow_override", GOOD["analysis"])
        self.assertEqual(studio.validate_config(GOOD), [])

    def test_both_booleans_are_valid(self):
        for value in (True, False):
            doc = copy.deepcopy(GOOD)
            doc["analysis"]["allow_override"] = value
            self.assertEqual(studio.validate_config(doc), [], value)

    def test_non_boolean_is_an_error(self):
        for value in ("true", 1, None, []):
            doc = copy.deepcopy(GOOD)
            doc["analysis"]["allow_override"] = value
            self.assertIn(
                "studio analysis: 'allow_override' must be true or false",
                studio.validate_config(doc), repr(value))

    def test_the_repo_file_sets_it_and_still_validates(self):
        doc = yamlio.load(os.path.join(ROOT, "data", "studio.yml"))
        self.assertIs(doc["analysis"]["allow_override"], True)
        self.assertEqual(studio.validate_config(doc), [])


class TestOverlayEnv(unittest.TestCase):
    def overlay(self, environ):
        return studio.overlay_env(GOOD, environ)

    def test_a_key_in_each_section(self):
        doc, taken = self.overlay({
            "STUDIO_REPOSITORY_API_URL": "https://forge.test/api/v1",
            "STUDIO_ANALYSIS_MODEL": "llama3",
            "STUDIO_ELASTIC_URL": "https://kibana.test:5601",
        })
        self.assertEqual(taken, ["analysis.model", "elastic.url",
                                 "repository.api_url"])
        self.assertEqual(doc["repository"]["api_url"],
                         "https://forge.test/api/v1")
        self.assertEqual(doc["analysis"]["model"], "llama3")
        self.assertEqual(doc["elastic"]["url"], "https://kibana.test:5601")

    def test_multi_word_keys_keep_their_underscores(self):
        doc, taken = self.overlay({
            "STUDIO_REPOSITORY_DEFAULT_BRANCH": "trunk",
            "STUDIO_REPOSITORY_WEB_IDE_URL": "https://forge.test/{path}",
            "STUDIO_ANALYSIS_API_VERSION": "2024-02-01",
        })
        self.assertEqual(taken, ["analysis.api_version",
                                 "repository.default_branch",
                                 "repository.web_ide_url"])
        self.assertEqual(doc["repository"]["default_branch"], "trunk")
        self.assertEqual(doc["repository"]["web_ide_url"],
                         "https://forge.test/{path}")

    def test_the_original_document_is_untouched(self):
        before = copy.deepcopy(GOOD)
        doc, _ = self.overlay({"STUDIO_ANALYSIS_MODEL": "llama3"})
        self.assertEqual(GOOD, before)
        self.assertIsNot(doc["analysis"], GOOD["analysis"])

    def test_nothing_in_the_environment_takes_nothing(self):
        doc, taken = self.overlay({"PATH": "/bin", "STUDIOFOO": "x"})
        self.assertEqual(taken, [])
        self.assertEqual(doc, GOOD)

    def test_allowed_hosts_is_not_an_override(self):
        """It configures the build's check, not the site's config."""
        doc, taken = self.overlay({"STUDIO_ALLOWED_HOSTS": "a.test,b.test"})
        self.assertEqual(taken, [])
        self.assertEqual(doc, GOOD)

    def test_allow_override_parses_as_a_boolean(self):
        for text, want in (("true", True), ("TRUE", True), ("false", False),
                           ("False", False), (" true ", True)):
            doc, taken = self.overlay(
                {"STUDIO_ANALYSIS_ALLOW_OVERRIDE": text})
            self.assertEqual(taken, ["analysis.allow_override"])
            self.assertIs(doc["analysis"]["allow_override"], want, text)
            self.assertEqual(studio.validate_config(doc), [])

    def test_a_non_boolean_allow_override_is_fatal(self):
        for text in ("yes", "1", "", "no"):
            with self.assertRaises(ValueError) as caught:
                self.overlay({"STUDIO_ANALYSIS_ALLOW_OVERRIDE": text})
            self.assertIn("must be true or false", str(caught.exception))

    def test_an_unknown_section_is_fatal(self):
        with self.assertRaises(ValueError) as caught:
            self.overlay({"STUDIO_SETTINGS_URL": "x"})
        self.assertIn("STUDIO_SETTINGS_URL: 'settings' is not a studio "
                      "config section", str(caught.exception))

    def test_an_unknown_key_is_fatal(self):
        with self.assertRaises(ValueError) as caught:
            self.overlay({"STUDIO_REPOSITORY_TOKEN": "hunter2"})
        self.assertEqual("STUDIO_REPOSITORY_TOKEN: 'token' is not a key of "
                         "studio repository", str(caught.exception))

    def test_a_section_with_no_key_is_fatal(self):
        with self.assertRaises(ValueError):
            self.overlay({"STUDIO_ELASTIC": "https://kibana.test"})

    def test_a_missing_section_is_created(self):
        doc, taken = studio.overlay_env(
            {}, {"STUDIO_ELASTIC_URL": "https://k"})
        self.assertEqual(doc, {"elastic": {"url": "https://k"}})
        self.assertEqual(taken, ["elastic.url"])

    def test_two_spellings_of_one_key_are_reported_once(self):
        """The name is lowercased on the way to a dotted key."""
        doc, taken = studio.overlay_env(
            {}, {"STUDIO_ELASTIC_URL": "https://k",
                 "STUDIO_elastic_url": "https://k2"})
        self.assertEqual(taken, ["elastic.url"])
        # The last name in sorted order wins - uppercase sorts first - and
        # the report names the key once either way.
        self.assertEqual(doc["elastic"]["url"], "https://k2")


class TestCheckHosts(unittest.TestCase):
    def hosts(self, config, allowed):
        return studio.check_hosts(config, allowed)

    def test_every_url_on_the_list_passes(self):
        self.assertEqual(
            self.hosts(GOOD, ["g", "api.openai.com"]), [])

    def test_the_comparison_ignores_case(self):
        doc = copy.deepcopy(GOOD)
        doc["elastic"]["url"] = "https://Kibana.Test:5601/app"
        self.assertEqual(self.hosts(doc, ["G", "API.OpenAI.com",
                                          "kibana.test"]), [])

    def test_an_off_list_host_is_named(self):
        doc = copy.deepcopy(GOOD)
        doc["analysis"]["api_url"] = "https://api.openai.com/v1"
        errors = self.hosts(doc, ["g"])
        self.assertEqual(
            errors,
            ["studio analysis: 'api_url' host 'api.openai.com' is not in "
             "STUDIO_ALLOWED_HOSTS"])

    def test_every_url_key_is_checked(self):
        doc = copy.deepcopy(GOOD)
        doc["elastic"]["url"] = "https://kibana.test"
        errors = self.hosts(doc, [])
        self.assertEqual(
            [e.split("'")[1] for e in errors],
            ["api_url", "web_ide_url", "api_url", "url"])

    def test_empty_urls_are_skipped(self):
        """An unset elastic.url points nowhere, so it breaks no lock."""
        self.assertEqual(GOOD["elastic"]["url"], "")
        errors = self.hosts(GOOD, ["g", "api.openai.com"])
        self.assertEqual(errors, [])

    def test_a_url_with_no_host_is_reported(self):
        doc = copy.deepcopy(GOOD)
        doc["elastic"]["url"] = "/relative/path"
        self.assertIn("studio elastic: 'url' host '' is not in "
                      "STUDIO_ALLOWED_HOSTS", self.hosts(doc, ["g"]))

    def test_a_url_urlsplit_cannot_parse_fails_the_check(self):
        """A malformed URL has no host, and no host is never on the list."""
        doc = copy.deepcopy(GOOD)
        # An unterminated IPv6 literal: urlsplit raises ValueError on
        # .hostname rather than returning anything.
        doc["elastic"]["url"] = "https://[::1/app"
        self.assertIn("studio elastic: 'url' host '' is not in "
                      "STUDIO_ALLOWED_HOSTS", self.hosts(doc, ["g"]))

    def test_the_repo_file_passes_against_its_own_hosts(self):
        doc = yamlio.load(os.path.join(ROOT, "data", "studio.yml"))
        self.assertEqual(self.hosts(doc, config_hosts(doc)), [])


def config_hosts(doc):
    """Every host a config's URLs name - what an allow-list would hold."""
    found = set()
    for section in ("repository", "analysis", "elastic"):
        for key, value in doc[section].items():
            if not key.endswith("url") or not isinstance(value, str):
                continue
            host = urllib.parse.urlsplit(value.strip()).hostname
            if host:
                found.add(host)
    return sorted(found)


class TestEnvironmentReachesTheBuild(unittest.TestCase):
    """The overlay and the endpoint lock, through build.main."""

    def build(self, environ):
        """Build the repository's data with this environment.

        The output path does not exist yet: a run that stops at the lock
        leaves nothing behind to find.
        """
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        out = os.path.join(root, "public")
        stderr = io.StringIO()
        stdout = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            with contextlib.redirect_stdout(stdout):
                code = build.main(data_dir=os.path.join(ROOT, "data"),
                                  out_dir=out, environ=environ)
        return code, stdout.getvalue(), stderr.getvalue(), out

    def repo_hosts(self):
        return config_hosts(build.load_studio_config(
            os.path.join(ROOT, "data")))

    def test_an_allowed_override_ships_in_config_json(self):
        url = "https://kibana.test:5601/app"
        code, stdout, stderr, out = self.build({
            "STUDIO_ELASTIC_URL": url,
            "STUDIO_ALLOWED_HOSTS":
                ", ".join(self.repo_hosts() + ["kibana.test"]) + ",",
        })
        self.assertEqual(code, 0, stderr)
        self.assertIn("studio config: keys from environment: elastic.url",
                      stdout)
        with open(os.path.join(out, "studio", "config.json"),
                  encoding="utf-8") as fh:
            published = json.load(fh)
        self.assertEqual(published["elastic"]["url"], url)
        # The file on disk is what it always was.
        self.assertEqual(
            build.load_studio_config(os.path.join(ROOT, "data"))["elastic"],
            {"url": ""})

    def test_a_host_off_the_list_is_fatal(self):
        code, stdout, stderr, out = self.build({
            "STUDIO_ELASTIC_URL": "https://elastic.example.test:9200",
            "STUDIO_ALLOWED_HOSTS": ",".join(self.repo_hosts()),
        })
        self.assertEqual(code, 1)
        self.assertIn("FATAL: studio elastic: 'url' host "
                      "'elastic.example.test' is not in STUDIO_ALLOWED_HOSTS",
                      stderr)
        self.assertFalse(os.path.exists(out))

    def test_an_unknown_variable_is_fatal(self):
        code, stdout, stderr, out = self.build({"STUDIO_ELASTIC_NOPE": "x"})
        self.assertEqual(code, 1)
        self.assertIn("FATAL: STUDIO_ELASTIC_NOPE: 'nope' is not a key of "
                      "studio elastic", stderr)
        self.assertFalse(os.path.exists(out))

    def test_an_overridden_value_still_has_to_validate(self):
        code, stdout, stderr, out = self.build(
            {"STUDIO_REPOSITORY_KIND": "github"})
        self.assertEqual(code, 1)
        self.assertIn("FATAL: studio repository: 'kind' value 'github'",
                      stderr)
        self.assertFalse(os.path.exists(out))


class TestStudioImportsNoHeavyDependency(unittest.TestCase):
    """datamaps.studio is a seam: it must not pull yaml or jinja2 in.

    build.py imports it, and CI's Node image has neither installed by
    default, so an import added here would only show up in the JS job.
    Asserting `"yaml" not in sys.modules` would prove nothing - by the time
    this file runs, something else has imported it - so the entries are
    poisoned with None instead, which Python turns into an ImportError at
    the `import` statement itself.  That catches a bare `import yaml` as
    well as any use of it.
    """

    HEAVY = ("yaml", "jinja2")

    def test_importing_studio_touches_neither_yaml_nor_jinja2(self):
        import importlib
        saved = dict((name, module) for name, module in sys.modules.items()
                     if name == "datamaps.studio"
                     or name.split(".")[0] in self.HEAVY)
        for name in saved:
            del sys.modules[name]
        for name in self.HEAVY:
            sys.modules[name] = None
        try:
            importlib.import_module("datamaps.studio")
        except ImportError as exc:
            self.fail("datamaps.studio must import neither yaml nor "
                      "jinja2: %s" % exc)
        finally:
            for name in self.HEAVY:
                if sys.modules.get(name, False) is None:
                    del sys.modules[name]
            sys.modules.pop("datamaps.studio", None)
            sys.modules.update(saved)

    def test_the_poison_would_actually_be_noticed(self):
        """The guard above only means something if the poison bites."""
        saved = dict((name, module) for name, module in sys.modules.items()
                     if name.split(".")[0] == "yaml")
        for name in saved:
            del sys.modules[name]
        sys.modules["yaml"] = None
        try:
            with self.assertRaises(ImportError):
                import yaml  # noqa: F401
        finally:
            if sys.modules.get("yaml", False) is None:
                del sys.modules["yaml"]
            sys.modules.update(saved)
