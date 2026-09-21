# Picker and Cribl-to-Elasticsearch ingest transpiler — design

Date: 2026-09-21
Status: approved for planning

## 1. Goal and boundaries

A public, static "give me my pipeline" tool on top of the catalog. A user
picks a technology, one of its datasets, one of that dataset's wire formats,
whether Cribl Stream is in their path, and a destination. The output is the
data map for that exact (dataset, format) block — viewable on the page and
downloadable as JSON, Markdown and CSV — plus the parser artifact for their
path:

- Cribl in the path: the committed Cribl Stream 4.19 pipeline for the block.
- Cribl not in the path: an Elasticsearch ingest pipeline generated from the
  Cribl pipeline by a deterministic transpiler, with an explicit coverage
  report of what could not be translated.

Destination has one value in v1, `elastic`. The axis exists in the exported
data so that adding `splunk` later is a data change, not a UI redesign.

Non-goals for this spec: Splunk output; any editing (Studio owns that); any
server-side component; live validation against Cribl or Elasticsearch in CI;
authoring example records.

The site remains a pure file-in / file-out build that must run on Python 3.6
(the CI pin `python:3.6-bullseye` is the oldest interpreter the project
supports). New Python code therefore avoids dataclasses, the walrus operator,
positional-only parameters and `from __future__ import annotations`.

## 2. Data layer: pipelines become catalog data

### 2.1 Location and naming

The 603 generated pipelines currently in the git-ignored `cribl-pipelines/`
move to `data/pipelines/<tech-id>/<dataset-id>__<format>.json`, keeping their
present file names. `cribl-pipelines/` is removed from `.gitignore` and the
directory is deleted.

Each file is exactly the JSON body that was POSTed to `/api/v1/pipelines`:

```
{ "id": "dm_<tech>_<dataset>_<format>",
  "conf": { "output": "default", "description": "...",
            "functions": [ { "id": "...", "filter": "true", "conf": {...},
                             "description": "..." } ] } }
```

where the id components are the catalog ids with `-` replaced by `_`.

### 2.2 Loader: `datamaps/pipelines.py`

A new module, so `model.py` (already the largest) does not grow. It exposes:

- `load_pipelines(data_dir)` — returns
  `{(tech_id, dataset_id, format): pipeline_dict}` by walking
  `data/pipelines/`. Parses the directory name and the `__`-split file stem.
- `check_pipelines(pipelines, model)` — returns a list of `(code, subject,
  message)` flags and raises `PipelineError` for hard failures.

Hard failures (build exits non-zero):

1. A pipeline whose `(tech, dataset, format)` is not a format block in the
   catalog. A typo unpublishes nothing silently.
2. A pipeline whose `id` is not `dm_<tech>_<dataset>_<format>` for its path.
3. A file that is not valid JSON or lacks `conf.functions`.

Flags (join the existing catalog flag panel and `exports/catalog.json`):

- `no-pipeline` — a format block whose `parsing.mechanism` is not `none`
  and has no pipeline file. As of this spec 605 blocks want one and 603
  exist; the plan authors the two missing ones, so this flag count should
  reach zero, but the build must not fail while it is not.

Blocks with `parsing.mechanism: none` (5 today) are expected to have no
pipeline; a pipeline present for one is a hard failure of kind 1's spirit
and is reported as `pipeline-for-none` and fails the build.

### 2.3 Semantic lint: `datamaps/cribl_lint.py`

`cribl-pipelines/_lint.py` moves into the package unchanged in behaviour:
it detects wrong-but-well-formed output (garbage `{"name":"name"}` eval
rows, invalid property paths, bare-identifier reads in `eval` values and
`filter`s, duplicate function ids where one is expected, comment length over
1000 characters). It exposes `lint_pipeline(pipeline) -> list[str]` and a
`__main__` that lints a directory. `tests/test_cribl_lint.py` asserts that
every committed pipeline lints clean and that each rule fires on a
hand-built bad example.

