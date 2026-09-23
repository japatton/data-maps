"""The committed pipelines' parse regexes against the vendors' documented formats.

Offline: each regex_extract in a pipeline is applied in order the way Cribl
applies it (the regex against the named source field, named groups becoming
fields, a step skipped when its filter says so), and the test asserts that a
record in the documented format comes out with the fields the rest of the
pipeline reads.  The records are message bodies; TestSyslogSourceFraming
also frames them the way a Cribl Syslog Source hands them to a pipeline
(docs/verification/2026-09-23-cribl-syslog-source-framing.md).
"""
import glob
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


class Unsupported(AssertionError):
    pass


def _filter_allows(expr, event):
    expr = (expr or "true").strip()
    if expr == "true":
        return True
    m = re.match(r"^__e\['([^']+)'\]\s*===\s*undefined$", expr)
    if m:
        return m.group(1) not in event
    raise Unsupported("filter not understood by this test: %r" % expr)


BODY = "__e['message'] !== undefined ? __e['message'] : __e['_raw']"


def extract(key, raw):
    """Run the pipeline's regex_extract steps over {_raw: raw}, or over an
    event dict as a Syslog Source would build it."""
    event = dict(raw) if isinstance(raw, dict) else {"_raw": raw}
    for fn in _pipeline(key)["conf"]["functions"]:
        if fn.get("disabled") is True:
            continue
        if fn.get("id") == "eval":
            for add in (fn.get("conf") or {}).get("add") or []:
                if add.get("value") == BODY:
                    event[add["name"]] = event.get("message", event["_raw"])
            continue
        if fn.get("id") != "regex_extract":
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


HEADER = "<134>Sep 23 12:00:00 host01 "
RFC3164 = re.compile(r"^(?:<\d{1,3}>)?[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d ")
RECORD = re.compile(r"^(?P<ds>.+?)-(?P<fmt>syslog-[a-z]+)-(?P<src>.+)\.log$")


def _syslog_records():
    """(pipeline key, record) for every sample and synthetic syslog record."""
    for kind in ("samples", "synthetic"):
        base = os.path.join(ROOT, "data", kind)
        for tech in sorted(os.listdir(base)):
            tdir = os.path.join(base, tech)
            if not os.path.isdir(tdir):
                continue
            for name in sorted(os.listdir(tdir)):
                m = RECORD.match(name)
                key = m and "%s/%s__%s" % (tech, m.group("ds"), m.group("fmt"))
                if not key or not os.path.exists(
                        os.path.join(ROOT, "data", "pipelines", key + ".json")):
                    continue
                with open(os.path.join(tdir, name), encoding="utf-8") as fh:
                    for line in fh.read().splitlines():
                        if line.strip():
                            yield key, line


def _groups(key, event):
    """Fields the regex steps produce, or None where a step's filter is one
    this offline runner can't evaluate."""
    try:
        ev = extract(key, event)
    except Unsupported:
        return None
    return {k: v for k, v in ev.items()
            if k not in ("_raw", "message") and not k.startswith("__")}


class TestSyslogSourceFraming(unittest.TestCase):
    """A Syslog Source keeps the whole line, header included, in _raw and puts
    the body in message; sent with no application tag, a CEF line loses
    `CEF` from message.  Whatever the framing, the regex steps must pull
    the same fields out of a record as they do from the bare record."""

    def test_framed_records_parse_like_bare_ones(self):
        checked = 0
        for key, rec in _syslog_records():
            bare = _groups(key, rec)
            if not bare:
                continue
            if rec.startswith("<"):
                continue
            if RFC3164.match(rec):
                framings = [{"_raw": "<134>" + rec}]
            else:
                framings = [{"_raw": HEADER + rec, "message": rec}]
                if rec.startswith("CEF:"):
                    framings.append({"_raw": HEADER + rec, "message": rec[3:]})
            for event in framings:
                with self.subTest(key=key, framing=event["_raw"][:60]):
                    framed = _groups(key, event) or {}
                    self.assertEqual({k: framed.get(k) for k in bare}, bare)
            checked += 1
        self.assertGreater(checked, 20)

    def test_no_body_parser_reads_raw_from_the_start(self):
        for path in sorted(glob.glob(os.path.join(
                ROOT, "data", "pipelines", "*", "*__syslog-*.json"))):
            with open(path, encoding="utf-8") as fh:
                fns = json.load(fh)["conf"]["functions"]
            for fn in fns:
                c = fn.get("conf") or {}
                with self.subTest(path=os.path.relpath(path, ROOT)):
                    if fn.get("id") == "regex_extract" and c.get("source", "_raw") == "_raw":
                        self.assertNotRegex(c["regex"], r"^/\^(?:CEF|LEEF):")
                    if fn.get("id") == "serde" and c.get("type") in ("kvp", "csv"):
                        self.assertNotEqual(c.get("srcField", "_raw"), "_raw")


if __name__ == "__main__":
    unittest.main()
