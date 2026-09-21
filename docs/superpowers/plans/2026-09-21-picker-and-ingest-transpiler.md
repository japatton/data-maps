# Picker and Cribl-to-Elasticsearch Ingest Transpiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A static picker page where a user selects technology → dataset → wire format → Cribl-in-path → destination and receives that block's data map (HTML, JSON, Markdown, CSV) plus either the committed Cribl pipeline or an Elasticsearch ingest pipeline transpiled from it.

**Architecture:** The 603 Cribl pipelines become catalog data under `data/pipelines/`, loaded and cross-checked by `datamaps/pipelines.py`. A pure-Python transpiler package `datamaps/ingest/` turns each Cribl pipeline into an ingest-pipeline envelope with explicit coverage. `datamaps/build.py` emits per-block exports and a `picker.json` index; `picker.html` plus vanilla ES modules under `static/picker/` consume them client-side with URL-hash state.

**Tech Stack:** Python 3.6+ (unittest, PyYAML, Jinja2), vanilla ES2018 modules tested with `node --test` (Node 20), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-picker-and-ingest-transpiler-design.md`

## Global Constraints

- Python code must run on 3.6: no dataclasses, no walrus, no positional-only params, no `from __future__ import annotations`, no f-strings with `=`, `dict` ordering not assumed where it matters (use `OrderedDict` or sorted keys for emitted JSON).
- No new Python or Node dependencies. `requirements.txt` is unchanged.
- JavaScript is ES2018 (Studio's floor: `studio/tests/es2018.test.js` enforces it for `studio/`; keep `static/picker/` to the same floor — no optional chaining `?.`, no `??`, no `replaceAll`).
- Every emitted JSON file ends with a newline and uses `indent=2, ensure_ascii=False`, matching `build._write_json`.
- Pipeline ids are `dm_` + `re.sub(r"[^a-z0-9]+", "_", "_".join((tech, dataset, fmt)).lower()).strip("_")`.
- The build is file-in / file-out; nothing here may read the network.
- Tests run with `python3 -m unittest discover -s tests` from the repo root and `node --test studio/tests/*.test.js static/picker/tests/*.test.js`.
- Commit after every task with the message shown; end every commit message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Never `git add -A`; add the files the task names.

## Repository facts an implementer needs

- `datamaps/build.py` `main()` loads inputs, validates, calls `model_mod.build_model(...)`, then `render.render_site`, `write_exports`, `examples_mod.publish`, `studio_mod.publish`. `page_model["flags"]` is a list of `{"code","subject","message"}` rendered on `index.html` and counted in the final report line.
- `page_model["technologies"]` is a list of tech views: `{"entry": catalog row, "doc": technology yaml or None, "datasets": [dataset views], ...}`. A dataset view has `"data"` (the authored dataset), `"formats"` (format views), `"recommendation"`, `"switch_gain"`, `"coverage_favours"`, `"examples"`. A format view has `"data"` (the authored format block with keys `format`, `parsing`, `fields`, `recommendations`, …), `"fields"` (`[{"field": row, "alerting": bool}]`), `"required"`, `"required_mapped"`, `"required_pct"`, `"fields_total"`, `"fields_mapped"`, `"recommended"`, `"recommended_source"`, `"parse_doctrine"`, `"parse_agrees"`.
- `templates/tech.html.j2` renders every format block inside `{% for fv in ds.formats %}<div class="format-variant …">…</div>{% endfor %}` (lines 93–164 at the time of writing). `templates/base.html.j2` holds the nav.
- `tests/test_build.py` builds the real data once per class into a temp dir (`run_build`, `temp_dir`). `tests/test_render.py` builds a tiny synthetic model with `ECS`/`PROFILES` constants and `row()` / `catalog()` helpers.
- Studio's Node tests import pure modules from `studio/lib/` and use `node:test` + `node:assert/strict`. There is no DOM shim; DOM-touching code is kept out of the tested modules. Follow that split for the picker: pure logic in `state.js` / `hash.js` / `render.js` (returns strings/structures), DOM only in `picker.js`.
- Cribl function conf shapes present in the corpus (census 2026-09-21):
  - `serde`: `{mode: "extract", type: json|kvp|csv|delim, srcField, [dstField], [fields], [kvDelim], [pairDelim], [delimChar], [delimiter]}`
  - `regex_extract`: `{regex: "/…/flags", source, [regexList: [{regex}], iterations: 100]}`
  - `eval`: `{add: [{name, value}], remove: [str]}` (no `keep` anywhere)
  - `rename`: `{rename: [{currentName, newName}]}`
  - `drop`: `{}` with the condition in the function's `filter`
  - `mask`: `{rules: [{matchRegex: "/…/flags", replaceExpr: "<js>"}], fields: [str]}`
  - `auto_timestamp`: `{srcField, dstField}` only
  - `numerify`: `{}` (all-fields form)
  - `code`, `distinct`, `unroll`, `xml_unroll`, `flatten`, `rollup_metrics`: manual
- Two blocks lack pipelines: `cisco-cucm/cdr__api-pull` and `cisco-cucm/audit__api-pull` (both `cribl-pipeline`). Five blocks are `mechanism: none`: `cisco-esa/mail-logs/csv-file`, `juniper-srx/flow/other`, `juniper-srx/idp/other`, `juniper-srx/utm/other`, `arkime/sessions/json`.

---

## Phase A — pipelines become catalog data

### Task 1: Move the pipelines and add the loader with its invariants

**Files:**
- Move: `cribl-pipelines/<tech>/<dataset>__<format>.json` (603 files) → `data/pipelines/<tech>/<dataset>__<format>.json`
- Modify: `.gitignore`
- Create: `datamaps/pipelines.py`
- Modify: `datamaps/build.py` (load + check + flags)
- Test: `tests/test_pipelines.py`

**Interfaces:**
- Produces: `pipelines.pipeline_id(tech_id, dataset_id, fmt) -> str`; `pipelines.load_pipelines(data_dir) -> OrderedDict[(tech, ds, fmt) -> dict]`; `pipelines.check_pipelines(pipelines, page_model) -> list[flag]` raising `pipelines.PipelineError(messages: list[str])`; `pipelines.iter_blocks(page_model) -> iterator of (tech_view, ds_view, fmt_view)`; `pipelines.NO_PIPELINE = "no-pipeline"`.
- `page_model["pipelines"]` is set by `build.main` to the loaded dict so later tasks (exports) read it from the model.

- [ ] **Step 1: Move the files and fix .gitignore**

```bash
cd /Users/jasonpatton/data-maps
mkdir -p data/pipelines
for d in cribl-pipelines/*/; do
  t=$(basename "$d"); case "$t" in _*) continue;; esac
  mkdir -p "data/pipelines/$t"
  for f in "$d"*.json; do mv "$f" "data/pipelines/$t/"; done
done
find data/pipelines -name '*.json' | wc -l
```
Expected: `603`.

Edit `.gitignore`: delete the line `cribl-pipelines/`; add the line `tools/pipelines/workorders/`.

- [ ] **Step 2: Write the failing tests**

`tests/test_pipelines.py`:

```python
import copy
import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import build, model as model_mod, pipelines

DATA = os.path.join(ROOT, "data")


def real_model():
    catalog, techs, profiles, ecs = build.load_inputs(DATA)
    return model_mod.build_model(catalog, techs, profiles, ecs)


class TestPipelineId(unittest.TestCase):
    def test_hyphens_become_underscores(self):
        self.assertEqual(
            pipelines.pipeline_id("cisco-asa", "device-admin", "snmp-trap"),
            "dm_cisco_asa_device_admin_snmp_trap")

    def test_other_punctuation_collapses(self):
        self.assertEqual(pipelines.pipeline_id("a.b", "c d", "e/f"),
                         "dm_a_b_c_d_e_f")


