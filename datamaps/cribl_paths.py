"""Flat-key discipline for the committed Cribl pipelines.

Cribl writes an unquoted dotted name (`source.ip`) only when the parent
object already exists; otherwise eval writes nothing and rename deletes the
source value (docs/verification/2026-09-22-cribl-field-semantics.md).  The
corpus therefore writes every dotted field as a FLAT key - a quoted name,
`'source.ip'` - and ends each pipeline with one canonical re-nest step
(renest.js) that turns the flat keys into objects, the pattern Cribl's own
prep_for_ECS pipeline uses.

A path is flat from the moment an earlier step wrote it flat; after that a
function conf must name it quoted and an expression must read it as
`__e['a.b']`, because the unquoted and member forms address the (absent)
nested object.  This module walks a pipeline in order, tracks which paths
are flat, and rewrites every reference that disagrees.  Stdlib only.
"""
import copy
import os
import re

_HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(_HERE, "renest.js"), encoding="utf-8") as _fh:
    RENEST_CODE = _fh.read().strip()
RENEST_DESCRIPTION = "Re-nest flat dotted keys (data-maps canonical step)"

# A bare name here is never an event field.
_NOT_FIELDS = set("""__e C Math Date JSON Object Array String Number Boolean
RegExp parseInt parseFloat isNaN isFinite encodeURIComponent
decodeURIComponent true false null undefined NaN Infinity typeof instanceof
new in of delete void this return if else for while do const let var
function break continue switch case default throw try catch finally
""".split())
# Conf keys holding a single field name, and lists of field names, that
# Cribl resolves with the quoted-literal rule.  mask.fields is absent on
# purpose: it is a wildcard pattern that matches a flat key and a nested
# path alike when unquoted, and matches neither when quoted.
_READ_NAMES = {"auto_timestamp": ("srcField",), "serde": ("srcField",),
               "regex_extract": ("source",)}
_WRITE_NAMES = {"auto_timestamp": ("dstField",), "serde": ("dstField",),
                "unroll": ("dstField",)}
_READ_LISTS = {"eval": ("remove",), "distinct": ("groupBy",),
               "rollup_metrics": ("dimensions",)}
_EXPR_KEYS = {"unroll": ("srcExpr",)}
_CODE_FLAT_WRITE = re.compile(r"""__e\[\s*(['"])([^'"\\]+)\1\s*\]\s*=(?!=)""")


def renest_function():
    return {"id": "code", "filter": "true", "description": RENEST_DESCRIPTION,
            "conf": {"maxNumOfIterations": 5000, "code": RENEST_CODE}}


def is_renest(fn):
    return (fn.get("id") == "code"
            and str((fn.get("conf") or {}).get("code", "")).strip() == RENEST_CODE)


def is_quoted(name):
    return len(name) >= 2 and name[0] == name[-1] and name[0] in "'\""


def unquote(name):
    return name[1:-1] if is_quoted(name) else name


def quote(name):
    return "'%s'" % name


class FlatSet(object):
    """Dotted paths that currently exist on the event as flat keys."""

    def __init__(self, names=(), prefixes=()):
        self.names = set(names)
        self.prefixes = set(prefixes)

    def add(self, name):
        if "." in name:
            self.names.add(name)

    def discard(self, name):
        self.names.discard(name)

    def has(self, path):
        if path in self.names:
            return True
        return any(path.startswith(p + ".") for p in self.prefixes)

    def has_child_of(self, path):
        return (any(n.startswith(path + ".") for n in self.names)
                or any(p == path or p.startswith(path + ".") for p in self.prefixes))


# ------------------------------------------------------------- scanner

_IDENT = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
_NUM = re.compile(r"\d[\d.]*(?:[eE][+-]?\d+)?")


def _skip_string(src, i):
    q = src[i]
    i += 1
    while i < len(src):
        if src[i] == "\\":
            i += 2
            continue
        if src[i] == q:
            return i + 1
        i += 1
    return i


def _skip_regex(src, i):
    i += 1
    in_class = False
    while i < len(src):
        c = src[i]
        if c == "\\":
            i += 2
            continue
        if c == "[":
            in_class = True
        elif c == "]":
            in_class = False
        elif c == "/" and not in_class:
            i += 1
            while i < len(src) and src[i].isalpha():
                i += 1
            return i
        elif c == "\n":
            return i
        i += 1
    return i


def _unescape(lit):
    return re.sub(r"\\(.)", r"\1", lit[1:-1])


