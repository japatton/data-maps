"""YAML loading behind a seam: the ONLY module that imports yaml."""
import yaml

# The same safe subset, parsed by libyaml where PyYAML was built with it:
# an order of magnitude faster on data/technologies (2.6 s -> 0.3 s), which
# is most of what a build and the test suite spend their time on. Pure
# PyYAML remains the fallback, and reads these documents identically: the
# values come out equal either way, and tests/test_yamlio.py holds that.
# The one known difference is in what each *rejects* - libyaml is
# marginally more permissive about tabs inside plain scalars - so a file
# that only the pure loader refuses would be caught by CI rather than
# locally, which is the safe direction.
_LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)


class DataError(Exception):
    """Unreadable or unparseable authored data."""


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return yaml.load(fh, Loader=_LOADER)
    except yaml.YAMLError as exc:
        raise DataError("%s: invalid YAML: %s" % (path, exc))
    except OSError as exc:
        raise DataError("%s: unreadable: %s" % (path, exc))


def _str_representer(dumper, value):
    if "\n" in value.rstrip():
        return dumper.represent_scalar("tag:yaml.org,2002:str", value,
                                       style="|")
    if len(value) > 100:
        return dumper.represent_scalar("tag:yaml.org,2002:str", value,
                                       style=">")
    return dumper.represent_scalar("tag:yaml.org,2002:str", value)


class _Dumper(yaml.SafeDumper):
    pass


_Dumper.add_representer(str, _str_representer)


def dump(path, doc):
    """Write doc as block-style YAML, preserving key order."""
    with open(path, "w", encoding="utf-8") as fh:
        yaml.dump(doc, fh, Dumper=_Dumper, default_flow_style=False,
                  allow_unicode=True, sort_keys=False, width=78)
