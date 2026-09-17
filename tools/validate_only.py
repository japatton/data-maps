"""Read-only validation: parse the data tree and run hard validation.

Writes nothing, so several authors can run this at once while the build -
which races on public/ - stays out of the picture.  Prints one line per
error and exits non-zero when there is at least one.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from datamaps import build, schema  # noqa: E402


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    data_dir = argv[0] if argv else "data"
    catalog, technologies, profiles, ecs = build.load_inputs(data_dir)
    errors = schema.validate_all(catalog, technologies, profiles, ecs)
    for message in errors:
        print(message)
    print("%d error(s)" % len(errors))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
