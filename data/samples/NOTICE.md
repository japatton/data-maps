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

The Elastic License 2.0 allows copying and redistribution provided these terms
travel with the copy. It does not allow providing the software to third parties
as a hosted or managed service, circumventing licence-key functionality, or
removing licensing notices.

A record is copied byte for byte except where `SOURCES.json` says otherwise:
Elastic's `.json` fixtures carry the raw line in a `message` or
`event.original` field, which is what is kept, and the Carbon Black EDR
records are that fixture's `json` object re-serialized as compact JSON.

A sample is filed against a dataset only when its wire format is one the
catalog already lists for that dataset. A record in another format is left
out rather than relabelled. The file name says which: `<dataset>-<format>-
<source>.log`.

These are not captured records. Records captured from our own feeds are
examples, attached through Studio under `data/examples/`, and stay on the
internal GitLab.
