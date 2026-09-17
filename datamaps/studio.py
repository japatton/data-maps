"""Publish the Studio editor: static files, schema/config JSON, sources.

Imports neither yaml nor jinja2 (seams live in yamlio.py / render.py).

Run as a module to regenerate the fixtures the JS tests read:

    python3 -m datamaps.studio --write-fixture [DIR]
"""
import argparse
import copy
import json
import os
import shutil
import sys
import urllib.parse

from datamaps import examples, parity, schema

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

REPO_KINDS = ["gitlab", "forgejo"]
API_KINDS = ["openai", "azure"]
SKIP = ("tests", "package.json", "package-lock.json", "node_modules",
        ".DS_Store")

# The generated fixtures the JS suite reads, relative to ROOT: the reduced
# schema it validates against, and the parity corpus with schema.py's
# answers that studio/tests/parity.test.js must reproduce.
FIXTURE_DIR = os.path.join("studio", "tests", "fixtures")
FIXTURE_PATH = os.path.join(FIXTURE_DIR, "schema.json")
PARITY_FIXTURE_PATH = os.path.join(FIXTURE_DIR, "parity.json")

# The fixture carries the real vocabularies and profiles but only the ECS
# fields the browser tests name: every field a profile requires, plus these,
# which studio/tests/*.test.js use as mapping targets.  Names the tests use
# *because* they are absent ("sorce.ip", "no.such.field") must stay absent.
FIXTURE_ECS_EXTRA = ("@timestamp", "client.ip", "destination.ip",
                     "dns.answers.name", "dns.answers.type", "event.action",
                     "event.code", "event.dataset", "event.outcome",
                     "host.name", "network.protocol", "related.ip",
                     "source.ip", "source.port", "source.user.name",
                     "user.name")

# The sections of data/studio.yml, in the order they are reported, each
# with its required and optional keys.  This table is the one authority
# for what an environment override may name (see overlay_env) as well as
# for what the file may contain.
_SECTION_ORDER = ("repository", "analysis", "elastic")
_SECTIONS = {
    "repository": (("kind", "api_url", "project", "default_branch",
                    "web_ide_url"), ()),
    "analysis": (("api_kind", "api_url", "model"),
                 ("api_version", "allow_override")),
    "elastic": (("url",), ()),
}

# Overrides arrive as strings; these keys are booleans instead.
_BOOL_KEYS = ("allow_override",)

# The prefix an override carries, and the one variable under it that
# configures the build rather than the site.
ENV_PREFIX = "STUDIO_"
ALLOWED_HOSTS_ENV = "STUDIO_ALLOWED_HOSTS"


def validate_config(doc):
    errors = []
    if not schema._check_keys(doc, _SECTION_ORDER, (), "studio", errors):
        return errors
    for section in _SECTION_ORDER:
        required, optional = _SECTIONS[section]
        where = "studio %s" % section
        body = doc[section]
        if not schema._check_keys(body, required, optional, where, errors):
            continue
        if section == "repository":
            schema._check_str(body, "kind", where, errors, vocab=REPO_KINDS)
            for key in ("api_url", "project", "default_branch", "web_ide_url"):
                schema._check_str(body, key, where, errors)
        elif section == "analysis":
            schema._check_str(body, "api_kind", where, errors, vocab=API_KINDS)
            schema._check_str(body, "api_url", where, errors)
            schema._check_str(body, "model", where, errors)
            if "api_version" in body and not isinstance(body["api_version"],
                                                        str):
                errors.append("%s: 'api_version' must be a string" % where)
            # Optional, and true when absent: an unset lock locks nothing.
            if "allow_override" in body and not isinstance(
                    body["allow_override"], bool):
                errors.append("%s: 'allow_override' must be true or false"
                              % where)
        else:
            if not isinstance(body.get("url"), str):
                errors.append("%s: 'url' must be a string" % where)
    return errors


def _split_env_name(name):
    """STUDIO_<SECTION>_<KEY> -> (section, key); ValueError if it is neither.

    The section is the first word after the prefix and the key is all of
    the rest, so STUDIO_REPOSITORY_API_URL names repository.api_url.
    """
    rest = name[len(ENV_PREFIX):]
    section, _, key = rest.partition("_")
    section = section.lower()
    if section not in _SECTIONS:
        raise ValueError("%s: '%s' is not a studio config section (%s)"
                         % (name, section, ", ".join(_SECTION_ORDER)))
    key = key.lower()
    required, optional = _SECTIONS[section]
    if key not in required and key not in optional:
        raise ValueError("%s: '%s' is not a key of studio %s"
                         % (name, key, section))
    return section, key


