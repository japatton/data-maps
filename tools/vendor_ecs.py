"""Home-only: vendor a pinned ECS field dictionary into data/reference.

Fetches the flat field list for a tagged elastic/ecs release and trims it
to what validation needs. Requires internet; NEVER runs in CI — the
committed artifact is what builds consume.
"""
import argparse
import json
import os
import sys
from collections import OrderedDict
from urllib.request import urlopen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import yaml  # noqa: E402

URL = ("https://raw.githubusercontent.com/elastic/ecs/"
       "v%s/generated/ecs/ecs_flat.yml")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default="9.4.0")
    args = parser.parse_args()
    raw = urlopen(URL % args.version).read().decode("utf-8")
    flat = yaml.safe_load(raw)
    trimmed = OrderedDict()
    for name in sorted(flat):
        entry = flat[name]
        item = OrderedDict([
            ("type", entry.get("type", "")),
            ("short", entry.get("short", "")),
        ])
        # Stability markers: beta/alpha fields may be renamed or dropped
        # in a minor ECS release, so mappers need the warning carried
        # through into the vendored dictionary.
        if entry.get("beta"):
            item["beta"] = True
        if entry.get("alpha"):
            item["alpha"] = True
        trimmed[name] = item
    out = OrderedDict([("ecs_version", args.version),
                       ("fields", trimmed)])
    path = os.path.join(ROOT, "data", "reference", "ecs.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print("Vendored ECS %s: %d fields -> %s"
          % (args.version, len(trimmed), path))


if __name__ == "__main__":
    main()
