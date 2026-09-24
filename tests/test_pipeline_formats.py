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
    if " || " in expr:
        return any(_filter_allows(part, event) for part in expr.split(" || "))
    m = re.match(r"^__e\['([^']+)'\]\s*(===|!==)\s*undefined$", expr)
    if m:
        return (m.group(1) not in event) == (m.group(2) == "===")
    m = re.match(r"^(?:__e\['([^']+)'\]|(\w+))\s*===?\s*'([^']*)'$", expr)
    if m:
        return event.get(m.group(1) or m.group(2)) == m.group(3)
    m = re.match(r"^__e\['([^']+)'\]\s*===?\s*'([^']*)'$", expr)
    if m:
        return event.get(m.group(1)) == m.group(2)
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
                m = re.match(r"^(/.*/[a-z]*)\.test\((\w+)\) \? '([^']*)' : '([^']*)'$",
                             add.get("value", ""))
                if m and isinstance(event.get(m.group(2)), str):
                    hit = _py_regex(m.group(1)).search(event[m.group(2)])
                    event[add["name"]] = m.group(3) if hit else m.group(4)
            continue
        if fn.get("id") != "regex_extract":
            continue
        if not _filter_allows(fn.get("filter"), event):
            continue
        conf = fn.get("conf") or {}
        source = event.get(conf.get("source", "_raw"))
        if not isinstance(source, str):
            continue
        for rx in [conf["regex"]] + [r["regex"] for r in conf.get("regexList") or []]:
            m = _py_regex(rx).search(source)
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


class TestPanConfigCef(unittest.TestCase):
    """PAN-OS 10.0 CEF Configuration Guide, config log: extension values
    carry spaces (rt, msg, labels), and cs1/cs2 hold free-form change
    detail."""
    key = "paloalto-ngfw/config__syslog-cef"
    record = ("CEF:0|Palo Alto Networks|PAN-OS|10.0.0|Succeeded|CONFIG|1|"
              "rt=Sep 23 2026 12:00:00 GMT deviceExternalId=007200000000001 "
              "shost=192.0.2.50 cs3Label=Virtual System cs3=vsys1 act=set "
              "duser=admin01 destinationServiceName=Web msg= deviceconfig system "
              "hostname externalId=1000005 PanOSDGl1=0 PanOSVsysName= dvchost=host01 "
              "PanOSActionFlags=0x0 cs1Label=Before Change Detail "
              "cs1=<entry name=\"old01\"/> cs2Label=After Change Detail "
              "cs2=<entry name=\"host01\"/> PanOSFWDeviceGroup= "
              "PanOSPolicyAuditComment=")

    def test_values_with_spaces(self):
        ev = extract(self.key, self.record)
        self.assertEqual(ev.get("rt"), "Sep 23 2026 12:00:00 GMT")
        self.assertEqual(ev.get("msg"), "deviceconfig system hostname")
        self.assertEqual(ev.get("duser"), "admin01")
        self.assertEqual(ev.get("externalId"), "1000005")

    def test_change_detail_stops_at_the_next_key(self):
        ev = extract(self.key, self.record)
        self.assertEqual(ev.get("cs1"), '<entry name="old01"/>')
        self.assertEqual(ev.get("cs2"), '<entry name="host01"/>')

    def test_empty_values_stay_absent(self):
        ev = extract(self.key, self.record.replace("msg= deviceconfig system hostname", "msg="))
        self.assertNotIn("msg", ev)
        self.assertEqual(ev.get("externalId"), "1000005")


class TestIvantiEventsStandard(unittest.TestCase):
    """Ivanti ICS Standard format: date time - node - [source ip]
    [ivs::]user(realm)[roles] - message.  Real records arrive double-framed
    (a relay's RFC 3164 header around the appliance's RFC 5424 one)."""
    key = "ivanti-ics/events__syslog-raw"

    def test_elastic_fixture_line_as_filed(self):
        with open(os.path.join(ROOT, "data", "samples", "ivanti-ics",
                               "events-syslog-raw-elastic.log"), encoding="utf-8") as fh:
            line = fh.readline().rstrip("\n")
        ev = extract(self.key, line)
        self.assertEqual((ev.get("datetime"), ev.get("node"), ev.get("srcip"), ev.get("user")),
                         ("2021-10-19 09:11:09", "pcs-node0", "127.0.0.1", "System"))
        self.assertTrue(ev.get("ics_message", "").startswith("No new virus signature list"))
        self.assertNotIn("ivs", ev)

    def test_virtual_system_user_realm_roles(self):
        ev = extract(self.key, "2026-09-23 12:00:00 - host01 - [192.0.2.5] "
                     "Default Network::user01(Users)[Role01, Role02] - AUT24414: Agent login succeeded")
        self.assertEqual((ev.get("ivs"), ev.get("user"), ev.get("realm"), ev.get("roles")),
                         ("Default Network", "user01", "Users", "Role01, Role02"))
        self.assertEqual(ev.get("ics_message"), "AUT24414: Agent login succeeded")


