"""Build entry point: data/ -> public/ (site pages + JSON exports).

Both directories move:

    python3 -m datamaps.build [--data DIR] [--out DIR]

and programmatically, main(data_dir=..., out_dir=...), which is how the
tests build into a temporary directory instead of over ./public/.
Templates, static files and the Studio sources still come from ROOT.
"""
import argparse
import datetime
import json
import os
import shutil
import sys

from datamaps import examples as examples_mod
from datamaps import model as model_mod
from datamaps import pipelines as pipelines_mod
from datamaps import studio as studio_mod
from datamaps import export_text, render, schema, yamlio
from datamaps.ingest import pipeline as ingest_mod

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_inputs(data_dir):
    catalog = yamlio.load(os.path.join(data_dir, "catalog.yml"))
    profiles = yamlio.load(os.path.join(data_dir, "profiles",
                                        "alerting.yml"))
    ecs_path = os.path.join(data_dir, "reference", "ecs.json")
    with open(ecs_path, encoding="utf-8") as fh:
        try:
            ecs = json.load(fh)
        except ValueError as exc:
            # JSONDecodeError carries a line and column and no file name, so
            # the FATAL line would not say which file to look at.
            raise ValueError("%s: %s" % (ecs_path, exc))
    technologies = {}
    tech_dir = os.path.join(data_dir, "technologies")
    if os.path.isdir(tech_dir):
        for name in sorted(os.listdir(tech_dir)):
            if name.endswith(".yml"):
                technologies[name[:-4]] = yamlio.load(
                    os.path.join(tech_dir, name))
    return catalog, technologies, profiles, ecs


def load_studio_config(data_dir):
    return yamlio.load(os.path.join(data_dir, "studio.yml"))


# Bumped when a consumer would have to change to keep reading these
# files. Additive keys do not bump it; renamed or removed ones do.
SCHEMA_VERSION = 1


