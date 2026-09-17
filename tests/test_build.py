import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import build, model as model_mod

DATA = os.path.join(ROOT, "data")

_INPUTS = None


def inputs():
    """This repository's data, parsed once for the whole module.

    Nothing here mutates it - two tests below assert exactly that - so one
    parse serves every case and the suite stays fast.
    """
    global _INPUTS
    if _INPUTS is None:
        _INPUTS = build.load_inputs(DATA)
    return _INPUTS


def run_build(out_dir, data_dir=DATA, argv=None):
    """build.main in-process, its report captured; returns (code, stdout)."""
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        with contextlib.redirect_stderr(stderr):
            code = build.main(argv=argv, data_dir=data_dir, out_dir=out_dir)
    return code, stdout.getvalue() + stderr.getvalue()


def temp_dir(case):
    out = tempfile.mkdtemp()
    case.addCleanup(shutil.rmtree, out, True)
    return out


class TestBuild(unittest.TestCase):
    """One build of the repository's data into a temporary directory."""

    @classmethod
    def setUpClass(cls):
        # tearDownClass does not run when setUpClass raises, so the
        # directory is removed here rather than left behind in /tmp.
        cls.out = tempfile.mkdtemp()
        try:
            cls.code, cls.report = run_build(cls.out)
        except BaseException:
            shutil.rmtree(cls.out, True)
            raise

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.out, True)

    def catalog(self):
        with open(os.path.join(self.out, "exports", "catalog.json"),
                  encoding="utf-8") as fh:
            return json.load(fh)

    def test_full_build(self):
        self.assertEqual(self.code, 0, self.report)
        for rel in ("index.html", "ecs-index.html", "styles.css",
                    "app.js", os.path.join("exports", "catalog.json")):
            self.assertTrue(os.path.exists(os.path.join(self.out, rel)), rel)
        catalog = self.catalog()
        self.assertGreaterEqual(len(catalog["technologies"]), 40)
        with_docs = [t for t in catalog["technologies"]
                     if t["coverage"]["fields_total"] > 0]
        self.assertGreaterEqual(len(with_docs), 3)
        one = with_docs[0]
        self.assertTrue(os.path.exists(os.path.join(
            self.out, "exports", one["id"] + ".json")))
        self.assertTrue(os.path.exists(os.path.join(
            self.out, "tech", one["id"] + ".html")))

    def test_the_report_names_the_directory_it_wrote(self):
        self.assertIn(self.out, self.report)

    def export(self, name):
        with open(os.path.join(self.out, "exports", name),
                  encoding="utf-8") as fh:
            return json.load(fh)

    def test_every_export_is_written_and_stamped_with_its_schema_version(self):
        one = next(t["id"] for t in self.catalog()["technologies"]
                   if t["coverage"]["fields_total"] > 0)
        for name in ("catalog.json", "alerting.json", "ecs-index.json",
                     one + ".json"):
            path = os.path.join(self.out, "exports", name)
            self.assertTrue(os.path.exists(path), name)
            self.assertEqual(self.export(name)["schema_version"],
                             build.SCHEMA_VERSION, name)

    def test_the_alerting_export_carries_the_profiles_and_the_matrix(self):
        doc = self.export("alerting.json")
        self.assertTrue(doc["ecs_version"])
        self.assertEqual(sorted(doc["profiles"]),
                         sorted(c["category"] for c in doc["matrix"]))
        for category in doc["matrix"]:
            required = doc["profiles"][category["category"]]["required"]
            self.assertEqual([r["field"] for r in category["required"]],
                             required)
            for entry in category["required"]:
                total = sum(len(entry[b]) for b in
                            ("satisfied", "partial", "missing"))
                self.assertEqual(total, category["datasets"])
                for cell in entry["satisfied"]:
                    self.assertEqual(sorted(cell), ["dataset", "tech"])
                    self.assertIsInstance(cell["tech"], str)

    def test_the_ecs_index_export_lists_fields_with_their_usages(self):
        doc = self.export("ecs-index.json")
        self.assertTrue(doc["ecs_version"])
        self.assertGreater(len(doc["fields"]), 0)
        keys = set()
        required_in = False
        for entry in doc["fields"]:
            self.assertEqual(sorted(entry),
                             ["name", "required_in", "short", "type",
                              "usages"])
            required_in = required_in or bool(entry["required_in"])
            for usage in entry["usages"]:
                keys.add(tuple(sorted(usage)))
        self.assertTrue(required_in)
        self.assertEqual(keys, set([("dataset", "format", "recommended",
                                     "status", "technology", "vendor")]))

    def test_the_catalog_export_lists_every_dataset(self):
        catalog = self.catalog()
        self.assertGreater(len(catalog["datasets"]), 0)
        for entry in catalog["datasets"]:
            self.assertEqual(sorted(entry),
                             ["coverage", "event_categories", "id", "name",
                              "recommendation", "technology"])
            self.assertEqual(sorted(entry["recommendation"]),
                             ["format", "source"])
            self.assertEqual(sorted(entry["coverage"]),
                             ["closable", "required_mapped", "required_pct",
                              "required_total", "unobtainable"])

    def test_technology_exports_flag_alerting_fields_and_carry_coverage(self):
        flagged = datasets = 0
        for entry in self.catalog()["technologies"]:
            path = os.path.join(self.out, "exports", entry["id"] + ".json")
            if not os.path.exists(path):
                continue
            for ds in self.export(entry["id"] + ".json")["datasets"]:
                datasets += 1
                self.assertEqual(sorted(ds["coverage"]),
                                 ["closable", "required_mapped",
                                  "required_pct", "required_total",
                                  "unobtainable"])
                for fmt in ds["formats"]:
                    for field in fmt["fields"]:
                        self.assertIn("alerting_required", field)
                        self.assertIsInstance(field["alerting_required"],
                                              bool)
                        flagged += field["alerting_required"]
        self.assertGreater(datasets, 0)
        self.assertGreater(flagged, 0)


