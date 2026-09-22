import importlib.util
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

SPEC = importlib.util.spec_from_file_location(
    "validate_live", os.path.join(ROOT, "tools", "validate_live", "validate.py"))
vl = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vl)


class TestBodies(unittest.TestCase):
    def test_simulate_body(self):
        self.assertEqual(vl.SIMULATE_BODY, {"docs": [{"_source": {"message": ""}}]})

    def test_env_targets(self):
        env = {"CRIBL_URL": "http://c:19000", "CRIBL_USER": "u", "CRIBL_PASSWORD": "p"}
        t = vl.targets(env)
        self.assertEqual(t["cribl"], ("http://c:19000", "u", "p"))
        self.assertIsNone(t["es"])


class TestDisplayEndpoint(unittest.TestCase):
    def test_loopback_and_placeholder_kept(self):
        self.assertEqual(vl.display_endpoint("http://localhost:9200"),
                         "http://localhost:9200")
        self.assertEqual(vl.display_endpoint("http://cribl.example:19000"),
                         "http://cribl.example:19000")

    def test_private_host_masked_port_kept(self):
        self.assertEqual(vl.display_endpoint("http://cribl.corp.internal:19000"),
                         "http://<private host>:19000")

    def test_private_host_masked_without_port(self):
        self.assertEqual(vl.display_endpoint("https://10.0.0.5"),
                         "https://<private host>")


class TestReport(unittest.TestCase):
    def test_report_lists_failures_verbatim(self):
        out = tempfile.mkdtemp()
        path = os.path.join(out, "r.md")
        cribl = [{"id": "dm_a", "key": "a/b__c", "ok": True, "status": 200, "detail": ""},
                 {"id": "dm_d", "key": "d/e__f", "ok": False, "status": 400,
                  "detail": '{"message":"bad conf"}'}]
        es = [{"id": "dm_a", "key": "a/b__c", "ok": False, "status": 400,
               "detail": "compile error at line 1"}]
        vl.write_report(path, cribl, es, {"date": "2026-09-30",
                                          "cribl": "http://c:19000",
                                          "es": "http://e:9200",
                                          "cribl_version": "4.19.0",
                                          "es_version": "8.15.0"})
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("# Live validation — 2026-09-30", text)
        self.assertIn("| Cribl Stream | `http://c:19000` | 4.19.0 |", text)
        self.assertIn("Cribl: 1 of 2 accepted", text)
        self.assertIn("Elasticsearch: 0 of 1 accepted", text)
        self.assertIn("bad conf", text)
        self.assertIn("compile error at line 1", text)
        self.assertIn("4.19.0", text)

    def test_masked_endpoint_survives_markdown(self):
        # `<private host>` outside a code span is an unknown HTML tag, and
        # every Markdown renderer swallows it: the committed report would then
        # read `| Cribl Stream | http://:19000 |` and look like a bug.
        out = tempfile.mkdtemp()
        path = os.path.join(out, "r.md")
        masked = vl.display_endpoint("https://cribl.corp.internal:19000")
        vl.write_report(path, [], None, {"date": "d", "cribl": masked, "es": None,
                                         "cribl_version": "4.19.0", "es_version": None})
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("| Cribl Stream | `https://<private host>:19000` | 4.19.0 |", text)

    def test_report_with_skipped_target(self):
        out = tempfile.mkdtemp()
        path = os.path.join(out, "r.md")
        vl.write_report(path, None, [], {"date": "d", "cribl": None, "es": "http://e",
                                         "cribl_version": None, "es_version": "8"})
        with open(path, encoding="utf-8") as fh:
            self.assertIn("Cribl: skipped (CRIBL_URL unset)", fh.read())


class TestSimulateError(unittest.TestCase):
    def test_clean_body_is_none(self):
        self.assertIsNone(vl.simulate_error('{"docs":[{"doc":{"_source":{}}}]}'))

    def test_error_body_returns_the_error_object(self):
        body = ('{"docs":[{"error":{"type":"illegal_argument_exception",'
                '"reason":"cannot cast [foo] to a long"}}]}')
        self.assertEqual(vl.simulate_error(body),
                         {"type": "illegal_argument_exception",
                          "reason": "cannot cast [foo] to a long"})

    def test_second_doc_erroring_is_reported(self):
        body = ('{"docs":[{"doc":{"_source":{}}},'
                '{"error":{"type":"script_exception","reason":"runtime error"}}]}')
        self.assertEqual(vl.simulate_error(body),
                         {"type": "script_exception", "reason": "runtime error"})

    def test_non_json_body_is_unparseable(self):
        self.assertEqual(vl.simulate_error("502 Bad Gateway"),
                         {"type": "unparseable", "reason": "502 Bad Gateway"})

    def test_unparseable_reason_keeps_only_the_first_200_characters(self):
        err = vl.simulate_error("x" * 500)
        self.assertEqual(err["type"], "unparseable")
        self.assertEqual(err["reason"], "x" * 200)

    def test_docs_not_a_list_is_unparseable(self):
        self.assertEqual(vl.simulate_error('{"docs": "x"}'),
                         {"type": "unparseable", "reason": '{"docs": "x"}'})

    def test_non_dict_error_value_is_wrapped(self):
        self.assertEqual(vl.simulate_error('{"docs":[{"error":"boom"}]}'),
                         {"type": "error", "reason": "boom"})


def fake_request(simulate_body):
    """A vl.request stand-in: 200 everywhere, simulate_body for the _simulate POST.

    Returns the fake and the list it records (method, url) into, so a test can
    assert the pipeline was deleted again whatever the simulate body said.
    """
    calls = []

    def fake(method, url, body=None, headers=None):
        calls.append((method, url))
        if method == "POST" and url.endswith("/_simulate"):
            return 200, simulate_body
        return 200, "{}"

    return fake, calls


class TestEsValidateSimulate(unittest.TestCase):
    URL = "http://es.example:9200"
    ENVELOPES = {("a", "b", "c"): {"id": "dm_a", "pipeline": {"processors": []}}}

    def setUp(self):
        self.addCleanup(setattr, vl, "request", vl.request)

    def test_a_200_carrying_a_per_document_error_is_a_failure(self):
        body = ('{"docs":[{"error":{"type":"script_exception",'
                '"reason":"runtime error in painless"}}]}')
        vl.request, calls = fake_request(body)
        results = vl.es_validate(self.URL, self.ENVELOPES)
        self.assertEqual(len(results), 1)
        self.assertIs(results[0]["ok"], False)
        self.assertEqual(results[0]["status"], 200)
        self.assertIn("reason", results[0]["detail"])
        self.assertIn("runtime error in painless", results[0]["detail"])
        self.assertIn(("DELETE", self.URL + "/_ingest/pipeline/dm_a"), calls)

    def test_a_clean_200_stays_green(self):
        vl.request, calls = fake_request('{"docs":[{"doc":{"_source":{}}}]}')
        results = vl.es_validate(self.URL, self.ENVELOPES)
        self.assertEqual(len(results), 1)
        self.assertIs(results[0]["ok"], True)
        self.assertEqual(results[0]["status"], 200)
        self.assertEqual(results[0]["detail"], "")
        self.assertIn(("DELETE", self.URL + "/_ingest/pipeline/dm_a"), calls)


if __name__ == "__main__":
    unittest.main()
