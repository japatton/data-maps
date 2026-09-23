"""Apply the flat-key discipline (datamaps/cribl_paths.py) to data/pipelines.

    python3 tools/pipelines/flat_keys.py            rewrite in place
    python3 tools/pipelines/flat_keys.py --check    report only; exit 1 if
                                                    any file would change

Rewritten files are written as JSON with indent=2 and a trailing newline.
Parent reads of a flat path are printed as notes: they are usually a vendor
field that shares an ECS parent's name, and the live gate's behaviour check
is what proves whether re-nesting collided with one.
"""
import argparse
import json
import os
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from datamaps import cribl_paths  # noqa: E402


def dump(doc):
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(prog="flat_keys.py")
    parser.add_argument("--data", default=os.path.join(ROOT, "data"))
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--notes", action="store_true", help="print parent-read notes")
    opts = parser.parse_args(argv)
    root = os.path.join(opts.data, "pipelines")
    kinds, notes, changed = Counter(), [], []
    for tech in sorted(os.listdir(root)):
        tdir = os.path.join(root, tech)
        if not os.path.isdir(tdir) or tech.startswith("_"):
            continue
        for name in sorted(os.listdir(tdir)):
            if not name.endswith(".json"):
                continue
            path = os.path.join(tdir, name)
            with open(path, encoding="utf-8") as fh:
                doc = json.load(fh)
            new, changes, problems = cribl_paths.rewrite_pipeline(doc)
            rel = "%s/%s" % (tech, name)
            notes.extend("%s  %s" % (rel, d) for _, d in problems)
            if not changes:
                continue
            changed.append(rel)
            kinds.update(c for c, _ in changes)
            if not opts.check:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(dump(new))
    verb = "would change" if opts.check else "rewrote"
    sys.stdout.write("%s %d files: %s\n" % (verb, len(changed), dict(kinds)))
    sys.stdout.write("%d parent-read notes%s\n"
                     % (len(notes), "" if opts.notes else " (--notes to list)"))
    if opts.notes:
        for n in notes:
            sys.stdout.write("  %s\n" % n)
    return 1 if (opts.check and changed) else 0


if __name__ == "__main__":
    sys.exit(main())