### 2.4 Provenance tooling: `tools/pipelines/`

The pipelines were authored by LLM agents following a brief and validated
against a live Cribl 4.19 instance; that process must remain reproducible
for the case where a technology YAML changes and its pipeline needs
re-authoring. The following move from `cribl-pipelines/`:

- `_AGENT-BRIEF.md` → `tools/pipelines/AGENT-BRIEF.md` (paths inside updated
  to `data/pipelines/` and `tools/pipelines/workorders/`).
- `_build_workorders.py` → `tools/pipelines/build_workorders.py`, writing to
  `tools/pipelines/workorders/` (git-ignored; regenerable).
- `_generate_thin.py` → `tools/pipelines/generate_thin.py`, writing into
  `data/pipelines/`.

`tools/pipelines/README.md` explains the three cases: a thin (Elastic-parses)
block changed → rerun `generate_thin.py`; a full block changed → rebuild its
work order and re-author per the brief; any change → run `cribl_lint` and
the live validation runbook (section 6) before publishing.

Deleted, not moved: `_dispatch-state.json`, `_rerun.json`,
`_rerun-batches.json`, `_pending.json`, `_bare-reads-to-fix.json`,
`_fix_bare_reads.py`, `_build_index.py`, `_coverage.py`,
`_write_thin_readmes.py`, `_workorders/`, per-technology `README.md`s,
`INDEX.md`, `NOTES-no-pipeline.md`, `__pycache__`. Everything they recorded
is either throwaway run state or is now derived by the build
(`exports/picker.json` is the inventory; `mechanism: none` blocks are
visible in the picker as "Cribl is not in this path").

## 3. Cribl → Elasticsearch ingest transpiler: `datamaps/ingest/`

### 3.1 What it must handle

Census of the 603 pipelines (2026-09-21):

| Cribl function | count | translation |
|---|---|---|
| `eval` | 805 | `set` / `script` / `remove` |
| `comment` | 613 | dropped; text folded into processor descriptions |
| `regex_extract` | 542 | `grok` |
| `rename` | 294 | `rename` |
| `serde` | 195 (json 112, kvp 69, csv 12, delim 2) | `json` / `kv` / `csv` |
| `auto_timestamp` | 83 | `date` |
| `code` | 79 | manual step |
| `drop` | 36 | `drop` with `if` |
| `mask` | 14 | `gsub` |
| `numerify` | 8 | `convert` |
| `distinct`, `unroll`, `xml_unroll`, `flatten`, `rollup_metrics` | 16 | manual step |

`eval` values and non-trivial `filter`s (173 of them) are JavaScript
expressions: 1,710 ternaries (often nested), field references, string
literals, `parseInt`, `Number`, `String`, `new Date(x).toISOString()`,
`Date.parse(x)/1000`, `.replace(/re/, '')`, `.toLowerCase()`, `||`
defaulting, array literals.

### 3.2 Principles

1. **Never guess.** A construct outside the declared subset raises
   `Untranslatable(reason)`; the step becomes a manual step. The generated
   pipeline does only what it claims.
2. **Manual steps are omitted, not stubbed.** No placeholder processors. The
   envelope lists them with the original Cribl function so a human can
   finish the job.
3. **Deterministic and pure.** Same input pipeline, same output, no I/O
   inside the translator. Runs at build time for all 603.
4. **Python 3.6-clean**, like the rest of the build.

### 3.3 `datamaps/ingest/expr.py` — JS expression subset → Painless

A tokenizer and Pratt parser produce an AST for this subset, and an emitter
produces Painless source:

- Literals: string (single/double quoted, JS escapes), number, `true`,
  `false`, `null`, `undefined`, array literal of literals.
- Field references: `__e['name']`, `__e["name"]`, `__e.name`, and dotted
  paths inside the string (`__e['source.ip']` → `ctx.source?.ip`). A bare
  identifier reads the field of that name (Cribl evaluates expressions inside
  `with(__e)`); the semantic lint still forbids bare reads in `eval` values,
  where an absent field throws in Cribl, but `filter`s use the idiom widely.
  A missing bare read is `null` in Painless rather than an exception, so a
  transpiled filter is more forgiving than the Cribl filter it came from.
  A bare identifier followed by `(` is untranslatable.