def _parse_bool(name, value):
    text = value.strip().lower()
    if text == "true":
        return True
    if text == "false":
        return False
    raise ValueError("%s: '%s' must be true or false" % (name, value))


def overlay_env(config, environ):
    """(config with STUDIO_* applied, sorted dotted keys taken).

    A deep copy: the loaded document is left as it was read.  Every name
    under STUDIO_ but ALLOWED_HOSTS_ENV, which configures the build's own
    host check, has to name a section and key this module accepts;
    anything else raises ValueError, which the build prints as FATAL.
    Values arrive as strings bar the booleans in _BOOL_KEYS.  os.environ
    is never read here - the caller passes the mapping.
    """
    out = copy.deepcopy(config)
    taken = []
    for name in sorted(environ):
        if not name.startswith(ENV_PREFIX) or name == ALLOWED_HOSTS_ENV:
            continue
        section, key = _split_env_name(name)
        value = environ[name]
        if key in _BOOL_KEYS:
            value = _parse_bool(name, value)
        if not isinstance(out, dict):
            raise ValueError("%s: studio config is not a mapping" % name)
        body = out.get(section)
        if not isinstance(body, dict):
            body = {}
            out[section] = body
        body[key] = value
        taken.append("%s.%s" % (section, key))
    # Deduped: the name is lowercased on the way to a dotted key, so
    # STUDIO_REPOSITORY_API_URL and STUDIO_repository_api_url both land on
    # repository.api_url and the report would name it twice.
    return out, sorted(set(taken))


def check_hosts(config, allowed):
    """Errors for every configured URL whose host is off the allow-list.

    Empty values are skipped: an unset elastic.url points nowhere.  The
    comparison is on the hostname alone - scheme, port and path are the
    deployment's business, the host is the one thing a fat-fingered CI
    variable could point at the wrong network.

    A value urlsplit cannot parse at all (a bracketed host with no closing
    bracket, say) has no host, which is never on the list: an unparseable
    URL fails the check rather than crashing the build with a traceback.
    """
    errors = []
    names = set(host.strip().lower() for host in allowed if host.strip())
    for section in _SECTION_ORDER:
        body = config.get(section) if isinstance(config, dict) else None
        if not isinstance(body, dict):
            continue
        required, optional = _SECTIONS[section]
        for key in tuple(required) + tuple(optional):
            if not key.endswith("url"):
                continue
            value = body.get(key)
            if not isinstance(value, str) or not value.strip():
                continue
            try:
                host = urllib.parse.urlsplit(value.strip()).hostname or ""
            except ValueError:
                host = ""
            if host.lower() not in names:
                errors.append("studio %s: '%s' host '%s' is not in %s"
                              % (section, key, host, ALLOWED_HOSTS_ENV))
    return errors


def parse_allowed_hosts(value):
    """A STUDIO_ALLOWED_HOSTS value as a list; empty entries dropped."""
    return [host.strip() for host in (value or "").split(",") if host.strip()]


def _table_json(table):
    """A KEY_ORDER/REQUIRED table as JSON: tuples become lists."""
    out = {}
    for node, keys in table.items():
        if isinstance(keys, dict):
            out[node] = dict((kind, list(v)) for kind, v in keys.items())
        else:
            out[node] = list(keys)
    return out


def schema_json(profiles_doc, ecs):
    hop_keys = {}
    for kind, (required, optional) in schema.HOP_KEYS.items():
        hop_keys[kind] = {"required": list(required),
                          "optional": list(optional)}
    profiles = {}
    for name, body in profiles_doc["profiles"].items():
        profiles[name] = list(body["required"])
    return {
        "ecs_version": ecs["ecs_version"],
        "vocab": {
            "categories": list(schema.CATEGORIES),
            "statuses": list(schema.STATUSES),
            "priorities": list(schema.PRIORITIES),
            "source_formats": list(schema.SOURCE_FORMATS),
            "mechanisms": list(schema.MECHANISMS),
            "hops": list(schema.HOPS),
            "hop_keys": hop_keys,
            "field_statuses": list(schema.FIELD_STATUSES),
            "parse_locations": list(schema.PARSE_LOCATIONS),
            "rec_keys": dict((k, list(v)) for k, v in schema.REC_KEYS.items()),
            "slug_pattern": schema.SLUG_RE.pattern,
            # The one source of truth for which keys each node accepts and
            # the order Studio writes them.
            "key_order": _table_json(schema.KEY_ORDER),
            "required": _table_json(schema.REQUIRED),
        },
        "profiles": profiles,
        # Technologies whose example records are never published.
        "examples": {"excluded": sorted(examples.EXCLUDED)},
        # A deep copy: callers mutating the published document must not
        # reach back into the loaded ECS dictionary, and each field is
        # itself a mapping a shallow copy would still share.
        "ecs": copy.deepcopy(ecs["fields"]),
    }


