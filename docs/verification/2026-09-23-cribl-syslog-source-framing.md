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