def scan(src):
    """[(kind, text, start, end)]; kinds: ident str num regex punct."""
    toks = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c.isspace():
            i += 1
            continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in "'\"`":
            j = _skip_string(src, i)
            toks.append(("str", src[i:j], i, j))
            i = j
            continue
        if c == "/":
            prev = toks[-1] if toks else None
            value_end = prev is not None and (
                prev[0] in ("str", "num", "regex")
                or (prev[0] == "ident" and prev[1] not in ("return", "typeof", "in", "of", "case"))
                or (prev[0] == "punct" and prev[1] in (")", "]", "}")))
            if not value_end:
                j = _skip_regex(src, i)
                toks.append(("regex", src[i:j], i, j))
                i = j
                continue
        m = _IDENT.match(src, i)
        if m:
            toks.append(("ident", m.group(0), i, m.end()))
            i = m.end()
            continue
        m = _NUM.match(src, i)
        if m:
            toks.append(("num", m.group(0), i, m.end()))
            i = m.end()
            continue
        if src.startswith("?.", i):
            toks.append(("punct", "?.", i, i + 2))
            i += 2
            continue
        toks.append(("punct", c, i, i + 1))
        i += 1
    return toks


def _chains(toks, mode):
    """Yield (start, [(segment, end)], called) for each field-read chain.

    A segment is one plain name; a bracketed string holding a dot is a flat
    key and ends the chain as its own segment, marked by keeping the dot.
    `called` is true when the chain is followed by `(`, so its last segment
    is a method, not a field.
    """
    i, n = 0, len(toks)
    while i < n:
        k, text, start, end = toks[i]
        prev = toks[i - 1] if i else None
        member = prev is not None and prev[0] == "punct" and prev[1] in (".", "?.")
        if k != "ident" or member:
            i += 1
            continue
        segs = []
        j = i + 1
        if text == "__e":
            pass
        elif mode == "expr" and text not in _NOT_FIELDS:
            segs.append((text, end))
        else:
            i += 1
            continue
        if text == "__e" and not (j < n and toks[j][1] in (".", "[")):
            i += 1
            continue
        while j < n:
            t = toks[j]
            if t[0] == "punct" and t[1] == "." and j + 1 < n and toks[j + 1][0] == "ident":
                segs.append((toks[j + 1][1], toks[j + 1][3]))
                j += 2
                continue
            if (t[0] == "punct" and t[1] == "[" and j + 2 < n and toks[j + 1][0] == "str"
                    and toks[j + 2][1] == "]" and not toks[j + 1][1].startswith("`")):
                segs.append((_unescape(toks[j + 1][1]), toks[j + 2][3]))
                j += 3
                if "." in segs[-1][0]:
                    break
                continue
            break
        called = j < n and toks[j][0] == "punct" and toks[j][1] == "("
        if segs:
            yield start, segs, called
        i = j if j > i else i + 1


_NULL_SAFE = re.compile(
    r"""\(\s*__e(?:\[\s*(['"])(\w+)\1\s*\]|\.(\w+))\s*\|\|\s*\{\s*\}\s*\)"""
    r"""\s*(?:\[\s*(['"])(\w+)\4\s*\]|\.(\w+))""")
_PARENT = r"""__e((?:\[\s*'\w+'\s*\]|\.\w+)+)"""
_NOT_NEGATED = r"(?<![!.\w])(?<!typeof )"
_GUARDS = [re.compile(r"(?<![!.\w])typeof\s+" + _PARENT + r"\s*===?\s*'object'\s*&&\s*"),
           re.compile(_NOT_NEGATED + _PARENT + r"\s*!==?\s*(?:undefined|null)\s*&&\s*"),
           re.compile(_NOT_NEGATED + _PARENT + r"\s*&&\s*")]


def _parent_path(text):
    return ".".join(re.findall(r"\w+", text))


def _drop_parent_guards(src, flat):
    """Drop `P &&` guards whose parent P now exists only as flat children.

    `__e['user'] && __e['user.name']` tests an object that re-nest has not
    built yet, so it is always false; the flat child read it guards is the
    real test.  A guard is dropped only when the same expression reads a
    flat child of P.
    """
    changed = True
    while changed:
        changed = False
        for guard in _GUARDS:
            for m in guard.finditer(src):
                parent = _parent_path(m.group(1))
                if not flat.has_child_of(parent) or flat.has(parent):
                    continue
                if not re.search(r"__e\[\s*'%s\." % re.escape(parent), src):
                    continue
                src = src[:m.start()] + src[m.end():]
                changed = True
                break
            if changed:
                break
    return src


def rewrite_expr(src, flat, mode="expr"):
    """(new_src, problems) with flat paths read through __e['a.b']."""
    if not isinstance(src, str) or not src:
        return src, []

    def null_safe(m):
        path = "%s.%s" % (m.group(2) or m.group(3), m.group(5) or m.group(6))
        return "__e[%s]" % quote(path) if flat.has(path) else m.group(0)

    src = _NULL_SAFE.sub(null_safe, src)
    src, _ = _rewrite_chains(src, flat, mode)
    src = _drop_parent_guards(src, flat)
    return _rewrite_chains(src, flat, mode)