class TestIvantiEventsWelf(unittest.TestCase):
    """Ivanti ICS WELF, in the layout of SEKOIA-IO/intake-formats' Pulse
    Connect Secure test events (keys vary by event class, ivs is optional and
    may contain spaces)."""
    key = "ivanti-ics/events__syslog-kv"
    sys_no_ivs = ('id=firewall time="2026-09-23 12:00:00" pri=6 fw=192.0.2.10 vpn=host01 '
                  'user=System realm="" roles="" type=mgmt proto= src=192.0.2.20 dst= dstname= '
                  'sent= rcvd= msg="SYS32039: Integrity Scan Completed: 1 new file"')
    sys_ivs = sys_no_ivs.replace("vpn=host01 ", "vpn=host01 ivs=Default Network ")
    aut = ('id=firewall time="2026-09-23 12:00:00" pri=6 fw=192.0.2.10 vpn=host01 '
           'ivs=Default Network user=user01@example.com realm="Users" roles="Role01" '
           'sessionID="9000001" proto=auth src=192.0.2.30 dst= dstname= type=vpn op= arg="" '
           'result= sent= rcvd= agent="Pulse-Secure/22.8.1 (Windows 10)" duration= '
           'msg="AUT24414: Agent login succeeded for user01@example.com/Users"')

    def test_system_event_without_ivs(self):
        ev = extract(self.key, self.sys_no_ivs)
        self.assertEqual((ev.get("time"), ev.get("pri"), ev.get("fw"), ev.get("vpn"),
                          ev.get("user"), ev.get("type"), ev.get("msg")),
                         ("2026-09-23 12:00:00", "6", "192.0.2.10", "host01", "System", "mgmt",
                          "SYS32039: Integrity Scan Completed: 1 new file"))
        self.assertNotIn("ivs", ev)
        self.assertNotIn("realm", ev)

    def test_ivs_with_a_space(self):
        self.assertEqual(extract(self.key, self.sys_ivs).get("ivs"), "Default Network")

    def test_user_access_layout(self):
        ev = extract(self.key, self.aut)
        self.assertEqual((ev.get("ivs"), ev.get("user"), ev.get("realm"), ev.get("type"),
                          ev.get("msg")),
                         ("Default Network", "user01@example.com", "Users", "vpn",
                          "AUT24414: Agent login succeeded for user01@example.com/Users"))


class TestIvantiAccessWelf(unittest.TestCase):
    """admin-access and user-access WELF, in the key layouts of SEKOIA-IO's
    Pulse Connect Secure tests: mgmt lines put proto..rcvd between type and
    msg; newer vpn lines add sessionID before proto."""
    head = 'id=firewall time="2026-09-23 12:00:00" pri=6 fw=192.0.2.10 vpn=host01 ivs=Default Network '
    mgmt = head + ('user=admin01 realm="Admin Users" roles=".Administrators" type=mgmt proto= '
                   'src=192.0.2.40 dst= dstname= sent= rcvd= '
                   'msg="ADM22668: Login succeeded for admin01/Admin Users from 192.0.2.40."')
    vpn_old = head + ('user=user01 realm="Users" roles="Role01" proto=auth src=192.0.2.30 dst= '
                      'dstname= type=vpn op= arg="" result= sent= rcvd= agent="" duration= '
                      'msg="AUT23457: Login failed using auth server Local (Local Authentication)."')
    vpn_new = vpn_old.replace('roles="Role01" proto=', 'roles="Role01" sessionID="9000001" proto=') \
                     .replace('AUT23457: Login failed', 'AUT24326: Primary authentication successful')

    def test_admin_mgmt_layout(self):
        ev = extract("ivanti-ics/admin-access__syslog-kv", self.mgmt)
        self.assertEqual((ev.get("ivs"), ev.get("user"), ev.get("realm"), ev.get("roles"),
                          ev.get("type"), ev.get("admin_src_ip")),
                         ("Default Network", "admin01", "Admin Users", ".Administrators",
                          "mgmt", "192.0.2.40"))
        self.assertTrue(ev.get("msg", "").startswith("ADM22668:"))

    def test_user_access_with_and_without_session_id(self):
        for line in (self.vpn_old, self.vpn_new):
            ev = extract("ivanti-ics/user-access__syslog-kv", line)
            self.assertEqual((ev.get("user"), ev.get("realm"), ev.get("proto"), ev.get("src"),
                              ev.get("ivs")),
                             ("user01", "Users", "auth", "192.0.2.30", "Default Network"), line)
            self.assertTrue(ev.get("msg", "").startswith("AUT2"), line)
            self.assertNotIn("dst", ev)


