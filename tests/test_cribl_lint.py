import json
import os
import shutil
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import cribl_lint, cribl_paths, pipelines

DATA = os.path.join(ROOT, "data")


def pipe(*functions):
    """A pipeline in the committed shape: the re-nest step comes last."""
    return raw_pipe(*(list(functions) + [cribl_paths.renest_function()]))


def raw_pipe(*functions):
    return {"id": "dm_t_d_f", "conf": {"output": "default",
                                       "description": "t",
                                       "functions": list(functions)}}


def ev(add=None, remove=None):
    conf = {}
    if add is not None:
        conf["add"] = add
    if remove is not None:
        conf["remove"] = remove
    return {"id": "eval", "filter": "true", "conf": conf}


DATASET = ev(add=[{"name": "'event.dataset'", "value": "'t.d'"}])


def codes(doc):
    return sorted(set(code for code, _ in cribl_lint.lint_pipeline(doc)))


class TestRules(unittest.TestCase):
    def test_clean_pipeline_has_no_findings(self):
        self.assertEqual(codes(pipe(DATASET)), [])

    def test_empty_pipeline(self):
        self.assertIn("empty-pipeline", codes(raw_pipe()))

    def test_no_event_dataset(self):
        self.assertIn("no-event-dataset",
                      codes(pipe(ev(add=[{"name": "a", "value": "'b'"}]))))

    def test_dataset_in_code_counts(self):
        doc = pipe({"id": "code", "filter": "true",
                    "conf": {"code": "__e['event.dataset']='t.d'"}})
        self.assertNotIn("no-event-dataset", codes(doc))

    def test_comment_over_1000(self):
        doc = pipe(DATASET, {"id": "comment", "filter": "true",
                             "conf": {"comment": "x" * 1001}})
        self.assertIn("comment-over-1000", codes(doc))

    def test_global_read_off_event(self):
        doc = pipe(DATASET, ev(add=[{"name": "t", "value": "__e['Date'].parse(x)"}]))
        self.assertIn("global-read-off-event", codes(doc))

    def test_echoed_placeholder_and_name_equals_value(self):
        doc = pipe(DATASET, ev(add=[{"name": "name", "value": "'value'"},
                                    {"name": "foo", "value": "'foo'"}]))
        found = codes(doc)
        self.assertIn("echoed-placeholder", found)
        self.assertIn("name-equals-value", found)

    def test_dataset_has_hyphen(self):
        doc = pipe(ev(add=[{"name": "'event.dataset'", "value": "'a-b.c'"}]))
        self.assertIn("dataset-has-hyphen", codes(doc))

    def test_invalid_paths(self):
        doc = pipe(DATASET, ev(add=[{"name": "@bad", "value": "1"}],
                               remove=["x-y"]))
        found = codes(doc)
        self.assertIn("invalid-path-in-eval-add", found)
        self.assertIn("invalid-path-in-eval-remove", found)

    def test_rename_rules(self):
        malformed = pipe(DATASET, {"id": "rename", "filter": "true",
                                   "conf": {"fromField": "a"}})
        self.assertIn("rename-conf-malformed", codes(malformed))
        pair = pipe(DATASET, {"id": "rename", "filter": "true",
                              "conf": {"rename": [{"currentName": "a"}]}})
        self.assertIn("rename-pair-malformed", codes(pair))
        noop = pipe(DATASET, {"id": "rename", "filter": "true",
                              "conf": {"rename": [{"currentName": "a",
                                                   "newName": "a"}]}})
        self.assertIn("rename-noop", codes(noop))
        bad = pipe(DATASET, {"id": "rename", "filter": "true",
                             "conf": {"rename": [{"currentName": "a",
                                                  "newName": "@b"}]}})
        self.assertIn("invalid-path-in-rename", codes(bad))

    def test_quoted_literal_names_are_valid(self):
        doc = pipe(DATASET, ev(add=[{"name": "'@timestamp'", "value": "1"}],
                               remove=["'user-agent'"]))
        self.assertEqual(codes(doc), [])

    def test_unquoted_dotted_write_is_pending(self):
        doc = pipe(DATASET, ev(add=[{"name": "source.ip", "value": "'1'"}]))
        self.assertIn("flat-key-rewrite-pending", codes(doc))

    def test_nested_read_of_a_flat_key_is_pending(self):
        doc = pipe(DATASET, ev(add=[{"name": "'a.b'", "value": "'1'"},
                                    {"name": "o", "value": "a.b"}]))
        self.assertIn("flat-key-rewrite-pending", codes(doc))

    def test_renest_must_be_last(self):
        self.assertIn("renest-not-last", codes(raw_pipe(DATASET)))
        early = raw_pipe(cribl_paths.renest_function(), DATASET)
        self.assertIn("renest-not-last", codes(early))

    def test_bare_regex(self):
        doc = pipe(DATASET, {"id": "regex_extract", "filter": "true",
                             "conf": {"regex": "(?<a>\\d+)", "source": "_raw"}})
        self.assertIn("bare-regex", codes(doc))

    def test_distinct_drops_fields(self):
        dedup = {"id": "distinct", "filter": "true",
                 "conf": {"groupBy": ["Identity"]}}
        self.assertIn("distinct-drops-fields", codes(pipe(DATASET, dedup)))
        off = dict(dedup, disabled=True)
        self.assertNotIn("distinct-drops-fields", codes(pipe(DATASET, off)))


    def test_eval_missing_global(self):
        def ev(value, filt="true"):
            return pipe(DATASET, {"id": "eval", "filter": filt,
                                  "conf": {"add": [{"name": "x", "value": value}]}})
        self.assertIn("eval-missing-global", codes(ev("parseInt(__e['a'], 10)")))
        self.assertIn("eval-missing-global", codes(ev("!isNaN(Number(__e['a']))")))
        self.assertIn("eval-missing-global",
                      codes(ev("1", filt="parseFloat(__e['a']) > 1")))
        for ok in ("Number.parseInt(__e['a'], 10)", "Number.isNaN(Number(__e['a']))",
                   "__e['m'] === 'Authentication Provider Error'",
                   "__e[\"isNaN\"]", "Math.round(Number(__e['a']))"):
            self.assertNotIn("eval-missing-global", codes(ev(ok)), ok)
        code = {"id": "code", "filter": "true",
                "conf": {"code": "__e['x'] = parseInt(__e['a'], 10);"}}
        self.assertNotIn("eval-missing-global", codes(pipe(DATASET, code)))

    def test_syslog_capture_collides(self):
        rx = {"id": "regex_extract", "filter": "true",
              "conf": {"regex": "/sev=(?<severity>\\d+) (?<body>.*)$/", "source": "_raw"}}
        found = lambda fmt, fn: cribl_lint.lint_all({("t", "d", fmt): pipe(DATASET, fn)})
        self.assertIn("syslog-capture-collides", found("syslog-cef", rx))
        listed = dict(rx, conf={"regex": "/(?<body>.*)/", "source": "_raw",
                                "regexList": [{"regex": "/h=(?<host>\\S+)/"}]})
        self.assertIn("syslog-capture-collides", found("syslog-raw", listed))
        self.assertEqual(found("syslog-cef", dict(rx, conf=dict(rx["conf"], overwrite=True))), {})
        self.assertEqual(found("json", rx), {})

    def test_syslog_framing(self):
        cef = {"id": "regex_extract", "filter": "true",
               "conf": {"regex": "/^CEF:(?<v>\\d+)\\|/", "source": "_raw"}}
        kvp = {"id": "serde", "filter": "true",
               "conf": {"mode": "extract", "type": "kvp", "srcField": "_raw"}}
        found = lambda fmt, *fns: cribl_lint.lint_all(
            {("t", "d", fmt): pipe(DATASET, *fns)})
        self.assertIn("syslog-anchored-on-raw", found("syslog-cef", cef))
        self.assertIn("syslog-serde-on-raw", found("syslog-kv", kvp))
        unanchored = dict(cef, conf={"regex": "/CEF:(?<v>\\d+)\\|/",
                                     "source": "_raw"})
        body = dict(kvp, conf=dict(kvp["conf"], srcField="__body"))
        self.assertEqual(found("syslog-cef", unanchored), {})
        self.assertEqual(found("syslog-kv", body), {})
        self.assertEqual(found("json", kvp), {})


