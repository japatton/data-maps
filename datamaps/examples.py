"""Raw example records: data/examples/<tech>/<dataset>[-<label>].log

Sidecar files, never parsed and never linted - discovered, validated,
rendered inline and published byte-exact. The whole layout lives here so
nothing else in the package learns the directory shape. Stdlib only.
"""
import glob
import os
import shutil

# Above this, the file gets a soft flag asking for a representative record.
MAX_BYTES = 262144
# Inline HTML is capped here; the download link always serves every byte.
INLINE_BYTES = 32768
# Controlled documentation: a real record here would defeat the map's
# deliberate placeholder policy.
EXCLUDED = frozenset(["everfox-hsg"])


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
    records = []
    errors = []
    catalog_ids = set(row["id"] for row in catalog["technologies"])
    root = os.path.join(data_dir, "examples")
    for path in sorted(glob.glob(os.path.join(root, "*", "*.log"))):
        tech_id = os.path.basename(os.path.dirname(path))
        name = os.path.basename(path)
        where = "example '%s/%s'" % (tech_id, name)
        if tech_id not in catalog_ids:
            errors.append("%s: '%s' is not a catalog technology"
                          % (where, tech_id))
            continue
        if tech_id in EXCLUDED:
            errors.append("%s: technology '%s' is excluded from examples "
                          "(controlled documentation)" % (where, tech_id))
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
        })
    records.sort(key=lambda r: (r["tech"], r["dataset"], r["label"]))
    return records, errors


def by_dataset(records):
    grouped = {}
    for rec in records:
        grouped.setdefault((rec["tech"], rec["dataset"]), []).append(rec)
    return grouped


def publish(records, out_dir):
    """Copy every example verbatim to <out_dir>/examples/<relpath>."""
    for rec in records:
        target = os.path.join(out_dir, "examples",
                              *rec["relpath"].split("/"))
        directory = os.path.dirname(target)
        if not os.path.isdir(directory):
            os.makedirs(directory)
        shutil.copyfile(rec["path"], target)
