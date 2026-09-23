"""The committed pipelines' parse regexes against the vendors' documented formats.

Offline: each regex_extract in a pipeline is applied in order the way Cribl
applies it (the regex against the named source field, named groups becoming
fields, a step skipped when its filter says so), and the test asserts that a
record in the documented format comes out with the fields the rest of the
pipeline reads.  The records are message bodies - what a Syslog Source leaves
once it has taken the header off.
"""
import json
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def _pipeline(key):
    path = os.path.join(ROOT, "data", "pipelines", key + ".json")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _py_regex(literal):
    m = re.match(r"^/(.*)/([a-z]*)$", literal, re.S)
    body, flags = m.group(1), m.group(2)
    body = re.sub(r"\(\?<([A-Za-z_][A-Za-z0-9_]*)>", r"(?P<\1>", body)
    return re.compile(body, (re.I if "i" in flags else 0) | (re.M if "m" in flags else 0))


def _filter_allows(expr, event):
    expr = (expr or "true").strip()
    if expr == "true":
        return True
    m = re.match(r"^__e\['([^']+)'\]\s*===\s*undefined$", expr)
    if m:
        return m.group(1) not in event
    raise AssertionError("filter not understood by this test: %r" % expr)


def extract(key, raw):
    """Run the pipeline's regex_extract steps over {_raw: raw}."""
    event = {"_raw": raw}
    for fn in _pipeline(key)["conf"]["functions"]:
        if fn.get("id") != "regex_extract" or fn.get("disabled") is True:
            continue
        if not _filter_allows(fn.get("filter"), event):
            continue
        conf = fn.get("conf") or {}
        source = event.get(conf.get("source", "_raw"))
        if not isinstance(source, str):
            continue
        m = _py_regex(conf["regex"]).search(source)
        if m:
            event.update({k: v for k, v in m.groupdict().items()
                          if v is not None})
    return event


GP = ("CEF:0|Palo Alto Networks|PAN-OS|10.0.0|GLOBALPROTECT|0|"
      "rt=2026/09/23 12:00:00 PanOSDeviceSN=007200000000001 "
      "PanOSEventID=gateway-connected PanOSStage=connected")


class TestGlobalProtectCef(unittest.TestCase):
    key = "paloalto-ngfw/globalprotect__syslog-cef"

    def test_six_field_header_as_pan_os_10_documents_it(self):
        ev = extract(self.key, GP)
        self.assertEqual(ev.get("device_event_class_id"), "GLOBALPROTECT")
        self.assertEqual(ev.get("cef_name"), "0")
        self.assertTrue(ev.get("extensions", "").startswith("rt="))

    def test_seven_field_header(self):
        seven = GP.replace("|0|rt=", "|0|3|rt=")
        ev = extract(self.key, seven)
        self.assertEqual(ev.get("severity"), "3")
        self.assertTrue(ev.get("extensions", "").startswith("rt="))


ORACLE = ("Oracle Unified Audit[4321]: LENGTH: '203' TYPE:\"4\" "
          "DBID:\"1000000001\" SESID:\"3000000001\" CLIENTID:\"\" ENTRYID:\"1\" "
          "STMTID:\"1\" DBUSER:\"USER01\" CURUSER:\"USER01\" ACTION:\"100\" "
          "RETCODE:\"0\" SCHEMA:\"\" OBJNAME:\"\" "
          "PDB_GUID:\"00000000000000000000000000000001\"")


class TestOracleUnifiedAuditSyslog(unittest.TestCase):
    key = "oracle-audit/unified-audit-syslog__syslog-kv"

    def test_length_with_a_space_as_oracle_documents_it(self):
        ev = extract(self.key, ORACLE)
        self.assertEqual(ev.get("LENGTH"), "203")
        self.assertEqual(ev.get("DBUSER"), "USER01")
        self.assertEqual(ev.get("ACTION"), "100")

    def test_length_without_a_space(self):
        ev = extract(self.key, ORACLE.replace("LENGTH: '", "LENGTH:'"))
        self.assertEqual(ev.get("LENGTH"), "203")


class TestPgauditSyslog(unittest.TestCase):
    key = "postgresql-audit/pgaudit__syslog-raw"
    documented_prefix = ("2026-09-23 12:00:00.000 UTC [4242] user01@appdb "
                         "66f1a0c0.1092 ")
    readme_prefix = "2026-09-23 12:00:00.000 UTC user01 appdb [4242]: "
    unquoted = "LOG:  AUDIT: SESSION,1,1,READ,SELECT,,,select * from account,<not logged>"
    quoted = ('LOG:  AUDIT: SESSION,2,1,DDL,CREATE TABLE,TABLE,public.account,'
              '"create table account (id int, name text)",<not logged>')

    def check(self, raw, user="user01", statement="select * from account"):
        ev = extract(self.key, raw)
        self.assertEqual(ev.get("pg_user"), user, raw)
        self.assertEqual(ev.get("pg_database"), "appdb", raw)
        self.assertEqual(ev.get("pg_pid"), "4242", raw)
        self.assertEqual(ev.get("statement"), statement, raw)

    def test_documented_prefix_unquoted_statement(self):
        self.check(self.documented_prefix + self.unquoted)

    def test_quoted_statement(self):
        self.check(self.documented_prefix + self.quoted,
                   statement='"create table account (id int, name text)"')

    def test_postgres_syslog_sequence_number(self):
        self.check("[5] " + self.documented_prefix + self.unquoted)
        self.check("[5-1] " + self.documented_prefix + self.unquoted)

    def test_pgaudit_readme_prefix(self):
        self.check("[5] " + self.readme_prefix + self.unquoted)


if __name__ == "__main__":
    unittest.main()