- Operators: `?:`, `||`, `&&`, `!`, `===`, `!==`, `==`, `!=`, `<`, `<=`,
  `>`, `>=`, `+`, `-`, `*`, `/`, `%`, unary `-`, parentheses, `typeof x`.
- Calls: `parseInt(x[, radix])`, `parseFloat(x)`, `Number(x)`, `String(x)`,
  `Boolean(x)`, `Date.parse(x)`, `new Date(x).toISOString()`,
  `new Date(x).getTime()`, `Math.floor|round|abs(x)`, `Array.isArray(x)`.
- Methods on an expression: `.toLowerCase()`, `.toUpperCase()`, `.trim()`,
  `.split(sep)`, `.replace(/re/[flags], repl)` (string or regex literal;
  flags `g` and `i` only), `.startsWith(s)`, `.endsWith(s)`, `.includes(s)`,
  `.indexOf(s)`, `.substring(a[, b])`, `.slice(a[, b])`, `.length`,
  `.test(x)` on a regex literal, `.match(/re/)`, `.join(s)`.

Emission rules that matter:

- `x === undefined` / `x !== undefined` / `x == null` become null checks;
  `undefined` as a value means "unset" and, at the `set` level, becomes a
  conditional processor rather than assigning null.
- `||` and `&&` emit JavaScript truthiness semantics explicitly
  (`(a != null && a != '') ? a : b`), not Java boolean `||`.
- `+` with any string operand emits string concatenation with `String.valueOf`.
- Regex literals become Painless regex literals `/re/` and require
  `script.painless.regex.enabled: true`; the envelope records
  `requires: ["painless-regex"]` when any processor uses one.
- Ternary chains emit nested ternaries; depth is not limited.

Public API: `translate_value(js) -> PainlessExpr` and
`translate_condition(js) -> PainlessExpr`, where `PainlessExpr` carries the
source text, the set of `ctx` fields read, whether it uses regex, and
whether it is a constant (so `eval` can choose `set` over `script`). Errors
raise `Untranslatable(reason, offset)`.

### 3.4 `datamaps/ingest/functions.py` — Cribl function → processors

One translator per function id, each returning a list of processors or
raising `Untranslatable`. A function's own `filter` (when not `"true"`)
translates via `translate_condition` to an `if` on every emitted processor;
if the filter is untranslatable the whole step is manual.

