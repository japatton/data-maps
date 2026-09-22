#!/usr/bin/env python3
"""Extract a focused work order per technology: only the format blocks that
need a real parsing pipeline (mechanism cribl-pipeline or cribl-pack).

Agents read these instead of the full technology YAML. The thin and none
mechanisms are already handled by generate_thin.py, so carrying them into an
agent's context is pure cost.
"""
import glob
import json
import os
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(REPO, "data", "technologies")
OUT = os.path.join(HERE, "workorders")
FULL = {"cribl-pipeline", "cribl-pack"}


def split_oversized(cap_kb=85.0):
    """Re-emit any work order above cap_kb as one order per dataset.

    A single agent cannot hold a 266 KB order: entra-id at 128 KB already cost
    185k tokens. Splitting per dataset keeps every job inside a comfortable
    context while leaving each dataset's formats together, which is the unit
    that shares parsing decisions.
    """
    made, removed = [], []
    for fn in sorted(glob.glob(os.path.join(OUT, "*.json"))):
        base = os.path.basename(fn)
        if base.startswith("_"):
            continue
        kb = os.path.getsize(fn) / 1024
        if kb <= cap_kb:
            continue
        order = json.load(open(fn))
        tid = order["technology"]["id"]
        for ds in order["datasets"]:
            part = {"technology": order["technology"], "note": order["note"],
                    "datasets": [ds]}
            pfn = os.path.join(OUT, "%s--%s.json" % (tid, ds["id"]))
            with open(pfn, "w") as fh:
                json.dump(part, fh, indent=2)
            made.append((os.path.getsize(pfn) / 1024, "%s--%s" % (tid, ds["id"]),
                         len(ds["formats"])))
        os.remove(fn)
        removed.append((round(kb, 1), tid, len(order["datasets"])))
    return made, removed


def main():
    os.makedirs(OUT, exist_ok=True)
    rows = []
    for path in sorted(glob.glob(os.path.join(DATA, "*.yml"))):
        tech_id = os.path.basename(path)[:-4]
        doc = yaml.safe_load(open(path))
        order = {
            "technology": {k: doc.get(k) for k in ("id", "name", "vendor", "versions")},
            "note": ("Only format blocks needing a real Cribl parsing pipeline are "
                     "included. Blocks deferring to Elastic are already generated "
                     "elsewhere - do not produce them."),
            "datasets": [],
        }
        for ds in doc.get("datasets") or []:
            keep = [fm for fm in (ds.get("formats") or [])
                    if (fm.get("parsing") or {}).get("mechanism") in FULL]
            if not keep:
                continue
            order["datasets"].append({
                "id": ds["id"],
                "name": ds.get("name"),
                "description": ds.get("description"),
                "event_categories": ds.get("event_categories"),
                "route_direct": (ds.get("route") or {}).get("direct"),
                "formats": keep,
            })
        if not order["datasets"]:
            continue
        fn = os.path.join(OUT, tech_id + ".json")
        with open(fn, "w") as fh:
            json.dump(order, fh, indent=2)
        rows.append((os.path.getsize(fn) / 1024, tech_id,
                     sum(len(d["formats"]) for d in order["datasets"])))

    rows.sort(reverse=True)
    CAP = 90.0
    batches = []
    cur, cur_kb = [], 0.0
    for kb, tid, nf in rows:
        if kb >= CAP:
            batches.append([(kb, tid, nf)])
            continue
        if cur and cur_kb + kb > CAP:
            batches.append(cur); cur, cur_kb = [], 0.0
        cur.append((kb, tid, nf)); cur_kb += kb
    if cur:
        batches.append(cur)

    print("work orders written: %d  (%d KB total, %d format blocks)"
          % (len(rows), sum(r[0] for r in rows), sum(r[2] for r in rows)))
    print("batches at <=%dKB: %d" % (CAP, len(batches)))
    manifest = []
    for i, b in enumerate(batches, 1):
        manifest.append({"batch": i, "kb": round(sum(x[0] for x in b), 1),
                         "technologies": [x[1] for x in b],
                         "format_blocks": sum(x[2] for x in b)})
        print("  %2d  %6.1fKB  %2d fmt  %s" % (i, sum(x[0] for x in b),
                                               sum(x[2] for x in b),
                                               ", ".join(x[1] for x in b)))
    json.dump(manifest, open(os.path.join(OUT, "_manifest.json"), "w"), indent=2)

    made, removed = split_oversized()
    print()
    print("split %d oversized work orders into %d per-dataset orders:" % (len(removed), len(made)))
    for kb, tid, nds in removed:
        print("  %-22s %6.1fKB -> %d dataset orders" % (tid, kb, nds))
    over = [(kb, n) for kb, n, _ in made if kb > 85]
    print("any part still over 85KB:", over or "none")


if __name__ == "__main__":
    main()