class TestLoad(unittest.TestCase):
    def test_loads_every_committed_pipeline(self):
        loaded = pipelines.load_pipelines(DATA)
        self.assertEqual(len(loaded), 603)
        key = ("cisco-asa", "device-admin", "snmp-trap")
        self.assertIn(key, loaded)
        self.assertEqual(loaded[key]["id"],
                         "dm_cisco_asa_device_admin_snmp_trap")
        self.assertIn("functions", loaded[key]["conf"])

    def test_missing_directory_is_empty(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        self.assertEqual(pipelines.load_pipelines(tmp), {})

    def test_bad_stem_is_hard_error(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        os.makedirs(os.path.join(tmp, "pipelines", "t"))
        with open(os.path.join(tmp, "pipelines", "t", "nosep.json"), "w") as fh:
            fh.write("{}")
        with self.assertRaises(pipelines.PipelineError) as ctx:
            pipelines.load_pipelines(tmp)
        self.assertIn("nosep.json", "\n".join(ctx.exception.messages))

    def test_invalid_json_is_hard_error(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        os.makedirs(os.path.join(tmp, "pipelines", "t"))
        with open(os.path.join(tmp, "pipelines", "t", "d__f.json"), "w") as fh:
            fh.write("{not json")
        with self.assertRaises(pipelines.PipelineError):
            pipelines.load_pipelines(tmp)


class TestCheck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = real_model()
        cls.loaded = pipelines.load_pipelines(DATA)

    def test_real_data_has_only_no_pipeline_flags(self):
        flags = pipelines.check_pipelines(self.loaded, self.model)
        codes = set(f["code"] for f in flags)
        self.assertLessEqual(codes, {pipelines.NO_PIPELINE})
        subjects = sorted(f["subject"] for f in flags)
        # The two cisco-cucm api-pull blocks are the known gaps until Task 4.
        for s in subjects:
            self.assertTrue(s.startswith("cisco-cucm/"), s)

    def test_none_blocks_have_no_pipeline_and_no_flag(self):
        flags = pipelines.check_pipelines(self.loaded, self.model)
        self.assertNotIn(("arkime", "sessions", "json"), self.loaded)
        self.assertFalse([f for f in flags if f["subject"] == "arkime/sessions"])

    def test_orphan_pipeline_is_hard_error(self):
        loaded = dict(self.loaded)
        loaded[("nope", "ds", "json")] = {"id": "dm_nope_ds_json",
                                          "conf": {"functions": []}}
        with self.assertRaises(pipelines.PipelineError) as ctx:
            pipelines.check_pipelines(loaded, self.model)
        self.assertIn("nope/ds__json", "\n".join(ctx.exception.messages))

    def test_wrong_id_is_hard_error(self):
        loaded = dict(self.loaded)
        key = ("cisco-asa", "device-admin", "snmp-trap")
        bad = copy.deepcopy(loaded[key])
        bad["id"] = "dm_wrong"
        loaded[key] = bad
        with self.assertRaises(pipelines.PipelineError) as ctx:
            pipelines.check_pipelines(loaded, self.model)
        self.assertIn("dm_wrong", "\n".join(ctx.exception.messages))

    def test_pipeline_for_none_block_is_hard_error(self):
        loaded = dict(self.loaded)
        loaded[("arkime", "sessions", "json")] = {
            "id": "dm_arkime_sessions_json", "conf": {"functions": []}}
        with self.assertRaises(pipelines.PipelineError) as ctx:
            pipelines.check_pipelines(loaded, self.model)
        self.assertIn("pipeline-for-none", "\n".join(ctx.exception.messages))

    def test_iter_blocks_covers_every_format(self):
        n = sum(1 for _ in pipelines.iter_blocks(self.model))
        self.assertEqual(n, 610)


class TestBuildIntegration(unittest.TestCase):
    def test_build_reports_pipelines_and_flags(self):
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out, True)
        import contextlib, io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            code = build.main(data_dir=DATA, out_dir=out)
        self.assertEqual(code, 0, buf.getvalue())
        self.assertIn("603 pipelines", buf.getvalue())
        with open(os.path.join(out, "index.html"), encoding="utf-8") as fh:
            self.assertIn("no-pipeline", fh.read())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `python3 -m unittest tests.test_pipelines -v`
Expected: `ImportError: cannot import name 'pipelines'`.

- [ ] **Step 4: Write `datamaps/pipelines.py`**

```python
"""Committed Cribl pipelines as catalog data: loading and cross-checks.

One file per (technology, dataset, format) block under
data/pipelines/<tech>/<dataset>__<format>.json, exactly the body that was
POSTed to Cribl's /api/v1/pipelines.  The loader is deliberately strict:
a file that names a block the catalog does not have is an error, never a
silent extra, because a typo would otherwise unpublish a pipeline without
anyone noticing.
"""
import json
import os
import re
from collections import OrderedDict

NO_PIPELINE = "no-pipeline"
PIPELINE_FOR_NONE = "pipeline-for-none"
_IDENT = re.compile(r"[^a-z0-9]+")


class PipelineError(Exception):
    """Hard failures; .messages is the list the build prints as FATAL lines."""

    def __init__(self, messages):
        self.messages = list(messages)
        Exception.__init__(self, "\n".join(self.messages))


def pipeline_id(tech_id, dataset_id, fmt):
    return "dm_" + _IDENT.sub("_", "_".join((tech_id, dataset_id, fmt))
                              .lower()).strip("_")


def _rel(tech_id, dataset_id, fmt):
    return "%s/%s__%s" % (tech_id, dataset_id, fmt)


def load_pipelines(data_dir):
    """{(tech, dataset, format): pipeline} from data/pipelines, sorted."""
    root = os.path.join(data_dir, "pipelines")
    found = OrderedDict()
    errors = []
    if not os.path.isdir(root):
        return found
    for tech_id in sorted(os.listdir(root)):
        tech_dir = os.path.join(root, tech_id)
        if not os.path.isdir(tech_dir) or tech_id.startswith("_"):
            continue
        for name in sorted(os.listdir(tech_dir)):
            if not name.endswith(".json"):
                continue
            path = os.path.join(tech_dir, name)
            stem = name[:-5]
            if "__" not in stem:
                errors.append("%s: file name must be <dataset>__<format>.json"
                              % os.path.relpath(path, data_dir))
                continue
            dataset_id, fmt = stem.split("__", 1)
            try:
                with open(path, encoding="utf-8") as fh:
                    doc = json.load(fh)
            except ValueError as exc:
                errors.append("%s: %s" % (os.path.relpath(path, data_dir), exc))
                continue
            conf = doc.get("conf") if isinstance(doc, dict) else None
            if not isinstance(conf, dict) or not isinstance(
                    conf.get("functions"), list):
                errors.append("%s: expected {id, conf: {functions: [...]}}"
                              % os.path.relpath(path, data_dir))
                continue
            found[(tech_id, dataset_id, fmt)] = doc
    if errors:
        raise PipelineError(errors)
    return found


def iter_blocks(page_model):
    """Every (tech_view, dataset_view, format_view) in catalog order."""
    for tech_view in page_model["technologies"]:
        for ds_view in tech_view["datasets"]:
            for fmt_view in ds_view["formats"]:
                yield tech_view, ds_view, fmt_view


def check_pipelines(pipelines, page_model):
    """Cross-check pipelines against the model; return flags, raise on errors."""
    errors = []
    flags = []
    blocks = {}
    for tech_view, ds_view, fmt_view in iter_blocks(page_model):
        key = (tech_view["entry"]["id"], ds_view["data"]["id"],
               fmt_view["data"]["format"])
        blocks[key] = fmt_view["data"]["parsing"]["mechanism"]
    for key, doc in pipelines.items():
        rel = _rel(*key)
        if key not in blocks:
            errors.append("pipeline %s: no such (technology, dataset, format) "
                          "block in the catalog" % rel)
            continue
        want = pipeline_id(*key)
        if doc.get("id") != want:
            errors.append("pipeline %s: id is %r, expected %r"
                          % (rel, doc.get("id"), want))
        if blocks[key] == "none":
            errors.append("%s: pipeline %s exists but the block's parsing "
                          "mechanism is none (Cribl is not in this path)"
                          % (PIPELINE_FOR_NONE, rel))
    for key, mechanism in blocks.items():
        if mechanism != "none" and key not in pipelines:
            subject = "%s/%s" % (key[0], key[1])
            flags.append({"code": NO_PIPELINE, "subject": subject,
                          "message": "dataset '%s' format '%s' (%s) has no "
                                     "pipeline under data/pipelines/"
                                     % (subject, key[2], mechanism)})
    if errors:
        raise PipelineError(errors)
    return flags
```

- [ ] **Step 5: Wire it into `datamaps/build.py`**

Add the import: `from datamaps import pipelines as pipelines_mod`.

In `main()`, right after `page_model = model_mod.build_model(...)` and before `if os.path.isdir(out_dir):`, insert:

```python
    try:
        loaded = pipelines_mod.load_pipelines(data_dir)
        page_model["flags"].extend(
            pipelines_mod.check_pipelines(loaded, page_model))
    except pipelines_mod.PipelineError as exc:
        for message in exc.messages:
            sys.stderr.write("FATAL: %s\n" % message)
        return 1
    page_model["pipelines"] = loaded
```

Change the final report `print` to include the count:

```python
    print("Built %s: %d technologies (%d with maps), %d datasets, "
          "%d examples, %d pipelines, %d flags"
          % (out_dir,
             page_model["summary"]["technologies"],
             sum(1 for v in page_model["technologies"] if v["doc"]),
             page_model["summary"]["datasets"],
             len(records),
             len(page_model["pipelines"]),
             len(page_model["flags"])))
```

`tests/test_build.py` and any test asserting on the report line's exact text: search with `grep -n "flags\"" tests/*.py` and `grep -n "examples, " tests/*.py`; update any exact-match assertions to the new wording.

- [ ] **Step 6: Run the tests**

Run: `python3 -m unittest tests.test_pipelines tests.test_build -v`
Expected: all PASS. `TestCheck.test_real_data_has_only_no_pipeline_flags` passes with two `cisco-cucm/` subjects.

Run the full suite: `python3 -m unittest discover -s tests` → `OK`.

- [ ] **Step 7: Commit**

```bash
git add .gitignore data/pipelines datamaps/pipelines.py datamaps/build.py tests/test_pipelines.py tests/test_build.py
git commit -m "data: commit the 603 Cribl pipelines and cross-check them against the catalog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Semantic lint moves into the package and runs in CI

**Files:**
- Create: `datamaps/cribl_lint.py` (from `cribl-pipelines/_lint.py`)
- Delete: `cribl-pipelines/_lint.py`
- Test: `tests/test_cribl_lint.py`

**Interfaces:**
- Produces: `cribl_lint.lint_pipeline(doc) -> list[(code, detail)]`; `cribl_lint.lint_all(pipelines) -> dict[code -> list[str]]` (also checks duplicate ids across the set); `python3 -m datamaps.cribl_lint [--data DIR]` prints the report and exits 1 on findings.
- Consumes: `pipelines.load_pipelines`.

- [ ] **Step 1: Write the failing tests**

`tests/test_cribl_lint.py`:

```python
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import cribl_lint, pipelines

DATA = os.path.join(ROOT, "data")


def pipe(*functions):
    return {"id": "dm_t_d_f", "conf": {"output": "default",
                                        "description": "t",
                                        "functions": list(functions)}}


def ev(add=None, remove=None):
    conf = {}
    if add is not None:
        conf["add"] = add
    if remove is not None:
        conf["remove"] = remove
    return {"id": "eval", "filter": "true", "conf": conf}


DATASET = ev(add=[{"name": "event.dataset", "value": "'t.d'"}])


def codes(doc):
    return sorted(set(code for code, _ in cribl_lint.lint_pipeline(doc)))


class TestRules(unittest.TestCase):
    def test_clean_pipeline_has_no_findings(self):
        self.assertEqual(codes(pipe(DATASET)), [])

    def test_empty_pipeline(self):
        self.assertIn("empty-pipeline", codes(pipe()))

    def test_no_event_dataset(self):
        self.assertIn("no-event-dataset",
                      codes(pipe(ev(add=[{"name": "a", "value": "'b'"}]))))

    def test_dataset_in_code_counts(self):
        doc = pipe({"id": "code", "filter": "true",
                    "conf": {"code": "__e['event.dataset']='t.d'"}})
        self.assertNotIn("no-event-dataset", codes(doc))

    def test_comment_over_1000(self):
        doc = pipe(DATASET, {"id": "comment", "filter": "true",
                             "conf": {"comment": "x" * 1001}})
        self.assertIn("comment-over-1000", codes(doc))

    def test_global_read_off_event(self):
        doc = pipe(DATASET, ev(add=[{"name": "t", "value": "__e['Date'].parse(x)"}]))
        self.assertIn("global-read-off-event", codes(doc))

    def test_echoed_placeholder_and_name_equals_value(self):
        doc = pipe(DATASET, ev(add=[{"name": "name", "value": "'value'"},
                                    {"name": "foo", "value": "'foo'"}]))
        found = codes(doc)
        self.assertIn("echoed-placeholder", found)
        self.assertIn("name-equals-value", found)

    def test_dataset_has_hyphen(self):
        doc = pipe(ev(add=[{"name": "event.dataset", "value": "'a-b.c'"}]))
        self.assertIn("dataset-has-hyphen", codes(doc))

    def test_invalid_paths(self):
        doc = pipe(DATASET, ev(add=[{"name": "@bad", "value": "1"}],
                               remove=["x-y"]))
        found = codes(doc)
        self.assertIn("invalid-path-in-eval-add", found)
        self.assertIn("invalid-path-in-eval-remove", found)

    def test_rename_rules(self):
        malformed = pipe(DATASET, {"id": "rename", "filter": "true",
                                   "conf": {"fromField": "a"}})
        self.assertIn("rename-conf-malformed", codes(malformed))
        pair = pipe(DATASET, {"id": "rename", "filter": "true",
                              "conf": {"rename": [{"currentName": "a"}]}})
        self.assertIn("rename-pair-malformed", codes(pair))
        noop = pipe(DATASET, {"id": "rename", "filter": "true",
                              "conf": {"rename": [{"currentName": "a",
                                                   "newName": "a"}]}})
        self.assertIn("rename-noop", codes(noop))
        bad = pipe(DATASET, {"id": "rename", "filter": "true",
                             "conf": {"rename": [{"currentName": "a",
                                                  "newName": "@b"}]}})
        self.assertIn("invalid-path-in-rename", codes(bad))

    def test_bare_regex(self):
        doc = pipe(DATASET, {"id": "regex_extract", "filter": "true",
                             "conf": {"regex": "(?<a>\\d+)", "source": "_raw"}})
        self.assertIn("bare-regex", codes(doc))


class TestCorpus(unittest.TestCase):
    def test_every_committed_pipeline_lints_clean(self):
        loaded = pipelines.load_pipelines(DATA)
        findings = cribl_lint.lint_all(loaded)
        self.assertEqual(findings, {}, cribl_lint.format_report(findings))

    def test_duplicate_id_detected(self):
        a = pipe(DATASET)
        b = pipe(DATASET)
        findings = cribl_lint.lint_all({("t", "d", "f"): a, ("t", "d", "g"): b})
        self.assertIn("duplicate-pipeline-id", findings)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_cribl_lint -v`
Expected: `ImportError: cannot import name 'cribl_lint'`.

- [ ] **Step 3: Write `datamaps/cribl_lint.py`**

Port `cribl-pipelines/_lint.py` rule-for-rule. Keep every comment that explains a rule's origin (they record real incidents). Shape:

```python
"""Semantic lint for the committed Cribl pipelines.

HTTP 200 from the Cribl API only proves the schema and every function conf
are well formed.  It does NOT prove the pipeline means anything: one agent
shipped `{"name":"name","value":"value"}` eval entries from a generator bug
and got 200.  These checks look for wrong-but-well-formed output.
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict

VALID_PATH = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$')
GARBAGE = {"name", "value", "field", "ecs", "vendor", "todo", "tbd",
           "placeholder"}
GLOBALS = ("Date", "Math", "String", "Number", "Boolean", "Array", "Object",
           "JSON", "RegExp", "parseInt", "parseFloat", "isNaN", "isFinite")


def lint_pipeline(doc):
    """[(code, detail)] for one pipeline document."""
    out = []
    conf = doc.get("conf") or {}
    fns = conf.get("functions") or []
    if not fns:
        out.append(("empty-pipeline", ""))
    has_dataset = False
    for fn in fns:
        fid = fn.get("id")
        c = fn.get("conf") or {}
        if fid == "comment" and len(str(c.get("comment", ""))) > 1000:
            out.append(("comment-over-1000", ""))
        # event.dataset is legitimately set inside a `code` function by some
        # pipelines, not only via eval.add - checking eval alone produced
        # eight false positives.
        if fid == "code" and "event.dataset" in str(c.get("code", "")):
            has_dataset = True
        # A JS global read off the event: `__e['Date'].parse(x)` evaluates
        # to undefined.parse(x) and throws at runtime.  Schema-valid, so
        # Cribl returns 200.
        blob = json.dumps(c)
        for g in GLOBALS:
            if "__e['%s']." % g in blob or '__e["%s"].' % g in blob:
                out.append(("global-read-off-event", "__e['%s'].*" % g))
        if fid == "eval":
            for add in c.get("add") or []:
                n = str(add.get("name", ""))
                v = str(add.get("value", ""))
                # Both sides generic - the observed bug was literally
                # {"name":"name","value":"value"}.  Either side alone
                # false-positives on maps whose own vendor fields are called
                # `value` (printers-mfd) or `NAME` (zos-acf2).
                if n.lower() in GARBAGE and v.strip("'\"").lower() in GARBAGE:
                    out.append(("echoed-placeholder", "{%s: %s}" % (n, v)))
                if n and v and n == v.strip("'\""):
                    out.append(("name-equals-value", n))
                if n == "event.dataset":
                    has_dataset = True
                    if "-" in v:
                        out.append(("dataset-has-hyphen", v))
                if n and not VALID_PATH.match(n):
                    out.append(("invalid-path-in-eval-add", n))
            for rm in c.get("remove") or []:
                if isinstance(rm, str) and "*" not in rm and not VALID_PATH.match(rm):
                    out.append(("invalid-path-in-eval-remove", rm))
        if fid == "rename":
            # Cribl does NOT validate the rename conf: a bogus key set and
            # even an empty conf both return HTTP 200.  This check is the
            # only thing between a typo and a silently no-op rename.
            pairs = c.get("rename")
            if not isinstance(pairs, list) or not pairs:
                out.append(("rename-conf-malformed",
                            "conf keys=%s" % sorted(c)))
                pairs = []
            for pair in pairs:
                if (not isinstance(pair, dict) or "currentName" not in pair
                        or "newName" not in pair):
                    out.append(("rename-pair-malformed", str(pair)))
                    continue
                cn = str(pair.get("currentName", ""))
                nn = str(pair.get("newName", ""))
                if cn and cn == nn:
                    out.append(("rename-noop", cn))
                for nm in (cn, nn):
                    if nm and not VALID_PATH.match(nm):
                        out.append(("invalid-path-in-rename", nm))
        if fid in ("regex_extract", "regex_filter"):
            rx = c.get("regex")
            if isinstance(rx, str) and rx and not rx.startswith("/"):
                out.append(("bare-regex", rx[:40]))
    if not has_dataset:
        out.append(("no-event-dataset", ""))
    return out


def lint_all(pipelines):
    """{code: [detail lines]} over a {(tech, ds, fmt): doc} mapping."""
    findings = defaultdict(list)
    ids = defaultdict(list)
    for key in sorted(pipelines):
        doc = pipelines[key]
        rel = "%s/%s__%s" % key
        ids[doc.get("id", "")].append(rel)
        for code, detail in lint_pipeline(doc):
            findings[code].append(("%s  %s" % (rel, detail)).rstrip())
    for pid, rels in ids.items():
        if len(rels) > 1:
            findings["duplicate-pipeline-id"].append(
                "%s  <- %s" % (pid, ", ".join(rels)))
    return dict(findings)


def format_report(findings):
    if not findings:
        return "no findings\n"
    lines = []
    for code in sorted(findings, key=lambda k: -len(findings[k])):
        items = findings[code]
        lines.append("%-28s %4d" % (code, len(items)))
        for item in items[:6]:
            lines.append("      %s" % item)
        if len(items) > 6:
            lines.append("      ... and %d more" % (len(items) - 6))
    return "\n".join(lines) + "\n"


def main(argv=None):
    from datamaps import pipelines as pipelines_mod
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser(prog="python3 -m datamaps.cribl_lint")
    parser.add_argument("--data", default=os.path.join(root, "data"))
    opts = parser.parse_args(argv)
    loaded = pipelines_mod.load_pipelines(opts.data)
    findings = lint_all(loaded)
    sys.stdout.write("linted %d pipeline files\n" % len(loaded))
    sys.stdout.write(format_report(findings))
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
```

Then `git rm cribl-pipelines/_lint.py`.

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest tests.test_cribl_lint -v`
Expected: all PASS, including `test_every_committed_pipeline_lints_clean`. If the corpus test fails, the report names the files; the corpus was clean on 2026-09-17, so a failure means a port mistake — compare with the deleted script's rule, do not "fix" data.

- [ ] **Step 5: Commit**

```bash
git add datamaps/cribl_lint.py tests/test_cribl_lint.py
git rm -q cribl-pipelines/_lint.py
git commit -m "lint: move the Cribl semantic lint into the package and run it in the suite

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Provenance tooling under tools/pipelines; delete the run state

**Files:**
- Move: `cribl-pipelines/_AGENT-BRIEF.md` → `tools/pipelines/AGENT-BRIEF.md`
- Move: `cribl-pipelines/_build_workorders.py` → `tools/pipelines/build_workorders.py`
- Move: `cribl-pipelines/_generate_thin.py` → `tools/pipelines/generate_thin.py`
- Create: `tools/pipelines/README.md`
- Delete: everything else under `cribl-pipelines/`, then the directory
- Test: `tests/test_pipeline_tools.py`

**Interfaces:**
- Produces: `tools/pipelines/generate_thin.py` writes into `data/pipelines/` and, when run on the current catalog, changes nothing (idempotency test).
- `tools/pipelines/build_workorders.py` writes `tools/pipelines/workorders/<tech>[--<dataset>].json` and `_manifest.json`.

- [ ] **Step 1: Move and delete**

```bash
cd /Users/jasonpatton/data-maps
mkdir -p tools/pipelines
git mv -k cribl-pipelines/_AGENT-BRIEF.md tools/pipelines/AGENT-BRIEF.md 2>/dev/null || mv cribl-pipelines/_AGENT-BRIEF.md tools/pipelines/AGENT-BRIEF.md
mv cribl-pipelines/_build_workorders.py tools/pipelines/build_workorders.py
mv cribl-pipelines/_generate_thin.py tools/pipelines/generate_thin.py
rm -rf cribl-pipelines
ls tools/pipelines
```
Expected: `AGENT-BRIEF.md build_workorders.py generate_thin.py`.

- [ ] **Step 2: Repath `generate_thin.py`**

In `tools/pipelines/generate_thin.py`:
- Replace `ROOT = os.path.dirname(os.path.abspath(__file__))` and `DATA = ...` with:

```python
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(REPO, "data", "technologies")
OUT = os.path.join(REPO, "data", "pipelines")
```
- Remove the `PILOT` set and the `if tech_id in PILOT: continue` line (the pilots' thin pipelines are committed like all the others now; the script must be a no-op over the current tree).
- `outdir = os.path.join(ROOT, tech_id)` → `outdir = os.path.join(OUT, tech_id)`.
- Delete the `notes` list, the `notes.append(...)` line, and the block that writes `NOTES-no-pipeline.md`; keep counting `skipped_none` and print it.
- The JSON write already uses `indent=2` and a trailing newline; keep it so existing files are byte-identical.

- [ ] **Step 3: Repath `build_workorders.py`**

- Replace the `ROOT`/`DATA`/`OUT` block with:

```python
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(REPO, "data", "technologies")
OUT = os.path.join(HERE, "workorders")
```
- Remove `PILOT` and its `continue`.
- Wrap the module-level script body (everything from `os.makedirs(OUT, exist_ok=True)` down to the final `print("any part still over 85KB:", ...)`) in `def main():` and add `if __name__ == "__main__": main()`. Move `def split_oversized` above `main` so it is defined before use.

- [ ] **Step 4: Update `AGENT-BRIEF.md` paths**

Replace every `/Users/jasonpatton/data-maps/cribl-pipelines/_workorders/` with `tools/pipelines/workorders/`, every `cribl-pipelines/<tech>/` output path with `data/pipelines/<tech>/`, and any mention of `_lint.py` with `python3 -m datamaps.cribl_lint`. Do not change the technical content (function whitelist, schema, constraints).

- [ ] **Step 5: Write `tools/pipelines/README.md`**

```markdown
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

It rewrites every thin pipeline in place.  On an unchanged catalog it
changes nothing; `git status` shows exactly the blocks whose text moved.

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
```

- [ ] **Step 6: Write the test**

`tests/test_pipeline_tools.py`:

```python
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools", "pipelines")


class TestGenerateThin(unittest.TestCase):
    def test_idempotent_on_current_catalog(self):
        before = subprocess.check_output(["git", "status", "--porcelain",
                                          "data/pipelines"], cwd=ROOT)
        subprocess.check_call([sys.executable,
                               os.path.join(TOOLS, "generate_thin.py")],
                              cwd=ROOT, stdout=subprocess.DEVNULL)
        after = subprocess.check_output(["git", "status", "--porcelain",
                                         "data/pipelines"], cwd=ROOT)
        self.assertEqual(before, after,
                         "generate_thin.py changed committed pipelines")


class TestBuildWorkorders(unittest.TestCase):
    def test_writes_manifest(self):
        subprocess.check_call([sys.executable,
                               os.path.join(TOOLS, "build_workorders.py")],
                              cwd=ROOT, stdout=subprocess.DEVNULL)
        manifest = os.path.join(TOOLS, "workorders", "_manifest.json")
        self.assertTrue(os.path.exists(manifest))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 7: Run**

Run: `python3 -m unittest tests.test_pipeline_tools -v`
Expected: PASS. If `test_idempotent_on_current_catalog` fails, diff one changed file: the pilots (`cisco-asa`, `apache-httpd`, `entra-id`) may have thin pipelines that were written by hand with different comment text. In that case the committed files are authoritative — restore them with `git checkout data/pipelines` and add the three pilot ids back as a `SKIP` set in `generate_thin.py` with a comment saying their thin pipelines were hand-authored during the pilot and must not be regenerated.

- [ ] **Step 8: Commit**

```bash
git add tools/pipelines/AGENT-BRIEF.md tools/pipelines/build_workorders.py tools/pipelines/generate_thin.py tools/pipelines/README.md tests/test_pipeline_tools.py
git commit -m "tools: keep the pipeline provenance under tools/pipelines, drop the run state

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Author the two missing cisco-cucm pipelines

**Files:**
- Create: `data/pipelines/cisco-cucm/cdr__api-pull.json`
- Create: `data/pipelines/cisco-cucm/audit__api-pull.json`
- Modify: `tests/test_pipelines.py` (the flag test tightens to zero)

**Interfaces:**
- Consumes: `tools/pipelines/AGENT-BRIEF.md`, `tools/pipelines/build_workorders.py` (produces `tools/pipelines/workorders/cisco-cucm.json` or `cisco-cucm--cdr.json` / `cisco-cucm--audit.json`).

- [ ] **Step 1: Build the work order and read the brief**

```bash
python3 tools/pipelines/build_workorders.py >/dev/null
ls tools/pipelines/workorders/ | grep cisco-cucm
```
Read `tools/pipelines/AGENT-BRIEF.md` in full, then the `cdr` and `audit` datasets' `api-pull` format blocks from the work order (or from `data/technologies/cisco-cucm.yml`).

- [ ] **Step 2: Author the two pipelines following the brief exactly**

Each file: `{"id": "dm_cisco_cucm_cdr_api_pull" | "dm_cisco_cucm_audit_api_pull", "conf": {"output": "default", "description": ..., "functions": [...]}}`. Use only functions the brief whitelists; every `eval` value reads fields as `__e['name']`; include an `eval` setting `event.dataset` to `'cisco_cucm.cdr'` / `'cisco_cucm.audit'`; `recommendations.direct.cribl` in the block outranks the generic recipe. Write with `json.dump(..., indent=2)` and a trailing newline.

- [ ] **Step 3: Lint**

Run: `python3 -m datamaps.cribl_lint`
Expected: `linted 605 pipeline files` / `no findings`.

- [ ] **Step 4: Tighten the test**

In `tests/test_pipelines.py`, replace `test_real_data_has_only_no_pipeline_flags` with:

```python
    def test_real_data_has_no_flags(self):
        self.assertEqual(pipelines.check_pipelines(self.loaded, self.model), [])
```
Change `self.assertEqual(len(loaded), 603)` to `605`, and in `TestBuildIntegration` change `"603 pipelines"` to `"605 pipelines"` and replace the `assertIn("no-pipeline", ...)` with `assertNotIn("no-pipeline", ...)`.

- [ ] **Step 5: Run**

Run: `python3 -m unittest tests.test_pipelines tests.test_cribl_lint -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add data/pipelines/cisco-cucm/cdr__api-pull.json data/pipelines/cisco-cucm/audit__api-pull.json tests/test_pipelines.py
git commit -m "data: author the two missing cisco-cucm api-pull pipelines

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase B — the Cribl → Elasticsearch ingest transpiler

The package is `datamaps/ingest/` with `__init__.py` (empty), `expr.py`, `functions.py`, `pipeline.py`. Read spec section 3 before starting any task in this phase. Emission rules that tests pin down:

- Field reads: `ctx.a` for a top-level identifier; nested identifiers use the null-safe operator `ctx.a?.b?.c`; a segment that is not a Painless identifier (or is a Painless reserved word) uses bracket form, `ctx['detail-type']`, and nested bracket segments are not null-safe (`ctx['a']['b']`).
- Field map on read and write: `_time` → `@timestamp` (bracket form), `_raw` → `message`. Any other name starting with `__` is `Untranslatable("Cribl internal field")`.
- Painless reserved words (bracket form when a segment equals one): `if else while do for in continue break return new try catch throw this instanceof def void boolean byte short char int long float double true false null`.
- Truthiness of a non-boolean expression X is always inlined as `(X != null && X != false && X != '' && X != 0)`. No helper functions.
- Value-mode `a || b` → `(T(a) ? A : B)`; `a && b` → `(T(a) ? B : A)`; condition-mode `a || b` → `(C(a) || C(b))`, `a && b` → `(C(a) && C(b))`, `!a` → `!` + C(a).
- Ternary → `(C(c) ? A : B)`.
- `===`/`!==` → `(A == B)` / `(A != B)`; any comparison against `null` or `undefined` (strict or loose) → `(A == null)` / `(A != null)`; loose `==`/`!=` with a string or number literal on one side → `(String.valueOf(A) == 'literal-text')`; other loose comparisons → `(A == B)`.
- `typeof X === 'undefined'` / `!== 'undefined'` → `(X == null)` / `(X != null)`; `=== 'string'|'number'|'boolean'` → `(X instanceof String|Number|Boolean)`; any other `typeof` use is untranslatable.
- Relational `< <= > >=` and `- * / %` → `(A op B)`. `+`: if either operand is a string literal or a string-producing call/method (`String(...)`, `.toLowerCase()`, `.toUpperCase()`, `.trim()`, `.replace(...)`, `.substring(...)`, `.slice(...)`, `.toISOString()`, `.toString()`) → `(String.valueOf(A) + String.valueOf(B))` with string literals left as literals; if either operand is a number literal or `Date.parse(...)`/`.getTime()`/`parseInt`/`parseFloat`/`Number(...)`/`Math.*` → numeric `(A + B)`; otherwise `Untranslatable("ambiguous +")`.
- Unary `-X` → `(-X)`; unary `+X` → `Double.parseDouble(String.valueOf(X).trim())`.
- Calls: `parseInt(x)` / `parseInt(x, 10)` → `(long) Double.parseDouble(String.valueOf(X).trim())` (any other radix untranslatable); `parseFloat(x)` / `Number(x)` → `Double.parseDouble(String.valueOf(X).trim())`; `String(x)` → `String.valueOf(X)`; `Boolean(x)` → T(x); `Date.parse(x)` → `ZonedDateTime.parse(String.valueOf(X)).toInstant().toEpochMilli()`; `Math.floor|round|abs|max|min(...)` → same name; `Array.isArray(x)` → `(X instanceof List)`; `new Date(x).toISOString()` → `ZonedDateTime.parse(String.valueOf(X)).toInstant().toString()`; `new Date(x).getTime()` → `ZonedDateTime.parse(String.valueOf(X)).toInstant().toEpochMilli()`; `new Date(x)` anywhere else, `Date.now()`, `JSON.*`, `isNaN`, `isFinite` → untranslatable.
- Methods: `.toLowerCase() .toUpperCase() .trim() .startsWith(s) .endsWith(s) .indexOf(s)` → same; `.includes(s)` → `.contains(S)`; `.split(s)` → `.splitOnToken(S)`; `.substring(a[,b])` / `.slice(a[,b])` → `.substring(A[, B])` (a literal negative argument is untranslatable); `.toString()` → `String.valueOf(R)`; `.replace(/re/flags, 'lit')` → `R.replaceFirst(/re/flags, m -> 'lit')`, or `replaceAll` when flags contain `g` (the `g` is dropped from the emitted flags; a replacement containing `$` is untranslatable); `.replace('a', 'b')` → `R.replace('a', 'b')`; `/re/.test(x)` → `(X =~ /re/flags)`; `x.match(/re/)` in condition mode → `(X =~ /re/)`, in value mode untranslatable; `.length`, `.join`, `.map`, `.forEach`, `.push` and anything else → untranslatable.
- Regex literals are emitted as Painless regex literals `/pattern/flags`; `/` inside the pattern is escaped `\/`; flags other than `i m s` (after dropping `g`) are untranslatable. Any regex sets `regex=True` on the result.
- String literals are emitted single-quoted with `\\` and `\'` escaped. Numbers as written. `null` and `undefined` → `null`. Arrays → `[A, B]`.
- Assignment (`=`), `++`, `--`, `new` other than `new Date(...)`, `function`, `=>`, `;`, `{`, and any bare identifier other than `__e`, `true`, `false`, `null`, `undefined`, `typeof`, `new`, `Date`, `Math`, `Array`, `String`, `Number`, `Boolean`, `parseInt`, `parseFloat`, `JSON`, `isNaN`, `isFinite` are untranslatable with the offending token in the reason.

If an implementation produces a string that is semantically identical to a test's expected string but differs in parenthesisation or spacing, the *rule above* is the arbiter: match the rule, and adjust whichever side departs from it.

### Task 5: Expression tokenizer and parser

**Files:**
- Create: `datamaps/ingest/__init__.py` (empty)
- Create: `datamaps/ingest/expr.py` (tokenizer + parser only in this task)
- Test: `tests/test_ingest_expr.py` (parser half)

**Interfaces:**
- Produces: `expr.Untranslatable(reason, offset=None)` with `.reason`, `.offset`; `expr.tokenize(src) -> list[(kind, value, offset)]` with kinds `num str ident punct regex eof`; `expr.parse(src) -> node`. Node tuples:
  - `("str", text)`, `("num", text)`, `("bool", True|False)`, `("null",)`, `("undef",)`, `("array", [nodes])`, `("regex", pattern, flags)`
  - `("field", [segments])` for `__e['a']`, `__e["a.b"]`, `__e.a`, `__e['a'].b`, `__e['a']['b']` — segments are split on `.` in bracket strings and extended by `.x` / `['x']` postfixes
  - `("unary", op, node)` op in `! - +`; `("typeof", node)`
  - `("binary", op, left, right)` op in `|| && === !== == != < <= > >= + - * / %`
  - `("cond", test, then, else)`
  - `("call", name, [args])` name in `parseInt parseFloat Number String Boolean Date.parse Math.floor Math.round Math.abs Math.max Math.min Array.isArray`
  - `("newdate", node)` for `new Date(x)`
  - `("method", receiver, name, [args])`

- [ ] **Step 1: Write the failing parser tests**

`tests/test_ingest_expr.py` (start of file; the emitter tests are added in Task 6):

```python
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps.ingest import expr
from datamaps.ingest.expr import Untranslatable, parse, tokenize


class TestTokenize(unittest.TestCase):
    def test_kinds(self):
        toks = tokenize("__e['a'] !== undefined ? 1 : 'x'")
        self.assertEqual([t[0] for t in toks],
                         ["ident", "punct", "str", "punct", "punct", "ident",
                          "punct", "num", "punct", "str", "eof"])

    def test_regex_after_operator_or_start(self):
        toks = tokenize("/^a\\/b$/i.test(__e['x'])")
        self.assertEqual(toks[0], ("regex", ("^a\\/b$", "i"), 0))
        toks = tokenize("x.replace(/a/g, 'b')")
        self.assertIn(("regex", ("a", "g"), 10), toks)

    def test_slash_after_value_is_division(self):
        toks = tokenize("Date.parse(__e['t'])/1000")
        self.assertIn(("punct", "/", 20), toks)

    def test_string_escapes(self):
        self.assertEqual(tokenize(r"'it\'s'")[0][1], "it's")
        self.assertEqual(tokenize(r'"a\nb"')[0][1], "a\nb")

    def test_unterminated_string_is_untranslatable(self):
        with self.assertRaises(Untranslatable):
            tokenize("'abc")


class TestParse(unittest.TestCase):
    def test_literals(self):
        self.assertEqual(parse("'a'"), ("str", "a"))
        self.assertEqual(parse("12"), ("num", "12"))
        self.assertEqual(parse("1.5"), ("num", "1.5"))
        self.assertEqual(parse("true"), ("bool", True))
        self.assertEqual(parse("null"), ("null",))
        self.assertEqual(parse("undefined"), ("undef",))
        self.assertEqual(parse("['a', 'b']"), ("array", [("str", "a"), ("str", "b")]))

    def test_field_forms(self):
        self.assertEqual(parse("__e['a']"), ("field", ["a"]))
        self.assertEqual(parse('__e["a.b"]'), ("field", ["a", "b"]))
        self.assertEqual(parse("__e.a"), ("field", ["a"]))
        self.assertEqual(parse("__e['a'].b"), ("field", ["a", "b"]))
        self.assertEqual(parse("__e['a']['b']"), ("field", ["a", "b"]))
        self.assertEqual(parse("__e['detail-type']"), ("field", ["detail-type"]))

    def test_precedence(self):
        node = parse("__e['a'] === 'x' || __e['b'] === 'y' && !__e['c']")
        self.assertEqual(node[0], "binary")
        self.assertEqual(node[1], "||")
        self.assertEqual(node[3][1], "&&")
        self.assertEqual(node[3][3], ("unary", "!", ("field", ["c"])))

    def test_ternary_nests_right(self):
        node = parse("__e['l']==='C'?2:(__e['l']==='E'?3:undefined)")
        self.assertEqual(node[0], "cond")
        self.assertEqual(node[2], ("num", "2"))
        self.assertEqual(node[3][0], "cond")
        self.assertEqual(node[3][3], ("undef",))

    def test_calls_and_methods(self):
        self.assertEqual(parse("parseInt(__e['n'], 10)"),
                         ("call", "parseInt", [("field", ["n"]), ("num", "10")]))
        self.assertEqual(parse("Date.parse(__e['t'])"),
                         ("call", "Date.parse", [("field", ["t"])]))
        self.assertEqual(parse("Math.floor(1.5)"), ("call", "Math.floor", [("num", "1.5")]))
        self.assertEqual(parse("new Date(__e['t']).toISOString()"),
                         ("method", ("newdate", ("field", ["t"])), "toISOString", []))
        self.assertEqual(parse("__e['s'].toLowerCase()"),
                         ("method", ("field", ["s"]), "toLowerCase", []))
        self.assertEqual(parse("(__e['a']||'').replace(/^.*\\./,'')"),
                         ("method",
                          ("binary", "||", ("field", ["a"]), ("str", "")),
                          "replace", [("regex", "^.*\\.", ""), ("str", "")]))
        self.assertEqual(parse("typeof __e['m'] !== 'undefined'"),
                         ("binary", "!==", ("typeof", ("field", ["m"])), ("str", "undefined")))

    def test_untranslatable_constructs(self):
        for src in ("foo", "__e['a'] = 1", "x => x", "JSON.parse(__e['a'])",
                    "new Foo()", "__e['a']++", "function(){}", "a; b"):
            with self.assertRaises(Untranslatable, msg=src):
                parse(src)

    def test_error_names_the_token(self):
        with self.assertRaises(Untranslatable) as ctx:
            parse("__e['a'] + foo")
        self.assertIn("foo", ctx.exception.reason)
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_ingest_expr -v`
Expected: `ImportError` (no `datamaps.ingest`).

- [ ] **Step 3: Write the tokenizer and parser in `datamaps/ingest/expr.py`**

```python
"""JavaScript expression subset -> Painless.

Cribl `eval` values and function `filter`s are JavaScript expressions.  This
module parses the subset the committed pipelines actually use and emits
Painless for it.  Anything outside the subset raises Untranslatable: the
transpiler never guesses at semantics it cannot reproduce.

The emission rules are listed in the implementation plan and the design
spec (section 3.3); the tests pin the exact strings.
"""
import re

_PUNCT = ("===", "!==", "&&", "||", "==", "!=", "<=", ">=", "=>", "++", "--",
          "?", ":", "(", ")", "[", "]", ".", ",", "!", "<", ">", "+", "-",
          "*", "/", "%", "=", ";", "{", "}")
_IDENT_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
_NUM_RE = re.compile(r"\d+(\.\d+)?([eE][+-]?\d+)?")
_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f",
            "0": "\0", "\\": "\\", "'": "'", '"': '"', "/": "/"}
# A '/' starts a regex literal unless the previous token could end a value.
_VALUE_END = ("num", "str", "ident", "regex")
_VALUE_END_PUNCT = (")", "]")

KNOWN_GLOBALS = ("__e", "true", "false", "null", "undefined", "typeof",
                 "new", "Date", "Math", "Array", "String", "Number",
                 "Boolean", "parseInt", "parseFloat", "JSON", "isNaN",
                 "isFinite")
CALLS = ("parseInt", "parseFloat", "Number", "String", "Boolean",
         "Date.parse", "Math.floor", "Math.round", "Math.abs", "Math.max",
         "Math.min", "Array.isArray")


class Untranslatable(Exception):
    def __init__(self, reason, offset=None):
        self.reason = reason
        self.offset = offset
        Exception.__init__(self, reason if offset is None
                           else "%s (at offset %d)" % (reason, offset))


def tokenize(src):
    toks = []
    i = 0
    n = len(src)
    while i < n:
        ch = src[i]
        if ch.isspace():
            i += 1
            continue
        start = i
        if ch in "'\"":
            quote = ch
            i += 1
            buf = []
            while True:
                if i >= n:
                    raise Untranslatable("unterminated string", start)
                c = src[i]
                if c == "\\":
                    if i + 1 >= n:
                        raise Untranslatable("unterminated string", start)
                    e = src[i + 1]
                    if e == "u" and i + 5 < n:
                        buf.append(chr(int(src[i + 2:i + 6], 16)))
                        i += 6
                        continue
                    buf.append(_ESCAPES.get(e, e))
                    i += 2
                    continue
                if c == quote:
                    i += 1
                    break
                buf.append(c)
                i += 1
            toks.append(("str", "".join(buf), start))
            continue
        m = _NUM_RE.match(src, i)
        if m and ch.isdigit():
            toks.append(("num", m.group(0), start))
            i = m.end()
            continue
        m = _IDENT_RE.match(src, i)
        if m:
            toks.append(("ident", m.group(0), start))
            i = m.end()
            continue
        if ch == "/":
            prev = toks[-1] if toks else None
            is_value_end = prev is not None and (
                prev[0] in _VALUE_END
                or (prev[0] == "punct" and prev[1] in _VALUE_END_PUNCT))
            if not is_value_end:
                i += 1
                buf = []
                in_class = False
                while True:
                    if i >= n:
                        raise Untranslatable("unterminated regex", start)
                    c = src[i]
                    if c == "\\":
                        buf.append(src[i:i + 2])
                        i += 2
                        continue
                    if c == "[":
                        in_class = True
                    elif c == "]":
                        in_class = False
                    elif c == "/" and not in_class:
                        i += 1
                        break
                    buf.append(c)
                    i += 1
                fm = re.compile(r"[a-z]*").match(src, i)
                flags = fm.group(0)
                i = fm.end()
                toks.append(("regex", ("".join(buf), flags), start))
                continue
        for p in _PUNCT:
            if src.startswith(p, i):
                toks.append(("punct", p, start))
                i += len(p)
                break
        else:
            raise Untranslatable("unexpected character %r" % ch, start)
    toks.append(("eof", None, n))
    return toks


class _Parser(object):
    def __init__(self, src):
        self.src = src
        self.toks = tokenize(src)
        self.pos = 0

    def peek(self, k=0):
        return self.toks[min(self.pos + k, len(self.toks) - 1)]

    def at(self, kind, value=None):
        t = self.peek()
        return t[0] == kind and (value is None or t[1] == value)

    def take(self):
        t = self.toks[self.pos]
        self.pos += 1
        return t

    def expect(self, kind, value=None):
        t = self.peek()
        if not self.at(kind, value):
            raise Untranslatable("expected %s but found %r"
                                 % (value or kind, t[1]), t[2])
        return self.take()

    def fail(self, what=None):
        t = self.peek()
        raise Untranslatable(what or "unsupported token %r" % (t[1],), t[2])

    def parse(self):
        node = self.conditional()
        if not self.at("eof"):
            self.fail("unsupported token %r after expression" % (self.peek()[1],))
        return node

    def conditional(self):
        test = self.logical_or()
        if self.at("punct", "?"):
            self.take()
            then = self.conditional()
            self.expect("punct", ":")
            other = self.conditional()
            return ("cond", test, then, other)
        return test

    def _binary(self, ops, below):
        node = below()
        while self.at("punct") and self.peek()[1] in ops:
            op = self.take()[1]
            node = ("binary", op, node, below())
        return node

    def logical_or(self):
        return self._binary(("||",), self.logical_and)

    def logical_and(self):
        return self._binary(("&&",), self.equality)

    def equality(self):
        return self._binary(("===", "!==", "==", "!="), self.relational)

    def relational(self):
        return self._binary(("<", "<=", ">", ">="), self.additive)

    def additive(self):
        return self._binary(("+", "-"), self.multiplicative)

    def multiplicative(self):
        return self._binary(("*", "/", "%"), self.unary)

    def unary(self):
        if self.at("punct") and self.peek()[1] in ("!", "-", "+"):
            op = self.take()[1]
            return ("unary", op, self.unary())
        if self.at("ident", "typeof"):
            self.take()
            return ("typeof", self.unary())
        return self.postfix()

    def args(self):
        self.expect("punct", "(")
        out = []
        if not self.at("punct", ")"):
            out.append(self.conditional())
            while self.at("punct", ","):
                self.take()
                out.append(self.conditional())
        self.expect("punct", ")")
        return out

    def postfix(self):
        node = self.primary()
        while True:
            if self.at("punct", "."):
                self.take()
                name = self.expect("ident")[1]
                if self.at("punct", "("):
                    node = ("method", node, name, self.args())
                elif node[0] == "field":
                    node = ("field", node[1] + [name])
                else:
                    raise Untranslatable("property access .%s is not supported"
                                         % name, self.peek()[2])
            elif self.at("punct", "["):
                if node[0] != "field":
                    self.fail("indexing is only supported on __e")
                self.take()
                key = self.expect("str")[1]
                self.expect("punct", "]")
                node = ("field", node[1] + key.split("."))
            elif self.at("punct") and self.peek()[1] in ("++", "--", "="):
                self.fail("assignment and increment are not expressions "
                          "the transpiler supports")
            else:
                return node

    def primary(self):
        t = self.peek()
        kind, value, offset = t
        if kind == "str":
            self.take()
            return ("str", value)
        if kind == "num":
            self.take()
            return ("num", value)
        if kind == "regex":
            self.take()
            return ("regex", value[0], value[1])
        if kind == "punct" and value == "(":
            self.take()
            node = self.conditional()
            self.expect("punct", ")")
            return node
        if kind == "punct" and value == "[":
            self.take()
            items = []
            if not self.at("punct", "]"):
                items.append(self.conditional())
                while self.at("punct", ","):
                    self.take()
                    items.append(self.conditional())
            self.expect("punct", "]")
            return ("array", items)
        if kind == "ident":
            if value in ("true", "false"):
                self.take()
                return ("bool", value == "true")
            if value == "null":
                self.take()
                return ("null",)
            if value == "undefined":
                self.take()
                return ("undef",)
            if value == "new":
                self.take()
                name = self.expect("ident")[1]
                if name != "Date":
                    raise Untranslatable("new %s is not supported" % name, offset)
                a = self.args()
                if len(a) != 1:
                    raise Untranslatable("new Date() needs exactly one argument", offset)
                return ("newdate", a[0])
            if value == "__e":
                self.take()
                if self.at("punct", "["):
                    self.take()
                    key = self.expect("str")[1]
                    self.expect("punct", "]")
                    return ("field", key.split("."))
                if self.at("punct", "."):
                    self.take()
                    name = self.expect("ident")[1]
                    return ("field", [name])
                raise Untranslatable("__e must be indexed", offset)
            if value in ("Date", "Math", "Array", "JSON"):
                self.take()
                self.expect("punct", ".")
                member = self.expect("ident")[1]
                name = "%s.%s" % (value, member)
                if name not in CALLS:
                    raise Untranslatable("%s is not supported" % name, offset)
                return ("call", name, self.args())
            if value in CALLS:
                self.take()
                return ("call", value, self.args())
            if value in KNOWN_GLOBALS:
                raise Untranslatable("%s is not supported here" % value, offset)
            raise Untranslatable("bare identifier %r (fields must be read as "
                                 "__e['%s'])" % (value, value), offset)
        self.fail()


def parse(src):
    return _Parser(src).parse()
```

- [ ] **Step 4: Run the parser tests**

Run: `python3 -m unittest tests.test_ingest_expr -v`
Expected: all PASS. Check `test_regex_after_operator_or_start`'s second assertion offset (10) against the source string `x.replace(/a/g, 'b')` — `x` is a bare identifier, so that test only tokenizes; tokenizing does not reject identifiers. If the offset differs, count characters and fix the test's number, not the tokenizer.

- [ ] **Step 5: Commit**

```bash
git add datamaps/ingest/__init__.py datamaps/ingest/expr.py tests/test_ingest_expr.py
git commit -m "ingest: tokenizer and parser for the Cribl JavaScript expression subset

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Painless emitter

**Files:**
- Modify: `datamaps/ingest/expr.py` (add the emitter)
- Test: `tests/test_ingest_expr.py` (append emitter tests)

**Interfaces:**
- Produces: `expr.Painless` with attributes `source: str`, `reads: list[str]` (dotted read paths after field mapping, in order, unique), `regex: bool`, `constant: object|None` and `is_constant: bool` (Python value of a literal/array-of-literals; `None` literal has `is_constant=True, constant=None`), `is_field: str|None` (mapped dotted path when the whole expression is one field read); `expr.translate_value(js) -> Painless`; `expr.translate_condition(js) -> Painless`; `expr.map_field(name) -> str` (applies `FIELD_MAP`, raises on `__*`); `expr.read_path(dotted) -> str` (Painless read expression for a mapped dotted path); `expr.write_target(dotted) -> (guards: list[str], target: str)`; `expr.FIELD_MAP = {"_time": "@timestamp", "_raw": "message"}`; `expr.painless_string(text) -> str`.

- [ ] **Step 1: Append the emitter tests**

Append to `tests/test_ingest_expr.py` (before the `if __name__` guard if one exists; otherwise at the end):

```python
from datamaps.ingest.expr import translate_condition, translate_value, read_path, write_target

T = "(%s != null && %s != false && %s != '' && %s != 0)"


def truthy(x):
    return T % (x, x, x, x)


class TestPaths(unittest.TestCase):
    def test_read_paths(self):
        self.assertEqual(read_path("Keywords"), "ctx.Keywords")
        self.assertEqual(read_path("source.ip"), "ctx.source?.ip")
        self.assertEqual(read_path("detail-type"), "ctx['detail-type']")
        self.assertEqual(read_path("_time"), "ctx['@timestamp']")
        self.assertEqual(read_path("_raw"), "ctx.message")
        self.assertEqual(read_path("in"), "ctx['in']")
        self.assertEqual(read_path("a.b-c"), "ctx.a['b-c']")

    def test_write_targets(self):
        self.assertEqual(write_target("event.dataset"),
                         (["if (ctx.event == null) { ctx.event = [:]; }"],
                          "ctx.event.dataset"))
        self.assertEqual(write_target("a.b.c"),
                         (["if (ctx.a == null) { ctx.a = [:]; }",
                           "if (ctx.a.b == null) { ctx.a.b = [:]; }"],
                          "ctx.a.b.c"))
        self.assertEqual(write_target("_time"), ([], "ctx['@timestamp']"))
        self.assertEqual(write_target("x"), ([], "ctx.x"))

    def test_internal_field_is_untranslatable(self):
        with self.assertRaises(Untranslatable):
            translate_value("__e['__inputId']")


class TestEmitValue(unittest.TestCase):
    def v(self, js):
        return translate_value(js).source

    def test_constants(self):
        r = translate_value("'active_directory.account_management'")
        self.assertEqual(r.source, "'active_directory.account_management'")
        self.assertTrue(r.is_constant)
        self.assertEqual(r.constant, "active_directory.account_management")
        r = translate_value("['network','dns','web']")
        self.assertEqual(r.source, "['network', 'dns', 'web']")
        self.assertEqual(r.constant, ["network", "dns", "web"])
        r = translate_value("12")
        self.assertEqual(r.constant, 12)
        r = translate_value("1.5")
        self.assertEqual(r.constant, 1.5)
        r = translate_value("true")
        self.assertIs(r.constant, True)
        r = translate_value("undefined")
        self.assertTrue(r.is_constant)
        self.assertIsNone(r.constant)
        self.assertEqual(r.source, "null")

    def test_string_escaping(self):
        self.assertEqual(self.v(r"'it\'s \\ ok'"), r"'it\'s \\ ok'")

    def test_single_field(self):
        r = translate_value("__e['Keywords']")
        self.assertEqual(r.source, "ctx.Keywords")
        self.assertEqual(r.is_field, "Keywords")
        self.assertEqual(r.reads, ["Keywords"])
        self.assertFalse(r.is_constant)
        r = translate_value("__e['_raw']")
        self.assertEqual(r.is_field, "message")

    def test_ternary_with_parseint(self):
        js = "__e['BadPasswordCount'] !== undefined ? parseInt(__e['BadPasswordCount'], 10) : undefined"
        self.assertEqual(self.v(js),
                         "((ctx.BadPasswordCount != null) ? (long) Double.parseDouble("
                         "String.valueOf(ctx.BadPasswordCount).trim()) : null)")

    def test_nested_ternary_strict_equality(self):
        js = "__e['Level']==='Critical'?2:(__e['Level']==='Error'?3:undefined)"
        self.assertEqual(self.v(js),
                         "((ctx.Level == 'Critical') ? 2 : ((ctx.Level == 'Error') ? 3 : null))")

    def test_truthy_test_and_date(self):
        js = "__e['t'] ? new Date(__e['t']).toISOString() : undefined"
        self.assertEqual(self.v(js),
                         "(%s ? ZonedDateTime.parse(String.valueOf(ctx.t)).toInstant()"
                         ".toString() : null)" % truthy("ctx.t"))

    def test_or_default_then_replace(self):
        js = "(__e['actionType']||'').replace(/^.*\\./,'')"
        r = translate_value(js)
        self.assertEqual(r.source,
                         "(%s ? ctx.actionType : '').replaceFirst(/^.*\\./, m -> '')"
                         % truthy("ctx.actionType"))
        self.assertTrue(r.regex)

    def test_replace_global_and_string_pattern(self):
        self.assertEqual(self.v("__e['s'].replace(/a/g, 'b')"),
                         "ctx.s.replaceAll(/a/, m -> 'b')")
        self.assertEqual(self.v("__e['s'].replace(/a/gi, 'b')"),
                         "ctx.s.replaceAll(/a/i, m -> 'b')")
        self.assertEqual(self.v("__e['s'].replace('a', 'b')"), "ctx.s.replace('a', 'b')")
        with self.assertRaises(Untranslatable):
            self.v("__e['s'].replace(/(a)/, '$1')")

    def test_date_parse_division(self):
        self.assertEqual(self.v("Date.parse(__e['TimeGenerated'])/1000"),
                         "(ZonedDateTime.parse(String.valueOf(ctx.TimeGenerated))"
                         ".toInstant().toEpochMilli() / 1000)")

    def test_casts(self):
        self.assertEqual(self.v("String(__e['externalId'])"), "String.valueOf(ctx.externalId)")
        self.assertEqual(self.v("Number(__e['Severity'])"),
                         "Double.parseDouble(String.valueOf(ctx.Severity).trim())")
        self.assertEqual(self.v("parseFloat(__e['x'])"),
                         "Double.parseDouble(String.valueOf(ctx.x).trim())")
        with self.assertRaises(Untranslatable):
            self.v("parseInt(__e['x'], 16)")

    def test_or_chain(self):
        self.assertEqual(self.v("__e['a'] || __e['b']"),
                         "(%s ? ctx.a : ctx.b)" % truthy("ctx.a"))
        self.assertEqual(self.v("__e['a'] && __e['b']"),
                         "(%s ? ctx.b : ctx.a)" % truthy("ctx.a"))

    def test_comparison_as_value(self):
        self.assertEqual(self.v("__e['signed_flag'] === 'S'"), "(ctx.signed_flag == 'S')")

    def test_loose_equality_with_literals(self):
        self.assertEqual(self.v("__e['EventID']=='512'"),
                         "(String.valueOf(ctx.EventID) == '512')")
        self.assertEqual(self.v("__e['EventID']!=512"),
                         "(String.valueOf(ctx.EventID) != '512')")
        self.assertEqual(self.v("__e['a'] == __e['b']"), "(ctx.a == ctx.b)")
        self.assertEqual(self.v("__e['a'] == null"), "(ctx.a == null)")

    def test_string_concat_and_numeric_plus(self):
        self.assertEqual(self.v("'x-' + __e['a']"), "('x-' + String.valueOf(ctx.a))")
        self.assertEqual(self.v("__e['a'].toLowerCase() + __e['b']"),
                         "(String.valueOf(ctx.a.toLowerCase()) + String.valueOf(ctx.b))")
        self.assertEqual(self.v("Date.parse(__e['t']) + 1"),
                         "(ZonedDateTime.parse(String.valueOf(ctx.t)).toInstant()"
                         ".toEpochMilli() + 1)")
        with self.assertRaises(Untranslatable):
            self.v("__e['a'] + __e['b']")

    def test_methods(self):
        self.assertEqual(self.v("__e['s'].split(',')"), "ctx.s.splitOnToken(',')")
        self.assertEqual(self.v("__e['s'].includes('x')"), "ctx.s.contains('x')")
        self.assertEqual(self.v("__e['s'].substring(0, 4)"), "ctx.s.substring(0, 4)")
        self.assertEqual(self.v("__e['s'].slice(2)"), "ctx.s.substring(2)")
        self.assertEqual(self.v("__e['s'].toString()"), "String.valueOf(ctx.s)")
        with self.assertRaises(Untranslatable):
            self.v("__e['s'].slice(-2)")
        with self.assertRaises(Untranslatable):
            self.v("__e['s'].length")

    def test_math_and_isarray(self):
        self.assertEqual(self.v("Math.floor(__e['n'])"), "Math.floor(ctx.n)")
        self.assertEqual(self.v("Array.isArray(__e['n'])"), "(ctx.n instanceof List)")

    def test_unary(self):
        self.assertEqual(self.v("-__e['n']"), "(-ctx.n)")
        self.assertEqual(self.v("+__e['n']"), "Double.parseDouble(String.valueOf(ctx.n).trim())")

    def test_reads_are_collected(self):
        r = translate_value("__e['a'] === 'x' ? __e['b.c'] : __e['_raw']")
        self.assertEqual(r.reads, ["a", "b.c", "message"])


class TestEmitCondition(unittest.TestCase):
    def c(self, js):
        return translate_condition(js).source

    def test_boolean_combos(self):
        self.assertEqual(self.c("__e['EventID']=='512' || __e['EventID']=='516'"),
                         "((String.valueOf(ctx.EventID) == '512') || "
                         "(String.valueOf(ctx.EventID) == '516'))")
        self.assertEqual(self.c("__e['a'] && !__e['b']"),
                         "(%s && !%s)" % (truthy("ctx.a"), truthy("ctx.b")))

    def test_field_alone_is_truthy(self):
        self.assertEqual(self.c("__e['a']"), truthy("ctx.a"))

    def test_typeof(self):
        self.assertEqual(self.c("typeof __e['_metric'] !== 'undefined'"), "(ctx._metric != null)")
        self.assertEqual(self.c("typeof __e['m'] === 'string'"), "(ctx.m instanceof String)")
        with self.assertRaises(Untranslatable):
            self.c("typeof __e['m'] === 'object'")

    def test_regex_test_and_match(self):
        r = translate_condition("/^\\d+$/.test(__e['a'])")
        self.assertEqual(r.source, "(ctx.a =~ /^\\d+$/)")
        self.assertTrue(r.regex)
        self.assertEqual(self.c("__e['a'].match(/x/i)"), "(ctx.a =~ /x/i)")
        with self.assertRaises(Untranslatable):
            translate_value("__e['a'].match(/x/)")

    def test_comparison_stays_boolean(self):
        self.assertEqual(self.c("__e['ProviderName'] !== 'AD FS'"),
                         "(ctx.ProviderName != 'AD FS')")

    def test_true_literal(self):
        self.assertEqual(self.c("true"), "true")


if __name__ == "__main__":
    unittest.main()
```

Remove any earlier `if __name__ == "__main__":` block so only this final one remains.

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_ingest_expr -v`
Expected: `ImportError: cannot import name 'translate_condition'`.

- [ ] **Step 3: Append the emitter to `datamaps/ingest/expr.py`**

```python
# ---------------------------------------------------------------- emitter

FIELD_MAP = {"_time": "@timestamp", "_raw": "message"}
_PAINLESS_RESERVED = set("""if else while do for in continue break return new
try catch throw this instanceof def void boolean byte short char int long
float double true false null""".split())
_PAINLESS_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_STRING_PRODUCERS = ("toLowerCase", "toUpperCase", "trim", "replace",
                     "substring", "slice", "toISOString", "toString")
_NUMBER_PRODUCERS = ("getTime",)
_BOOL_METHODS = ("startsWith", "endsWith", "includes", "test", "match")
_TYPEOF_CLASSES = {"string": "String", "number": "Number", "boolean": "Boolean"}


class Painless(object):
    def __init__(self, source, reads=None, regex=False, is_constant=False,
                 constant=None, is_field=None):
        self.source = source
        self.reads = list(reads or [])
        self.regex = regex
        self.is_constant = is_constant
        self.constant = constant
        self.is_field = is_field


def painless_string(text):
    return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"


def map_field(name):
    if name in FIELD_MAP:
        return FIELD_MAP[name]
    if name.startswith("__"):
        raise Untranslatable("Cribl internal field %s has no Elasticsearch "
                             "equivalent" % name)
    return name


def _segment(seg):
    if _PAINLESS_IDENT.match(seg) and seg not in _PAINLESS_RESERVED:
        return ".", seg
    return "[", "['%s']" % seg.replace("'", "\\'")


def _segments(dotted):
    return dotted.split(".")


def read_path(dotted):
    """Null-safe Painless read for a mapped dotted path."""
    out = "ctx"
    for i, seg in enumerate(_segments(dotted)):
        kind, text = _segment(seg)
        if kind == ".":
            out += ("." if i == 0 else "?.") + text
        else:
            out += text
    return out


def write_target(dotted):
    """(guards, target) - guards create intermediate maps, target assigns."""
    segs = _segments(dotted)
    guards = []
    path = "ctx"
    for seg in segs[:-1]:
        kind, text = _segment(seg)
        path += text if kind == "[" else "." + text
        guards.append("if (%s == null) { %s = [:]; }" % (path, path))
    kind, text = _segment(segs[-1])
    path += text if kind == "[" else "." + text
    return guards, path


class _Emitter(object):
    def __init__(self):
        self.reads = []
        self.regex = False

    def field(self, segs):
        mapped = map_field(".".join(segs))
        if mapped not in self.reads:
            self.reads.append(mapped)
        return read_path(mapped)

    # -- classification -------------------------------------------------
    def is_bool(self, node):
        k = node[0]
        if k == "bool":
            return True
        if k == "unary" and node[1] == "!":
            return True
        if k == "binary" and node[1] in ("||", "&&", "===", "!==", "==", "!=",
                                         "<", "<=", ">", ">="):
            return True
        if k == "method" and node[2] in _BOOL_METHODS:
            return True
        if k == "call" and node[1] in ("Array.isArray", "Boolean"):
            return True
        return False

    def is_stringy(self, node):
        k = node[0]
        if k == "str":
            return True
        if k == "call" and node[1] == "String":
            return True
        if k == "method" and node[2] in _STRING_PRODUCERS:
            return True
        return False

    def is_numeric(self, node):
        k = node[0]
        if k == "num":
            return True
        if k == "call" and node[1] in ("Date.parse", "parseInt", "parseFloat",
                                       "Number", "Math.floor", "Math.round",
                                       "Math.abs", "Math.max", "Math.min"):
            return True
        if k == "method" and node[2] in _NUMBER_PRODUCERS:
            return True
        if k == "unary" and node[1] in ("-", "+"):
            return True
        if k == "binary" and node[1] in ("-", "*", "/", "%"):
            return True
        return False

    def truthy(self, node):
        x = self.value(node)
        return "(%s != null && %s != false && %s != '' && %s != 0)" % (x, x, x, x)

    # -- condition mode -----------------------------------------------------
    def cond(self, node):
        k = node[0]
        if k == "binary" and node[1] in ("||", "&&"):
            return "(%s %s %s)" % (self.cond(node[2]), node[1], self.cond(node[3]))
        if k == "unary" and node[1] == "!":
            return "!" + self.cond(node[2])
        if k == "method" and node[2] == "match":
            return self.regex_test(node[1], node[3])
        if self.is_bool(node):
            return self.value(node)
        return self.truthy(node)

    def regex_test(self, subject, args):
        if len(args) != 1 or args[0][0] != "regex":
            raise Untranslatable(".match() needs one regex literal")
        return "(%s =~ %s)" % (self.value(subject), self.regex_literal(args[0]))

    def regex_literal(self, node, drop_g=True):
        pattern, flags = node[1], node[2]
        flags = flags.replace("g", "") if drop_g else flags
        bad = [f for f in flags if f not in "ims"]
        if bad:
            raise Untranslatable("regex flag %r has no Painless equivalent" % bad[0])
        self.regex = True
        return "/%s/%s" % (pattern.replace("/", "\\/").replace("\\/", "\\/"), flags)

    # -- value mode -------------------------------------------------------------
    def value(self, node):
        k = node[0]
        if k == "str":
            return painless_string(node[1])
        if k == "num":
            return node[1]
        if k == "bool":
            return "true" if node[1] else "false"
        if k in ("null", "undef"):
            return "null"
        if k == "array":
            return "[%s]" % ", ".join(self.value(n) for n in node[1])
        if k == "regex":
            raise Untranslatable("a regex literal is only supported in "
                                 ".test(), .match() and .replace()")
        if k == "field":
            return self.field(node[1])
        if k == "typeof":
            raise Untranslatable("typeof is only supported compared with "
                                 "'undefined', 'string', 'number' or 'boolean'")
        if k == "unary":
            return self.unary(node)
        if k == "binary":
            return self.binary(node)
        if k == "cond":
            return "(%s ? %s : %s)" % (self.cond(node[1]), self.value(node[2]),
                                       self.value(node[3]))
        if k == "call":
            return self.call(node)
        if k == "newdate":
            raise Untranslatable("new Date(x) is only supported with "
                                 ".toISOString() or .getTime()")
        if k == "method":
            return self.method(node)
        raise Untranslatable("unsupported node %s" % k)

    def unary(self, node):
        op, operand = node[1], node[2]
        if op == "!":
            return "!" + self.cond(operand)
        if op == "-":
            return "(-%s)" % self.value(operand)
        return "Double.parseDouble(String.valueOf(%s).trim())" % self.value(operand)

    def binary(self, node):
        op, left, right = node[1], node[2], node[3]
        if op in ("||", "&&"):
            t = self.truthy(left)
            a, b = self.value(left), self.value(right)
            return "(%s ? %s : %s)" % ((t, a, b) if op == "||" else (t, b, a))
        if op in ("===", "!==", "==", "!="):
            return self.equality(op, left, right)
        if op in ("<", "<=", ">", ">=", "-", "*", "/", "%"):
            return "(%s %s %s)" % (self.value(left), op, self.value(right))
        if op == "+":
            if self.is_stringy(left) or self.is_stringy(right):
                return "(%s + %s)" % (self.stringify(left), self.stringify(right))
            if self.is_numeric(left) or self.is_numeric(right):
                return "(%s + %s)" % (self.value(left), self.value(right))
            raise Untranslatable("ambiguous + (string or numeric): %s"
                                 % " + ".join(x[0] for x in (left, right)))
        raise Untranslatable("operator %s" % op)

    def stringify(self, node):
        if node[0] == "str":
            return self.value(node)
        return "String.valueOf(%s)" % self.value(node)

    def equality(self, op, left, right):
        neg = op in ("!==", "!=")
        sym = "!=" if neg else "=="
        if left[0] == "typeof" or right[0] == "typeof":
            t, lit = (left, right) if left[0] == "typeof" else (right, left)
            if lit[0] != "str":
                raise Untranslatable("typeof must be compared with a string literal")
            subject = self.value(t[1])
            if lit[1] == "undefined":
                return "(%s %s null)" % (subject, sym)
            if lit[1] in _TYPEOF_CLASSES:
                test = "(%s instanceof %s)" % (subject, _TYPEOF_CLASSES[lit[1]])
                return "!" + test if neg else test
            raise Untranslatable("typeof compared with %r" % lit[1])
        if left[0] in ("null", "undef") or right[0] in ("null", "undef"):
            other = right if left[0] in ("null", "undef") else left
            return "(%s %s null)" % (self.value(other), sym)
        if op in ("==", "!=") and (left[0] in ("str", "num")) != (right[0] in ("str", "num")):
            lit, other = (left, right) if left[0] in ("str", "num") else (right, left)
            text = lit[1]
            return "(String.valueOf(%s) %s %s)" % (self.value(other), sym,
                                                    painless_string(text))
        return "(%s %s %s)" % (self.value(left), sym, self.value(right))

    def call(self, node):
        name, args = node[1], node[2]
        if name == "parseInt":
            if len(args) == 2 and args[1] != ("num", "10"):
                raise Untranslatable("parseInt with a radix other than 10")
            if not args:
                raise Untranslatable("parseInt needs an argument")
            return "(long) Double.parseDouble(String.valueOf(%s).trim())" % self.value(args[0])
        if name in ("parseFloat", "Number"):
            self._arity(name, args, 1)
            return "Double.parseDouble(String.valueOf(%s).trim())" % self.value(args[0])
        if name == "String":
            self._arity(name, args, 1)
            return "String.valueOf(%s)" % self.value(args[0])
        if name == "Boolean":
            self._arity(name, args, 1)
            return self.truthy(args[0])
        if name == "Date.parse":
            self._arity(name, args, 1)
            return ("ZonedDateTime.parse(String.valueOf(%s)).toInstant().toEpochMilli()"
                    % self.value(args[0]))
        if name == "Array.isArray":
            self._arity(name, args, 1)
            return "(%s instanceof List)" % self.value(args[0])
        if name.startswith("Math."):
            return "%s(%s)" % (name, ", ".join(self.value(a) for a in args))
        raise Untranslatable("%s is not supported" % name)

    def _arity(self, name, args, n):
        if len(args) != n:
            raise Untranslatable("%s needs %d argument(s)" % (name, n))

    def method(self, node):
        recv, name, args = node[1], node[2], node[3]
        if recv[0] == "newdate":
            inner = "ZonedDateTime.parse(String.valueOf(%s)).toInstant()" % self.value(recv[1])
            if name == "toISOString":
                return inner + ".toString()"
            if name == "getTime":
                return inner + ".toEpochMilli()"
            raise Untranslatable("new Date(x).%s()" % name)
        if recv[0] == "regex":
            if name == "test":
                self._arity(".test", args, 1)
                return "(%s =~ %s)" % (self.value(args[0]), self.regex_literal(recv))
            raise Untranslatable("regex.%s()" % name)
        r = self.value(recv)
        if name in ("toLowerCase", "toUpperCase", "trim"):
            self._arity(name, args, 0)
            return "%s.%s()" % (r, name)
        if name in ("startsWith", "endsWith", "indexOf"):
            self._arity(name, args, 1)
            return "%s.%s(%s)" % (r, name, self.value(args[0]))
        if name == "includes":
            self._arity(name, args, 1)
            return "%s.contains(%s)" % (r, self.value(args[0]))
        if name == "split":
            self._arity(name, args, 1)
            return "%s.splitOnToken(%s)" % (r, self.value(args[0]))
        if name in ("substring", "slice"):
            if not 1 <= len(args) <= 2:
                raise Untranslatable("%s needs one or two arguments" % name)
            for a in args:
                if a[0] == "unary" and a[1] == "-":
                    raise Untranslatable("negative %s index" % name)
            return "%s.substring(%s)" % (r, ", ".join(self.value(a) for a in args))
        if name == "toString":
            self._arity(name, args, 0)
            return "String.valueOf(%s)" % r
        if name == "replace":
            self._arity(name, args, 2)
            pat, repl = args
            if repl[0] != "str":
                raise Untranslatable("replace() needs a string literal replacement")
            if "$" in repl[1]:
                raise Untranslatable("replace() with $-backreferences")
            if pat[0] == "regex":
                fn = "replaceAll" if "g" in pat[2] else "replaceFirst"
                return "%s.%s(%s, m -> %s)" % (r, fn, self.regex_literal(pat),
                                                painless_string(repl[1]))
            if pat[0] == "str":
                return "%s.replace(%s, %s)" % (r, self.value(pat), self.value(repl))
            raise Untranslatable("replace() pattern must be a regex or string literal")
        if name == "match":
            raise Untranslatable(".match() is only supported as a condition")
        raise Untranslatable(".%s() is not supported" % name)


def _constant_of(node):
    """(is_constant, python value) for literal nodes."""
    k = node[0]
    if k == "str":
        return True, node[1]
    if k == "num":
        text = node[1]
        return True, (float(text) if ("." in text or "e" in text.lower()) else int(text))
    if k == "bool":
        return True, node[1]
    if k in ("null", "undef"):
        return True, None
    if k == "array":
        items = []
        for item in node[1]:
            ok, value = _constant_of(item)
            if not ok:
                return False, None
            items.append(value)
        return True, items
    return False, None


def _finish(em, node, source):
    ok, const = _constant_of(node)
    is_field = None
    if node[0] == "field":
        is_field = map_field(".".join(node[1]))
    return Painless(source, reads=em.reads, regex=em.regex, is_constant=ok,
                    constant=const, is_field=is_field)


def translate_value(js):
    node = parse(js)
    em = _Emitter()
    return _finish(em, node, em.value(node))


def translate_condition(js):
    node = parse(js)
    em = _Emitter()
    return _finish(em, node, em.cond(node))
```

Note on `regex_literal`: the pattern text arrives with escapes exactly as written in the JS source (the tokenizer keeps backslash pairs), so `\/` stays `\/` and a bare `/` cannot occur (it would have terminated the literal). The double `.replace` is therefore a no-op kept for clarity; simplify to `pattern` alone if you prefer, and keep the test passing.

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest tests.test_ingest_expr -v`
Expected: all PASS. Work through failures one at a time against the rules at the top of Phase B.

- [ ] **Step 5: Commit**

```bash
git add datamaps/ingest/expr.py tests/test_ingest_expr.py
git commit -m "ingest: Painless emitter for the expression subset

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Function translators — serde, regex_extract, rename, drop, mask, auto_timestamp, numerify, manual

**Files:**
- Create: `datamaps/ingest/functions.py`
- Test: `tests/test_ingest_functions.py`

**Interfaces:**
- Produces: `functions.translate_function(fn, description) -> Result` where `fn` is a Cribl function dict and `description` is the text to put on each processor. `Result` has `processors: list[dict]`, `notes: list[str]`, `manual: dict|None` (a manual-step record `{"function", "reason", "original"}` — for a *partial* eval it carries only the failing rows in `original`), `regex: bool`. `functions.Untranslatable` is re-exported from `expr`. `functions.MANUAL_FUNCTIONS = ("code", "distinct", "unroll", "xml_unroll", "flatten", "rollup_metrics")`. `functions.condition_for(fn) -> Painless|None` translates the function's `filter` (None when `"true"` or absent).
- Consumes: everything in `expr`.

Processor descriptions: every emitted processor carries `"description": description`. Every processor that reads a source field carries `"ignore_missing": True` where the processor type supports it (`json`, `kv`, `csv`, `grok`, `rename`, `remove`, `gsub`, `convert`, `date` does not — use `ignore_failure`).

- [ ] **Step 1: Write the failing tests**

`tests/test_ingest_functions.py`:

```python
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps.ingest import functions as fx
from datamaps.ingest.expr import Untranslatable

D = "why this step exists"


def fn(fid, conf=None, filt="true"):
    return {"id": fid, "filter": filt, "conf": conf or {}, "description": D}


class TestCondition(unittest.TestCase):
    def test_true_is_none(self):
        self.assertIsNone(fx.condition_for(fn("drop")))
        self.assertIsNone(fx.condition_for({"id": "drop", "conf": {}}))

    def test_filter_translates(self):
        c = fx.condition_for(fn("drop", filt="__e['ProviderName'] !== 'AD FS'"))
        self.assertEqual(c.source, "(ctx.ProviderName != 'AD FS')")


class TestSerde(unittest.TestCase):
    def test_json_to_root(self):
        r = fx.translate_function(
            fn("serde", {"mode": "extract", "type": "json", "srcField": "_raw"}), D)
        self.assertEqual(r.processors, [{"json": {
            "field": "message", "add_to_root": True, "ignore_failure": True,
            "description": D}}])
        self.assertIsNone(r.manual)

    def test_json_to_target(self):
        r = fx.translate_function(
            fn("serde", {"mode": "extract", "type": "json", "srcField": "detail",
                         "dstField": "aws"}), D)
        self.assertEqual(r.processors[0]["json"]["target_field"], "aws")
        self.assertNotIn("add_to_root", r.processors[0]["json"])

    def test_kvp_defaults_and_delims(self):
        r = fx.translate_function(
            fn("serde", {"mode": "extract", "type": "kvp", "srcField": "extension"}), D)
        kv = r.processors[0]["kv"]
        self.assertEqual(kv["field"], "extension")
        self.assertEqual(kv["field_split"], "\\s+")
        self.assertEqual(kv["value_split"], "=")
        self.assertTrue(kv["ignore_missing"])
        self.assertTrue(kv["ignore_failure"])
        r = fx.translate_function(
            fn("serde", {"mode": "extract", "type": "kvp", "srcField": "x",
                         "kvDelim": ":", "pairDelim": "|"}), D)
        kv = r.processors[0]["kv"]
        self.assertEqual(kv["value_split"], ":")
        self.assertEqual(kv["field_split"], "\\|")
        self.assertTrue(any("quoted" in n or "space" in n for n in r.notes))

    def test_csv_and_delim(self):
        r = fx.translate_function(
            fn("serde", {"mode": "extract", "type": "csv", "srcField": "_raw",
                         "fields": ["a", "b"]}), D)
        csv = r.processors[0]["csv"]
        self.assertEqual(csv["field"], "message")
        self.assertEqual(csv["target_fields"], ["a", "b"])
        self.assertEqual(csv["separator"], ",")
        self.assertEqual(csv["quote"], '"')
        r = fx.translate_function(
            fn("serde", {"mode": "extract", "type": "delim", "srcField": "_raw",
                         "delimChar": "\t", "fields": ["a"]}), D)
        self.assertEqual(r.processors[0]["csv"]["separator"], "\t")
        with self.assertRaises(Untranslatable):
            fx.translate_function(
                fn("serde", {"mode": "extract", "type": "csv", "srcField": "_raw"}), D)

    def test_other_modes_untranslatable(self):
        with self.assertRaises(Untranslatable):
            fx.translate_function(
                fn("serde", {"mode": "reserialize", "type": "json", "srcField": "_raw"}), D)


class TestRegexExtract(unittest.TestCase):
    def test_single_regex_becomes_grok(self):
        r = fx.translate_function(
            fn("regex_extract", {"regex": "/Activity ID:\\s*(?<ActivityId>\\S+)/",
                                 "source": "Message"}), D)
        self.assertEqual(r.processors, [{"grok": {
            "field": "Message", "patterns": ["Activity ID:\\s*(?<ActivityId>\\S+)"],
            "ignore_missing": True, "ignore_failure": True, "description": D}}])

    def test_flags_and_list_and_iterations(self):
        r = fx.translate_function(
            fn("regex_extract", {"regex": "/rt=(?<rt>\\S+)/i", "source": "_raw",
                                 "regexList": [{"regex": "/duser=(?<duser>\\S+)/"}],
                                 "iterations": 100}), D)
        self.assertEqual(len(r.processors), 2)
        self.assertEqual(r.processors[0]["grok"]["patterns"], ["(?i)rt=(?<rt>\\S+)"])
        self.assertEqual(r.processors[0]["grok"]["field"], "message")
        self.assertEqual(r.processors[1]["grok"]["patterns"], ["duser=(?<duser>\\S+)"])
        self.assertTrue(any("iterations" in n for n in r.notes))

    def test_percent_brace_is_escaped(self):
        r = fx.translate_function(
            fn("regex_extract", {"regex": "/%{(?<a>\\w+)}/", "source": "m"}), D)
        self.assertEqual(r.processors[0]["grok"]["patterns"], ["\\%\\{(?<a>\\w+)}"])

    def test_bare_regex_untranslatable(self):
        with self.assertRaises(Untranslatable):
            fx.translate_function(fn("regex_extract", {"regex": "abc", "source": "m"}), D)


class TestRenameDropMask(unittest.TestCase):
    def test_rename(self):
        r = fx.translate_function(
            fn("rename", {"rename": [{"currentName": "EventID", "newName": "event.code"},
                                     {"currentName": "_time", "newName": "ts"}]}), D)
        self.assertEqual(r.processors, [
            {"rename": {"field": "EventID", "target_field": "event.code",
                        "ignore_missing": True, "ignore_failure": True,
                        "description": D}},
            {"rename": {"field": "@timestamp", "target_field": "ts",
                        "ignore_missing": True, "ignore_failure": True,
                        "description": D}}])

    def test_drop_with_and_without_condition(self):
        r = fx.translate_function(fn("drop", filt="__e['a'] === 'x'"), D)
        self.assertEqual(r.processors, [{"drop": {"if": "(ctx.a == 'x')", "description": D}}])
        r = fx.translate_function(fn("drop"), D)
        self.assertEqual(r.processors, [{"drop": {"description": D}}])

    def test_mask_literal_replacement(self):
        r = fx.translate_function(
            fn("mask", {"rules": [{"matchRegex": "/[\\s\\S]+/",
                                   "replaceExpr": "'suppressed'"}],
                        "fields": ["Message", "_raw"]}), D)
        self.assertEqual(r.processors, [
            {"gsub": {"field": "Message", "pattern": "[\\s\\S]+", "replacement": "suppressed",
                      "ignore_missing": True, "description": D}},
            {"gsub": {"field": "message", "pattern": "[\\s\\S]+", "replacement": "suppressed",
                      "ignore_missing": True, "description": D}}])

    def test_mask_expression_replacement_is_manual(self):
        with self.assertRaises(Untranslatable):
            fx.translate_function(
                fn("mask", {"rules": [{"matchRegex": "/a/",
                                       "replaceExpr": "__e['x']"}],
                            "fields": ["m"]}), D)


class TestTimestampNumerifyManual(unittest.TestCase):
    def test_auto_timestamp(self):
        r = fx.translate_function(
            fn("auto_timestamp", {"srcField": "CreatedDateTime", "dstField": "_time"}), D)
        self.assertEqual(r.processors, [{"date": {
            "field": "CreatedDateTime", "target_field": "@timestamp",
            "formats": ["ISO8601", "UNIX", "UNIX_MS"], "ignore_failure": True,
            "description": D}}])
        self.assertTrue(r.notes)

    def test_numerify_all_fields_is_untranslatable(self):
        with self.assertRaises(Untranslatable):
            fx.translate_function(fn("numerify", {}), D)

    def test_numerify_listed_fields(self):
        r = fx.translate_function(fn("numerify", {"fields": ["a", "b"]}), D)
        self.assertEqual(r.processors[0], {"convert": {
            "field": "a", "type": "auto", "ignore_missing": True,
            "ignore_failure": True, "description": D}})

    def test_manual_functions(self):
        for fid in fx.MANUAL_FUNCTIONS:
            with self.assertRaises(Untranslatable, msg=fid):
                fx.translate_function(fn(fid, {"code": "x"}), D)

    def test_unknown_function(self):
        with self.assertRaises(Untranslatable):
            fx.translate_function(fn("lookup", {}), D)

    def test_filter_applies_to_every_processor(self):
        r = fx.translate_function(
            fn("rename", {"rename": [{"currentName": "a", "newName": "b"}]},
               filt="__e['x'] === 1"), D)
        self.assertEqual(r.processors[0]["rename"]["if"], "(ctx.x == 1)")

    def test_untranslatable_filter_fails_the_step(self):
        with self.assertRaises(Untranslatable):
            fx.translate_function(
                fn("rename", {"rename": [{"currentName": "a", "newName": "b"}]},
                   filt="foo(1)"), D)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_ingest_functions -v`
Expected: `ImportError: cannot import name 'functions'`.

- [ ] **Step 3: Write `datamaps/ingest/functions.py`**

```python
"""One translator per Cribl function id, producing ingest processors.

Each translator returns a Result or raises Untranslatable.  A function's
own `filter` becomes an `if` on every processor it emits; when the filter
cannot be translated the whole step is manual, because running a step
unconditionally that Cribl ran conditionally would be a different
pipeline.
"""
import re

from datamaps.ingest import expr
from datamaps.ingest.expr import Untranslatable, map_field

MANUAL_FUNCTIONS = ("code", "distinct", "unroll", "xml_unroll", "flatten",
                    "rollup_metrics")
DATE_FORMATS = ["ISO8601", "UNIX", "UNIX_MS"]
_REGEX_LITERAL = re.compile(r"^/(.*)/([a-z]*)$", re.S)


class Result(object):
    def __init__(self, processors, notes=None, manual=None, regex=False):
        self.processors = processors
        self.notes = list(notes or [])
        self.manual = manual
        self.regex = regex


def condition_for(fn):
    filt = fn.get("filter", "true")
    if filt in (None, "", "true"):
        return None
    return expr.translate_condition(filt)


def _regex_parts(text, what):
    """(pattern, flags) from a Cribl "/pattern/flags" string."""
    if not isinstance(text, str):
        raise Untranslatable("%s: regex must be a string" % what)
    m = _REGEX_LITERAL.match(text)
    if not m:
        raise Untranslatable("%s: regex %r is not a /pattern/flags literal"
                             % (what, text[:40]))
    return m.group(1), m.group(2)


def _java_regex(pattern, flags):
    """Pattern with JS flags folded into Java inline flags; g is implicit."""
    inline = "".join(f for f in flags if f in "ims")
    bad = [f for f in flags if f not in "gims"]
    if bad:
        raise Untranslatable("regex flag %r has no Java equivalent" % bad[0])
    return ("(?%s)" % inline if inline else "") + pattern


def _grok_pattern(pattern, flags):
    # grok reads %{...} as a pattern reference; a literal one must be escaped.
    return _java_regex(pattern.replace("%{", "\\%\\{"), flags)


def _serde(c, d):
    if c.get("mode") != "extract":
        raise Untranslatable("serde mode %r (only extract is supported)" % c.get("mode"))
    src = map_field(c.get("srcField") or "_raw")
    kind = c.get("type")
    notes = []
    if kind == "json":
        body = {"field": src, "ignore_failure": True, "description": d}
        if c.get("dstField"):
            body["target_field"] = map_field(c["dstField"])
        else:
            body["add_to_root"] = True
        return Result([{"json": body}])
    if kind == "kvp":
        pair = c.get("pairDelim")
        body = {"field": src,
                "field_split": re.escape(pair) if pair else "\\s+",
                "value_split": c.get("kvDelim") or "=",
                "ignore_missing": True, "ignore_failure": True,
                "trim_value": "\"", "strip_brackets": True,
                "description": d}
        if c.get("dstField"):
            body["target_field"] = map_field(c["dstField"])
        notes.append("kv: values containing the pair delimiter (spaces in a "
                     "quoted CEF extension value) split differently from "
                     "Cribl's kvp extractor")
        return Result([{"kv": body}], notes)
    if kind in ("csv", "delim"):
        fields = c.get("fields")
        if not fields:
            raise Untranslatable("serde %s without a fields list" % kind)
        sep = c.get("delimChar") or c.get("delimiter") or ","
        if kind == "csv":
            sep = ","
        if len(sep) != 1:
            raise Untranslatable("csv separator %r must be one character" % sep)
        body = {"field": src, "target_fields": [map_field(f) for f in fields],
                "separator": sep, "quote": "\"", "trim": True,
                "ignore_missing": True, "ignore_failure": True,
                "description": d}
        return Result([{"csv": body}])
    raise Untranslatable("serde type %r" % kind)


def _regex_extract(c, d):
    src = map_field(c.get("source") or "_raw")
    regexes = [c.get("regex")] + [r.get("regex") for r in c.get("regexList") or []]
    procs = []
    notes = []
    for i, text in enumerate(regexes):
        pattern, flags = _regex_parts(text, "regex_extract #%d" % i)
        procs.append({"grok": {"field": src,
                               "patterns": [_grok_pattern(pattern, flags)],
                               "ignore_missing": True, "ignore_failure": True,
                               "description": d}})
    if c.get("iterations") not in (None, 1):
        notes.append("regex_extract: iterations=%s ignored; each named group "
                     "extracts once" % c["iterations"])
    return Result(procs, notes, regex=True)


def _rename(c, d):
    pairs = c.get("rename")
    if not isinstance(pairs, list) or not pairs:
        raise Untranslatable("rename conf has no rename list")
    procs = []
    for pair in pairs:
        if not isinstance(pair, dict) or "currentName" not in pair or "newName" not in pair:
            raise Untranslatable("rename pair %r is malformed" % (pair,))
        if "*" in pair["currentName"] or "*" in pair["newName"]:
            raise Untranslatable("wildcard rename")
        procs.append({"rename": {"field": map_field(pair["currentName"]),
                                 "target_field": map_field(pair["newName"]),
                                 "ignore_missing": True, "ignore_failure": True,
                                 "description": d}})
    return Result(procs)


def _drop(c, d):
    return Result([{"drop": {"description": d}}])


def _mask(c, d):
    fields = c.get("fields") or []
    rules = c.get("rules") or []
    if not fields or not rules:
        raise Untranslatable("mask without fields or rules")
    procs = []
    notes = []
    regex = False
    for rule in rules:
        pattern, flags = _regex_parts(rule.get("matchRegex"), "mask")
        repl = expr.translate_value(rule.get("replaceExpr", ""))
        if not repl.is_constant or not isinstance(repl.constant, str):
            raise Untranslatable("mask replaceExpr is not a string literal")
        if "g" not in flags:
            notes.append("mask: gsub replaces every match; the Cribl rule "
                         "had no g flag and replaced the first only")
        for field in fields:
            procs.append({"gsub": {"field": map_field(field),
                                   "pattern": _java_regex(pattern, flags),
                                   "replacement": repl.constant,
                                   "ignore_missing": True, "description": d}})
        regex = True
    return Result(procs, notes, regex=regex)


def _auto_timestamp(c, d):
    src = map_field(c.get("srcField") or "_raw")
    dst = map_field(c.get("dstField") or "_time")
    return Result([{"date": {"field": src, "target_field": dst,
                             "formats": list(DATE_FORMATS),
                             "ignore_failure": True, "description": d}}],
                  ["auto_timestamp: Cribl auto-detects the format; the date "
                   "processor tries %s" % ", ".join(DATE_FORMATS)])


def _numerify(c, d):
    fields = c.get("fields")
    if not fields:
        raise Untranslatable("numerify over all numeric-looking fields has no "
                             "processor equivalent")
    return Result([{"convert": {"field": map_field(f), "type": "auto",
                                "ignore_missing": True, "ignore_failure": True,
                                "description": d}} for f in fields])


_TRANSLATORS = {"serde": _serde, "regex_extract": _regex_extract,
                "rename": _rename, "drop": _drop, "mask": _mask,
                "auto_timestamp": _auto_timestamp, "numerify": _numerify}


def _apply_condition(result, cond):
    if cond is None:
        return result
    for proc in result.processors:
        body = proc[list(proc)[0]]
        body["if"] = cond.source
    result.regex = result.regex or cond.regex
    return result


def translate_function(fn, description):
    fid = fn.get("id")
    if fid in MANUAL_FUNCTIONS:
        raise Untranslatable("%s has no ingest-processor equivalent" % fid)
    if fid == "eval":
        from datamaps.ingest import evaluate
        return _apply_condition(evaluate.translate_eval(fn.get("conf") or {},
                                                        description),
                                condition_for(fn))
    if fid not in _TRANSLATORS:
        raise Untranslatable("function %r is not supported" % fid)
    cond = condition_for(fn)
    result = _TRANSLATORS[fid](fn.get("conf") or {}, description)
    return _apply_condition(result, cond)
```

The `eval` branch imports `datamaps.ingest.evaluate`, which Task 8 creates; until then `eval` raises `ImportError`, and no test in this task exercises it.

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest tests.test_ingest_functions -v`
Expected: all PASS. In `test_percent_brace_is_escaped` the expected pattern is `\%\{(?<a>\w+)}` — Python source `"\\%\\{(?<a>\\w+)}"`.

- [ ] **Step 5: Commit**

```bash
git add datamaps/ingest/functions.py tests/test_ingest_functions.py
git commit -m "ingest: translators for serde, regex_extract, rename, drop, mask, auto_timestamp, numerify

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The eval translator (set / copy_from / script, partial steps)

**Files:**
- Create: `datamaps/ingest/evaluate.py`
- Test: `tests/test_ingest_evaluate.py`

**Interfaces:**
- Produces: `evaluate.translate_eval(conf, description) -> functions.Result`. Rows in `conf["add"]` become `set` (constant), `set` with `copy_from` (single field), or lines in one `script` processor. `conf["remove"]` becomes one `remove` processor. Rows that cannot translate are collected and returned as `Result.manual = {"function": "eval", "reason": "...", "original": {"add": [failing rows]}}` while the good rows still emit (a *partial* step). A row whose value is the constant `null`/`undefined` emits nothing and adds a note. A wildcard in `remove` makes the whole step untranslatable (raise).
- Consumes: `expr.translate_value`, `expr.write_target`, `expr.map_field`, `functions.Result`.

Script text for expression rows, one block per row, joined with `"\n"`:

```
try { def v = <EXPR>; if (v != null) { <GUARD>; <GUARD>; <TARGET> = v; } } catch (Exception e) { }
```
(guards are separated by a single space; when there are none the block is `try { def v = <EXPR>; if (v != null) { <TARGET> = v; } } catch (Exception e) { }`).

- [ ] **Step 1: Write the failing tests**

`tests/test_ingest_evaluate.py`:

```python
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps.ingest import evaluate
from datamaps.ingest.expr import Untranslatable

D = "d"


class TestEval(unittest.TestCase):
    def test_constant_row_is_set(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "event.dataset", "value": "'ad.account'"}]}, D)
        self.assertEqual(r.processors, [{"set": {
            "field": "event.dataset", "value": "ad.account", "description": D}}])
        self.assertIsNone(r.manual)

    def test_array_and_number_constants(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "event.category", "value": "['network','dns']"},
                     {"name": "event.severity", "value": "3"}]}, D)
        self.assertEqual(r.processors[0]["set"]["value"], ["network", "dns"])
        self.assertEqual(r.processors[1]["set"]["value"], 3)

    def test_field_copy(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "host.name", "value": "__e['Computer']"},
                     {"name": "message", "value": "__e['_raw']"}]}, D)
        self.assertEqual(r.processors, [
            {"set": {"field": "host.name", "copy_from": "Computer",
                     "ignore_empty_value": True, "description": D}},
            {"set": {"field": "message", "copy_from": "message",
                     "ignore_empty_value": True, "description": D}}])

    def test_expression_rows_share_one_script(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "adfs.n", "value": "parseInt(__e['n'], 10)"},
                     {"name": "x", "value": "__e['a'] || __e['b']"}]}, D)
        self.assertEqual(len(r.processors), 1)
        script = r.processors[0]["script"]
        self.assertEqual(script["lang"], "painless")
        self.assertEqual(script["description"], D)
        lines = script["source"].split("\n")
        self.assertEqual(lines[0],
                         "try { def v = (long) Double.parseDouble(String.valueOf(ctx.n).trim()); "
                         "if (v != null) { if (ctx.adfs == null) { ctx.adfs = [:]; } "
                         "ctx.adfs.n = v; } } catch (Exception e) { }")
        self.assertTrue(lines[1].startswith("try { def v = ((ctx.a != null"))
        self.assertTrue(lines[1].endswith("ctx.x = v; } } catch (Exception e) { }"))

    def test_order_is_preserved_across_kinds(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "a", "value": "'1'"},
                     {"name": "b", "value": "__e['a'] === '1' ? 2 : 3"},
                     {"name": "c", "value": "'3'"}]}, D)
        kinds = [list(p)[0] for p in r.processors]
        self.assertEqual(kinds, ["set", "script", "set"])

    def test_null_constant_is_a_noop_with_note(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "unmapped", "value": "undefined"}]}, D)
        self.assertEqual(r.processors, [])
        self.assertTrue(any("unmapped" in n for n in r.notes))

    def test_remove(self):
        r = evaluate.translate_eval({"remove": ["a", "b.c", "_raw"]}, D)
        self.assertEqual(r.processors, [{"remove": {
            "field": ["a", "b.c", "message"], "ignore_missing": True,
            "description": D}}])

    def test_wildcard_remove_is_untranslatable(self):
        with self.assertRaises(Untranslatable):
            evaluate.translate_eval({"remove": ["tmp_*"]}, D)

    def test_keep_is_untranslatable(self):
        with self.assertRaises(Untranslatable):
            evaluate.translate_eval({"keep": ["a"]}, D)

    def test_partial_step_keeps_good_rows(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "ok", "value": "'x'"},
                     {"name": "bad", "value": "JSON.parse(__e['j'])"},
                     {"name": "also_bad", "value": "__e['a'] + __e['b']"}]}, D)
        self.assertEqual(len(r.processors), 1)
        self.assertEqual(r.manual["function"], "eval")
        self.assertEqual([row["name"] for row in r.manual["original"]["add"]],
                         ["bad", "also_bad"])
        self.assertIn("JSON.parse", r.manual["reason"])

    def test_all_rows_failing_raises(self):
        with self.assertRaises(Untranslatable):
            evaluate.translate_eval({"add": [{"name": "b", "value": "foo"}]}, D)

    def test_internal_target_is_skipped_with_note(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "__tmp", "value": "'x'"},
                     {"name": "ok", "value": "'y'"}]}, D)
        self.assertEqual(len(r.processors), 1)
        self.assertTrue(any("__tmp" in n for n in r.notes))

    def test_regex_flag_propagates(self):
        r = evaluate.translate_eval(
            {"add": [{"name": "a", "value": "__e['s'].replace(/x/g, '')"}]}, D)
        self.assertTrue(r.regex)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_ingest_evaluate -v`
Expected: `ImportError: cannot import name 'evaluate'`.

- [ ] **Step 3: Write `datamaps/ingest/evaluate.py`**

```python
"""Cribl `eval` -> set / copy_from / script / remove.

A constant becomes `set`, a single field read becomes `set` with
`copy_from`, and every other row becomes one try/catch block in a single
`script` processor.  The try/catch is what gives Cribl's per-row
semantics: an expression that throws leaves its field unset and the event
continues.  Rows that cannot be translated are returned as a manual step
alongside the rows that could, so a partially translatable eval still
emits everything it can.
"""
from datamaps.ingest import expr
from datamaps.ingest.expr import Untranslatable, map_field
from datamaps.ingest.functions import Result

_ROW = "try { def v = %s; if (v != null) { %s%s = v; } } catch (Exception e) { }"


def _row_script(value, target_name):
    guards, target = expr.write_target(target_name)
    prefix = "".join(g + " " for g in guards)
    return _ROW % (value, prefix, target)


def translate_eval(conf, description):
    if conf.get("keep"):
        raise Untranslatable("eval keep has no processor equivalent")
    procs = []
    notes = []
    failing = []
    reasons = []
    regex = False
    pending_script = []

    def flush_script():
        if pending_script:
            procs.append({"script": {"lang": "painless",
                                     "source": "\n".join(pending_script),
                                     "description": description}})
            del pending_script[:]

    for row in conf.get("add") or []:
        name = str(row.get("name", ""))
        value = str(row.get("value", ""))
        if name.startswith("__"):
            notes.append("eval: %s is a Cribl internal field; row skipped" % name)
            continue
        try:
            target = map_field(name)
            result = expr.translate_value(value)
        except Untranslatable as exc:
            failing.append(row)
            reasons.append("%s: %s" % (name, exc.reason))
            continue
        regex = regex or result.regex
        if result.is_constant:
            if result.constant is None:
                notes.append("eval: %s is set to undefined/null; no processor "
                             "emitted" % name)
                continue
            flush_script()
            procs.append({"set": {"field": target, "value": result.constant,
                                  "description": description}})
        elif result.is_field:
            flush_script()
            procs.append({"set": {"field": target, "copy_from": result.is_field,
                                  "ignore_empty_value": True,
                                  "description": description}})
        else:
            pending_script.append(_row_script(result.source, target))
    flush_script()

    remove = conf.get("remove") or []
    if remove:
        if any("*" in str(f) for f in remove):
            raise Untranslatable("eval remove with a wildcard")
        procs.append({"remove": {"field": [map_field(str(f)) for f in remove],
                                 "ignore_missing": True,
                                 "description": description}})

    manual = None
    if failing:
        if not procs:
            raise Untranslatable("; ".join(reasons))
        manual = {"function": "eval", "reason": "; ".join(reasons),
                  "original": {"add": failing}}
    return Result(procs, notes, manual=manual, regex=regex)
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest tests.test_ingest_evaluate tests.test_ingest_functions -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add datamaps/ingest/evaluate.py tests/test_ingest_evaluate.py
git commit -m "ingest: eval translator with set, copy_from, per-row try/catch scripts and partial steps

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Pipeline envelope and whole-corpus translation

**Files:**
- Create: `datamaps/ingest/pipeline.py`
- Test: `tests/test_ingest_pipeline.py`

**Interfaces:**
- Produces: `pipeline.translate_pipeline(cribl) -> dict` (the envelope in spec §3.5, with `coverage` keys `translated partial manual total`, plus `notes`, `manual_steps`, `field_map`, `requires`); `pipeline.translate_all(pipelines) -> OrderedDict[key -> envelope]`; `pipeline.summarize(envelopes) -> dict` with `translated partial manual total` summed.
- Consumes: `functions.translate_function`, `functions.MANUAL_FUNCTIONS`, `expr.FIELD_MAP`, `pipelines.load_pipelines`.

Manual-step record: `{"index": i, "function": fid, "reason": str, "description": fn.get("description", ""), "original": fn}` where `index` is the position among non-comment functions (0-based). For a partial eval, `original` is `Result.manual["original"]` merged over the function (`{"id": "eval", "filter": ..., "conf": {"add": [failing rows]}, "description": ...}`) and the record has `"partial": True`.

Processor description: `fn["description"]` if present; when one or more `comment` functions directly precede the function, their `conf.comment` texts are prepended, joined with `" | "`, then `" — "` and the function's description. Whitespace runs collapse to one space.

Envelope `pipeline.description`: `"<cribl conf.description> (translated from Cribl by data-maps: T of N steps translated, P partial, M manual)"`.

- [ ] **Step 1: Write the failing tests**

`tests/test_ingest_pipeline.py`:

```python
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import pipelines
from datamaps.ingest import pipeline as ip

DATA = os.path.join(ROOT, "data")


def cribl(*functions, **kw):
    return {"id": kw.get("id", "dm_t_d_f"),
            "conf": {"output": "default", "description": kw.get("desc", "T d f"),
                     "functions": list(functions)}}


COMMENT = {"id": "comment", "filter": "true", "conf": {"comment": "why  we\nparse"},
           "description": "record why"}
DATASET = {"id": "eval", "filter": "true",
           "conf": {"add": [{"name": "event.dataset", "value": "'t.d'"}]},
           "description": "tag the dataset"}
CODE = {"id": "code", "filter": "true", "conf": {"code": "__e['x']=1"},
        "description": "hand-written"}
PARTIAL = {"id": "eval", "filter": "true",
           "conf": {"add": [{"name": "a", "value": "'1'"},
                            {"name": "b", "value": "JSON.parse(__e['j'])"}]},
           "description": "mixed"}
REGEX = {"id": "regex_extract", "filter": "true",
         "conf": {"regex": "/(?<a>\\d+)/", "source": "_raw"}, "description": "grab"}


class TestEnvelope(unittest.TestCase):
    def test_shape_and_coverage(self):
        env = ip.translate_pipeline(cribl(COMMENT, DATASET, CODE, PARTIAL, REGEX))
        self.assertEqual(env["id"], "dm_t_d_f")
        self.assertEqual(env["coverage"], {"translated": 2, "partial": 1,
                                           "manual": 1, "total": 4})
        self.assertEqual(env["field_map"], {"_time": "@timestamp", "_raw": "message"})
        self.assertEqual(env["requires"], ["painless-regex"])
        self.assertEqual(
            env["pipeline"]["description"],
            "T d f (translated from Cribl by data-maps: 2 of 4 steps translated, "
            "1 partial, 1 manual)")
        kinds = [list(p)[0] for p in env["pipeline"]["processors"]]
        self.assertEqual(kinds, ["set", "set", "grok"])

    def test_comment_folds_into_next_description(self):
        env = ip.translate_pipeline(cribl(COMMENT, DATASET))
        self.assertEqual(env["pipeline"]["processors"][0]["set"]["description"],
                         "why we parse — tag the dataset")

    def test_manual_steps(self):
        env = ip.translate_pipeline(cribl(DATASET, CODE, PARTIAL))
        steps = env["manual_steps"]
        self.assertEqual([s["index"] for s in steps], [1, 2])
        self.assertEqual(steps[0]["function"], "code")
        self.assertEqual(steps[0]["original"], CODE)
        self.assertIn("no ingest-processor equivalent", steps[0]["reason"])
        self.assertTrue(steps[1]["partial"])
        self.assertEqual(steps[1]["original"]["conf"]["add"],
                         [{"name": "b", "value": "JSON.parse(__e['j'])"}])

    def test_no_regex_no_requires(self):
        env = ip.translate_pipeline(cribl(DATASET))
        self.assertEqual(env["requires"], [])
        self.assertEqual(env["coverage"], {"translated": 1, "partial": 0,
                                           "manual": 0, "total": 1})

    def test_notes_collected(self):
        ts = {"id": "auto_timestamp", "filter": "true",
              "conf": {"srcField": "t", "dstField": "_time"}, "description": "time"}
        env = ip.translate_pipeline(cribl(DATASET, ts))
        self.assertTrue(any(n.startswith("auto_timestamp #1:") for n in env["notes"]))


class TestCorpus(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.loaded = pipelines.load_pipelines(DATA)
        cls.envelopes = ip.translate_all(cls.loaded)

    def test_every_pipeline_translates(self):
        self.assertEqual(len(self.envelopes), len(self.loaded))
        known = {"set", "script", "remove", "json", "kv", "csv", "grok", "rename",
                 "drop", "gsub", "date", "convert"}
        for key, env in self.envelopes.items():
            for proc in env["pipeline"]["processors"]:
                self.assertEqual(len(proc), 1, key)
                self.assertIn(list(proc)[0], known, key)
            cov = env["coverage"]
            self.assertEqual(cov["translated"] + cov["partial"] + cov["manual"],
                             cov["total"], key)

    def test_coverage_floor(self):
        total = ip.summarize(self.envelopes)
        usable = total["translated"] + total["partial"]
        print("\ncorpus coverage:", total)
        # Set once from the first green run of this suite; a drop means the
        # supported subset regressed.
        self.assertGreaterEqual(usable, FLOOR)


FLOOR = 0


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_ingest_pipeline -v`
Expected: `ImportError: cannot import name 'pipeline'`.

- [ ] **Step 3: Write `datamaps/ingest/pipeline.py`**

```python
"""Cribl pipeline -> Elasticsearch ingest pipeline envelope."""
import copy
import re
from collections import OrderedDict

from datamaps.ingest import expr, functions
from datamaps.ingest.expr import Untranslatable

_WS = re.compile(r"\s+")


def _clean(text):
    return _WS.sub(" ", str(text or "")).strip()


def _description(comments, fn):
    own = _clean(fn.get("description"))
    if comments:
        lead = " | ".join(_clean(c) for c in comments if _clean(c))
        return "%s — %s" % (lead, own) if own else lead
    return own


def translate_pipeline(cribl):
    conf = cribl.get("conf") or {}
    processors = []
    manual_steps = []
    notes = []
    counts = {"translated": 0, "partial": 0, "manual": 0, "total": 0}
    regex = False
    pending_comments = []
    index = 0
    for fn in conf.get("functions") or []:
        fid = fn.get("id")
        if fid == "comment":
            pending_comments.append((fn.get("conf") or {}).get("comment", ""))
            continue
        description = _description(pending_comments, fn)
        pending_comments = []
        counts["total"] += 1
        try:
            result = functions.translate_function(fn, description)
        except Untranslatable as exc:
            counts["manual"] += 1
            manual_steps.append({"index": index, "function": fid,
                                 "reason": exc.reason,
                                 "description": _clean(fn.get("description")),
                                 "original": fn})
            index += 1
            continue
        processors.extend(result.processors)
        regex = regex or result.regex
        for note in result.notes:
            notes.append("%s #%d: %s" % (fid, index, note.split(": ", 1)[-1]))
        if result.manual:
            counts["partial"] += 1
            original = copy.deepcopy(fn)
            original["conf"] = result.manual["original"]
            manual_steps.append({"index": index, "function": fid,
                                 "reason": result.manual["reason"],
                                 "description": _clean(fn.get("description")),
                                 "original": original, "partial": True})
        else:
            counts["translated"] += 1
        index += 1
    summary = ("%s (translated from Cribl by data-maps: %d of %d steps "
               "translated, %d partial, %d manual)"
               % (_clean(conf.get("description")), counts["translated"],
                  counts["total"], counts["partial"], counts["manual"]))
    return OrderedDict([
        ("id", cribl.get("id")),
        ("pipeline", OrderedDict([("description", summary),
                                  ("processors", processors)])),
        ("coverage", OrderedDict([(k, counts[k]) for k in
                                  ("translated", "partial", "manual", "total")])),
        ("notes", notes),
        ("manual_steps", manual_steps),
        ("field_map", OrderedDict(sorted(expr.FIELD_MAP.items(), reverse=True))),
        ("requires", ["painless-regex"] if regex else []),
    ])


def translate_all(pipelines):
    out = OrderedDict()
    for key in sorted(pipelines):
        out[key] = translate_pipeline(pipelines[key])
    return out


def summarize(envelopes):
    total = {"translated": 0, "partial": 0, "manual": 0, "total": 0}
    for env in envelopes.values():
        for k in total:
            total[k] += env["coverage"][k]
    return total
```

Check `field_map` ordering against the test: the test compares with a plain dict, so key order does not matter for equality; `OrderedDict(sorted(..., reverse=True))` yields `_time` then `_raw`, which is also the order the spec shows.

- [ ] **Step 4: Run, then set the floor**

Run: `python3 -m unittest tests.test_ingest_pipeline -v`
Expected: PASS, with a printed line like `corpus coverage: {'translated': N, 'partial': P, 'manual': M, 'total': T}`. Set `FLOOR` in the test to the printed `translated + partial`. Re-run; PASS.

Also run `python3 -m unittest discover -s tests` — the whole suite must be green.

- [ ] **Step 5: Commit**

```bash
git add datamaps/ingest/pipeline.py tests/test_ingest_pipeline.py
git commit -m "ingest: pipeline envelope with coverage, notes and manual steps; whole-corpus test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase C — build outputs

### Task 10: One renderer for the format block; HTML fragment export

**Files:**
- Create: `templates/_format_block.html.j2` (extracted from `tech.html.j2`)
- Modify: `templates/tech.html.j2`
- Modify: `datamaps/render.py` (add `fragment_html`)
- Test: `tests/test_render.py` (append)

**Interfaces:**
- Produces: `render.fragment_html(env, ds_view, fmt_view, asset_prefix) -> str` rendering `_format_block.html.j2` with `{"ds": ds_view, "fv": fmt_view, "asset_prefix": asset_prefix}`.
- The partial uses only `ds`, `fv` and `asset_prefix` from context.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_render.py` (inside the module, using its existing helpers `build_site`, `read`, `row`, `catalog`, `ECS`, `PROFILES` and the `model`/`render` imports):

```python
class TestFragment(unittest.TestCase):
    def test_fragment_is_a_substring_of_the_technology_page(self):
        techs = {"paloalto-ngfw": {
            "id": "paloalto-ngfw", "name": "Palo Alto NGFW", "vendor": "PAN",
            "datasets": [{
                "id": "traffic", "name": "Traffic", "description": "flows",
                "event_categories": ["network"],
                "route": {"direct": [{"hop": "cribl", "location": "core"},
                                     {"hop": "elastic", "data_stream": "logs-panw"}]},
                "formats": [{
                    "format": "syslog-csv",
                    "parsing": {"mechanism": "cribl-pipeline",
                                "artifact": "dm_paloalto_ngfw_traffic_syslog_csv",
                                "notes": "positional CSV"},
                    "recommendations": {"direct": {"parse_location": "high",
                                                   "cribl": "split the CSV",
                                                   "elastic": "index as-is"}},
                    "fields": [{"vendor": "src", "type": "ip",
                                "description": "source", "ecs": "source.ip",
                                "status": "mapped"},
                               {"vendor": "odd <field>", "type": "keyword",
                                "description": "x & y", "ecs": None,
                                "custom": "panw.odd", "status": "unmapped"}]}]}]}}
        m = model.build_model(catalog(), techs, copy.deepcopy(PROFILES), ECS)
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out, True)
        render.render_site(m, ROOT, out)
        page = read(out, "tech", "paloalto-ngfw.html")
        env = render.build_env(ROOT)
        view = m["technologies"][0]
        frag = render.fragment_html(env, view["datasets"][0],
                                    view["datasets"][0]["formats"][0], "../")
        self.assertIn("odd &lt;field&gt;", frag)
        self.assertIn("x &amp; y", frag)
        self.assertIn(frag.strip(), page)
```

Check the test's synthetic technology against `datamaps/schema.py` requirements only if `build_model` raises a KeyError; the model layer reads `route`, `formats[].parsing.mechanism`, `fields[].status`, `event_categories` — all present above.

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_render.TestFragment -v`
Expected: `AttributeError: module 'datamaps.render' has no attribute 'fragment_html'`.

- [ ] **Step 3: Extract the partial**

In `templates/tech.html.j2`, the loop `{% for fv in ds.formats %}` opens a `<div class="format-variant…" data-format="…">` and closes it with `</div>` just before `{% endfor %}`. Cut everything *between* the opening `<div …>` line and the closing `</div>` line — from `{% if fv.data.enable %}` through the `{% endif %}` that closes the `fields_omitted` branch — and paste it verbatim into `templates/_format_block.html.j2`. In `tech.html.j2` replace the cut region with:

```
{% include "_format_block.html.j2" %}
```

so the loop body reads:

```
{% for fv in ds.formats %}
<div class="format-variant{% if fv.recommended %} active{% endif %}" data-format="{{ fv.data.format }}">
{% include "_format_block.html.j2" %}
</div>
{% endfor %}
```

The partial references `ds.coverage_favours`, `ds.switch_gain`, `ds.data.route.guarded`, `fv.*` — all from the including context, unchanged.

- [ ] **Step 4: Add `fragment_html` to `datamaps/render.py`**

```python
def fragment_html(env, ds_view, fmt_view, asset_prefix):
    """The one format block, rendered by the same partial the page uses."""
    template = env.get_template("_format_block.html.j2")
    return template.render(ds=ds_view, fv=fmt_view, asset_prefix=asset_prefix)
```

- [ ] **Step 5: Run**

Run: `python3 -m unittest tests.test_render -v`
Expected: PASS, including every pre-existing render test (they read the technology page and must see identical markup).

Run the whole suite: `python3 -m unittest discover -s tests` → `OK`.

- [ ] **Step 6: Commit**

```bash
git add templates/_format_block.html.j2 templates/tech.html.j2 datamaps/render.py tests/test_render.py
git commit -m "render: one partial for the format block, reusable as an HTML fragment

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Markdown and CSV renderers for one block

**Files:**
- Create: `datamaps/export_text.py`
- Test: `tests/test_export_text.py`
- Modify: `tests/test_studio_parity.py` (CSV column parity)

**Interfaces:**
- Produces: `export_text.CSV_COLUMNS` (list, must equal Studio's), `export_text.block_csv(tech_view, ds_view, fmt_view) -> str` (CRLF-terminated RFC 4180), `export_text.block_markdown(tech_view, ds_view, fmt_view) -> str`.

- [ ] **Step 1: Write the failing tests**

`tests/test_export_text.py`:

```python
import copy
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import export_text, model

ECS = {"ecs_version": "8.11.0", "fields": {"source.ip": {"type": "ip", "short": "s"}}}
PROFILES = {"profiles": {"network": {"required": ["source.ip"]}}}
ROW = {"id": "t", "name": "Tech", "vendor": "V", "category": "network-security",
       "status": "in-progress", "priority": "core"}
TECH = {"id": "t", "name": "Tech", "vendor": "V", "datasets": [{
    "id": "d", "name": "Data", "description": "what it is",
    "event_categories": ["network"],
    "route": {"direct": [{"hop": "cribl", "location": "core"},
                         {"hop": "elastic", "data_stream": "logs-t"}]},
    "formats": [{
        "format": "json",
        "parsing": {"mechanism": "cribl-pipeline", "artifact": "dm_t_d_json",
                    "notes": "parse it"},
        "recommendations": {"direct": {"parse_location": "high",
                                       "cribl": "do x", "elastic": "do y"}},
        "fields": [
            {"vendor": "src", "type": "ip", "description": "source, \"quoted\"",
             "ecs": "source.ip", "status": "mapped"},
            {"vendor": "note", "type": "text", "description": "multi\nline",
             "ecs": None, "custom": "t.note", "status": "unmapped",
             "transform": "trim", "notes": "n"}]}]}]}


def views():
    m = model.build_model({"technologies": [ROW]}, {"t": TECH},
                          copy.deepcopy(PROFILES), ECS)
    tv = m["technologies"][0]
    return tv, tv["datasets"][0], tv["datasets"][0]["formats"][0]


class TestCsv(unittest.TestCase):
    def test_header_and_rows(self):
        text = export_text.block_csv(*views())
        lines = text.split("\r\n")
        self.assertEqual(lines[0], ",".join(export_text.CSV_COLUMNS))
        self.assertEqual(lines[1],
                         't,d,json,1,src,ip,"source, ""quoted""",source.ip,mapped,,,')
        self.assertTrue(lines[2].startswith('t,d,json,2,note,text,"multi\nline",,unmapped,t.note,trim,n'))
        self.assertEqual(text[-2:], "\r\n")

    def test_columns_are_studios(self):
        self.assertEqual(export_text.CSV_COLUMNS,
                         ["technology", "dataset", "format", "#", "vendor", "type",
                          "description", "ecs", "status", "custom", "transform", "notes"])


class TestMarkdown(unittest.TestCase):
    def test_sections(self):
        md = export_text.block_markdown(*views())
        self.assertTrue(md.startswith("# Tech — d — json\n"))
        for heading in ("## Route", "## Parsing", "## Recommendations", "## Fields"):
            self.assertIn(heading, md)
        self.assertIn("`cribl-pipeline`", md)
        self.assertIn("**Cribl:** do x", md)
        self.assertIn("| `src` | ip | source, \"quoted\" | `source.ip` |  |  | mapped | ● |", md)
        self.assertIn("| `note` | text | multi line |  | `t.note` | trim n | unmapped |  |", md)
        self.assertIn("cribl: core → elastic: logs-t", md)

    def test_pipes_in_cells_are_escaped(self):
        tv, dv, fv = views()
        fv["fields"][0]["field"]["description"] = "a | b"
        md = export_text.block_markdown(tv, dv, fv)
        self.assertIn("a \\| b", md)


if __name__ == "__main__":
    unittest.main()
```

Append to `tests/test_studio_parity.py` (a new class; it needs no Node):

```python
class TestCsvColumnParity(unittest.TestCase):
    def test_python_csv_columns_equal_studios(self):
        from datamaps import export_text
        import re
        with open(os.path.join(ROOT, "studio", "lib", "export.js"),
                  encoding="utf-8") as fh:
            js = fh.read()
        block = re.search(r"export const CSV_COLUMNS = \[(.*?)\];", js, re.S).group(1)
        columns = re.findall(r'"([^"]+)"', block)
        self.assertEqual(columns, export_text.CSV_COLUMNS)
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_export_text -v`
Expected: `ImportError: cannot import name 'export_text'`.

- [ ] **Step 3: Write `datamaps/export_text.py`**

```python
"""Markdown and CSV renderings of one (dataset, format) block.

The CSV mirrors Studio's export (studio/lib/export.js): same columns in the
same order, CRLF records, quotes only where RFC 4180 needs them, so a file
from either source opens identically.  tests/test_studio_parity.py holds
the two column lists together.
"""
import csv
import io

CSV_COLUMNS = ["technology", "dataset", "format", "#",
               "vendor", "type", "description", "ecs", "status",
               "custom", "transform", "notes"]
_FIELD_KEYS = ["vendor", "type", "description", "ecs", "status",
               "custom", "transform", "notes"]


def _text(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def block_csv(tech_view, ds_view, fmt_view):
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(CSV_COLUMNS)
    tech_id = tech_view["entry"]["id"]
    ds_id = ds_view["data"]["id"]
    fmt = fmt_view["data"]["format"]
    for at, fw in enumerate(fmt_view["fields"], 1):
        field = fw["field"]
        writer.writerow([tech_id, ds_id, fmt, str(at)]
                        + [_text(field.get(k)) for k in _FIELD_KEYS])
    return buf.getvalue()


def _cell(value):
    return " ".join(_text(value).split()).replace("|", "\\|")


def _code(value):
    text = _text(value)
    return "`%s`" % text if text else ""


def _hop(hop):
    parts = [hop.get("hop", "")]
    for key in ("location", "device", "name", "data_stream"):
        if hop.get(key):
            parts.append(hop[key])
    return ": ".join(parts)


def block_markdown(tech_view, ds_view, fmt_view):
    entry = tech_view["entry"]
    ds = ds_view["data"]
    fmt = fmt_view["data"]
    parsing = fmt.get("parsing") or {}
    out = []
    out.append("# %s — %s — %s" % (entry["name"], ds["id"], fmt["format"]))
    out.append("")
    out.append("**Technology:** %s (%s) · **Dataset:** %s · **Format:** `%s` · "
               "**Parsing:** `%s`"
               % (entry["name"], entry.get("vendor", ""), ds.get("name", ds["id"]),
                  fmt["format"], parsing.get("mechanism", "")))
    if ds.get("description"):
        out.append("")
        out.append(" ".join(_text(ds["description"]).split()))
    route = ds.get("route") or {}
    for side in ("direct", "guarded"):
        hops = route.get(side)
        if hops:
            out.append("")
            out.append("## Route (%s)" % side)
            out.append("")
            out.append(" → ".join(_hop(h) for h in hops))
    out.append("")
    out.append("## Parsing")
    out.append("")
    line = "`%s`" % parsing.get("mechanism", "")
    if parsing.get("artifact"):
        line += " — %s" % _text(parsing["artifact"])
    out.append(line)
    if parsing.get("notes"):
        out.append("")
        out.append(" ".join(_text(parsing["notes"]).split()))
    recs = fmt.get("recommendations") or {}
    if recs:
        out.append("")
        out.append("## Recommendations")
        for side in ("direct", "guarded"):
            body = recs.get(side)
            if not body:
                continue
            out.append("")
            out.append("### %s" % side)
            if body.get("parse_location"):
                out.append("")
                out.append("Parse location: `%s`" % body["parse_location"])
            for key, label in (("cribl", "Cribl"), ("elastic", "Elastic"),
                               ("relay", "Relay")):
                if body.get(key):
                    out.append("")
                    out.append("**%s:** %s" % (label, " ".join(_text(body[key]).split())))
    out.append("")
    out.append("## Fields (%d mapped of %d)" % (fmt_view["fields_mapped"],
                                                fmt_view["fields_total"]))
    out.append("")
    if fmt.get("fields_omitted"):
        out.append("No field table: %s" % _text(fmt["fields_omitted"]))
    else:
        out.append("| Vendor field | Type | Description | ECS | Custom | Transform | Status | Alerting |")
        out.append("|---|---|---|---|---|---|---|---|")
        for fw in fmt_view["fields"]:
            f = fw["field"]
            transform = " ".join(x for x in (_cell(f.get("transform")),
                                             _cell(f.get("notes"))) if x)
            out.append("| %s | %s | %s | %s | %s | %s | %s | %s |" % (
                _code(f.get("vendor")), _cell(f.get("type")),
                _cell(f.get("description")), _code(f.get("ecs")),
                _code(f.get("custom")), transform, _cell(f.get("status")),
                "●" if fw["alerting"] else ""))
    out.append("")
    return "\n".join(out)
```

- [ ] **Step 4: Run**

Run: `python3 -m unittest tests.test_export_text tests.test_studio_parity -v`
Expected: PASS. If `test_header_and_rows` differs only in Python's `csv` quoting of the multi-line cell, compare with RFC 4180 (a cell containing CR/LF must be quoted — Python does this) and adjust the assertion's `startswith` text, not the writer.

- [ ] **Step 5: Commit**

```bash
git add datamaps/export_text.py tests/test_export_text.py tests/test_studio_parity.py
git commit -m "exports: Markdown and CSV renderers for one format block, CSV columns tied to Studio

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Per-block exports, ingest envelopes, and picker.json

**Files:**
- Modify: `datamaps/build.py` (`write_block_exports`, `write_picker_index`, call sites)
- Test: `tests/test_build_exports.py`

**Interfaces:**
- Produces, per block, under `out_dir/exports/`: `map/<tech>/<ds>__<fmt>.json|.md|.csv|.html`, `cribl/<tech>/<ds>__<fmt>.json` (when a pipeline exists; byte-identical to `data/pipelines/...`), `ingest/<tech>/<ds>__<fmt>.json` (when a pipeline exists), and `picker.json`.
- `build.block_rel(tech_id, ds_id, fmt) -> "<tech>/<ds>__<fmt>"`.
- `page_model["ingest"]` is set to `{key: envelope}` for reuse.

`picker.json` shape:

```
{ "schema_version": 1, "generated": "YYYY-MM-DD", "destinations": ["elastic"],
  "technologies": [ { "id", "name", "vendor", "category", "status",
      "datasets": [ { "id", "name", "description", "event_categories": [...],
          "formats": [ { "format", "recommended": bool, "mechanism", "artifact",
                         "has_cribl_pipeline": bool,
                         "ingest": {"translated","partial","manual","total"} | null,
                         "fields_total", "fields_mapped", "path": "<tech>/<ds>__<fmt>" } ] } ] } ] }
```

Map JSON shape:

```
{ "schema_version": 1, "technology": {"id","name","vendor","category","status"},
  "dataset": {"id","name","description","event_categories","route"},
  "format": <build._format_export(fmt_view)>,
  "recommended": bool,
  "coverage": {"required_total","required_mapped","required_pct","fields_total","fields_mapped"},
  "artifacts": {"cribl": "exports/cribl/<path>.json" | null, "ingest": "exports/ingest/<path>.json" | null} }
```

- [ ] **Step 1: Write the failing tests**

`tests/test_build_exports.py`:

```python
import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from tests.test_build import run_build, DATA


class TestBlockExports(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = tempfile.mkdtemp()
        try:
            cls.code, cls.report = run_build(cls.out)
        except BaseException:
            shutil.rmtree(cls.out, True)
            raise

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.out, True)

    def path(self, *parts):
        return os.path.join(self.out, "exports", *parts)

    def load(self, *parts):
        with open(self.path(*parts), encoding="utf-8") as fh:
            return json.load(fh)

    def test_build_ok(self):
        self.assertEqual(self.code, 0, self.report)

    def test_every_kind_exists_for_a_full_block(self):
        base = os.path.join("cisco-asa", "device-admin__snmp-trap")
        for kind, ext in (("map", ".json"), ("map", ".md"), ("map", ".csv"),
                          ("map", ".html"), ("cribl", ".json"), ("ingest", ".json")):
            self.assertTrue(os.path.exists(self.path(kind, base + ext)), kind + ext)

    def test_cribl_export_is_byte_identical(self):
        rel = os.path.join("cisco-asa", "device-admin__snmp-trap.json")
        with open(os.path.join(DATA, "pipelines", rel), "rb") as fh:
            src = fh.read()
        with open(self.path("cribl", rel), "rb") as fh:
            self.assertEqual(fh.read(), src)

    def test_ingest_envelope_shape(self):
        env = self.load("ingest", "cisco-asa", "device-admin__snmp-trap.json")
        self.assertEqual(env["id"], "dm_cisco_asa_device_admin_snmp_trap")
        for key in ("pipeline", "coverage", "notes", "manual_steps", "field_map", "requires"):
            self.assertIn(key, env)
        self.assertIn("processors", env["pipeline"])

    def test_map_json_shape(self):
        doc = self.load("map", "cisco-asa", "device-admin__snmp-trap.json")
        self.assertEqual(doc["technology"]["id"], "cisco-asa")
        self.assertEqual(doc["dataset"]["id"], "device-admin")
        self.assertEqual(doc["format"]["format"], "snmp-trap")
        self.assertEqual(doc["artifacts"]["cribl"],
                         "exports/cribl/cisco-asa/device-admin__snmp-trap.json")
        self.assertIn("fields", doc["format"])
        self.assertIn("alerting_required", doc["format"]["fields"][0])

    def test_none_block_has_no_artifacts(self):
        doc = self.load("map", "arkime", "sessions__json.json")
        self.assertEqual(doc["artifacts"], {"cribl": None, "ingest": None})
        self.assertFalse(os.path.exists(self.path("cribl", "arkime", "sessions__json.json")))

    def test_fragment_is_in_the_technology_page(self):
        with open(self.path("map", "cisco-asa", "device-admin__snmp-trap.html"),
                  encoding="utf-8") as fh:
            frag = fh.read().strip()
        with open(os.path.join(self.out, "tech", "cisco-asa.html"), encoding="utf-8") as fh:
            self.assertIn(frag, fh.read())

    def test_picker_index(self):
        idx = self.load("picker.json")
        self.assertEqual(idx["destinations"], ["elastic"])
        self.assertEqual(len(idx["technologies"]), 97)
        formats = [f for t in idx["technologies"] for d in t["datasets"] for f in d["formats"]]
        self.assertEqual(len(formats), 610)
        self.assertEqual(sum(1 for f in formats if f["has_cribl_pipeline"]), 605)
        none = [f for f in formats if f["mechanism"] == "none"]
        self.assertEqual(len(none), 5)
        for f in none:
            self.assertFalse(f["has_cribl_pipeline"])
            self.assertIsNone(f["ingest"])
        asa = [t for t in idx["technologies"] if t["id"] == "cisco-asa"][0]
        ds = [d for d in asa["datasets"] if d["id"] == "device-admin"][0]
        fmt = [f for f in ds["formats"] if f["format"] == "snmp-trap"][0]
        self.assertEqual(fmt["path"], "cisco-asa/device-admin__snmp-trap")
        self.assertEqual(set(fmt["ingest"]), {"translated", "partial", "manual", "total"})
        self.assertEqual(sum(1 for f in ds["formats"] if f["recommended"]), 1)

    def test_technology_ids_do_not_collide_with_export_dirs(self):
        idx = self.load("picker.json")
        ids = set(t["id"] for t in idx["technologies"])
        self.assertFalse(ids & {"map", "cribl", "ingest", "picker"})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_build_exports -v`
Expected: failures on missing `exports/map/...` and `picker.json`.

- [ ] **Step 3: Implement in `datamaps/build.py`**

Add imports:

```python
import datetime

from datamaps import export_text, render
from datamaps import pipelines as pipelines_mod
from datamaps.ingest import pipeline as ingest_mod
```
(`render` is already imported; merge, do not duplicate.)

Add helpers after `_usage_export`:

```python
def block_rel(tech_id, ds_id, fmt):
    return "%s/%s__%s" % (tech_id, ds_id, fmt)


def _write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def _write_json_at(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


def _block_map(tech_view, ds_view, fmt_view, rel, has_pipeline):
    entry = tech_view["entry"]
    ds = ds_view["data"]
    return {
        "schema_version": SCHEMA_VERSION,
        "technology": {k: entry.get(k) for k in
                       ("id", "name", "vendor", "category", "status")},
        "dataset": {"id": ds["id"], "name": ds.get("name"),
                    "description": ds.get("description"),
                    "event_categories": list(ds.get("event_categories") or []),
                    "route": ds.get("route")},
        "format": _format_export(fmt_view),
        "recommended": bool(fmt_view["recommended"]),
        "coverage": {
            "required_total": len(fmt_view["required"]),
            "required_mapped": len(fmt_view["required_mapped"]),
            "required_pct": fmt_view["required_pct"],
            "fields_total": fmt_view["fields_total"],
            "fields_mapped": fmt_view["fields_mapped"],
        },
        "artifacts": {
            "cribl": "exports/cribl/%s.json" % rel if has_pipeline else None,
            "ingest": "exports/ingest/%s.json" % rel if has_pipeline else None,
        },
    }


def write_block_exports(page_model, out_dir, data_dir, env):
    """Per-format-block files plus the ingest envelopes; returns {key: env}."""
    exports_dir = os.path.join(out_dir, "exports")
    envelopes = {}
    for tech_view, ds_view, fmt_view in pipelines_mod.iter_blocks(page_model):
        key = (tech_view["entry"]["id"], ds_view["data"]["id"],
               fmt_view["data"]["format"])
        rel = block_rel(*key)
        pipeline = page_model["pipelines"].get(key)
        _write_json_at(os.path.join(exports_dir, "map", rel + ".json"),
                       _block_map(tech_view, ds_view, fmt_view, rel,
                                  pipeline is not None))
        _write_text(os.path.join(exports_dir, "map", rel + ".md"),
                    export_text.block_markdown(tech_view, ds_view, fmt_view))
        _write_text(os.path.join(exports_dir, "map", rel + ".csv"),
                    export_text.block_csv(tech_view, ds_view, fmt_view))
        _write_text(os.path.join(exports_dir, "map", rel + ".html"),
                    render.fragment_html(env, ds_view, fmt_view, "../../../"))
        if pipeline is not None:
            src = os.path.join(data_dir, "pipelines", rel + ".json")
            dst = os.path.join(exports_dir, "cribl", rel + ".json")
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(src, dst)
            envelope = ingest_mod.translate_pipeline(pipeline)
            envelopes[key] = envelope
            _write_json_at(os.path.join(exports_dir, "ingest", rel + ".json"),
                           envelope)
    return envelopes


def write_picker_index(page_model, out_dir, envelopes, today=None):
    technologies = []
    for tech_view in page_model["technologies"]:
        entry = tech_view["entry"]
        datasets = []
        for ds_view in tech_view["datasets"]:
            ds = ds_view["data"]
            formats = []
            for fmt_view in ds_view["formats"]:
                key = (entry["id"], ds["id"], fmt_view["data"]["format"])
                envelope = envelopes.get(key)
                parsing = fmt_view["data"]["parsing"]
                formats.append({
                    "format": fmt_view["data"]["format"],
                    "recommended": bool(fmt_view["recommended"]),
                    "mechanism": parsing["mechanism"],
                    "artifact": parsing.get("artifact"),
                    "has_cribl_pipeline": key in page_model["pipelines"],
                    "ingest": dict(envelope["coverage"]) if envelope else None,
                    "fields_total": fmt_view["fields_total"],
                    "fields_mapped": fmt_view["fields_mapped"],
                    "path": block_rel(*key),
                })
            datasets.append({"id": ds["id"], "name": ds.get("name"),
                             "description": ds.get("description"),
                             "event_categories": list(ds.get("event_categories") or []),
                             "formats": formats})
        technologies.append({"id": entry["id"], "name": entry["name"],
                             "vendor": entry.get("vendor"),
                             "category": entry.get("category"),
                             "status": entry.get("status"),
                             "datasets": datasets})
    _write_json(os.path.join(out_dir, "exports"), "picker.json", {
        "schema_version": SCHEMA_VERSION,
        "generated": today or datetime.date.today().isoformat(),
        "destinations": ["elastic"],
        "technologies": technologies,
    })
```

In `main()`, replace the two lines

```python
    render.render_site(page_model, ROOT, out_dir)
    write_exports(page_model, out_dir)
```
with
```python
    env = render.build_env(ROOT)
    render.render_site(page_model, ROOT, out_dir)
    write_exports(page_model, out_dir)
    envelopes = write_block_exports(page_model, out_dir, data_dir, env)
    page_model["ingest"] = envelopes
    write_picker_index(page_model, out_dir, envelopes)
```

`write_exports` calls `os.makedirs(exports_dir)` (non-`exist_ok`); it runs before `write_block_exports`, so leave it.

- [ ] **Step 4: Run**

Run: `python3 -m unittest tests.test_build_exports tests.test_build tests.test_pipelines -v`
Expected: PASS. Then `python3 -m unittest discover -s tests` → `OK`. Then `python3 -m datamaps.build` and `find public/exports -type f | wc -l` → roughly 3,600 + the 100 pre-existing.

- [ ] **Step 5: Commit**

```bash
git add datamaps/build.py tests/test_build_exports.py
git commit -m "build: per-block map/cribl/ingest exports and the picker index

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase D — the picker page

Vanilla ES2018 modules under `static/picker/`: `hash.js`, `state.js`, `render.js` are pure and tested with `node --test`; `picker.js` is the only file that touches `document`, `fetch`, `location`, `navigator` and `URL`. `static/picker/package.json` is `{"type": "module", "private": true}` so Node loads the tests as ESM. The build copies `static/picker/*.js` (top level only) to `public/picker/`.

### Task 13: Picker page shell, hash state and cascading selection

**Files:**
- Create: `templates/picker.html.j2`
- Modify: `templates/base.html.j2` (nav link), `templates/index.html.j2` (pointer paragraph)
- Modify: `datamaps/render.py` (render `picker.html`, copy `static/picker/*.js`)
- Create: `static/picker/package.json`, `static/picker/hash.js`, `static/picker/state.js`
- Test: `static/picker/tests/hash.test.js`, `static/picker/tests/state.test.js`, `tests/test_render.py` (picker page exists)

**Interfaces:**
- `hash.js`: `parseHash(hash) -> {tech, dataset, format, cribl, dest}` (strings or `null`; `cribl` boolean default `true`; `dest` default `"elastic"`); `formatHash(state) -> string` beginning with `#`, omitting trailing null levels: `#cisco-asa/device-admin/snmp-trap?cribl=1&dest=elastic`, `#cisco-asa?cribl=1&dest=elastic`, `#?cribl=1&dest=elastic` when nothing is selected.
- `state.js`: `resolve(index, wanted) -> {state, notice}` validates `wanted` against `index` (the parsed `picker.json`), clearing from the first invalid level down and describing it in `notice` (`null` when nothing was changed); when a dataset is set and `format` is null, the dataset's recommended format is filled in. `select(index, state, level, value) -> state` applies cascade (tech change clears dataset+format; dataset change sets format to the recommended one; format sets format; `cribl` and `dest` set directly). `options(index, state) -> {techs: [{id,name,category}], datasets: [...], formats: [...]}` lists the choices at each level for the current state. `current(index, state) -> {tech, dataset, format} | null` returns the selected objects when all three are set.

- [ ] **Step 1: Write the failing Node tests**

`static/picker/tests/hash.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { parseHash, formatHash } from "../hash.js";

test("full hash round-trips", () => {
  const s = { tech: "cisco-asa", dataset: "device-admin", format: "snmp-trap",
              cribl: true, dest: "elastic" };
  assert.equal(formatHash(s), "#cisco-asa/device-admin/snmp-trap?cribl=1&dest=elastic");
  assert.deepEqual(parseHash(formatHash(s)), s);
});

test("defaults when parts are missing", () => {
  assert.deepEqual(parseHash(""), { tech: null, dataset: null, format: null, cribl: true, dest: "elastic" });
  assert.deepEqual(parseHash("#"), { tech: null, dataset: null, format: null, cribl: true, dest: "elastic" });
  assert.deepEqual(parseHash("#cisco-asa"), { tech: "cisco-asa", dataset: null, format: null, cribl: true, dest: "elastic" });
  assert.deepEqual(parseHash("#a/b?cribl=0"), { tech: "a", dataset: "b", format: null, cribl: false, dest: "elastic" });
});

test("partial state formats without trailing slashes", () => {
  assert.equal(formatHash({ tech: "a", dataset: null, format: null, cribl: false, dest: "elastic" }),
               "#a?cribl=0&dest=elastic");
  assert.equal(formatHash({ tech: null, dataset: null, format: null, cribl: true, dest: "elastic" }),
               "#?cribl=1&dest=elastic");
});

test("segments are URI-encoded", () => {
  const s = { tech: "a b", dataset: "c/d", format: "e", cribl: true, dest: "elastic" };
  assert.equal(formatHash(s), "#a%20b/c%2Fd/e?cribl=1&dest=elastic");
  assert.deepEqual(parseHash(formatHash(s)), s);
});

test("unknown query keys are ignored and bad cribl values default to true", () => {
  assert.equal(parseHash("#a?x=1&cribl=maybe").cribl, true);
});
```

`static/picker/tests/state.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { resolve, select, options, current } from "../state.js";

const INDEX = { destinations: ["elastic"], technologies: [
  { id: "asa", name: "Cisco ASA", category: "network-security", datasets: [
    { id: "traffic", name: "Traffic", formats: [
      { format: "syslog-raw", recommended: false },
      { format: "syslog-cef", recommended: true } ] },
    { id: "vpn", name: "VPN", formats: [ { format: "syslog-raw", recommended: true } ] } ] },
  { id: "win", name: "Windows", category: "endpoint", datasets: [
    { id: "security", name: "Security", formats: [ { format: "windows-event", recommended: true } ] } ] } ] };

const EMPTY = { tech: null, dataset: null, format: null, cribl: true, dest: "elastic" };

test("resolve keeps a valid state and fills the recommended format", () => {
  const r = resolve(INDEX, { tech: "asa", dataset: "traffic", format: null, cribl: true, dest: "elastic" });
  assert.equal(r.notice, null);
  assert.equal(r.state.format, "syslog-cef");
});

test("resolve clears from the first invalid level", () => {
  const r = resolve(INDEX, { tech: "asa", dataset: "nope", format: "syslog-cef", cribl: false, dest: "elastic" });
  assert.deepEqual(r.state, { tech: "asa", dataset: null, format: null, cribl: false, dest: "elastic" });
  assert.match(r.notice, /nope/);
  const t = resolve(INDEX, { tech: "zzz", dataset: "x", format: "y", cribl: true, dest: "elastic" });
  assert.deepEqual(t.state, EMPTY);
});

test("resolve rejects an unknown destination", () => {
  const r = resolve(INDEX, { tech: null, dataset: null, format: null, cribl: true, dest: "splunk" });
  assert.equal(r.state.dest, "elastic");
  assert.match(r.notice, /splunk/);
});

test("select cascades", () => {
  let s = select(INDEX, EMPTY, "tech", "asa");
  assert.deepEqual(s, { tech: "asa", dataset: null, format: null, cribl: true, dest: "elastic" });
  s = select(INDEX, s, "dataset", "traffic");
  assert.equal(s.format, "syslog-cef");
  s = select(INDEX, s, "format", "syslog-raw");
  assert.equal(s.format, "syslog-raw");
  s = select(INDEX, s, "cribl", false);
  assert.equal(s.cribl, false);
  s = select(INDEX, s, "tech", "win");
  assert.deepEqual(s, { tech: "win", dataset: null, format: null, cribl: false, dest: "elastic" });
});

test("options list each level for the current state", () => {
  const o = options(INDEX, select(INDEX, EMPTY, "tech", "asa"));
  assert.deepEqual(o.techs.map((t) => t.id), ["asa", "win"]);
  assert.deepEqual(o.datasets.map((d) => d.id), ["traffic", "vpn"]);
  assert.deepEqual(o.formats, []);
  const o2 = options(INDEX, select(INDEX, select(INDEX, EMPTY, "tech", "asa"), "dataset", "traffic"));
  assert.deepEqual(o2.formats.map((f) => f.format), ["syslog-raw", "syslog-cef"]);
});

test("current returns the selected objects only when complete", () => {
  assert.equal(current(INDEX, EMPTY), null);
  const s = select(INDEX, select(INDEX, EMPTY, "tech", "asa"), "dataset", "vpn");
  const c = current(INDEX, s);
  assert.equal(c.tech.name, "Cisco ASA");
  assert.equal(c.dataset.id, "vpn");
  assert.equal(c.format.format, "syslog-raw");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test static/picker/tests/*.test.js`
Expected: module-not-found failures for `../hash.js` and `../state.js`.

- [ ] **Step 3: Write `static/picker/package.json`, `hash.js`, `state.js`**

`static/picker/package.json`:

```json
{"type": "module", "private": true}
```

`static/picker/hash.js`:

```js
// The selection lives in the URL hash so a result is a link:
//   #<tech>/<dataset>/<format>?cribl=1|0&dest=elastic
// Pure string functions; picker.js owns location.hash.

const DEFAULTS = { tech: null, dataset: null, format: null, cribl: true, dest: "elastic" };

export function parseHash(hash) {
  const text = (hash || "").replace(/^#/, "");
  const q = text.indexOf("?");
  const pathPart = q === -1 ? text : text.slice(0, q);
  const queryPart = q === -1 ? "" : text.slice(q + 1);
  const segs = pathPart === "" ? [] : pathPart.split("/").map(decodeSafe);
  const out = Object.assign({}, DEFAULTS);
  out.tech = segs[0] || null;
  out.dataset = segs[1] || null;
  out.format = segs[2] || null;
  for (const pair of queryPart.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? "" : decodeSafe(pair.slice(eq + 1));
    if (key === "cribl") {
      if (value === "0") out.cribl = false;
      else if (value === "1") out.cribl = true;
    } else if (key === "dest" && value) {
      out.dest = value;
    }
  }
  return out;
}

export function formatHash(state) {
  const segs = [];
  for (const key of ["tech", "dataset", "format"]) {
    if (!state[key]) break;
    segs.push(encodeURIComponent(state[key]));
  }
  return "#" + segs.join("/") + "?cribl=" + (state.cribl ? "1" : "0")
    + "&dest=" + encodeURIComponent(state.dest || "elastic");
}

function decodeSafe(text) {
  try { return decodeURIComponent(text); } catch (err) { return text; }
}
```

`static/picker/state.js`:

```js
// Selection state over the picker index (exports/picker.json).  Pure:
// every function returns a new state and never touches the DOM.

export function findTech(index, id) {
  return (index.technologies || []).find((t) => t.id === id) || null;
}

export function findDataset(tech, id) {
  return tech ? (tech.datasets || []).find((d) => d.id === id) || null : null;
}

export function findFormat(dataset, id) {
  return dataset ? (dataset.formats || []).find((f) => f.format === id) || null : null;
}

function recommendedFormat(dataset) {
  if (!dataset || !dataset.formats || !dataset.formats.length) return null;
  const rec = dataset.formats.find((f) => f.recommended);
  return (rec || dataset.formats[0]).format;
}

export function resolve(index, wanted) {
  const notices = [];
  const state = { tech: null, dataset: null, format: null,
                  cribl: wanted.cribl !== false, dest: "elastic" };
  const dests = index.destinations || ["elastic"];
  if (wanted.dest && dests.indexOf(wanted.dest) === -1) {
    notices.push("destination '" + wanted.dest + "' is not available; using elastic");
  } else if (wanted.dest) {
    state.dest = wanted.dest;
  }
  const tech = wanted.tech ? findTech(index, wanted.tech) : null;
  if (wanted.tech && !tech) {
    notices.push("no technology '" + wanted.tech + "'");
    return { state, notice: notices.join("; ") };
  }
  state.tech = tech ? tech.id : null;
  const dataset = wanted.dataset ? findDataset(tech, wanted.dataset) : null;
  if (wanted.dataset && !dataset) {
    notices.push("no dataset '" + wanted.dataset + "' on " + (tech ? tech.id : "?"));
    return { state, notice: notices.join("; ") };
  }
  state.dataset = dataset ? dataset.id : null;
  if (dataset) {
    const format = wanted.format ? findFormat(dataset, wanted.format) : null;
    if (wanted.format && !format) {
      notices.push("no format '" + wanted.format + "' on " + dataset.id);
    }
    state.format = format ? format.format : recommendedFormat(dataset);
  }
  return { state, notice: notices.length ? notices.join("; ") : null };
}

export function select(index, state, level, value) {
  const next = Object.assign({}, state);
  if (level === "tech") {
    next.tech = value || null;
    next.dataset = null;
    next.format = null;
  } else if (level === "dataset") {
    next.dataset = value || null;
    next.format = recommendedFormat(findDataset(findTech(index, next.tech), next.dataset));
  } else if (level === "format") {
    next.format = value || null;
  } else if (level === "cribl") {
    next.cribl = Boolean(value);
  } else if (level === "dest") {
    next.dest = value || "elastic";
  }
  return next;
}

export function options(index, state) {
  const tech = findTech(index, state.tech);
  const dataset = findDataset(tech, state.dataset);
  return {
    techs: (index.technologies || []).map((t) => ({ id: t.id, name: t.name, category: t.category })),
    datasets: tech ? tech.datasets.map((d) => ({ id: d.id, name: d.name })) : [],
    formats: dataset ? dataset.formats.slice() : [],
  };
}

export function current(index, state) {
  const tech = findTech(index, state.tech);
  const dataset = findDataset(tech, state.dataset);
  const format = findFormat(dataset, state.format);
  if (!tech || !dataset || !format) return null;
  return { tech, dataset, format };
}
```

- [ ] **Step 4: Run the Node tests**

Run: `node --test static/picker/tests/*.test.js`
Expected: all PASS.

- [ ] **Step 5: The page template and render wiring**

`templates/picker.html.j2`:

```
{% extends "base.html.j2" %}
{% block title %}Picker — Data maps{% endblock %}
{% block content %}
<section>
<h2>Pick a feed, get its map and its pipeline</h2>
<p class="page-help">Choose the technology, the log type, and the wire format you actually have. Say whether Cribl Stream sits in your path. The result is that block's data map — readable here, downloadable as JSON, Markdown or CSV — and the parser artifact for your path: the Cribl pipeline, or an Elasticsearch ingest pipeline translated from it.</p>
<form class="picker-form" id="picker-form" autocomplete="off">
<label>Technology
<select id="pick-tech" name="tech"><option value="">—</option></select>
</label>
<label>Dataset
<select id="pick-dataset" name="dataset" disabled><option value="">—</option></select>
</label>
<label>Wire format
<select id="pick-format" name="format" disabled><option value="">—</option></select>
</label>
<label class="picker-toggle"><input type="checkbox" id="pick-cribl" name="cribl" checked> Cribl Stream is in the path</label>
<label>Destination
<select id="pick-dest" name="dest"><option value="elastic">Elastic</option></select>
</label>
</form>
<p id="picker-notice" class="picker-notice" hidden></p>
</section>
<section id="picker-result" class="picker-result" hidden>
<div id="result-header"></div>
<div id="result-map" class="panel-plain"></div>
<div id="result-artifact"></div>
</section>
<script type="module" src="{{ asset_prefix }}picker/picker.js"></script>
{% endblock %}
```

In `templates/base.html.j2` add after the ECS index link:

```
<a href="{{ asset_prefix }}picker.html">Picker</a>
```

In `templates/index.html.j2`, directly after the `<div class="cards">…</div>` block's closing `</div>` (before `{% if model.flags %}`), add:

```
<p class="page-help">Looking for one feed's map and pipeline? The <a href="picker.html">Picker</a> takes a technology, dataset and wire format and hands back the data map with the Cribl pipeline or an Elasticsearch ingest pipeline.</p>
```

In `datamaps/render.py` `render_site`, add to `jobs`:

```python
        ("picker.html.j2", os.path.join(out_dir, "picker.html"),
         {"model": model, "asset_prefix": ""}),
```
and after the static copy loop:

```python
    picker_src = os.path.join(root, "static", "picker")
    picker_dst = os.path.join(out_dir, "picker")
    if not os.path.isdir(picker_dst):
        os.makedirs(picker_dst)
    for name in sorted(os.listdir(picker_src)):
        if name.endswith(".js"):
            shutil.copy(os.path.join(picker_src, name), picker_dst)
```

Append to `tests/test_render.py`:

```python
class TestPickerPage(unittest.TestCase):
    def test_picker_page_and_scripts_are_emitted(self):
        out = build_site(catalog()["technologies"], {})
        self.addCleanup(shutil.rmtree, out, True)
        page = read(out, "picker.html")
        self.assertIn('id="pick-tech"', page)
        self.assertIn('src="picker/picker.js"', page)
        self.assertIn('href="picker.html">Picker</a>', read(out, "index.html"))
        for name in ("picker.js", "hash.js", "state.js", "render.js"):
            self.assertTrue(os.path.exists(os.path.join(out, "picker", name)), name)
        self.assertFalse(os.path.exists(os.path.join(out, "picker", "tests")))
```

`render.js` and `picker.js` are created in Task 14; for this task create them as placeholders containing only a comment line each (`// filled in by the next task`) so the copy and the test pass, and replace them in Task 14.

- [ ] **Step 6: Run everything**

Run: `python3 -m unittest tests.test_render -v` → PASS. `node --test static/picker/tests/*.test.js` → PASS. `python3 -m unittest discover -s tests` → `OK`.

- [ ] **Step 7: Commit**

```bash
git add templates/picker.html.j2 templates/base.html.j2 templates/index.html.j2 datamaps/render.py static/picker/package.json static/picker/hash.js static/picker/state.js static/picker/render.js static/picker/picker.js static/picker/tests/hash.test.js static/picker/tests/state.test.js tests/test_render.py
git commit -m "picker: page shell, URL-hash state and cascading selection

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Result rendering, fetch wiring, CSS, ES2018 sweep, CI globs

**Files:**
- Create: `static/picker/render.js`, `static/picker/picker.js` (replacing placeholders)
- Create: `static/picker/tests/render.test.js`, `static/picker/tests/es2018.test.js`
- Modify: `static/styles.css`
- Modify: `.gitlab-ci.yml`, `.forgejo/workflows/pages.yml` (Node test glob)

**Interfaces:**
- `render.js` (pure, returns HTML strings; escapes with `esc`):
  - `headerHtml(sel) -> string` where `sel = {tech, dataset, format}` from `state.current`.
  - `artifactHtml(sel, state, data) -> string` where `data = {cribl: object|null, ingest: envelope|null}`; branches on `state.cribl`, `sel.format.mechanism`, `sel.format.has_cribl_pipeline`.
  - `downloadsHtml(path) -> string` — links to `exports/map/<path>.json|.md|.csv`.
  - `esc(text) -> string`.
- `picker.js`: on load fetches `exports/picker.json`, resolves the hash, fills selects, listens to `change` and `hashchange`, fetches `exports/map/<path>.html` and the artifact JSON, sets `innerHTML`, builds the ingest download with `URL.createObjectURL(new Blob([...]))`, wires copy buttons through `navigator.clipboard.writeText`.

Texts the tests pin (exact):
- Downstream note (Elastic-parsed mechanisms): `Parsing happens downstream in <artifact>; this pipeline only identifies the event and tags event.dataset.`
- Mechanism none: `Cribl is not in this path for this feed.`
- Missing pipeline: `No pipeline has been authored for this block yet.`
- Coverage badge: `<translated> of <total> steps translated` plus `, <partial> partial` when partial > 0 and `, <manual> manual` when manual > 0.

- [ ] **Step 1: Write the failing tests**

`static/picker/tests/render.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { headerHtml, artifactHtml, downloadsHtml, esc } from "../render.js";

const FULL = { format: "snmp-trap", mechanism: "cribl-pipeline", artifact: null,
               has_cribl_pipeline: true, path: "asa/dev__snmp-trap",
               ingest: { translated: 3, partial: 1, manual: 1, total: 5 } };
const THIN = { format: "syslog-raw", mechanism: "elastic-integration",
               artifact: "Cisco ASA integration (cisco_asa)", has_cribl_pipeline: true,
               path: "asa/dev__syslog-raw", ingest: { translated: 1, partial: 0, manual: 0, total: 1 } };
const NONE = { format: "json", mechanism: "none", artifact: null, has_cribl_pipeline: false,
               path: "arkime/sessions__json", ingest: null };
const MISSING = { format: "api-pull", mechanism: "cribl-pipeline", artifact: null,
                  has_cribl_pipeline: false, path: "x/y__api-pull", ingest: null };
const SEL = (format) => ({ tech: { id: "asa", name: "Cisco <ASA>" },
                           dataset: { id: "dev", name: "Device admin" }, format });
const CRIBL = { id: "dm_asa_dev_snmp_trap", conf: { functions: [] } };
const ENV = { id: "dm_asa_dev_snmp_trap",
              pipeline: { description: "d", processors: [{ set: { field: "a", value: "b" } }] },
              coverage: { translated: 3, partial: 1, manual: 1, total: 5 },
              notes: ["regex_extract #2: iterations ignored"],
              manual_steps: [{ index: 4, function: "code", reason: "no equivalent",
                               description: "hand-written", original: { id: "code" } }],
              field_map: { _time: "@timestamp", _raw: "message" },
              requires: ["painless-regex"] };

test("esc escapes html", () => {
  assert.equal(esc('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
});

test("header names the selection and escapes it", () => {
  const html = headerHtml(SEL(FULL));
  assert.match(html, /Cisco &lt;ASA&gt;/);
  assert.match(html, /Device admin/);
  assert.match(html, /snmp-trap/);
  assert.match(html, /cribl-pipeline/);
});

test("downloads link to the three map exports", () => {
  const html = downloadsHtml("asa/dev__snmp-trap");
  for (const ext of ["json", "md", "csv"]) {
    assert.match(html, new RegExp('href="exports/map/asa/dev__snmp-trap\\.' + ext + '"'));
  }
});

test("cribl on, full block: pipeline json with copy and download", () => {
  const html = artifactHtml(SEL(FULL), { cribl: true, dest: "elastic" }, { cribl: CRIBL, ingest: ENV });
  assert.match(html, /dm_asa_dev_snmp_trap/);
  assert.match(html, /href="exports\/cribl\/asa\/dev__snmp-trap\.json"/);
  assert.match(html, /data-copy="cribl"/);
  assert.doesNotMatch(html, /Parsing happens downstream/);
});

test("cribl on, thin block: downstream note", () => {
  const html = artifactHtml(SEL(THIN), { cribl: true, dest: "elastic" }, { cribl: CRIBL, ingest: ENV });
  assert.match(html, /Parsing happens downstream in Cisco ASA integration \(cisco_asa\); this pipeline only identifies the event and tags event\.dataset\./);
});

test("cribl off: coverage badge, requires, manual steps, download hook", () => {
  const html = artifactHtml(SEL(FULL), { cribl: false, dest: "elastic" }, { cribl: CRIBL, ingest: ENV });
  assert.match(html, /3 of 5 steps translated, 1 partial, 1 manual/);
  assert.match(html, /painless-regex/);
  assert.match(html, /hand-written/);
  assert.match(html, /no equivalent/);
  assert.match(html, /iterations ignored/);
  assert.match(html, /data-download="ingest"/);
  assert.match(html, /data-copy="ingest"/);
  assert.match(html, /"processors"/);
});

test("cribl off, thin block: note first, no manual list", () => {
  const html = artifactHtml(SEL(THIN), { cribl: false, dest: "elastic" }, { cribl: CRIBL, ingest: Object.assign({}, ENV, { manual_steps: [], coverage: THIN.ingest, notes: [] }) });
  assert.match(html, /Parsing happens downstream/);
  assert.match(html, /1 of 1 steps translated/);
  assert.doesNotMatch(html, /Manual steps/);
});

test("mechanism none and missing pipeline", () => {
  assert.match(artifactHtml(SEL(NONE), { cribl: true, dest: "elastic" }, { cribl: null, ingest: null }),
               /Cribl is not in this path for this feed\./);
  assert.match(artifactHtml(SEL(MISSING), { cribl: false, dest: "elastic" }, { cribl: null, ingest: null }),
               /No pipeline has been authored for this block yet\./);
  assert.match(artifactHtml(SEL(MISSING), { cribl: false, dest: "elastic" }, { cribl: null, ingest: null }),
               /href="tech\/asa\.html"/);
});
```

`static/picker/tests/es2018.test.js` — copy `studio/tests/es2018.test.js`, change `sources()` to return the top-level `.js` files of `static/picker/` (`ROOT = path.join(HERE, "..")`, list `readdirSync(ROOT)` filtered to `.js`), drop the `globalObject` test and the "covers every shipped module" names to `["picker.js", "render.js", "state.js", "hash.js"]`, and lower the `files.length >= 10` floor to `>= 4`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test static/picker/tests/*.test.js`
Expected: `render.test.js` fails (placeholder exports nothing); `es2018.test.js` passes trivially.

- [ ] **Step 3: Write `static/picker/render.js`**

```js
// HTML for the result panel.  Pure string builders so the Node tests can
// hold the texts; picker.js puts them in the DOM and wires the buttons.

export function esc(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ELASTIC_PARSES = ["elastic-integration", "elastic-ingest-pipeline"];

export function headerHtml(sel) {
  const f = sel.format;
  return '<h2 class="result-title">' + esc(sel.tech.name) + ' <span class="muted">/</span> '
    + esc(sel.dataset.name || sel.dataset.id) + ' <span class="muted">/</span> <code>'
    + esc(f.format) + "</code></h2>"
    + '<p class="parsing"><span class="chip">' + esc(f.mechanism) + "</span>"
    + (f.artifact ? " " + esc(f.artifact) : "") + "</p>";
}

export function downloadsHtml(path) {
  const base = "exports/map/" + path;
  return '<p class="downloads">Download the map: '
    + '<a href="' + esc(base) + '.json" download>JSON</a> · '
    + '<a href="' + esc(base) + '.md" download>Markdown</a> · '
    + '<a href="' + esc(base) + '.csv" download>CSV</a></p>';
}

function downstreamNote(f) {
  return '<p class="downstream-note">Parsing happens downstream in ' + esc(f.artifact || f.mechanism)
    + "; this pipeline only identifies the event and tags event.dataset.</p>";
}

function coverageBadge(c) {
  let text = c.translated + " of " + c.total + " steps translated";
  if (c.partial) text += ", " + c.partial + " partial";
  if (c.manual) text += ", " + c.manual + " manual";
  const cls = c.manual || c.partial ? "coverage-badge coverage-partial" : "coverage-badge coverage-full";
  return '<span class="' + cls + '">' + esc(text) + "</span>";
}

function pre(id, text) {
  return '<pre class="artifact mono" id="' + id + '">' + esc(text) + "</pre>";
}

export function artifactHtml(sel, state, data) {
  const f = sel.format;
  if (f.mechanism === "none") {
    return '<h3>Parser</h3><p class="artifact-note">Cribl is not in this path for this feed.</p>';
  }
  if (!f.has_cribl_pipeline || !data.cribl || !data.ingest) {
    return '<h3>Parser</h3><p class="artifact-note">No pipeline has been authored for this block yet. '
      + 'See the <a href="tech/' + esc(sel.tech.id) + '.html">technology page</a>.</p>';
  }
  const parts = [];
  if (state.cribl) {
    parts.push("<h3>Cribl Stream pipeline</h3>");
    if (ELASTIC_PARSES.indexOf(f.mechanism) !== -1) parts.push(downstreamNote(f));
    parts.push('<p class="artifact-actions"><button type="button" data-copy="cribl">Copy</button> '
      + '<a href="exports/cribl/' + esc(f.path) + '.json" download>Download</a> '
      + "<code>" + esc(data.cribl.id) + "</code></p>");
    parts.push(pre("artifact-cribl", JSON.stringify(data.cribl, null, 2)));
    return parts.join("\n");
  }
  const env = data.ingest;
  parts.push("<h3>Elasticsearch ingest pipeline</h3>");
  if (ELASTIC_PARSES.indexOf(f.mechanism) !== -1) parts.push(downstreamNote(f));
  parts.push('<p class="artifact-actions">' + coverageBadge(env.coverage)
    + ' <button type="button" data-copy="ingest">Copy</button> '
    + '<a href="#" data-download="ingest" download="' + esc(env.id) + '.ingest.json">Download</a> '
    + "<code>PUT _ingest/pipeline/" + esc(env.id) + "</code></p>");
  if (env.requires && env.requires.length) {
    parts.push('<p class="artifact-note">Requires: ' + env.requires.map(esc).join(", ")
      + " (set <code>script.painless.regex.enabled: true</code> on the node).</p>");
  }
  parts.push(pre("artifact-ingest", JSON.stringify(env.pipeline, null, 2)));
  if (env.notes && env.notes.length) {
    parts.push("<h4>Notes</h4><ul class=\"notes\">" + env.notes.map((n) => "<li>" + esc(n) + "</li>").join("") + "</ul>");
  }
  if (env.manual_steps && env.manual_steps.length) {
    parts.push("<h4>Manual steps</h4><ol class=\"manual-steps\">");
    for (const step of env.manual_steps) {
      parts.push('<li class="manual-step"><strong>' + esc(step.function) + "</strong>"
        + (step.partial ? ' <span class="chip">partial</span>' : "")
        + (step.description ? " — " + esc(step.description) : "")
        + '<br><span class="muted">' + esc(step.reason) + "</span>"
        + "<details><summary>Original Cribl function</summary>"
        + pre("", JSON.stringify(step.original, null, 2)) + "</details></li>");
    }
    parts.push("</ol>");
  }
  parts.push('<p class="artifact-note">Field map: ' + Object.keys(env.field_map || {})
    .map((k) => "<code>" + esc(k) + "</code> → <code>" + esc(env.field_map[k]) + "</code>").join(", ") + "</p>");
  return parts.join("\n");
}
```

- [ ] **Step 4: Write `static/picker/picker.js`**

```js
// The only module that touches the page: selects, hash, fetches, buttons.
import { parseHash, formatHash } from "./hash.js";
import { resolve, select, options, current } from "./state.js";
import { headerHtml, artifactHtml, downloadsHtml } from "./render.js";

const el = (id) => document.getElementById(id);
let index = null;
let state = null;
let loaded = { path: null, cribl: null, ingest: null, map: null };
let blobUrl = null;

function fill(selectEl, items, value, label) {
  selectEl.innerHTML = '<option value="">—</option>';
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item.id !== undefined ? item.id : item.format;
    opt.textContent = label(item);
    if (opt.value === value) opt.selected = true;
    selectEl.appendChild(opt);
  }
  selectEl.disabled = items.length === 0;
}

function syncForm() {
  const o = options(index, state);
  fill(el("pick-tech"), o.techs, state.tech, (t) => t.name + " (" + t.category + ")");
  fill(el("pick-dataset"), o.datasets, state.dataset, (d) => d.name || d.id);
  fill(el("pick-format"), o.formats, state.format,
       (f) => f.format + (f.recommended ? " · recommended" : ""));
  el("pick-cribl").checked = state.cribl;
  el("pick-dest").value = state.dest;
}

function notice(text) {
  const p = el("picker-notice");
  p.hidden = !text;
  p.textContent = text || "";
}

function getJson(url) {
  return fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

function getText(url) {
  return fetch(url).then((r) => (r.ok ? r.text() : "")).catch(() => "");
}

function loadArtifacts(sel) {
  const path = sel.format.path;
  if (loaded.path === path) return Promise.resolve(loaded);
  const wants = sel.format.has_cribl_pipeline;
  return Promise.all([
    getText("exports/map/" + path + ".html"),
    wants ? getJson("exports/cribl/" + path + ".json") : Promise.resolve(null),
    wants ? getJson("exports/ingest/" + path + ".json") : Promise.resolve(null),
  ]).then((results) => {
    loaded = { path, map: results[0], cribl: results[1], ingest: results[2] };
    return loaded;
  });
}

function wireButtons(sel, data) {
  const root = el("result-artifact");
  for (const button of root.querySelectorAll("button[data-copy]")) {
    button.addEventListener("click", () => {
      const which = button.getAttribute("data-copy");
      const text = which === "cribl"
        ? JSON.stringify(data.cribl, null, 2)
        : JSON.stringify(data.ingest.pipeline, null, 2);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => { button.textContent = "Copied"; });
      }
    });
  }
  const download = root.querySelector("a[data-download='ingest']");
  if (download && data.ingest) {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    const body = JSON.stringify(data.ingest.pipeline, null, 2) + "\n";
    blobUrl = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    download.href = blobUrl;
  }
}

function renderResult() {
  const sel = current(index, state);
  const result = el("picker-result");
  if (!sel) {
    result.hidden = true;
    return;
  }
  loadArtifacts(sel).then((data) => {
    el("result-header").innerHTML = headerHtml(sel);
    el("result-map").innerHTML = downloadsHtml(sel.format.path)
      + '<div class="format-variant active">' + (data.map || "<p>Map unavailable.</p>") + "</div>";
    el("result-artifact").innerHTML = artifactHtml(sel, state, data);
    wireButtons(sel, data);
    result.hidden = false;
  });
}

function apply(next, pushHash) {
  state = next;
  syncForm();
  if (pushHash) {
    const hash = formatHash(state);
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }
  renderResult();
}

function fromHash() {
  const r = resolve(index, parseHash(location.hash));
  notice(r.notice);
  apply(r.state, true);
}

function onChange(level) {
  return (event) => {
    const value = level === "cribl" ? event.target.checked : event.target.value;
    notice(null);
    apply(select(index, state, level, value), true);
  };
}

getJson("exports/picker.json").then((idx) => {
  if (!idx) {
    notice("The picker index could not be loaded.");
    return;
  }
  index = idx;
  el("pick-tech").addEventListener("change", onChange("tech"));
  el("pick-dataset").addEventListener("change", onChange("dataset"));
  el("pick-format").addEventListener("change", onChange("format"));
  el("pick-cribl").addEventListener("change", onChange("cribl"));
  el("pick-dest").addEventListener("change", onChange("dest"));
  window.addEventListener("hashchange", fromHash);
  fromHash();
});
```

The fetch URLs are relative to `picker.html` at the site root; the map fragment was rendered with `asset_prefix` `../../../` (relative to `exports/map/<tech>/`), so example-download links inside a fragment resolve from the fragment's own location, not from `picker.html`. The fragment carries such links only when a dataset has example records, and the public tree has none; leave as is and note it in the README's Picker section.

- [ ] **Step 5: CSS**

Append to `static/styles.css`:

```css
/* picker */
.picker-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 18px; align-items: end; }
.picker-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
.picker-form select { background: var(--surface); color: var(--ink); border: 1px solid var(--border); padding: 6px 8px; font: inherit; }
.picker-form select:disabled { opacity: 0.5; }
.picker-toggle { flex-direction: row !important; align-items: center; gap: 8px !important; color: var(--ink) !important; }
.picker-notice { color: var(--warn); }
.result-title { margin-bottom: 4px; }
.downloads { color: var(--muted); font-size: 13px; }
.artifact-actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.artifact-actions button { background: var(--surface-raise); color: var(--ink); border: 1px solid var(--border); padding: 4px 10px; cursor: pointer; font: inherit; }
.artifact-actions button:hover { border-color: var(--accent); }
pre.artifact { background: var(--surface); border: 1px solid var(--border); padding: 12px; overflow: auto; max-height: 60vh; font-size: 12px; }
.coverage-badge { font-size: 12px; font-weight: 650; padding: 2px 9px; border-radius: 10px; }
.coverage-full { color: var(--ok); background: rgba(12,163,12,0.12); }
.coverage-partial { color: var(--warn); background: rgba(250,178,25,0.12); }
.artifact-note, .downstream-note { color: var(--muted); font-size: 13px; }
.manual-steps li { margin: 8px 0; }
.manual-step details { margin-top: 4px; }
.muted { color: var(--muted); }
```

- [ ] **Step 6: CI globs**

`.gitlab-ci.yml` `test-js` script line becomes:

```
    - node --test studio/tests/*.test.js static/picker/tests/*.test.js
```

`.forgejo/workflows/pages.yml` `test-js` last step becomes:

```
      - run: node --test studio/tests/*.test.js static/picker/tests/*.test.js
```

- [ ] **Step 7: Run everything and look at it**

Run: `node --test studio/tests/*.test.js static/picker/tests/*.test.js` → PASS.
Run: `python3 -m unittest discover -s tests` → `OK`.
Run: `python3 -m datamaps.build && (cd public && python3 -m http.server 8765 >/dev/null 2>&1 &) && sleep 1 && curl -s http://localhost:8765/picker.html | grep -c pick-tech; curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8765/exports/picker.json; curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:8765/exports/ingest/cisco-asa/device-admin__snmp-trap.json'; kill %1`
Expected: `1`, `200`, `200`. If a browser is available, open `http://localhost:8765/picker.html#cisco-asa/device-admin/snmp-trap?cribl=0&dest=elastic` and confirm the coverage badge, the ingest JSON, and that the three map downloads and the ingest download work.

- [ ] **Step 8: Commit**

```bash
git add static/picker/render.js static/picker/picker.js static/picker/tests/render.test.js static/picker/tests/es2018.test.js static/styles.css .gitlab-ci.yml .forgejo/workflows/pages.yml
git commit -m "picker: result rendering, artifact fetch and download wiring, CI test globs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase E — verification, documentation, hosting

### Task 15: Live validation tooling and runbook

**Files:**
- Create: `tools/validate_live/compose.yml`
- Create: `tools/validate_live/validate.py`
- Create: `tools/validate_live/README.md`
- Create: `docs/verification/.gitkeep`
- Modify: `docs/wiki/Runbooks.md` (new section "Live validation")
- Test: `tests/test_validate_live.py` (report formatting and request bodies only — no network)

**Interfaces:**
- `validate.py` reads `CRIBL_URL`, `CRIBL_USER`, `CRIBL_PASSWORD`, `ES_URL` from the environment (all optional: an unset target is skipped and the report says so). Functions: `cribl_login(url, user, password) -> token`; `cribl_validate(url, token, pipelines) -> list[result]`; `es_validate(url, envelopes) -> list[result]`; `write_report(path, cribl_results, es_results, meta) -> None`. A result is `{"id", "key", "ok": bool, "status": int, "detail": str}`.
- Cribl API (single instance): `POST {url}/api/v1/auth/login` with `{"username","password"}` → `{"token"}`; `Authorization: Bearer <token>`; `DELETE {url}/api/v1/pipelines/{id}` (ignore 404), `POST {url}/api/v1/pipelines` with the pipeline body → 200 is success. Every created `dm_*` pipeline is deleted again at the end so the instance is left as found.
- Elasticsearch: `PUT {url}/_ingest/pipeline/{id}` with the envelope's `pipeline` → 200 is success; then `POST {url}/_ingest/pipeline/{id}/_simulate` with `{"docs":[{"_source":{"message":""}}]}` → 200 confirms it loads. Every `dm_*` ingest pipeline is deleted at the end.
- Report path: `docs/verification/<YYYY-MM-DD>-live-validation.md`.

- [ ] **Step 1: Write the failing test**

`tests/test_validate_live.py`:

```python
import importlib.util
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

SPEC = importlib.util.spec_from_file_location(
    "validate_live", os.path.join(ROOT, "tools", "validate_live", "validate.py"))
vl = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vl)


class TestBodies(unittest.TestCase):
    def test_simulate_body(self):
        self.assertEqual(vl.SIMULATE_BODY, {"docs": [{"_source": {"message": ""}}]})

    def test_env_targets(self):
        env = {"CRIBL_URL": "http://c:19000", "CRIBL_USER": "u", "CRIBL_PASSWORD": "p"}
        t = vl.targets(env)
        self.assertEqual(t["cribl"], ("http://c:19000", "u", "p"))
        self.assertIsNone(t["es"])


class TestReport(unittest.TestCase):
    def test_report_lists_failures_verbatim(self):
        out = tempfile.mkdtemp()
        path = os.path.join(out, "r.md")
        cribl = [{"id": "dm_a", "key": "a/b__c", "ok": True, "status": 200, "detail": ""},
                 {"id": "dm_d", "key": "d/e__f", "ok": False, "status": 400,
                  "detail": '{"message":"bad conf"}'}]
        es = [{"id": "dm_a", "key": "a/b__c", "ok": False, "status": 400,
               "detail": "compile error at line 1"}]
        vl.write_report(path, cribl, es, {"date": "2026-09-30",
                                          "cribl": "http://c:19000",
                                          "es": "http://e:9200",
                                          "cribl_version": "4.19.0",
                                          "es_version": "8.15.0"})
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("# Live validation — 2026-09-30", text)
        self.assertIn("Cribl: 1 of 2 accepted", text)
        self.assertIn("Elasticsearch: 0 of 1 accepted", text)
        self.assertIn("bad conf", text)
        self.assertIn("compile error at line 1", text)
        self.assertIn("4.19.0", text)

    def test_report_with_skipped_target(self):
        out = tempfile.mkdtemp()
        path = os.path.join(out, "r.md")
        vl.write_report(path, None, [], {"date": "d", "cribl": None, "es": "http://e",
                                         "cribl_version": None, "es_version": "8"})
        with open(path, encoding="utf-8") as fh:
            self.assertIn("Cribl: skipped (CRIBL_URL unset)", fh.read())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_validate_live -v`
Expected: `FileNotFoundError` for `tools/validate_live/validate.py`.

- [ ] **Step 3: Write `tools/validate_live/validate.py`**

```python
#!/usr/bin/env python3
"""Launch gate: push every pipeline at a real Cribl and a real Elasticsearch.

Run by hand, never in CI.  Targets come from the environment so no host
or credential is committed:

    CRIBL_URL       e.g. http://cribl.example:19000   (skipped when unset)
    CRIBL_USER      Cribl UI/API user
    CRIBL_PASSWORD  its password
    ES_URL          e.g. http://localhost:9200         (skipped when unset)

Everything created is named dm_* and is deleted again at the end.  The
report is written to docs/verification/<date>-live-validation.md and is
meant to be committed.

What a green report proves: every Cribl pipeline is accepted by the API
(schema and conf valid) and every ingest pipeline compiles and loads in
Elasticsearch.  What it does not prove: correct parsing of real events;
the public tree carries no example records to run through them.
"""
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, REPO)

from datamaps import pipelines as pipelines_mod  # noqa: E402
from datamaps.ingest import pipeline as ingest_mod  # noqa: E402

SIMULATE_BODY = {"docs": [{"_source": {"message": ""}}]}


def targets(env):
    cribl = None
    if env.get("CRIBL_URL"):
        cribl = (env["CRIBL_URL"].rstrip("/"), env.get("CRIBL_USER", "admin"),
                 env.get("CRIBL_PASSWORD", ""))
    es = env["ES_URL"].rstrip("/") if env.get("ES_URL") else None
    return {"cribl": cribl, "es": es}


def request(method, url, body=None, headers=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def cribl_login(url, user, password):
    status, text = request("POST", url + "/api/v1/auth/login",
                           {"username": user, "password": password})
    if status != 200:
        raise SystemExit("Cribl login failed: %s %s" % (status, text[:200]))
    return json.loads(text)["token"]


def cribl_version(url, token):
    status, text = request("GET", url + "/api/v1/system/info",
                           headers={"Authorization": "Bearer " + token})
    if status != 200:
        return "unknown"
    try:
        return json.loads(text).get("BUILD", {}).get("VERSION", "unknown")
    except ValueError:
        return "unknown"


def cribl_validate(url, token, pipelines):
    auth = {"Authorization": "Bearer " + token}
    results = []
    for key in sorted(pipelines):
        doc = pipelines[key]
        pid = doc["id"]
        request("DELETE", url + "/api/v1/pipelines/" + pid, headers=auth)
        status, text = request("POST", url + "/api/v1/pipelines", doc, headers=auth)
        results.append({"id": pid, "key": "%s/%s__%s" % key, "ok": status == 200,
                        "status": status, "detail": "" if status == 200 else text[:2000]})
        request("DELETE", url + "/api/v1/pipelines/" + pid, headers=auth)
        sys.stdout.write("cribl %s %s\n" % (status, pid))
    return results


def es_version(url):
    status, text = request("GET", url)
    if status != 200:
        return "unknown"
    try:
        return json.loads(text)["version"]["number"]
    except (ValueError, KeyError):
        return "unknown"


def es_validate(url, envelopes):
    results = []
    for key in sorted(envelopes):
        env = envelopes[key]
        pid = env["id"]
        status, text = request("PUT", url + "/_ingest/pipeline/" + pid, env["pipeline"])
        ok = status == 200
        detail = "" if ok else text[:2000]
        if ok:
            s2, t2 = request("POST", url + "/_ingest/pipeline/" + pid + "/_simulate",
                             SIMULATE_BODY)
            if s2 != 200:
                ok, status, detail = False, s2, t2[:2000]
        results.append({"id": pid, "key": "%s/%s__%s" % key, "ok": ok,
                        "status": status, "detail": detail})
        request("DELETE", url + "/_ingest/pipeline/" + pid)
        sys.stdout.write("es %s %s\n" % (status, pid))
    return results


def _section(name, results, skipped_reason):
    if results is None:
        return ["## %s: skipped (%s)" % (name, skipped_reason), ""]
    ok = sum(1 for r in results if r["ok"])
    lines = ["## %s: %d of %d accepted" % (name, ok, len(results)), ""]
    failures = [r for r in results if not r["ok"]]
    if not failures:
        lines.append("No failures.")
    for r in failures:
        lines.append("### %s (`%s`) — HTTP %s" % (r["key"], r["id"], r["status"]))
        lines.append("")
        lines.append("```")
        lines.append(r["detail"])
        lines.append("```")
        lines.append("")
    lines.append("")
    return lines


def write_report(path, cribl_results, es_results, meta):
    lines = ["# Live validation — %s" % meta["date"], "",
             "| target | endpoint | version |", "|---|---|---|",
             "| Cribl Stream | %s | %s |" % (meta.get("cribl") or "—",
                                            meta.get("cribl_version") or "—"),
             "| Elasticsearch | %s | %s |" % (meta.get("es") or "—",
                                             meta.get("es_version") or "—"), "",
             "A green line means the target accepted the pipeline: schema and conf "
             "valid for Cribl, compiled and loaded for Elasticsearch. Neither proves "
             "correct parsing of real events.", ""]
    lines += _section("Cribl", cribl_results, "CRIBL_URL unset")
    lines += _section("Elasticsearch", es_results, "ES_URL unset")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines).rstrip() + "\n")


def main():
    t = targets(os.environ)
    if not t["cribl"] and not t["es"]:
        sys.stderr.write("set CRIBL_URL and/or ES_URL\n")
        return 2
    loaded = pipelines_mod.load_pipelines(os.path.join(REPO, "data"))
    envelopes = ingest_mod.translate_all(loaded)
    meta = {"date": datetime.date.today().isoformat(), "cribl": None, "es": None,
            "cribl_version": None, "es_version": None}
    cribl_results = es_results = None
    if t["cribl"]:
        url, user, password = t["cribl"]
        token = cribl_login(url, user, password)
        meta["cribl"] = url
        meta["cribl_version"] = cribl_version(url, token)
        cribl_results = cribl_validate(url, token, loaded)
    if t["es"]:
        meta["es"] = t["es"]
        meta["es_version"] = es_version(t["es"])
        es_results = es_validate(t["es"], envelopes)
    path = os.path.join(REPO, "docs", "verification",
                        "%s-live-validation.md" % meta["date"])
    write_report(path, cribl_results, es_results, meta)
    sys.stdout.write("report: %s\n" % os.path.relpath(path, REPO))
    failed = sum(1 for rs in (cribl_results, es_results) if rs
                 for r in rs if not r["ok"])
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Compose file and README**

`tools/validate_live/compose.yml` (a throwaway Elasticsearch with the Painless regex setting; Cribl is expected to be an existing instance but a service is provided for machines without one):

```yaml
services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.15.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - script.painless.regex.enabled=true
      - ES_JAVA_OPTS=-Xms1g -Xmx1g
    ports:
      - "9200:9200"
  cribl:
    image: cribl/cribl:4.19.0
    environment:
      - CRIBL_DIST_MODE=single
    ports:
      - "19000:9000"
    profiles: ["cribl"]
```

`tools/validate_live/README.md`:

```markdown
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
```

Create `docs/verification/.gitkeep` (empty).

- [ ] **Step 5: Runbook section**

Append to `docs/wiki/Runbooks.md`:

```markdown
## Live validation

Before enabling public hosting, and after any change to `data/pipelines/`
or `datamaps/ingest/`, run the live validation described in
`tools/validate_live/README.md` and commit the report it writes under
`docs/verification/`.  CI runs the offline lint and the transpiler tests on
every push; this is the one check that needs a real Cribl and a real
Elasticsearch, so it is run by a person and recorded.

A report proves acceptance — Cribl took the conf, Elasticsearch compiled the
processors.  It does not prove parsing correctness: this repository holds no
example records to run through either.
```

- [ ] **Step 6: Run**

Run: `python3 -m unittest tests.test_validate_live -v` → PASS. `python3 -m unittest discover -s tests` → `OK`.

- [ ] **Step 7: Commit**

```bash
git add tools/validate_live/compose.yml tools/validate_live/validate.py tools/validate_live/README.md docs/verification/.gitkeep docs/wiki/Runbooks.md tests/test_validate_live.py
git commit -m "tools: live validation against Cribl and Elasticsearch, with a committed report

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: README and wiki

**Files:**
- Modify: `README.md`
- Create: `docs/wiki/Picker.md`
- Modify: `docs/wiki/_Sidebar.md`, `docs/wiki/Home.md`, `docs/wiki/Troubleshooting.md`, `docs/wiki/Glossary.md`
- Modify: `tests/test_wiki.py` only if a test enumerates pages by name (check with `grep -n "Studio-tasks" tests/test_wiki.py`); otherwise no test change.

- [ ] **Step 1: README — introduction and layout**

In the first paragraph of `README.md`, change `and Studio, a browser editor and log-analysis workbench.` to `Studio, a browser editor and log-analysis workbench, and the Picker, which hands a consumer one feed's map together with its Cribl pipeline or an Elasticsearch ingest pipeline translated from it.`

In `## Repository layout`, add rows (match the existing list style there) for:
- `data/pipelines/<tech>/<dataset>__<format>.json` — the committed Cribl Stream 4.19 pipelines, one per format block
- `datamaps/pipelines.py`, `datamaps/cribl_lint.py`, `datamaps/ingest/`, `datamaps/export_text.py`
- `static/picker/`, `templates/picker.html.j2`, `templates/_format_block.html.j2`
- `tools/pipelines/`, `tools/validate_live/`, `docs/verification/`

- [ ] **Step 2: README — the Picker section**

Insert a new `### The Picker` subsection at the end of `## The published site` (after `### Studio`), containing: the flow (technology → dataset → wire format → Cribl in path → destination), the URL-hash link format with the `cisco-asa/device-admin/snmp-trap` example, what each output is (map HTML/JSON/Markdown/CSV; Cribl pipeline verbatim; ingest envelope with coverage), the three special states (Elastic-parsed downstream note; `mechanism: none`; no pipeline yet), and the note that fragments with example-record links resolve relative to the fragment path.

- [ ] **Step 3: README — Cribl pipelines and the translation**

Insert a new top-level section `## Cribl pipelines and the Elasticsearch translation` before `## Building locally`, with three subsections:

`### The committed pipelines` — provenance (agents + brief + live 4.19 acceptance, September 2026), the invariants the build enforces (orphan → error, id → error, `no-pipeline` → flag), the lint (`python3 -m datamaps.cribl_lint`), and the regeneration pointer to `tools/pipelines/README.md`.

`### What translates and what does not` — reproduce the function table from spec §3.4 (as amended), then the expression subset list from §3.3 in prose, then the field map table (`_time` → `@timestamp`, `_raw` → `message`, `__*` → untranslatable), then the semantic divergences worth knowing: `parseInt` on non-numeric text is `null` here (Painless throws; the per-row try/catch swallows it) where JavaScript gives `NaN`; string-pattern `.replace` replaces all occurrences; `gsub` replaces all matches even where the Cribl rule lacked `g`; loose `==` against a literal compares as strings; `.length` is refused because strings and lists differ.

`### What verification means` — CI checks (lint, transpiler tests, corpus coverage floor, export parity); the live validation runbook; the plain statement about acceptance versus parsing correctness.

- [ ] **Step 4: Wiki**

`docs/wiki/Picker.md` — task-shaped, like `Studio-tasks.md`: "I have Cisco ASA sending CEF to Cribl and I want the pipeline", "I do not run Cribl; what do I load into Elasticsearch", "The ingest pipeline says N manual steps", "I want to send someone this exact result" (the hash link), "The format I have is not listed". Use `{{REPO}}` for repository links as the other pages do.

`docs/wiki/_Sidebar.md` — under **Doing something** add `  - [Picker](Picker)` after Studio tasks.

`docs/wiki/Home.md` — under **Start here** add `- **I need one feed's pipeline or its map** → [Picker](Picker)`.

`docs/wiki/Troubleshooting.md` — add `## My ingest pipeline has manual steps` (what a manual step is, why it is omitted rather than stubbed, how to finish it by hand from the original Cribl function shown) and `## Elasticsearch rejects the ingest pipeline with a regex error` (the `script.painless.regex.enabled` node setting).

`docs/wiki/Glossary.md` — add entries for *Picker*, *ingest pipeline*, *envelope*, *manual step*, *partial step*, *coverage*.

- [ ] **Step 5: Run the wiki tests and the suite**

Run: `python3 -m unittest tests.test_wiki -v` → PASS. `python3 -m unittest discover -s tests` → `OK`.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/wiki/Picker.md docs/wiki/_Sidebar.md docs/wiki/Home.md docs/wiki/Troubleshooting.md docs/wiki/Glossary.md
git commit -m "docs: Picker and translation sections in the README; Picker wiki page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: GitHub Pages workflow (gated)

**Files:**
- Create: `.github/workflows/pages.yml`
- Modify: `docs/wiki/Runbooks.md` (mirror-token step)

This task ends at a manual step the repository owner performs; the file is committed but the mirror will reject the push until that step is done. Say so in the task's completion report.

- [ ] **Step 1: Workflow**

`.github/workflows/pages.yml`:

```yaml
name: pages
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  test-js:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: node --test studio/tests/*.test.js static/picker/tests/*.test.js
  build:
    needs: [test-js]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install -r requirements.txt
      - run: python -m unittest discover -s tests
      - run: python -m datamaps.build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: public
  deploy:
    needs: [build]
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Runbook**

Append to the "Publish the site" section of `docs/wiki/Runbooks.md`:

```markdown
### Public hosting on GitHub Pages

`.github/workflows/pages.yml` builds and publishes the site from the GitHub
mirror. Two one-time steps by the repository owner gate it:

1. The Forgejo → GitHub push-mirror credential must carry the `workflow`
   scope, or GitHub refuses the push that carries this file. Reissue the
   token with that scope and update the mirror's credential in Forgejo.
2. In the GitHub repository settings, set Pages → Source to **GitHub
   Actions**. Do this only after a report exists under
   `docs/verification/`.
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pages.yml docs/wiki/Runbooks.md
git commit -m "ci: GitHub Pages workflow for the mirror, gated on the mirror token scope

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Report that the push-mirror will fail on this commit until the owner reissues the mirror token with `workflow` scope, and that `main` on Forgejo is otherwise complete.

---

## Self-review notes

- Spec §2 → Tasks 1–4. §2.2's `pipeline-for-none` hard failure is in `check_pipelines`. §2.4's deletions are in Task 3.
- Spec §3 → Tasks 5–9. The `eval` `ignore_failure` wording in §3.4 is implemented as per-row `try/catch` inside one `script` processor (Task 8), which is the closer match to Cribl's per-row semantics; `set`/`copy_from` cannot fail. Partial steps, notes, `requires`, `field_map` all present.
- Spec §4 → Tasks 10–12. The spec's separate `fragment.html.j2` is replaced by rendering the partial directly (`render.fragment_html`); same outcome, one fewer file.
- Spec §5 → Tasks 13–14. Texts and states pinned by `render.test.js`.
- Spec §6 → Task 15 plus the CI additions in Tasks 2, 9, 14.
- Spec §7 → Task 17, with the mirror-token constraint.
- Spec §9 housekeeping → Tasks 1, 3, 16.
