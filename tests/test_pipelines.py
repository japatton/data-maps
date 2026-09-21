import copy
import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import build, model as model_mod, pipelines

DATA = os.path.join(ROOT, "data")


def real_model():
    catalog, techs, profiles, ecs = build.load_inputs(DATA)
    return model_mod.build_model(catalog, techs, profiles, ecs)


class TestPipelineId(unittest.TestCase):
    def test_hyphens_become_underscores(self):
        self.assertEqual(
            pipelines.pipeline_id("cisco-asa", "device-admin", "snmp-trap"),
            "dm_cisco_asa_device_admin_snmp_trap")

    def test_other_punctuation_collapses(self):
        self.assertEqual(pipelines.pipeline_id("a.b", "c d", "e/f"),
                         "dm_a_b_c_d_e_f")


class TestLoad(unittest.TestCase):
    def test_loads_every_committed_pipeline(self):
        loaded = pipelines.load_pipelines(DATA)
        self.assertEqual(len(loaded), 603)
        key = ("cisco-asa", "device-admin", "snmp-trap")
        self.assertIn(key, loaded)
        self.assertEqual(loaded[key]["id"],
                         "dm_cisco_asa_device_admin_snmp_trap")
        self.assertIn("functions", loaded[key]["conf"])

    def test_missing_directory_is_empty(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        self.assertEqual(pipelines.load_pipelines(tmp), {})

    def test_bad_stem_is_hard_error(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        os.makedirs(os.path.join(tmp, "pipelines", "t"))
        with open(os.path.join(tmp, "pipelines", "t", "nosep.json"), "w") as fh:
            fh.write("{}")
        with self.assertRaises(pipelines.PipelineError) as ctx:
            pipelines.load_pipelines(tmp)
        self.assertIn("nosep.json", "\n".join(ctx.exception.messages))

    def test_invalid_json_is_hard_error(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        os.makedirs(os.path.join(tmp, "pipelines", "t"))
        with open(os.path.join(tmp, "pipelines", "t", "d__f.json"), "w") as fh:
            fh.write("{not json")
        with self.assertRaises(pipelines.PipelineError):
            pipelines.load_pipelines(tmp)


class TestCheck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = real_model()
        cls.loaded = pipelines.load_pipelines(DATA)

    def test_real_data_has_only_no_pipeline_flags(self):
        flags = pipelines.check_pipelines(self.loaded, self.model)
        codes = set(f["code"] for f in flags)
        self.assertLessEqual(codes, {pipelines.NO_PIPELINE})
        subjects = sorted(f["subject"] for f in flags)
        # The two cisco-cucm api-pull blocks are the known gaps until Task 4.
        for s in subjects:
            self.assertTrue(s.startswith("cisco-cucm/"), s)

    def test_none_blocks_have_no_pipeline_and_no_flag(self):
        flags = pipelines.check_pipelines(self.loaded, self.model)
        self.assertNotIn(("arkime", "sessions", "json"), self.loaded)
        self.assertFalse([f for f in flags if f["subject"] == "arkime/sessions"])

    def test_orphan_pipeline_is_hard_error(self):
        loaded = dict(self.loaded)
        loaded[("nope", "ds", "json")] = {"id": "dm_nope_ds_json",
                                          "conf": {"functions": []}}
        with self.assertRaises(pipelines.PipelineError) as ctx:
            pipelines.check_pipelines(loaded, self.model)
        self.assertIn("nope/ds__json", "\n".join(ctx.exception.messages))

    def test_wrong_id_is_hard_error(self):
        loaded = dict(self.loaded)
        key = ("cisco-asa", "device-admin", "snmp-trap")
        bad = copy.deepcopy(loaded[key])
        bad["id"] = "dm_wrong"
        loaded[key] = bad
        with self.assertRaises(pipelines.PipelineError) as ctx:
            pipelines.check_pipelines(loaded, self.model)
        self.assertIn("dm_wrong", "\n".join(ctx.exception.messages))

    def test_pipeline_for_none_block_is_hard_error(self):
        loaded = dict(self.loaded)
        loaded[("arkime", "sessions", "json")] = {
            "id": "dm_arkime_sessions_json", "conf": {"functions": []}}
        with self.assertRaises(pipelines.PipelineError) as ctx:
            pipelines.check_pipelines(loaded, self.model)
        self.assertIn("pipeline-for-none", "\n".join(ctx.exception.messages))

    def test_iter_blocks_covers_every_format(self):
        n = sum(1 for _ in pipelines.iter_blocks(self.model))
        self.assertEqual(n, 610)


class TestBuildIntegration(unittest.TestCase):
    def test_build_reports_pipelines_and_flags(self):
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out, True)
        import contextlib, io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            code = build.main(data_dir=DATA, out_dir=out)
        self.assertEqual(code, 0, buf.getvalue())
        self.assertIn("603 pipelines", buf.getvalue())
        with open(os.path.join(out, "index.html"), encoding="utf-8") as fh:
            self.assertIn("no-pipeline", fh.read())


if __name__ == "__main__":
    unittest.main()