class TestF5ApmHeader(unittest.TestCase):
    """BIG-IP's syslog puts the level word between host and process
    ('host01 notice tmm1[12390]:'), as in SC4S's APM test records."""

    def test_access_policy_sc4s_record(self):
        with open(os.path.join(ROOT, "data", "samples", "f5-bigip-apm",
                               "access-policy-syslog-raw-sc4s.log"), encoding="utf-8") as fh:
            line = fh.readline().rstrip("\n")
        ev = extract("f5-bigip-apm/access-policy__syslog-raw", line)
        self.assertEqual((ev.get("service"), ev.get("pid"), ev.get("message_id"),
                          ev.get("session_id"), ev.get("client_ip")),
                         ("tmm1", "12390", "01490500", "e03c2ca8", "71.0.0.0"))

    def test_level_word_is_optional_in_every_apm_header(self):
        tail = "apmd[11023]: 01490102:5: /Common/ap01:Common:8c6be305: Access policy result: Network_Access"
        for key in ("access-policy", "acl", "network-access"):
            for head in ("<134>Sep 23 12:00:00 host01 notice ", "<134>Sep 23 12:00:00 host01 "):
                ev = extract("f5-bigip-apm/%s__syslog-raw" % key, head + tail)
                self.assertEqual(ev.get("message_id"), "01490102", (key, head))


class TestNetappManagementAudit(unittest.TestCase):
    """ONTAP 9 audit.log: <seq> <id> <time with offset> [kern_audit...]
    <session>:<command> :: <vserver>:<app> :: <remote> :: <vserver>:<user>
    :: <input> :: <state> [:: <message>], as SC4S recorded it."""
    key = "netapp-ontap/management-audit__syslog-raw"

    def test_sc4s_record(self):
        with open(os.path.join(ROOT, "data", "samples", "netapp-ontap",
                               "management-audit-syslog-raw-sc4s.log"), encoding="utf-8") as fh:
            line = fh.readline().rstrip("\n")
        ev = extract(self.key, line)
        self.assertEqual((ev.get("timestamp"), ev.get("session_id"), ev.get("command_id"),
                          ev.get("vserver"), ev.get("application"), ev.get("location"),
                          ev.get("username"), ev.get("state")),
                         ("Thu Oct 03 2024 11:36:44 -06:00", "8004b7000021e73b", "4005f7000021e73d",
                          "cluster", "ssh", "0.0.0.0:32879", "admin", "Pending"))
        self.assertEqual(ev.get("input"), "qos statistics volume performance show -rows 20 -iter 1")
        self.assertEqual((ev.get("location_ip"), ev.get("location_port")), ("0.0.0.0", "32879"))

    def test_error_with_message(self):
        ev = extract(self.key, "<14>Sep 23 12:00:00 host01: host01: 00000030.00c8f1e2 11e5347f "
                     "Wed Sep 23 2026 12:00:00 +00:00 [kern_audit:info:1740] 8003e9000000b7d8:8003e9000000b7d9 "
                     ":: cluster1:ssh :: 192.0.2.5:57404 :: cluster1:admin01 :: volume delete -volume vol9 "
                     ":: Error :: entry doesn't exist")
        self.assertEqual((ev.get("username"), ev.get("state"), ev.get("message"), ev.get("location")),
                         ("admin01", "Error", "entry doesn't exist", "192.0.2.5:57404"))