| Cribl | Elasticsearch processors |
|---|---|
| `comment` | none; text appended to the next processor's `description` |
| `serde` extract json | `json` `{field, add_to_root: true}` or `target_field` when `dstField` given |
| `serde` extract kvp | one `script` scanning `key=value` pairs left to right the way Cribl's extractor does, from `pairDelim`/`kvDelim`, into the root or into `dstField`. **Not** the `kv` processor: `kv` throws on the first `field_split` token carrying no kv delimiter, and an unquoted CEF value with spaces (`msg=User logged in cs1=x`) produces exactly such a token, so `ignore_failure` would silently drop the whole extraction |
| `serde` extract csv / delim | `csv` `{field, target_fields, separator, quote, ignore_missing}` from `fields` |
| `regex_extract` | one `grok` `{field: source, patterns: [regex], ignore_missing: true, ignore_failure: true}` per regex (`regex` then each `regexList` entry — Cribl applies all of them, grok's own list means first-match). `ignore_failure` because grok raises on no match while Cribl silently extracts nothing. `iterations` is recorded as a note, not a manual step: every named group extracts once either way |
| `eval` `add` | per row: `set {field, value, ignore_failure: true}` for a constant, `set {field, copy_from, ignore_empty_value: true, ignore_failure: true}` for a single field ref; otherwise one `script` holding one `try { def v = <expr>; if (v != null) { <target> = v; } } catch (Exception e) { }` per row, with intermediate-map guards, so an `undefined` result leaves the field unset. The per-row `try`/`catch` is what mirrors Cribl, where a throwing expression leaves that field unset and the event continues; the `script` processor carries no `ignore_failure`, which would abandon the remaining rows instead. Rows that fail translation make the step *partial*: the good rows are emitted and the failing rows are listed as a manual step |
| `eval` `remove` | one `remove {field: [...], ignore_missing: true}`; a wildcard entry makes the step manual |
| `eval` `keep` | manual (absent from the corpus; listed so the behaviour is defined) |
| `rename` | `rename {field, target_field, ignore_missing: true, ignore_failure: true}` per row; `baseFields`/wildcard forms → manual. `ignore_failure` because Elasticsearch's `rename` fails when the target field already exists, where Cribl's overwrites |
| `drop` | `drop {if: <filter>}`; unconditional drop → `drop` |
| `mask` | `gsub {field, pattern, replacement}` per rule on each listed field; rules with JS replacement functions → manual |
| `auto_timestamp` | `date {field: srcField or 'message', target_field: mapped dstField or '@timestamp', formats: ["ISO8601", "UNIX", "UNIX_MS"], ignore_failure: true}` plus a note that Cribl auto-detected the format. `timeExpression` is not read: no committed pipeline sets one, and a strptime string would be a second format dialect to translate |
| `numerify` | `convert {field, type: 'auto'}` per listed field; the "all numeric-looking fields" form → manual |
| `code`, `distinct`, `unroll`, `xml_unroll`, `flatten`, `rollup_metrics` | manual |

Field-name translation applies to every field path read or written:
`_time` → `@timestamp`, `_raw` → `message`; other Cribl internal fields
(`__*`) are dropped from writes and flagged when read. Dotted names become
`ctx.a.b` paths; grok/kv/csv targets keep dots (Elasticsearch expands them).
The table is `FIELD_MAP` in `expr.py` and is emitted in the envelope.

### 3.5 `datamaps/ingest/pipeline.py` — envelope

`translate_pipeline(cribl_pipeline) -> dict`:

```
{ "id": "dm_<tech>_<dataset>_<format>",
  "pipeline": { "description": "<Cribl description> (translated by data-maps; N of M steps manual)",
                "processors": [ ... ] },
  "coverage": { "translated": N, "partial": P, "manual": K, "total": M },
  "notes": [ "regex_extract #4: iterations=100 ignored; each named group extracts once" ],
  "manual_steps": [ { "index": i, "function": "code", "reason": "...",
                      "description": "<Cribl step description>",
                      "original": { ...the Cribl function object... } } ],
  "field_map": { "_time": "@timestamp", "_raw": "message" },
  "requires": [ "painless-regex" ] }
```

`comment` functions are not counted in `total`; `total = translated +
partial + manual`. The picker's download is `pipeline` alone (the body for
`PUT _ingest/pipeline/<id>`); the page shows `coverage`, `notes` and
`manual_steps`.

### 3.6 Tests

- `tests/test_ingest_expr.py`: for each supported construct, a JS input and
  the exact Painless output; parse-error cases; each unsupported construct
  raises `Untranslatable` with the offending token named.
- `tests/test_ingest_functions.py`: golden processor output per function
  family (one fixture each, kept small and readable inline).
- `tests/test_ingest_pipeline.py`: envelope shape; a pipeline with a `code`
  step yields `manual: 1` and no stub processor; `coverage` sums; the whole
  603 translate without raising and every processor has a known type.
- Coverage floor: a test asserts aggregate translated steps across the 603
  are at least the number measured when the transpiler lands, so a
  regression in the subset is caught.

### 3.7 Documentation

README gains a "Cribl to Elasticsearch translation" section with the
function table above, the expression subset, the field map, and the plain
statement that a generated pipeline loads and compiles but has not been
run against real events. The wiki Troubleshooting page gains "my ingest
pipeline has manual steps".