def _rewrite_chains(src, flat, mode):
    edits, problems = [], []
    for start, segs, called in _chains(scan(src), mode):
        fields = segs[:-1] if called else segs
        if not fields:
            continue
        if "." in fields[0][0]:
            continue  # already a flat bracket read
        plain = []
        for name, _ in fields:
            if "." in name:
                break
            plain.append(name)
        best = None
        for k in range(len(plain), 1, -1):
            if flat.has(".".join(plain[:k])):
                best = k
                break
        if best is None:
            whole = ".".join(plain)
            if len(plain) == len(fields) and flat.has_child_of(whole):
                problems.append(("parent-read-of-flat", whole))
            continue
        path = ".".join(plain[:best])
        end = fields[best - 1][1]
        replacement = "__e[%s]" % quote(path)
        if src[start:end] != replacement:
            edits.append((start, end, replacement))
    for start, end, text in sorted(edits, reverse=True):
        src = src[:start] + text + src[end:]
    return src, problems


# ------------------------------------------------------------- pipeline

def _where(i, fn, what):
    return "functions[%d] %s %s" % (i, fn.get("id"), what)


def rewrite_pipeline(doc):
    """(new_doc, changes, problems) - the input is never modified.

    changes and problems are lists of (code, detail).
    """
    out = copy.deepcopy(doc)
    functions = out.get("conf", {}).get("functions") or []
    flat = FlatSet()
    changes, problems = [], []

    def expr(i, fn, what, src, mode="expr"):
        new, probs = rewrite_expr(src, flat, mode)
        for code, detail in probs:
            problems.append((code, "%s: %s" % (_where(i, fn, what), detail)))
        if new != src:
            changes.append(("flat-read", "%s: %s -> %s" % (_where(i, fn, what), src, new)))
        return new

    def read_name(i, fn, what, name):
        if isinstance(name, str) and not is_quoted(name) and "*" not in name and flat.has(name):
            changes.append(("quote-read", "%s: %s" % (_where(i, fn, what), name)))
            return quote(name)
        return name

    def write_name(i, fn, what, name):
        if not isinstance(name, str):
            return name
        if is_quoted(name):
            flat.add(unquote(name))
            return name
        if "." in name and "*" not in name:
            flat.add(name)
            changes.append(("quote-write", "%s: %s" % (_where(i, fn, what), name)))
            return quote(name)
        return name

    kept = [f for f in functions if not is_renest(f)]
    if len(functions) - len(kept) != 1 or not is_renest(functions[-1]):
        changes.append(("renest", "re-nest step placed last"))
    for i, fn in enumerate(kept):
        if fn.get("disabled") is True:
            continue
        fid = fn.get("id")
        conf = fn.get("conf") or {}
        if "filter" in fn:
            fn["filter"] = expr(i, fn, "filter", fn["filter"])
        if fid == "eval":
            for row in conf.get("add") or []:
                if "value" in row:
                    row["value"] = expr(i, fn, "value", row["value"])
                if "name" in row:
                    row["name"] = write_name(i, fn, "name", row["name"])
        elif fid == "rename":
            for pair in conf.get("rename") or []:
                if not isinstance(pair, dict):
                    continue
                cur = read_name(i, fn, "currentName", pair.get("currentName"))
                pair["currentName"] = cur
                if isinstance(cur, str):
                    flat.discard(unquote(cur))
                pair["newName"] = write_name(i, fn, "newName", pair.get("newName"))
        elif fid == "flatten" and conf.get("delimiter", "_") == ".":
            for field in conf.get("fields") or []:
                flat.prefixes.add(unquote(field))
        elif fid == "code":
            # The body's own flat assignments count for its reads too; a
            # read that precedes its write in the same body is not modelled.
            for m in _CODE_FLAT_WRITE.finditer(conf.get("code") or ""):
                flat.add(m.group(2))
            conf["code"] = expr(i, fn, "code", conf.get("code"), mode="code")
        for key in _READ_NAMES.get(fid, ()):
            if key in conf:
                conf[key] = read_name(i, fn, key, conf[key])
        for key in _READ_LISTS.get(fid, ()):
            if isinstance(conf.get(key), list):
                conf[key] = [read_name(i, fn, key, x) for x in conf[key]]
        for key in _EXPR_KEYS.get(fid, ()):
            if key in conf:
                conf[key] = expr(i, fn, key, conf[key])
        for key in _WRITE_NAMES.get(fid, ()):
            if key in conf:
                conf[key] = write_name(i, fn, key, conf[key])
    kept.append(renest_function())
    out["conf"]["functions"] = kept
    if not changes:
        out = copy.deepcopy(doc)
    return out, changes, problems
