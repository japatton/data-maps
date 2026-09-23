import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import pipelines
from datamaps.ingest import pipeline as ip

DATA = os.path.join(ROOT, "data")


def cribl(*functions, **kw):
    return {"id": kw.get("id", "dm_t_d_f"),
            "conf": {"output": "default", "description": kw.get("desc", "T d f"),
                     "functions": list(functions)}}


COMMENT = {"id": "comment", "filter": "true", "conf": {"comment": "why  we\nparse"},
           "description": "record why"}
DATASET = {"id": "eval", "filter": "true",
           "conf": {"add": [{"name": "event.dataset", "value": "'t.d'"}]},
           "description": "tag the dataset"}
CODE = {"id": "code", "filter": "true", "conf": {"code": "__e['x']=1"},
        "description": "hand-written"}
PARTIAL = {"id": "eval", "filter": "true",
           "conf": {"add": [{"name": "a", "value": "'1'"},
                            {"name": "b", "value": "JSON.parse(__e['j'])"}]},
           "description": "mixed"}
REGEX = {"id": "regex_extract", "filter": "true",
         "conf": {"regex": "/(?<a>\\d+)/", "source": "_raw"}, "description": "grab"}
KVP = {"id": "serde", "filter": "true",
       "conf": {"mode": "extract", "type": "kvp", "srcField": "_raw"},
       "description": "scan pairs"}
MASK = {"id": "mask", "filter": "true",
        "conf": {"fields": ["a"],
                 "rules": [{"matchRegex": "/x/", "replaceExpr": "'1'"},
                           {"matchRegex": "/y/", "replaceExpr": "'2'"}]},
        "description": "redact"}


class TestEnvelope(unittest.TestCase):
    def test_shape_and_coverage(self):
        env = ip.translate_pipeline(cribl(COMMENT, DATASET, CODE, PARTIAL, REGEX))
        self.assertEqual(env["id"], "dm_t_d_f")
        self.assertEqual(env["coverage"], {"translated": 2, "partial": 1,
                                           "manual": 1, "total": 4})
        self.assertEqual(env["field_map"], {"_time": "@timestamp", "_raw": "message"})
        self.assertEqual(env["requires"], ["painless-regex"])
        self.assertEqual(
            env["pipeline"]["description"],
            "T d f (translated from Cribl by data-maps: 2 of 4 steps translated, "
            "1 partial, 1 manual)")
        kinds = [list(p)[0] for p in env["pipeline"]["processors"]]
        self.assertEqual(kinds, ["set", "set", "grok"])

    def test_comment_folds_into_next_description(self):
        env = ip.translate_pipeline(cribl(COMMENT, DATASET))
        self.assertEqual(env["pipeline"]["processors"][0]["set"]["description"],
                         "why we parse — tag the dataset")

    def test_manual_steps(self):
        env = ip.translate_pipeline(cribl(DATASET, CODE, PARTIAL))
        steps = env["manual_steps"]
        self.assertEqual([s["index"] for s in steps], [1, 2])
        self.assertEqual(steps[0]["function"], "code")
        self.assertEqual(steps[0]["original"], CODE)
        self.assertIn("no ingest-processor equivalent", steps[0]["reason"])
        self.assertTrue(steps[1]["partial"])
        self.assertEqual(steps[1]["original"]["conf"]["add"],
                         [{"name": "b", "value": "JSON.parse(__e['j'])"}])

    def test_no_regex_no_requires(self):
        env = ip.translate_pipeline(cribl(DATASET))
        self.assertEqual(env["requires"], [])
        self.assertEqual(env["coverage"], {"translated": 1, "partial": 0,
                                           "manual": 0, "total": 1})

    def test_notes_collected(self):
        ts = {"id": "auto_timestamp", "filter": "true",
              "conf": {"srcField": "t", "dstField": "_time"}, "description": "time"}
        env = ip.translate_pipeline(cribl(DATASET, ts))
        self.assertTrue(any(n.startswith("auto_timestamp #1:") for n in env["notes"]))

    def test_note_keeps_a_qualifier_the_function_id_does_not_match(self):
        env = ip.translate_pipeline(cribl(KVP))
        self.assertIn("serde #0: kvp: pairs are scanned", env["notes"][0])

    def test_identical_notes_from_two_rules_are_said_once(self):
        env = ip.translate_pipeline(cribl(DATASET, MASK))
        mask_notes = [n for n in env["notes"] if n.startswith("mask #1:")]
        self.assertEqual(len(mask_notes), 1)
        self.assertIn("had no g flag", mask_notes[0])


class TestCorpus(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.loaded = pipelines.load_pipelines(DATA)
        cls.envelopes = ip.translate_all(cls.loaded)

    def test_every_pipeline_translates(self):
        self.assertEqual(len(self.envelopes), len(self.loaded))
        known = {"set", "script", "remove", "json", "kv", "csv", "grok", "rename",
                 "drop", "gsub", "date", "convert", "dot_expander"}
        for key, env in self.envelopes.items():
            for proc in env["pipeline"]["processors"]:
                self.assertEqual(len(proc), 1, key)
                self.assertIn(list(proc)[0], known, key)
            cov = env["coverage"]
            self.assertEqual(cov["translated"] + cov["partial"] + cov["manual"],
                             cov["total"], key)

    def test_coverage_floor(self):
        total = ip.summarize(self.envelopes)
        usable = total["translated"] + total["partial"]
        print("\ncorpus coverage:", total)
        # Set once from the first green run of this suite; a drop means the
        # supported subset regressed.
        self.assertGreaterEqual(usable, FLOOR)
        # usable alone cannot see a fully translated step decaying into a
        # partial one, so translated carries its own floor.
        self.assertGreaterEqual(total["translated"], TRANSLATED_FLOOR)


FLOOR = 1952
TRANSLATED_FLOOR = 1758


if __name__ == "__main__":
    unittest.main()