def _write_json(exports_dir, name, payload):
    path = os.path.join(exports_dir, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


def _dataset_coverage(ds_view):
    return {
        "required_total": len(ds_view["required"]),
        "required_mapped": len(ds_view["required_mapped"]),
        "required_pct": ds_view["required_pct"],
        "closable": list(ds_view["closable"]),
        "unobtainable": list(ds_view["unobtainable"]),
    }


def _format_export(fmt_view):
    """The authored format, its fields annotated with the derived flag.

    Copied at every level the annotation reaches: the loaded documents
    are shared with the page model and must come out unchanged.
    """
    payload = dict(fmt_view["data"])
    fields = []
    for fv in fmt_view["fields"]:
        field = dict(fv["field"])
        field["alerting_required"] = bool(fv["alerting"])
        fields.append(field)
    payload["fields"] = fields
    return payload


def _dataset_export(ds_view):
    payload = dict(ds_view["data"])
    payload["formats"] = [_format_export(fv) for fv in ds_view["formats"]]
    payload["recommendation"] = {
        "format": ds_view["recommendation"]["data"]["format"],
        "source": ds_view["recommendation_source"],
    }
    payload["coverage"] = _dataset_coverage(ds_view)
    return payload


def _usage_export(usage):
    return {"technology": usage["tech"]["id"],
            "dataset": usage["dataset"],
            "format": usage["format"],
            "vendor": usage["vendor"],
            "status": usage["status"],
            "recommended": usage["recommended"]}


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
            datasets.append({
                "id": ds["id"], "name": ds.get("name"),
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


def write_exports(page_model, out_dir):
    exports_dir = os.path.join(out_dir, "exports")
    os.makedirs(exports_dir)
    catalog_dump = []
    dataset_dump = []
    for view in page_model["technologies"]:
        entry = dict(view["entry"])
        entry["coverage"] = {
            "required_pct": view["required_pct"],
            "required_mapped": view["required_mapped"],
            "required_total": view["required_total"],
            "fields_mapped": view["fields_mapped"],
            "fields_total": view["fields_total"],
        }
        catalog_dump.append(entry)
        for ds_view in view["datasets"]:
            ds = ds_view["data"]
            dataset_dump.append({
                "technology": view["entry"]["id"],
                "id": ds["id"],
                "name": ds["name"],
                "event_categories": list(ds["event_categories"]),
                "recommendation": {
                    "format": ds_view["recommendation"]["data"]["format"],
                    "source": ds_view["recommendation_source"],
                },
                "coverage": _dataset_coverage(ds_view),
            })
        if view["doc"]:
            payload = {"schema_version": SCHEMA_VERSION}
            payload.update(view["doc"])
            # ds_view["data"] is the authored dataset, so the document's
            # own list is not zipped alongside it.
            payload["datasets"] = [_dataset_export(ds_view)
                                   for ds_view in view["datasets"]]
            listing = []
            for ds_view in view["datasets"]:
                for rec in ds_view["examples"]:
                    listing.append({"dataset": rec["dataset"],
                                    "label": rec["label"],
                                    "path": "examples/" + rec["relpath"]})
            if listing:
                payload["examples"] = listing
            _write_json(exports_dir, view["entry"]["id"] + ".json", payload)
    _write_json(exports_dir, "catalog.json", {
        "schema_version": SCHEMA_VERSION,
        "ecs_version": page_model["ecs_version"],
        "technologies": catalog_dump,
        "datasets": dataset_dump,
    })
    _write_json(exports_dir, "alerting.json", {
        "schema_version": SCHEMA_VERSION,
        "ecs_version": page_model["ecs_version"],
        "profiles": dict(
            (category, {"required": list(body["required"])})
            for category, body in page_model["profiles"].items()),
        "matrix": page_model["alerting_matrix"],
    })
    _write_json(exports_dir, "ecs-index.json", {
        "schema_version": SCHEMA_VERSION,
        "ecs_version": page_model["ecs_version"],
        "fields": [{"name": entry["name"],
                    "type": entry["type"],
                    "short": entry["short"],
                    "required_in": list(entry["required_in"]),
                    "usages": [_usage_export(u) for u in entry["usages"]]}
                   for entry in page_model["ecs_index"]],
    })


ENV_HELP = """\
environment:
  These override data/studio.yml key by key, so one branch can publish
  two different sites.  Unset, the committed file stands.

    STUDIO_REPOSITORY_KIND            gitlab | forgejo
    STUDIO_REPOSITORY_API_URL         e.g. https://gitlab.example/api/v4
    STUDIO_REPOSITORY_PROJECT         group/project
    STUDIO_REPOSITORY_DEFAULT_BRANCH  e.g. main
    STUDIO_REPOSITORY_WEB_IDE_URL     with {project} {branch} {path}
    STUDIO_ANALYSIS_API_KIND          openai | azure
    STUDIO_ANALYSIS_API_URL           the analysis endpoint
    STUDIO_ANALYSIS_MODEL             model, or Azure deployment name
    STUDIO_ANALYSIS_API_VERSION       Azure only; empty otherwise
    STUDIO_ANALYSIS_ALLOW_OVERRIDE    true | false
    STUDIO_ELASTIC_URL                Elasticsearch base URL, or empty

    STUDIO_ALLOWED_HOSTS              comma-separated hostnames; the build
                                      fails if any URL in the effective
                                      config resolves outside the list

  No secret belongs in any of these.  The site is static and config.json
  is served to every browser, so a token or API key set here would be
  published; the build refuses the key names outright.

exit status:
  0 on success, 1 on any error.  Problems are printed as FATAL lines on
  stderr; validation collects them and prints one line per problem, but
  a bad STUDIO_* value or an unreadable file stops at the first.
"""


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="python3 -m datamaps.build",
        description="Build the authored data into a static site.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=ENV_HELP)
    parser.add_argument("--data", metavar="DIR", default=None,
                        help="authored data (default: <repo>/data)")
    parser.add_argument("--out", metavar="DIR", default=None,
                        help="site output, replaced wholesale "
                             "(default: <repo>/public)")
    return parser.parse_args(argv)


def resolve_dirs(argv, data_dir, out_dir):
    """Where to read and write: arguments win, then options, then defaults."""
    opts = parse_args(argv or [])
    return (data_dir or opts.data or os.path.join(ROOT, "data"),
            out_dir or opts.out or os.path.join(ROOT, "public"))


def check_out_dir(out_dir, data_dir):
    """Reasons out_dir must not be emptied, or None if it is safe.

    The build does shutil.rmtree(out_dir) before writing.  Nothing used to
    stop that directory being the data it had just read - the inputs are
    already in memory by then, so `--out data` deleted data/technologies,
    wrote the site over it and exited 0 with a success line.  `--out .`
    would have taken .git with it.
    """
    out = os.path.abspath(out_dir)
    data = os.path.abspath(data_dir)
    if out == data:
        return ("refusing to build into the data directory: %s\n"
                "       the build empties its output directory, and that is "
                "where the technology files live" % out)
    if data.startswith(out + os.sep):
        return ("refusing to build into %s: it contains the data directory "
                "%s\n       the build empties its output directory" % (out, data))
    if os.path.isdir(os.path.join(out, ".git")):
        return ("refusing to build into %s: it holds a git repository\n"
                "       the build empties its output directory" % out)
    return None


def main(argv=None, data_dir=None, out_dir=None, environ=None):
    """Build data_dir into out_dir; return a process exit code.

    The command line is read only when the call names nothing at all: a
    programmatic caller passing data_dir, out_dir or environ never inherits
    sys.argv, and a test that passes only environ is one of those.

    environ is the environment the Studio config overlay reads (default
    os.environ): STUDIO_<SECTION>_<KEY> overrides data/studio.yml, and
    STUDIO_ALLOWED_HOSTS locks the URLs the built site may point at.
    """
    if (argv is None and data_dir is None and out_dir is None
            and environ is None):
        argv = sys.argv[1:]
    data_dir, out_dir = resolve_dirs(argv, data_dir, out_dir)
    if environ is None:
        environ = os.environ
    refusal = check_out_dir(out_dir, data_dir)
    if refusal:
        sys.stderr.write("FATAL: %s\n" % refusal)
        return 1
    try:
        catalog, technologies, profiles, ecs = load_inputs(data_dir)
        config = load_studio_config(data_dir)
    except (yamlio.DataError, OSError, ValueError) as exc:
        sys.stderr.write("FATAL: %s\n" % exc)
        return 1
    try:
        config, from_env = studio_mod.overlay_env(config, environ)
    except ValueError as exc:
        sys.stderr.write("FATAL: %s\n" % exc)
        return 1
    if from_env:
        print("studio config: keys from environment: %s"
              % ", ".join(from_env))
    errors = schema.validate_all(catalog, technologies, profiles, ecs)
    errors.extend(studio_mod.validate_config(config))
    # Example discovery indexes catalog rows by row["id"], so it runs after
    # the schema has confirmed there is one.  Before, a catalog row missing
    # its id raised KeyError out of the build and buried the FATAL line that
    # says exactly that.  When the data is valid this still reports schema
    # and example problems together, in one pass.
    records = []
    if not errors:
        records, example_errors = examples_mod.discover(data_dir, catalog,
                                                        technologies)
        errors.extend(example_errors)
    if errors:
        for error in errors:
            sys.stderr.write("FATAL: %s\n" % error)
        return 1
    # The endpoint lock, on the config the site will actually ship.  A
    # blank value counts as unset: an empty allow-list would forbid
    # every URL, which is never what setting the variable meant.
    allowed = studio_mod.parse_allowed_hosts(
        environ.get(studio_mod.ALLOWED_HOSTS_ENV))
    if allowed:
        host_errors = studio_mod.check_hosts(config, allowed)
        if host_errors:
            for error in host_errors:
                sys.stderr.write("FATAL: %s\n" % error)
            return 1
    page_model = model_mod.build_model(
        catalog, technologies, profiles, ecs,
        examples_mod.by_dataset(records))
    try:
        loaded = pipelines_mod.load_pipelines(data_dir)
        page_model["flags"].extend(
            pipelines_mod.check_pipelines(loaded, page_model))
    except pipelines_mod.PipelineError as exc:
        for message in exc.messages:
            sys.stderr.write("FATAL: %s\n" % message)
        return 1
    page_model["pipelines"] = loaded
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir)
    env = render.build_env(ROOT)
    render.render_site(page_model, ROOT, out_dir)
    write_exports(page_model, out_dir)
    envelopes = write_block_exports(page_model, out_dir, data_dir, env)
    page_model["ingest"] = envelopes
    write_picker_index(page_model, out_dir, envelopes)
    examples_mod.publish(records, out_dir)
    studio_mod.publish(ROOT, out_dir, catalog, technologies, profiles, ecs,
                       config, records)
    print("Built %s: %d technologies (%d with maps), %d datasets, "
          "%d examples, %d pipelines, %d flags"
          % (out_dir,
             page_model["summary"]["technologies"],
             sum(1 for v in page_model["technologies"] if v["doc"]),
             page_model["summary"]["datasets"],
             len(records),
             len(page_model["pipelines"]),
             len(page_model["flags"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
