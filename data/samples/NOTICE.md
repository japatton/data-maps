# Third-party example records

Every `.log` file under this directory is a small selection of records taken
from somebody else's public repository. None of it is data-maps' own work, and
none of it comes from a production system: the upstream projects wrote these
records as test fixtures, pack samples or attack-simulation captures.

`SOURCES.json` records, for each file, the upstream repository, the pinned
commit, the upstream paths, how the records were extracted and, where records
were chosen from a larger file, the pattern that chose them. Each file is
distributed under its source's licence, not under the licence of the rest of
this repository:

| Source | Licence | Text |
|---|---|---|
| [elastic/integrations](https://github.com/elastic/integrations) pipeline test fixtures | Elastic License 2.0 | [LICENSES/Elastic-2.0.txt](LICENSES/Elastic-2.0.txt) |
| [splunk/attack_data](https://github.com/splunk/attack_data) | Apache License 2.0 | [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt) |
| [criblpacks](https://github.com/criblpacks) pack samples | Apache License 2.0 | [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt) |
| [Azure/Azure-Sentinel](https://github.com/Azure/Azure-Sentinel) `Sample Data` | MIT, Copyright (c) Microsoft Corporation | [LICENSES/MIT-Azure-Sentinel.txt](LICENSES/MIT-Azure-Sentinel.txt) |
| [splunk/splunk-connect-for-syslog](https://github.com/splunk/splunk-connect-for-syslog) test suite | BSD 2-Clause, Copyright (c) 2019 Splunk, Inc | [LICENSES/BSD-2-Clause-Splunk-SC4S.txt](LICENSES/BSD-2-Clause-Splunk-SC4S.txt) |
| [mdecrevoisier/EVTX-to-MITRE-Attack](https://github.com/mdecrevoisier/EVTX-to-MITRE-Attack) | CC0 1.0 (public domain dedication) | [LICENSES/CC0-1.0.txt](LICENSES/CC0-1.0.txt) |
| [sbousseaden/EVTX-ATTACK-SAMPLES](https://github.com/sbousseaden/EVTX-ATTACK-SAMPLES) | GNU GPL v3 | [LICENSES/GPL-3.0.txt](LICENSES/GPL-3.0.txt) |
| [arkime/arkime](https://github.com/arkime/arkime) capture tests | Apache License 2.0 | [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt) |
| [domainaware/parsedmarc](https://github.com/domainaware/parsedmarc) sample reports | Apache License 2.0 | [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt) |
| [DefectDojo/django-DefectDojo](https://github.com/DefectDojo/django-DefectDojo) unit-test scans | BSD 3-Clause, Copyright (c) DefectDojo, Inc. | [LICENSES/BSD-3-Clause-DefectDojo.txt](LICENSES/BSD-3-Clause-DefectDojo.txt) |

The Elastic License 2.0 allows copying and redistribution provided these terms
travel with the copy. It does not allow providing the software to third parties
as a hosted or managed service, circumventing licence-key functionality, or
removing licensing notices.

A record is copied byte for byte except where `SOURCES.json` says otherwise.
The exceptions, each named in its file's `extracted` note:

- Elastic's `.json` fixtures carry the raw line in a `message` or
  `event.original` field, which is what is kept; the Carbon Black EDR records
  are that fixture's `json` object, and the Arkime records each capture test's
  session `body`, re-serialized as compact JSON.
- Where an SC4S test holds only a Jinja template, the template is rendered
  with fixed values (host `host01`, timestamps 2026-09-23T12:00:00Z, priority
  `<134>`). Records SC4S quotes verbatim in comments are kept as quoted.
- Windows event records are binary EVTX, rendered to XML by the `evtx` Rust
  parser; the XML layout is that renderer's, not Windows' own.
- The DMARC records are parsedmarc's JSON output for its own sample reports,
  produced offline so no DNS or geolocation data was looked up.

Samples from load generators and feed-format templates were rejected even
where openly licensed: they are invented records or placeholders, not logs.
Records that name a real person or a real organisation's systems were left
out.

A sample is filed against a dataset only when its wire format is one the
catalog already lists for that dataset. A record in another format is left
out rather than relabelled. The file name says which: `<dataset>-<format>-
<source>.log`.

These are not captured records. Records captured from our own feeds are
examples, attached through Studio under `data/examples/`, and stay on the
internal GitLab.