## 4. Build outputs

`datamaps/build.py` gains, for every format block:

| path | content |
|---|---|
| `exports/map/<tech>/<dataset>__<format>.json` | the block's format export (existing `_format_export` shape) plus dataset id/name/description, route, parsing, recommendations |
| `exports/map/<tech>/<dataset>__<format>.md` | Markdown rendering: heading, route hop strip, parsing, recommendations, field table |
| `exports/map/<tech>/<dataset>__<format>.csv` | field table; columns equal Studio's `CSV_COLUMNS` |
| `exports/map/<tech>/<dataset>__<format>.html` | the format block as an HTML fragment |
| `exports/cribl/<tech>/<dataset>__<format>.json` | the committed pipeline, byte-for-byte |
| `exports/ingest/<tech>/<dataset>__<format>.json` | the transpiler envelope |
| `exports/picker.json` | the index (below) |

`exports/picker.json`:

```
{ "generated": "<iso date>",
  "destinations": ["elastic"],
  "technologies": [
    { "id", "name", "vendor", "category", "status",
      "datasets": [
        { "id", "name", "description", "event_categories",
          "formats": [
            { "format", "recommended": bool, "mechanism", "artifact",
              "has_cribl_pipeline": bool,
              "ingest": { "translated", "manual", "total" } | null,
              "fields_total", "fields_mapped" } ] } ] } ] }
```

The HTML fragment and the technology page share one renderer: the
format-block markup in `templates/tech.html.j2` (format buttons excluded;
parsing, recommendations, coverage line, field table included) moves to
`templates/_format_block.html.j2` and is `{% include %}`d from both
`tech.html.j2` and a new `templates/fragment.html.j2`. A test renders one
block both ways and asserts the fragment is a substring of the page.

Markdown and CSV renderers live in `datamaps/export_text.py`.
`tests/test_studio_parity.py` gains an assertion that the Python CSV header
equals Studio's `CSV_COLUMNS` (read from `studio/lib/export.js` by regex,
as the existing parity tests read fixtures).

Roughly 3,600 files are added to `public/`. The only CI change in
`.gitlab-ci.yml` and `.forgejo/workflows/pages.yml` is the Node test glob
gaining `static/picker/tests/*.test.js` (section 5); the rsync deploy
carries whatever the build emits.

## 5. Picker page

Files: `picker.html` (Jinja-rendered from `templates/picker.html.j2` so it
shares `base.html.j2` nav and styles), `static/picker/picker.js` (entry),
`static/picker/state.js`, `static/picker/hash.js`, `static/picker/render.js`,
`static/picker/fetch.js`. Vanilla ES modules, no build step, same as Studio.
The nav in `base.html.j2` links to it; `index.html.j2` gets a one-paragraph
pointer.

State: `{ tech, dataset, format, cribl: bool, dest: "elastic" }`. URL hash
form `#<tech>/<dataset>/<format>?cribl=1|0&dest=elastic`; every state change
rewrites the hash, and load/hashchange parses it and restores selection.
Unknown ids in the hash reset to the first invalid level and show a notice.

Flow: on load fetch `exports/picker.json`. Technology select (grouped by
category, searchable by typing) → dataset select → format select (the
recommended one preselected and labelled) → "Cribl Stream in the path?"
toggle (default on) → destination select showing the single `elastic`
option. Selection changes fetch `exports/map/<…>.html` and the artifact.

Result panel, top to bottom:

1. Header: technology, dataset, format; the block's route (direct) and
   parsing mechanism/artifact in one line.