class TestCorpus(unittest.TestCase):
    def test_every_committed_pipeline_lints_clean(self):
        loaded = pipelines.load_pipelines(DATA)
        findings = cribl_lint.lint_all(loaded)
        self.assertEqual(findings, {}, cribl_lint.format_report(findings))

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_every_expression_compiles(self):
        """Lint cannot parse JavaScript; Node can.  Every eval value and
        filter must compile as an expression, or Cribl rejects the pipeline
        (or, for a filter, never matches)."""
        exprs = []
        for key, doc in sorted(pipelines.load_pipelines(DATA).items()):
            for fn in doc["conf"]["functions"]:
                exprs.append(("%s/%s__%s" % key, fn.get("filter", "true")))
                if fn.get("id") == "eval":
                    exprs += [("%s/%s__%s" % key, a.get("value", ""))
                              for a in (fn.get("conf") or {}).get("add") or []]
        script = ("const xs = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
                  "const bad = xs.filter(([k, x]) => { try { new Function('__e',"
                  " 'with (__e) { return (' + x + '); }'); return false; }"
                  " catch (e) { return true; } });"
                  "process.stdout.write(JSON.stringify(bad));")
        out = subprocess.run(["node", "-e", script], input=json.dumps(exprs),
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(json.loads(out), [])
        self.assertGreater(len(exprs), 1000)

    def test_duplicate_id_detected(self):
        a = pipe(DATASET)
        b = pipe(DATASET)
        findings = cribl_lint.lint_all({("t", "d", "f"): a, ("t", "d", "g"): b})
        self.assertIn("duplicate-pipeline-id", findings)


if __name__ == "__main__":
    unittest.main()
