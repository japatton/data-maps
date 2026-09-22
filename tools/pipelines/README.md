# Pipeline provenance and regeneration

The pipelines under `data/pipelines/` were authored in September 2026 by
LLM agents following `AGENT-BRIEF.md`, one work order at a time, and each
was accepted by a live Cribl Stream 4.19 instance (`POST /api/v1/pipelines`
returned 200) before being kept.  HTTP 200 proves schema and conf validity,
not runtime behaviour; `python3 -m datamaps.cribl_lint` catches the
wrong-but-well-formed cases we have seen.

Three situations call for regeneration.

**A thin block changed** (parsing mechanism `elastic-integration` or
`elastic-ingest-pipeline`).  These pipelines are mechanical and a script
emits them:

    python3 tools/pipelines/generate_thin.py

It rewrites every thin pipeline in place, except for the three pilot
technologies in the script's `SKIP` set, whose thin-mechanism pipelines were
hand-authored and are authoritative.  On an unchanged catalog it changes
nothing; `git status` shows exactly the blocks whose text moved.

`--out DIR` writes the same tree under `DIR/<tech>/` instead, leaving
`data/pipelines/` untouched — how `tests/test_pipeline_tools.py` checks the
committed pipelines without dirtying the working tree, and the safe way to
preview a catalog change before letting it overwrite anything:

    python3 tools/pipelines/generate_thin.py --out /tmp/thin
    diff -r /tmp/thin data/pipelines

`diff -r` also lists every full-parse and pilot pipeline as `Only in
data/pipelines`; that is expected, because `generate_thin.py` emits only the
217 thin ones.

**A full block changed** (mechanism `cribl-pipeline` or `cribl-pack`).
Build the work orders, then hand the affected order to an agent with the
brief:

    python3 tools/pipelines/build_workorders.py
    ls tools/pipelines/workorders/

Work orders are git-ignored; they are derived from the catalog.  An order
is `<tech>.json`, or `<tech>--<dataset>.json` when the technology's order
was too large for one context.

**Before publishing any change** run the lint and the live validation
runbook in `docs/wiki/Runbooks.md`:

    python3 -m datamaps.cribl_lint
    python3 -m unittest discover -s tests
