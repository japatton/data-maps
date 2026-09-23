"""Raw example records: data/examples/<tech>/<dataset>[-<label>].log

Sidecar files, never parsed and never linted - discovered, validated,
rendered inline and published byte-exact. The whole layout lives here so
nothing else in the package learns the directory shape. Stdlib only.

data/samples/ has the same layout and holds third-party records - vendor
test fixtures and pack samples - rather than records captured from our own
feeds.  Those are somebody else's data under somebody else's licence, so
every sample needs a row in data/samples/SOURCES.json naming its upstream
repository, pinned commit, upstream paths and licence, and the licence text
must sit in data/samples/LICENSES/.  A sample without its row is fatal.
The manifest, NOTICE.md and LICENSES/ publish beside the samples.
data/examples/ needs none of that: Studio attaches captured records there.
"""
import glob
import json
import os
import shutil

# Above this, the file gets a soft flag asking for a representative record.
MAX_BYTES = 262144
# Inline HTML is capped here; the download link always serves every byte.
INLINE_BYTES = 32768
# Controlled documentation: a real record here would defeat the map's
# deliberate placeholder policy.
EXCLUDED = frozenset(["everfox-hsg"])
EXAMPLES = "examples"
SAMPLES = "samples"
# Provenance for data/samples/, relative to that directory.
MANIFEST = "SOURCES.json"
NOTICE = "NOTICE.md"
LICENSES = "LICENSES"
_SOURCE_KEYS = ("repo", "commit", "license", "license_file")


def resolve_stem(stem, dataset_ids):
    """Map a file stem to (dataset_id, label), or (None, None).

    Dataset ids contain hyphens, so the match is longest-prefix and the
    prefix must end at the stem's end or at a '-': 'nx-alerts' does not
    match dataset 'nx-alert'.
    """
    best = None
    for ds_id in dataset_ids:
        if stem != ds_id and not stem.startswith(ds_id + "-"):
            continue
        if best is None or len(ds_id) > len(best):
            best = ds_id
    if best is None:
        return None, None
    if stem == best:
        return best, "example"
    return best, stem[len(best) + 1:].replace("-", " ")


def _read(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    truncated = len(raw) > INLINE_BYTES
    text = raw[:INLINE_BYTES].decode("utf-8", "replace")
    return len(raw), text, truncated


def discover(data_dir, catalog, technologies):
    """Find every example file; return (sorted records, FATAL strings)."""
    return _discover(data_dir, EXAMPLES, "example", catalog, technologies)


def _load_manifest(root, errors):
    """(sources, files) from SOURCES.json, reporting what is wrong with it."""
    path = os.path.join(root, MANIFEST)
    if not os.path.isfile(path):
        errors.append("samples: %s is missing; every sample needs a "
                      "provenance row" % MANIFEST)
        return {}, {}
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except ValueError as exc:
        errors.append("samples: %s is not valid JSON: %s" % (MANIFEST, exc))
        return {}, {}
    sources = doc.get("sources") or {}
    for name, src in sorted(sources.items()):
        missing = [k for k in _SOURCE_KEYS if not src.get(k)]
        if missing:
            errors.append("samples: source '%s' lacks %s"
                          % (name, ", ".join(missing)))
        elif not os.path.isfile(os.path.join(root, src["license_file"])):
            errors.append("samples: source '%s' licence file %s does not "
                          "exist" % (name, src["license_file"]))
    return sources, doc.get("files") or {}


def discover_samples(data_dir, catalog, technologies):
    """Every third-party sample with its provenance; (records, FATALs)."""
    root = os.path.join(data_dir, SAMPLES)
    if not glob.glob(os.path.join(root, "*", "*.log")):
        return [], []
    errors = []
    sources, files = _load_manifest(root, errors)
    found, layout_errors = _discover(data_dir, SAMPLES, "sample", catalog,
                                     technologies)
    errors.extend(layout_errors)
    on_disk = set("%s/%s" % (os.path.basename(os.path.dirname(p)),
                             os.path.basename(p))
                  for p in glob.glob(os.path.join(root, "*", "*.log")))
    records = []
    for rec in found:
        where = "sample '%s'" % rec["relpath"]
        row = files.get(rec["relpath"])
        if not row:
            errors.append("%s: no provenance row in %s" % (where, MANIFEST))
            continue
        src = sources.get(row.get("source"))
        if src is None:
            errors.append("%s: provenance names unknown source '%s'"
                          % (where, row.get("source")))
            continue
        rec["source"] = {"name": row["source"], "repo": src["repo"],
                         "commit": src["commit"], "license": src["license"],
                         "paths": list(row.get("paths") or [])}
        records.append(rec)
    for relpath in sorted(set(files) - on_disk):
        errors.append("samples: %s has a provenance row for %s but no such "
                      "file" % (MANIFEST, relpath))
    return records, errors


def _discover(data_dir, subdir, noun, catalog, technologies):
    records = []
    errors = []
    catalog_ids = set(row["id"] for row in catalog["technologies"])
    root = os.path.join(data_dir, subdir)
    for path in sorted(glob.glob(os.path.join(root, "*", "*.log"))):
        tech_id = os.path.basename(os.path.dirname(path))
        name = os.path.basename(path)
        where = "%s '%s/%s'" % (noun, tech_id, name)
        if tech_id not in catalog_ids:
            errors.append("%s: '%s' is not a catalog technology"
                          % (where, tech_id))
            continue
        if tech_id in EXCLUDED:
            errors.append("%s: technology '%s' is excluded from %ss "
                          "(controlled documentation)"
                          % (where, tech_id, noun))
            continue
        doc = technologies.get(tech_id) or {"datasets": []}
        dataset_ids = [ds["id"] for ds in doc["datasets"]]
        ds_id, label = resolve_stem(name[:-4], dataset_ids)
        if ds_id is None:
            errors.append("%s: stem does not name a dataset of '%s'"
                          % (where, tech_id))
            continue
        size, text, truncated = _read(path)
        records.append({
            "tech": tech_id, "dataset": ds_id, "label": label,
            "path": path, "relpath": "%s/%s" % (tech_id, name),
            "size": size, "text": text, "truncated": truncated,
            "root": subdir,
        })
    records.sort(key=lambda r: (r["tech"], r["dataset"], r["label"]))
    return records, errors


def by_dataset(records):
    grouped = {}
    for rec in records:
        grouped.setdefault((rec["tech"], rec["dataset"]), []).append(rec)
    return grouped


def publish(records, out_dir, data_dir=None):
    """Copy every record verbatim to <out_dir>/<root>/<relpath>.

    Samples take their manifest, NOTICE.md and LICENSES/ with them (from
    `data_dir`), so a download carries the licence it is distributed under.
    """
    if data_dir and any(r.get("root") == SAMPLES for r in records):
        src = os.path.join(data_dir, SAMPLES)
        dest = os.path.join(out_dir, SAMPLES)
        if not os.path.isdir(dest):
            os.makedirs(dest)
        for name in (MANIFEST, NOTICE):
            if os.path.isfile(os.path.join(src, name)):
                shutil.copyfile(os.path.join(src, name),
                                os.path.join(dest, name))
        if os.path.isdir(os.path.join(src, LICENSES)):
            shutil.copytree(os.path.join(src, LICENSES),
                            os.path.join(dest, LICENSES), dirs_exist_ok=True)
    for rec in records:
        target = os.path.join(out_dir, rec.get("root", EXAMPLES),
                              *rec["relpath"].split("/"))
        directory = os.path.dirname(target)
        if not os.path.isdir(directory):
            os.makedirs(directory)
        shutil.copyfile(rec["path"], target)
