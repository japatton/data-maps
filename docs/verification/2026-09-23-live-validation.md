# Live validation — 2026-09-23

| target | endpoint | version |
|---|---|---|
| Cribl Stream | `http://<private host>:19000` | 4.19.0-0fbd6d34 |
| Elasticsearch | `http://localhost:9200` | 8.15.0 |

A green line means the target accepted the pipeline: schema and conf valid for Cribl, compiled and loaded for Elasticsearch. Neither proves correct parsing of real events.

## Cribl: 605 of 605 accepted

No failures.

## Cribl behaviour: 605 of 605 clean

One preview per pipeline, seeded with a sentinel at every field a `rename` reads (1949 sentinels); alternate sources of one target go in separate events. A finding is a dotted key the re-nest step left flat, or a sentinel that vanished, neither raw nor md5-masked, in both the word pass and the digit pass that retries a loss (a legitimate numeric coercion keeps the digits). 20 pipelines dropped the synthetic event and prove nothing here.

No findings.

## Elasticsearch: 605 of 605 accepted

No failures.
