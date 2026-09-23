# What a Cribl Syslog Source hands a pipeline - probed on 4.19.0

**Question.** Do pipelines behind a Syslog Source see the syslog header in
`_raw`, or only the message body? Cribl's Syslog Source documentation says
`message` holds "the actual message" but does not say what `_raw` holds.

**Method.** On the lab Cribl Stream 4.19.0, a temporary Syslog Source
(`dm_probe_syslog`, port 15514, container-internal) was created with the same
settings as the live `truenas_syslog` source (`inferFraming`,
`strictlyInferOctetCounting`, `keepFieldsList: []`, `singleMsgUdpPackets:
false`) and a pre-processing pipeline that drops every event, so nothing
reached Routes or any Destination. A capture at level 0 (before
pre-processing) recorded what the Source produced for six lines sent over TCP
and UDP from inside the container. Source and pipeline were then deleted.

**Result.**

| Line sent | `_raw` | `message` | other fields |
|---|---|---|---|
| `<14>Sep 23 12:00:00 host01 CEF:0\|Palo Alto Networks\|PAN-OS\|...` (TCP and UDP) | the whole line, header included | `:0\|Palo Alto Networks\|PAN-OS\|...` | `appname: CEF` |
| `<134>Sep 23 12:00:00 host01 postgres[4242]: [5] 2026-09-23 ... LOG:  AUDIT: ...` | the whole line | `[5] 2026-09-23 ... LOG:  AUDIT: ...` | `appname: postgres`, `procid: 4242` |
| `<134>1 2026-09-23T12:00:00Z host01 myapp 123 ID47 - body of an RFC 5424 message` | the whole line | `body of an RFC 5424 message` | `appname`, `procid`, `msgid` |
| `Sep 23 12:00:00 zscaler-nss: LEEF:1.0\|Zscaler\|NSS\|...` (no priority) | the whole line | absent | `host: 127.0.0.1` only - not parsed as syslog |
| `<189>CEF: 0\|Fortinet\|Fortigate\|...` (priority only, as FortiGate frames it) | the whole line | `CEF: 0\|Fortinet\|Fortigate\|...` | `severity`, `facility` |

**Findings.**

1. `_raw` always keeps the full received line, priority and header included.
   The parsed body is in `message`.
2. CEF sent over RFC 3164 with no application tag (`host01 CEF:0|...`) is
   mis-framed: `CEF` is taken as the application name and `message` loses it,
   starting `:0|`. Neither `_raw` nor `message` then starts with `CEF:`.
3. A line with no priority (an NSS feed template that starts with a
   timestamp) is not parsed as syslog at all: only `_raw` carries it.
4. A priority-only line (FortiGate's framing) parses cleanly: `message` is the
   CEF string.

**Consequence for the committed pipelines.** A syslog-format pipeline whose
first parse step reads `_raw` from a `^` anchor on the message body cannot
match real traffic from a Syslog Source. At the time of this probe that is 76
pipelines (26 anchored at `^CEF`, 20 at `^LEEF`, 30 at a body field). The 29
whose regex begins with an optional `<pri>` header are unaffected. Reading
`message` instead is not enough on its own, because of findings 2 and 3.

## Fix

Applied to the 96 pipelines the probe implicates:

- 46 that anchored a CEF or LEEF header at the start of `_raw` now find it
  anywhere in `_raw`. That covers the mis-framed case too: `_raw` still holds
  `CEF:0|` when `message` has lost it.
- 43 that parse a message body (a body-anchored regex, or a `kvp`/`csv`
  `serde`) first set `__body` to `message`, or to `_raw` when there is no
  `message`, and parse that. `__`-prefixed fields never reach a destination.
- 7 whose regex parses the RFC 3164 header itself now accept a leading
  `<pri>`.

The lint rules `syslog-anchored-on-raw` and `syslog-serde-on-raw` keep the
anchors and `_raw` parsers from coming back.
`tests/test_pipeline_formats.py` runs every syslog sample and synthetic record
through its pipeline's regex steps bare, framed as a Syslog Source frames it,
and (for CEF) mis-framed, and requires the same fields each time.

**Checked on lab Cribl.** Every sample and synthetic record of a changed
pipeline (83 lines, 29 pipelines) was sent over TCP to a temporary Syslog
Source whose pre-processing pipeline dropped everything; a line without a
header was sent as `<134>Sep 23 12:00:00 host01 <record>`, with no application
tag. The 83 events it built were captured at level 0 and previewed through
both the old and the new version of their pipeline:

| Result | Pipelines |
|---|---|
| New version extracts more, loses nothing | 13 |
| Identical output | 16 |
| New version loses a field | 0 |

Improved: `cisco-duo/auth` and `telephony` CEF, `fireeye-hx/hx-audit` CEF,
`paloalto-ngfw` config, globalprotect, threat, traffic and userid CEF and
traffic LEEF, `zscaler-zia/web` LEEF, `f5-bigip-ltm/system` raw,
`infoblox-ddi/dns-firewall-rpz` CEF, `postgresql-audit/pgaudit` raw.

The identical ones are mostly `kvp`/`csv` parsers, which were already tolerant
of a header containing no `=` or comma. Three pipelines drop or fail to parse
their own sample in both versions - a pre-existing mismatch between record and
pipeline, not framing: `ivanti-ics/events` kv (the sample is not the WELF
`id=` format), `vmware-nsx/dfw-packet-log` raw (the sample is NSX 4's RFC 5424
`FIREWALL-PKTLOG` layout, the pipeline expects `dfwpktlogs:`), and
`workspace-one-uem/device-events` kv.