class TestBuildDirectories(unittest.TestCase):
    """--data/--out, and the defaults they replace."""

    def test_defaults_are_the_repository_directories(self):
        self.assertEqual(build.resolve_dirs([], None, None),
                         (os.path.join(ROOT, "data"),
                          os.path.join(ROOT, "public")))

    def test_options_replace_the_defaults(self):
        self.assertEqual(
            build.resolve_dirs(["--data", "/d", "--out", "/o"], None, None),
            ("/d", "/o"))

    def test_arguments_win_over_options(self):
        self.assertEqual(
            build.resolve_dirs(["--data", "/d", "--out", "/o"], "/D", "/O"),
            ("/D", "/O"))

    def test_argv_reaches_main(self):
        """--data is honoured by main itself, not only by resolve_dirs.

        out_dir is passed even though this build fails before anything is
        written: a case that let the output directory resolve to its
        default would be one wrong edit away from replacing ./public/.
        """
        missing = os.path.join(temp_dir(self), "not-here")
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = build.main(argv=["--data", missing],
                              out_dir=temp_dir(self))
        self.assertEqual(code, 1)
        self.assertIn(missing, stderr.getvalue())


class TestExampleExports(unittest.TestCase):
    def inputs(self):
        return inputs()

    def test_export_lists_examples_site_relative(self):
        catalog, techs, profiles, ecs = self.inputs()
        tech_id = sorted(techs)[0]
        ds_id = techs[tech_id]["datasets"][0]["id"]
        rec = {"tech": tech_id, "dataset": ds_id, "label": "example",
               "path": "/tmp/x.log",
               "relpath": "%s/%s.log" % (tech_id, ds_id),
               "size": 3, "text": "raw", "truncated": False}
        page_model = model_mod.build_model(
            catalog, techs, profiles, ecs, {(tech_id, ds_id): [rec]})
        out = temp_dir(self)
        build.write_exports(page_model, out)
        with open(os.path.join(out, "exports", tech_id + ".json"),
                  encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertEqual(doc["examples"], [
            {"dataset": ds_id, "label": "example",
             "path": "examples/%s/%s.log" % (tech_id, ds_id)}])
        # the source YAML doc must not have been mutated
        self.assertNotIn("examples", techs[tech_id])

    def test_export_dataset_names_the_recommendation(self):
        catalog, techs, profiles, ecs = self.inputs()
        page_model = model_mod.build_model(catalog, techs, profiles, ecs)
        tech_view = next(v for v in page_model["technologies"] if v["doc"])
        tech_id = tech_view["entry"]["id"]
        out = temp_dir(self)
        build.write_exports(page_model, out)
        with open(os.path.join(out, "exports", tech_id + ".json"),
                  encoding="utf-8") as fh:
            doc = json.load(fh)
        for ds_payload, ds_view in zip(doc["datasets"],
                                       tech_view["datasets"]):
            rec = ds_payload["recommendation"]
            self.assertEqual(rec["format"],
                             ds_view["recommendation"]["data"]["format"])
            self.assertEqual(rec["source"], ds_view["recommendation_source"])
            self.assertEqual(list(ds_payload)[-2:],
                             ["recommendation", "coverage"])
        # the source YAML doc's dataset dicts must not have been mutated
        for ds in techs[tech_id]["datasets"]:
            self.assertNotIn("recommendation", ds)

    def test_export_omits_the_key_when_there_are_no_examples(self):
        catalog, techs, profiles, ecs = self.inputs()
        page_model = model_mod.build_model(catalog, techs, profiles, ecs)
        out = temp_dir(self)
        build.write_exports(page_model, out)
        tech_id = sorted(techs)[0]
        with open(os.path.join(out, "exports", tech_id + ".json"),
                  encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertNotIn("examples", doc)


class TestModelAdditionsOnRealData(unittest.TestCase):
    """The new model keys, read off this repository's own catalog."""

    @classmethod
    def setUpClass(cls):
        catalog, techs, profiles, ecs = inputs()
        cls.model = model_mod.build_model(catalog, techs, profiles, ecs)
        cls.profiles = profiles["profiles"]

    def test_usages_name_their_format_and_the_recommended_one(self):
        seen = set()
        for entry in self.model["ecs_index"]:
            for usage in entry["usages"]:
                self.assertTrue(usage["format"])
                seen.add(usage["recommended"])
        self.assertEqual(seen, set([True, False]))

    def test_required_in_agrees_with_the_profiles(self):
        checked = 0
        for entry in self.model["ecs_index"]:
            expected = sorted(c for c, body in self.profiles.items()
                              if entry["name"] in body["required"])
            self.assertEqual(entry["required_in"], expected, entry["name"])
            checked += bool(expected)
        self.assertGreater(checked, 0)

    def test_the_matrix_covers_every_category_and_places_every_dataset(self):
        matrix = self.model["alerting_matrix"]
        self.assertEqual([c["category"] for c in matrix],
                         list(self.profiles))
        for category in matrix:
            carrying = [d for view in self.model["technologies"]
                        for d in view["datasets"]
                        if category["category"]
                        in d["data"]["event_categories"]]
            self.assertEqual(category["datasets"], len(carrying))
            self.assertLessEqual(category["all_satisfied"],
                                 category["datasets"])
            for entry in category["required"]:
                placed = sum(len(entry[b]) for b in
                             ("satisfied", "partial", "missing"))
                self.assertEqual(placed, len(carrying), entry["field"])


class TestExportAnnotationsDoNotMutate(unittest.TestCase):
    """The annotated copies must leave the loaded documents alone."""

    def test_fields_and_coverage_are_added_to_copies_only(self):
        catalog, techs, profiles, ecs = inputs()
        page_model = model_mod.build_model(catalog, techs, profiles, ecs)
        out = temp_dir(self)
        build.write_exports(page_model, out)
        for tech_id, doc in techs.items():
            for ds in doc["datasets"]:
                self.assertNotIn("coverage", ds, tech_id)
                for fmt in ds["formats"]:
                    for field in fmt["fields"]:
                        self.assertNotIn("alerting_required", field, tech_id)

    def test_alerting_required_repeats_the_models_flag(self):
        catalog, techs, profiles, ecs = inputs()
        page_model = model_mod.build_model(catalog, techs, profiles, ecs)
        out = temp_dir(self)
        build.write_exports(page_model, out)
        view = next(v for v in page_model["technologies"] if v["doc"])
        with open(os.path.join(out, "exports",
                               view["entry"]["id"] + ".json"),
                  encoding="utf-8") as fh:
            doc = json.load(fh)
        for ds_payload, ds_view in zip(doc["datasets"], view["datasets"]):
            for fmt_payload, fmt_view in zip(ds_payload["formats"],
                                             ds_view["formats"]):
                self.assertEqual(
                    [f["alerting_required"] for f in fmt_payload["fields"]],
                    [bool(f["alerting"]) for f in fmt_view["fields"]])


class TestBuildIsDeterministic(unittest.TestCase):
    """Two builds of the same data into two directories agree byte for byte.

    Both run in this interpreter, so they share one PYTHONHASHSEED: what
    this covers is ordering the build itself chose, not ordering a set or
    a dict iteration happened to give twice.  Nondeterminism that only
    appears across processes would need two runs of the suite under
    different seeds, which no test here does.
    """

    @classmethod
    def setUpClass(cls):
        cls.first_dir = tempfile.mkdtemp()
        cls.second_dir = tempfile.mkdtemp()
        try:
            cls.first_code, cls.first_report = run_build(cls.first_dir)
            cls.second_code, cls.second_report = run_build(cls.second_dir)
        except BaseException:
            shutil.rmtree(cls.first_dir, True)
            shutil.rmtree(cls.second_dir, True)
            raise

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.first_dir, True)
        shutil.rmtree(cls.second_dir, True)

    def snapshot(self, public):
        out = {}
        for base, _dirs, names in os.walk(public):
            for name in names:
                path = os.path.join(base, name)
                with open(path, "rb") as fh:
                    out[os.path.relpath(path, public)] = fh.read()
        return out

    def test_both_builds_succeeded(self):
        self.assertEqual(self.first_code, 0, self.first_report)
        self.assertEqual(self.second_code, 0, self.second_report)

    def test_rebuild_is_byte_identical(self):
        self.assertEqual(self.snapshot(self.first_dir),
                         self.snapshot(self.second_dir))

    def test_the_catalog_export_is_identical(self):
        """The machine-readable export is the same document either time."""
        rel = os.path.join("exports", "catalog.json")
        with open(os.path.join(self.first_dir, rel), "rb") as fh:
            first = fh.read()
        with open(os.path.join(self.second_dir, rel), "rb") as fh:
            second = fh.read()
        self.assertEqual(first, second)
        self.assertGreater(len(json.loads(first.decode("utf-8"))
                               ["technologies"]), 0)


if __name__ == "__main__":
    unittest.main()


class OutputDirectoryGuardTests(unittest.TestCase):
    """The build empties out_dir before writing it.

    Nothing stopped that directory being the data it just read, or the
    repository, so `--out data` deleted data/technologies and reported
    success, and `--out .` would have taken .git with it.

    Every case here uses a REAL copy of data/, so the build would otherwise
    reach the rmtree and succeed.  A temp directory with no catalog fails
    early for an unrelated reason and would pass these assertions without
    the guard existing at all.
    """

    def _data_copy(self):
        root = temp_dir(self)
        dest = os.path.join(root, "data")
        shutil.copytree(os.path.join(build.ROOT, "data"), dest)
        return root, dest

    def _run(self, out, data):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = build.main(["--out", out, "--data", data])
        return code, stderr.getvalue()

    def test_a_normal_output_directory_still_builds(self):
        """The guard must not break the ordinary case."""
        root, data = self._data_copy()
        code, err = self._run(os.path.join(root, "public"), data)
        self.assertEqual(code, 0, err)
        self.assertTrue(os.path.isfile(os.path.join(root, "public", "index.html")))

    def test_refuses_to_write_into_the_data_directory(self):
        root, data = self._data_copy()
        code, err = self._run(data, data)
        self.assertEqual(code, 1)
        self.assertIn("FATAL", err)
        self.assertTrue(
            os.path.isdir(os.path.join(data, "technologies")),
            "the build deleted the data it had just read")

    def test_refuses_to_write_into_a_parent_of_the_data_directory(self):
        root, data = self._data_copy()
        code, err = self._run(root, data)
        self.assertEqual(code, 1)
        self.assertIn("FATAL", err)
        self.assertTrue(os.path.isdir(data))

    def test_refuses_to_write_into_a_directory_holding_a_git_repository(self):
        root, data = self._data_copy()
        site = os.path.join(root, "site")
        os.makedirs(site)
        os.makedirs(os.path.join(site, ".git"))
        code, err = self._run(site, data)
        self.assertEqual(code, 1)
        self.assertIn("FATAL", err)
        self.assertTrue(os.path.isdir(os.path.join(site, ".git")))


class MalformedCatalogTests(unittest.TestCase):
    """A broken catalog must report the schema's message, not a traceback.

    examples.discover indexes catalog rows by row["id"] and used to run
    before validate_all, so a row with no id raised KeyError out of the
    build and hid the FATAL lines the schema layer already had for it.
    """

    def test_a_catalog_row_with_no_id_is_reported_not_raised(self):
        root = temp_dir(self)
        data = os.path.join(root, "data")
        shutil.copytree(os.path.join(build.ROOT, "data"), data)
        path = os.path.join(data, "catalog.yml")
        with io.open(path, encoding="utf-8") as fh:
            text = fh.read()
        with io.open(path, "w", encoding="utf-8") as fh:
            fh.write(text.replace(
                "technologies:\n",
                "technologies:\n- {name: Broken, vendor: X, "
                "category: endpoint, status: in-progress, priority: edge}\n",
                1))
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = build.main(["--data", data, "--out", os.path.join(root, "out")])
        err = stderr.getvalue()
        self.assertEqual(code, 1)
        self.assertIn("missing key 'id'", err)
        self.assertNotIn("Traceback", err)
        self.assertNotIn("KeyError", err)
