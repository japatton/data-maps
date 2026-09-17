"""Rewrite data files as Studio's YAML emitter would write them.

Studio's drift guard compares the repository's file text against the text
its emitter produces from the published snapshot, so a file that is merely
equivalent - same content, different line wrapping - reads to an admin as
"changed in the repository since this site was built" and blocks the merge
request.  A hand edit to prose is enough to cause it: deleting a word from
a folded block leaves the paragraph wrapped at the old width.

So every data file is stored exactly as the emitter writes it, and this is
what puts them back that way after a hand edit.

    python3 tools/canonicalize.py --check     report, change nothing
    python3 tools/canonicalize.py             rewrite what differs

Requires node, because the emitter is JavaScript.  Rewriting is formatting
only: the tool refuses to write a file whose content would change.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from datamaps import yamlio  # noqa: E402

SCRIPT = """
import { readFileSync } from "node:fs";
import { emit, emitCatalog } from "%s/studio/lib/yaml-emit.js";
const input = JSON.parse(readFileSync(0, "utf8"));
const out = {};
for (const [name, entry] of Object.entries(input))
  out[name] = entry.catalog ? emitCatalog(entry.doc) : emit(entry.doc);
process.stdout.write(JSON.stringify(out));
"""


def data_files(data_dir):
    paths = [os.path.join(data_dir, "catalog.yml")]
    tech = os.path.join(data_dir, "technologies")
    paths += [os.path.join(tech, n) for n in sorted(os.listdir(tech))
              if n.endswith(".yml")]
    return paths


def emitted(paths):
    """{path: text} as the emitter would write each document."""
    docs = {}
    for path in paths:
        docs[path] = {"doc": yamlio.load(path),
                      "catalog": os.path.basename(path) == "catalog.yml"}
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", SCRIPT % ROOT],
        input=json.dumps(docs).encode("utf-8"),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode:
        raise RuntimeError(proc.stderr.decode("utf-8"))
    return json.loads(proc.stdout.decode("utf-8")), docs


def normalize(text):
    """The comparison Studio's driftedPaths makes, verbatim."""
    return text.replace("\r\n", "\n").rstrip()


def differing(paths):
    texts, _ = emitted(paths)
    out = []
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            if normalize(fh.read()) != normalize(texts[path]):
                out.append(path)
    return out, texts


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true",
                        help="report and change nothing; exit 1 if any differ")
    parser.add_argument("--data", default=os.path.join(ROOT, "data"))
    args = parser.parse_args(argv)

    paths = data_files(args.data)
    stale, texts = differing(paths)

    if args.check:
        for path in stale:
            sys.stdout.write("not canonical: %s\n"
                             % os.path.relpath(path, ROOT))
        sys.stdout.write("%d of %d file(s) are not as the emitter writes "
                         "them\n" % (len(stale), len(paths)))
        return 1 if stale else 0

    work = tempfile.mkdtemp()
    probe = os.path.join(work, "probe.yml")
    for path in stale:
        before = yamlio.load(path)
        with open(probe, "w", encoding="utf-8") as fh:
            fh.write(texts[path])
        if yamlio.load(probe) != before:
            sys.stderr.write("refusing to rewrite %s: the emitted document "
                             "differs from the authored one\n" % path)
            return 2
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(texts[path])
        sys.stdout.write("rewrote %s\n" % os.path.relpath(path, ROOT))
    sys.stdout.write("%d file(s) rewritten, %d already canonical\n"
                     % (len(stale), len(paths) - len(stale)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
