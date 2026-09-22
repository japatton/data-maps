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