def fixture_schema(profiles_doc, ecs):
    """schema_json with the ECS dictionary cut down to the tested fields."""
    doc = schema_json(profiles_doc, ecs)
    keep = set(FIXTURE_ECS_EXTRA)
    for required in doc["profiles"].values():
        keep.update(required)
    missing = sorted(name for name in keep if name not in doc["ecs"])
    if missing:
        raise KeyError("not in the vendored ECS dictionary: %s"
                       % ", ".join(missing))
    doc["ecs"] = dict((name, doc["ecs"][name]) for name in sorted(keep))
    return doc


def fixture_parity(profiles_doc, ecs):
    """The parity corpus and its answers, against the reduced schema."""
    return parity.fixture(fixture_schema(profiles_doc, ecs))


def examples_json(records):
    """{tech: {dataset: [{label, path, size}]}} for the Studio editor.

    The label is the raw one from the file stem - hyphens and all - not the
    display form examples.discover renders, because Studio composes stems
    from it and has to land on the same filename.  A bare stem carries the
    empty label, which is what Studio's own "no label" attach produces.
    """
    out = {}
    for rec in records or []:
        name = rec["relpath"].split("/")[-1]
        stem = name[:-4] if name.endswith(".log") else name
        dataset = rec["dataset"]
        label = "" if stem == dataset else stem[len(dataset) + 1:]
        listing = out.setdefault(rec["tech"], {}).setdefault(dataset, [])
        listing.append({"label": label,
                        "path": "examples/" + rec["relpath"],
                        "size": rec["size"]})
    return out


def _write_json(path, doc):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


def publish(root, out_dir, catalog, technologies, profiles_doc, ecs, config,
            records=None):
    src = os.path.join(root, "studio")
    dest = os.path.join(out_dir, "studio")
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    shutil.copytree(src, dest, ignore=shutil.ignore_patterns(*SKIP))
    _write_json(os.path.join(dest, "schema.json"),
                schema_json(profiles_doc, ecs))
    _write_json(os.path.join(dest, "config.json"), config)
    # Always written, even with nothing to list: a 404 here would be
    # indistinguishable in the browser from a site built before examples
    # existed, and Studio would have to guess.
    _write_json(os.path.join(dest, "examples.json"), examples_json(records))
    source_dir = os.path.join(dest, "source")
    os.makedirs(source_dir)
    _write_json(os.path.join(source_dir, "catalog.json"), catalog)
    for tech_id in sorted(technologies):
        _write_json(os.path.join(source_dir, tech_id + ".json"),
                    technologies[tech_id])


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python3 -m datamaps.studio",
        description="Regenerate the fixtures the JS tests read: the reduced "
                    "schema and the validator parity corpus.")
    parser.add_argument("--write-fixture", nargs="?", metavar="DIR",
                        const=os.path.join(ROOT, FIXTURE_DIR),
                        help="write schema.json and parity.json into DIR "
                             "(default: %s)" % FIXTURE_DIR)
    args = parser.parse_args(argv)
    if args.write_fixture is None:
        parser.error("nothing to do: pass --write-fixture")
    # Imported here: this module is a seam that must not pull yaml in for
    # the build, and build.py imports it.
    from datamaps import build
    catalog, technologies, profiles_doc, ecs = build.load_inputs(
        os.path.join(ROOT, "data"))
    directory = args.write_fixture
    if not os.path.isdir(directory):
        os.makedirs(directory)
    for name, doc in (("schema.json", fixture_schema(profiles_doc, ecs)),
                      ("parity.json", fixture_parity(profiles_doc, ecs))):
        path = os.path.join(directory, name)
        _write_json(path, doc)
        sys.stdout.write("wrote %s\n" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
