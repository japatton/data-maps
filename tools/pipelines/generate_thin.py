#!/usr/bin/env python3
"""Emit the thin (pass-through) Cribl pipelines deterministically.

A format block whose parsing.mechanism defers to Elastic needs no parsing in
Cribl: re-implementing the integration's grok fights it and produces duplicate
or conflicting fields. Those pipelines are mechanical - a comment saying why,
and one eval tagging event.dataset - so a script emits them more consistently
than 78 separate model agents would.

Mechanism `none` gets no pipeline at all; the catalog says Cribl is not in that
path. Those are counted and reported, not written.

Constraints verified against the live Cribl 4.19 instance:
  - `comment` conf has a 1000-character maxLength (HTTP 400 beyond it).
  - a field path containing `@` is rejected by the property-accessor parser,
    so `@timestamp` can never be a rename/eval target; `_time` is the canonical
    Cribl time field and the Elastic destination maps it to `@timestamp`.
  - `event.dataset` must not contain a hyphen: it becomes the dataset component
    of an Elastic data stream name, which forbids `-`.
"""
import argparse
import glob
import json
import os
import re
import sys

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(REPO, "data", "technologies")
OUT = os.path.join(REPO, "data", "pipelines")
sys.path.insert(0, REPO)
from datamaps import cribl_paths  # noqa: E402
THIN = {"elastic-integration", "elastic-ingest-pipeline"}
# The three pilot technologies' thin-mechanism pipelines were hand-authored
# during the pilot - several of them parse the format in Cribl anyway, with
# reasoning this script has no way to reproduce - so the committed files are
# authoritative and must not be regenerated.
SKIP = {"cisco-asa", "apache-httpd", "entra-id"}
COMMENT_MAX = 1000


def ident(*parts):
    return re.sub(r"[^a-z0-9]+", "_", "_".join(parts).lower()).strip("_")


def dataset_tag(tech_id, ds_id):
    return "%s.%s" % (re.sub(r"[^a-z0-9]+", "_", tech_id.lower()),
                      re.sub(r"[^a-z0-9]+", "_", ds_id.lower()))


def comment_for(tech, ds, fmt, mech, artifact):
    why = ("the Elastic integration is the parser downstream"
           if mech == "elastic-integration" else
           "the Elastic ingest pipeline decodes this downstream")
    text = (
        "%s / %s / %s. Parsing is deliberately NOT implemented here: %s%s. "
        "Re-implementing that parsing in Cribl would fight it and yield "
        "duplicate or conflicting fields, so this pipeline only identifies the "
        "event and tags event.dataset, then passes _raw through unmodified. "
        "Direct route (no cross-domain guard hop)."
        % (tech, ds, fmt, why,
           " (%s)" % artifact if artifact else "")
    )
    return text[:COMMENT_MAX]


def main(out_dir=None):
    out_root = out_dir or OUT
    made = skipped_none = 0
    for path in sorted(glob.glob(os.path.join(DATA, "*.yml"))):
        tech_id = os.path.basename(path)[:-4]
        if tech_id in SKIP:
            continue
        doc = yaml.safe_load(open(path))
        outdir = os.path.join(out_root, tech_id)
        for ds in doc.get("datasets") or []:
            for fmt in ds.get("formats") or []:
                parsing = fmt.get("parsing") or {}
                mech = parsing.get("mechanism")
                fmt_name = fmt.get("format") or "unknown"
                if mech == "none":
                    skipped_none += 1
                    continue
                if mech not in THIN:
                    continue
                tag = dataset_tag(tech_id, ds["id"])
                pipeline = {
                    "id": "dm_" + ident(tech_id, ds["id"], fmt_name),
                    "conf": {
                        "output": "default",
                        "description": ("%s %s / %s: thin pass-through, parsing deferred "
                                        "to Elastic (%s)." % (doc.get("name") or tech_id,
                                                              ds["id"], fmt_name, mech))[:1000],
                        "functions": [
                            {"id": "comment", "filter": "true",
                             "conf": {"comment": comment_for(tech_id, ds["id"], fmt_name,
                                                             mech, parsing.get("artifact"))},
                             "description": "record why this pipeline does not parse"},
                            {"id": "eval", "filter": "true",
                             "conf": {"add": [{"name": "'event.dataset'", "value": "'%s'" % tag}]},
                             "description": "tag the dataset before Elastic parses _raw"},
                            cribl_paths.renest_function(),
                        ],
                    },
                }
                os.makedirs(outdir, exist_ok=True)
                fn = os.path.join(outdir, "%s__%s.json" % (ds["id"], fmt_name))
                with open(fn, "w", encoding="utf-8") as fh:
                    json.dump(pipeline, fh, indent=2, ensure_ascii=False)
                    fh.write("\n")
                made += 1
    print("thin pipelines written: %d" % made)
    print("mechanism=none recorded, no pipeline: %d" % skipped_none)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=OUT, metavar="DIR",
                    help="write the pipelines under DIR/<tech>/ instead of "
                         "data/pipelines (the tests regenerate into a scratch "
                         "directory and diff against the committed bytes)")
    main(ap.parse_args().out)
