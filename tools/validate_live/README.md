# Live validation

The launch gate before public hosting: every committed Cribl pipeline is
POSTed to a real Cribl Stream 4.19 and every generated ingest pipeline is
PUT (and `_simulate`d) against a real Elasticsearch.  Run it from a
workstation; it is deliberately not a CI job.

    docker compose -f tools/validate_live/compose.yml up -d
    export ES_URL=http://localhost:9200
    export CRIBL_URL=http://<your-cribl>:19000
    export CRIBL_USER=admin
    read -rs CRIBL_PASSWORD; export CRIBL_PASSWORD
    python3 tools/validate_live/validate.py
    docker compose -f tools/validate_live/compose.yml down

Without a Cribl of your own: `docker compose -f tools/validate_live/compose.yml --profile cribl up -d`
brings one up on :19000 (first login sets the admin password in the UI).

Elasticsearch must have `script.painless.regex.enabled: true`; the compose
file sets it.  An existing cluster without it rejects every pipeline whose
envelope lists `painless-regex` in `requires`, and the report shows that
as a compile failure — that is the node setting, not the pipeline.

The report lands in `docs/verification/<date>-live-validation.md`; commit it.
Everything the run creates is named `dm_*` and is deleted again.