class TestNsxDfwPacketLog(unittest.TestCase):
    """The layouts in the NSX 4.0 Administration Guide, 'Distributed Firewall
    Packet Logs', with reserved values, framed as a log file, an ESXi syslog
    line and NSX 4's RFC 5424 feed."""
    key = "vmware-nsx/dfw-packet-log__syslog-raw"
    ts = "2026-09-23T12:00:00.000Z"

    def ev(self, record):
        return extract(self.key, "%s b6507827 %s" % (self.ts, record))

    def test_match_with_ruleset_and_flags(self):
        ev = self.ev("INET match PASS mainrs/1024 IN 52 TCP "
                     "192.0.2.3/49627->192.0.2.4/49153 SEW")
        self.assertEqual((ev["vif_id"], ev["action"], ev["ruleset"], ev["rule_id"],
                          ev["direction"], ev["packet_size"], ev["src_port"],
                          ev["dst_ip"], ev["tcp_flags"]),
                         ("b6507827", "PASS", "mainrs", "1024", "IN", "52",
                          "49627", "192.0.2.4", "SEW"))
        self.assertEqual(ev["timestamp"], self.ts)

    def test_proto_without_ports(self):
        ev = self.ev("INET match DROP mainrs/1027 IN 36 PROTO 2 0.0.0.0->224.0.0.1")
        self.assertEqual((ev["protocol"], ev["src_ip"], ev["dst_ip"]),
                         ("PROTO 2", "0.0.0.0", "224.0.0.1"))
        self.assertNotIn("src_port", ev)

    def test_ipv6_udp(self):
        ev = self.ev("INET6 match DROP mainrs/1027 OUT 143 UDP "
                     "fe80:0:0:0:0:0:0:1/546->ff02:0:0:0:0:0:1:2/547")
        self.assertEqual((ev["inet_type"], ev["src_ip"], ev["src_port"], ev["dst_port"]),
                         ("INET6", "fe80:0:0:0:0:0:0:1", "546", "547"))
        self.assertNotIn("tcp_flags", ev)

    def test_bare_rule_id_with_fqdn_and_app_id(self):
        ev = self.ev("INET match PASS 1031 OUT 48 TCP 192.0.2.5/32808->"
                     "203.0.113.7/80 S www.example.com(00000000-0000-0000-0000-000000000001)")
        self.assertEqual((ev["rule_id"], ev["tcp_flags"], ev["annotation"]),
                         ("1031", "S", "www.example.com(00000000-0000-0000-0000-000000000001)"))
        self.assertNotIn("ruleset", ev)
        ev = self.ev("INET match PASS 1030 OUT 48 UDP 192.0.2.5/42035->192.0.2.1/53 APP_DNS")
        self.assertEqual(ev["annotation"], "APP_DNS")
        self.assertNotIn("tcp_flags", ev)

    def test_term(self):
        ev = self.ev("INET TERM mainrs/1024 OUT TCP RST 192.0.2.3/49627->"
                     "192.0.2.4/49153 20/16 1718/76308")
        self.assertEqual((ev["reason"], ev["ruleset"], ev["close_reason"],
                          ev["packet_counts"], ev["byte_counts"]),
                         ("TERM", "mainrs", "RST", "20/16", "1718/76308"))
        self.assertNotIn("action", ev)

    def test_nsx4_syslog_term_with_action_and_rule_tag(self):
        ev = extract(self.key, "<13>1 2026-09-23T12:00:00.001Z host01 FIREWALL-PKTLOG - - - "
                     "INET TERM PASS 5096 OUT TCP RST 192.0.2.11/60517->192.0.2.10/443 "
                     "9/8 1461/4677 DR-Allow")
        self.assertEqual((ev["dfw_host"], ev["ident"], ev["action"], ev["rule_id"],
                          ev["close_reason"], ev["annotation"]),
                         ("host01", "FIREWALL-PKTLOG", "PASS", "5096", "RST", "DR-Allow"))
        self.assertNotIn("vif_id", ev)

    def test_esxi_syslog(self):
        ev = extract(self.key, "<134>Sep 23 12:00:00 host01 dfwpktlogs: b6507827 INET match "
                     "PASS mainrs/1024 IN 52 TCP 192.0.2.3/49627->192.0.2.4/49153 S")
        self.assertEqual((ev["dfw_host"], ev["ident"], ev["vif_id"], ev["rule_id"]),
                         ("host01", "dfwpktlogs", "b6507827", "1024"))


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
