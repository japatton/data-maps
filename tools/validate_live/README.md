# Live validation

The launch gate before public hosting: every committed Cribl pipeline is
POSTed to a real Cribl Stream 4.19 and every generated ingest pipeline is
PUT (and `_simulate`d) against a real Elasticsearch.  A `_simulate` that
answers 200 but carries a per-document `error` is reported as a failure with
that error object as its detail, because Elasticsearch returns 200 for a
processor that threw at run time.  Run it from a workstation; it is
deliberately not a CI job.

Bring the throwaway Elasticsearch up and name both targets (edit the Cribl
URL to your own instance):

    docker compose -f tools/validate_live/compose.yml up -d
    export ES_URL=http://localhost:9200
    export CRIBL_URL=http://cribl.example:19000
    export CRIBL_USER=admin

Now the password.  It is the only line in its block on purpose: `read`
consumes whatever arrives next, so a second pasted line would be taken as
the password.

    read -rs CRIBL_PASSWORD; export CRIBL_PASSWORD

Elasticsearch needs a few seconds before it answers; wait for it rather
than guess:

    until curl -fs "$ES_URL" >/dev/null; do sleep 2; done

Run the validation, then take the throwaway stack down:

    python3 tools/validate_live/validate.py
    docker compose -f tools/validate_live/compose.yml down

Without a Cribl of your own: `docker compose -f tools/validate_live/compose.yml --profile cribl up -d`
brings one up on :19000 (first login sets the admin password in the UI).

Elasticsearch must have `script.painless.regex.enabled: true`; the compose
file sets it.  An existing cluster without it rejects every pipeline whose
envelope lists `painless-regex` in `requires`, and the report shows that
as a compile failure — that is the node setting, not the pipeline.

The `dm_` prefix is reserved for validation.  The run DELETEs each `dm_*` id
before it POSTs and again afterwards, so a Cribl pipeline or an
Elasticsearch ingest pipeline that already carries that prefix on the target
is deleted by the run and is not restored: nothing is backed up first.
Point the tool at a scratch instance, or accept that anything named `dm_*`
there is expendable.

The report lands in `docs/verification/<date>-live-validation.md`; commit it.
It never records a private host — a target that is not loopback and not a
`.example` placeholder appears as `<scheme>://<private host>:<port>`, so a
run against internal infrastructure puts no hostname in this public
repository.  Everything the run creates is named `dm_*` and is deleted
again.