2. Data map: the HTML fragment; download buttons for JSON, Markdown, CSV.
3. Parser artifact:
   - Cribl on: the pipeline JSON in a `<pre>` with copy and download. When
     `mechanism` is `elastic-integration` or `elastic-ingest-pipeline`, a
     note above it: "Parsing happens downstream in <artifact>; this pipeline
     only identifies the event and tags `event.dataset`."
   - Cribl off: the ingest envelope: coverage badge ("11 of 12 steps
     translated"), the `pipeline` body in a `<pre>` with copy and download
     (filename `<id>.ingest.json`), the `requires` list, then the manual
     steps as a list showing function, reason, description, and the
     original Cribl function JSON in a collapsed `<details>`. For
     Elastic-parsed blocks the same downstream note appears first.
   - `mechanism: none`: "Cribl is not in this path for this feed" and the
     parsing notes; no artifact.
   - `no-pipeline` flag (no file): "No pipeline has been authored for this
     block yet" with a link to the technology page.

Tests in `studio/tests/` style, run by the existing `node --test` job
(extended to `static/picker/tests/*.test.js`): hash parse/format
round-trip; cascading rules (changing tech resets dataset and format;
recommended format preselected); render of each artifact state against a
fixture envelope using the existing DOM shim approach in
`studio/tests/`.

## 6. Verification

Every push (CI, unchanged runners):

- `python -m unittest discover -s tests` now includes `cribl_lint` over all
  committed pipelines, the transpiler tests, export parity, the fragment
  substring test, and `check_pipelines` invariants via the build test.
- `node --test studio/tests/*.test.js static/picker/tests/*.test.js`.
- The build succeeds; `no-pipeline` flags are reported, not fatal.

Launch gate, run once by hand before public hosting, never in CI:

- `tools/validate_live/compose.yml`: `cribl/cribl:4.19.x` (single instance,
  free licence accepted by env) and `docker.elastic.co/elasticsearch/elasticsearch:8.x`
  single node, security off, `script.painless.regex.enabled=true`.
- `tools/validate_live/validate.py`: POST every `data/pipelines/**.json` to
  `/api/v1/pipelines` (delete first if present) and record status and body;
  PUT every ingest envelope's `pipeline` to `_ingest/pipeline/<id>` (Painless
  compiles here — the real check) and `_simulate` it with a stub document
  `{"message": ""}` to confirm it loads. Writes
  `docs/verification/<date>-live-validation.md` with totals, every failure
  verbatim, and the image tags used. The report is committed.
- What this proves and does not: every pipeline is accepted by its target
  and compiles. It does not prove correct parsing of real events; the
  public tree holds no example records. The runbook and README say so.

`docs/wiki/Runbooks.md` gains the "Live validation" runbook.

## 7. Hosting

The Forgejo Pages path is unchanged. Public hosting is GitHub Pages from the
existing mirror `japatton/data-maps`: `.github/workflows/pages.yml` runs the
Node tests, the Python tests and the build on `ubuntu-latest` and publishes
`public/` with `actions/deploy-pages`. It is added as the final task and
the repository's Pages setting is enabled only after a
`docs/verification/` report exists.

Constraint recorded in `docs/wiki/Runbooks.md`: the Forgejo→GitHub mirror
credential deliberately lacks GitHub `workflow` permission, which is why
the CI file lives under `.forgejo/`. GitHub rejects a push that writes
`.github/workflows/` without it, so the mirror will fail on that commit
until the mirror token is reissued with the `workflow` scope — a one-time
manual step by the repository owner, documented in the same runbook. The
task adding the workflow file states this and stops for that step.

## 8. Execution

1. This spec is committed.
2. `writing-plans` produces `docs/superpowers/plans/2026-09-21-picker-and-ingest-transpiler.md`.
3. `subagent-driven-development` executes the plan with Opus 5 subagents,
   one task each, with review between tasks. If a usage limit is hit, work
   pauses until the reset and resumes from the plan's checklist.

## 9. Housekeeping done within this work

- `.gitignore`: remove `cribl-pipelines/`; add `tools/pipelines/workorders/`.
- `cribl-pipelines/` deleted after the move.
- `README.md`: the Studio/GitLab framing stays (the day-job deployment
  shape is still a valid one); a "Picker" section and the translation
  section are added; the introduction mentions the picker as the consumer
  entry point.
