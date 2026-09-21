"""JavaScript expression subset -> Painless.

Cribl `eval` values and function `filter`s are JavaScript expressions.  This
module parses the subset the committed pipelines actually use and emits
Painless for it.  Anything outside the subset raises Untranslatable: the
transpiler never guesses at semantics it cannot reproduce.

The emission rules are listed in the implementation plan and the design
spec (section 3.3); the tests pin the exact strings.
"""
import re

_PUNCT = ("===", "!==", "&&", "||", "==", "!=", "<=", ">=", "=>", "++", "--",
          "?", ":", "(", ")", "[", "]", ".", ",", "!", "<", ">", "+", "-",
          "*", "/", "%", "=", ";", "{", "}")
_IDENT_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
_NUM_RE = re.compile(r"\d+(\.\d+)?([eE][+-]?\d+)?")
_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f",
            "0": "\0", "\\": "\\", "'": "'", '"': '"', "/": "/"}
_HEX4_RE = re.compile(r"[0-9a-fA-F]{4}\Z")
_REGEX_FLAGS = "gimsuy"
# A '/' starts a regex literal unless the previous token could end a value.
_VALUE_END = ("num", "str", "ident", "regex")
_VALUE_END_PUNCT = (")", "]")

KNOWN_GLOBALS = ("__e", "true", "false", "null", "undefined", "typeof",
                 "new", "Date", "Math", "Array", "String", "Number",
                 "Boolean", "parseInt", "parseFloat", "JSON", "isNaN",
                 "isFinite")
CALLS = ("parseInt", "parseFloat", "Number", "String", "Boolean",
         "Date.parse", "Math.floor", "Math.round", "Math.abs", "Math.max",
         "Math.min", "Array.isArray")


class Untranslatable(Exception):
    def __init__(self, reason, offset=None):
        self.reason = reason
        self.offset = offset
        Exception.__init__(self, reason if offset is None
                           else "%s (at offset %d)" % (reason, offset))


def tokenize(src):
    toks = []
    i = 0
    n = len(src)
    while i < n:
        ch = src[i]
        if ch.isspace():
            i += 1
            continue
        start = i
        if ch in "'\"":
            quote = ch
            i += 1
            buf = []
            while True:
                if i >= n:
                    raise Untranslatable("unterminated string", start)
                c = src[i]
                if c == "\\":
                    if i + 1 >= n:
                        raise Untranslatable("unterminated string", start)
                    e = src[i + 1]
                    if e == "u":
                        hex4 = src[i + 2:i + 6]
                        if not _HEX4_RE.match(hex4):
                            raise Untranslatable("bad \\u escape", i)
                        buf.append(chr(int(hex4, 16)))
                        i += 6
                        continue
                    buf.append(_ESCAPES.get(e, e))
                    i += 2
                    continue
                if c == quote:
                    i += 1
                    break
                buf.append(c)
                i += 1
            toks.append(("str", "".join(buf), start))
            continue
        m = _NUM_RE.match(src, i)
        if m and ch.isdigit():
            toks.append(("num", m.group(0), start))
            i = m.end()
            continue
        m = _IDENT_RE.match(src, i)
        if m:
            toks.append(("ident", m.group(0), start))
            i = m.end()
            continue
        if ch == "/":
            prev = toks[-1] if toks else None
            is_value_end = prev is not None and (
                prev[0] in _VALUE_END
                or (prev[0] == "punct" and prev[1] in _VALUE_END_PUNCT))
            if not is_value_end:
                i += 1
                buf = []
                in_class = False
                while True:
                    if i >= n:
                        raise Untranslatable("unterminated regex", start)
                    c = src[i]
                    if c == "\\":
                        buf.append(src[i:i + 2])
                        i += 2
                        continue
                    if c == "[":
                        in_class = True
                    elif c == "]":
                        in_class = False
                    elif c == "/" and not in_class:
                        i += 1
                        break
                    buf.append(c)
                    i += 1
                fm = re.compile(r"[a-z]*").match(src, i)
                flags = fm.group(0)
                i = fm.end()
                pattern = "".join(buf)
                if not pattern:
                    raise Untranslatable("empty regex literal", start)
                for f in flags:
                    if f not in _REGEX_FLAGS:
                        raise Untranslatable("unknown regex flag %r" % f, start)
                toks.append(("regex", (pattern, flags), start))
                continue
        for p in _PUNCT:
            if src.startswith(p, i):
                toks.append(("punct", p, start))
                i += len(p)
                break
        else:
            raise Untranslatable("unexpected character %r" % ch, start)
    toks.append(("eof", None, n))
    return toks


class _Parser(object):
    def __init__(self, src):
        self.src = src
        self.toks = tokenize(src)
        self.pos = 0

    def peek(self, k=0):
        return self.toks[min(self.pos + k, len(self.toks) - 1)]

    def at(self, kind, value=None):
        t = self.peek()
        return t[0] == kind and (value is None or t[1] == value)

    def take(self):
        t = self.toks[self.pos]
        self.pos += 1
        return t

    def expect(self, kind, value=None):
        t = self.peek()
        if not self.at(kind, value):
            raise Untranslatable("expected %s but found %r"
                                 % (value or kind, t[1]), t[2])
        return self.take()

    def fail(self, what=None):
        t = self.peek()
        raise Untranslatable(what or "unsupported token %r" % (t[1],), t[2])

    def parse(self):
        node = self.conditional()
        if not self.at("eof"):
            self.fail("unsupported token %r after expression" % (self.peek()[1],))
        return node

    def conditional(self):
        test = self.logical_or()
        if self.at("punct", "?"):
            self.take()
            then = self.conditional()
            self.expect("punct", ":")
            other = self.conditional()
            return ("cond", test, then, other)
        return test

    def _binary(self, ops, below):
        node = below()
        while self.at("punct") and self.peek()[1] in ops:
            op = self.take()[1]
            node = ("binary", op, node, below())
        return node

    def logical_or(self):
        return self._binary(("||",), self.logical_and)

    def logical_and(self):
        return self._binary(("&&",), self.equality)

    def equality(self):
        return self._binary(("===", "!==", "==", "!="), self.relational)

    def relational(self):
        return self._binary(("<", "<=", ">", ">="), self.additive)

    def additive(self):
        return self._binary(("+", "-"), self.multiplicative)

    def multiplicative(self):
        return self._binary(("*", "/", "%"), self.unary)

    def unary(self):
        if self.at("punct") and self.peek()[1] in ("!", "-", "+"):
            op = self.take()[1]
            return ("unary", op, self.unary())
        if self.at("ident", "typeof"):
            self.take()
            return ("typeof", self.unary())
        return self.postfix()

    def args(self):
        self.expect("punct", "(")
        out = []
        if not self.at("punct", ")"):
            out.append(self.conditional())
            while self.at("punct", ","):
                self.take()
                out.append(self.conditional())
        self.expect("punct", ")")
        return out

    def postfix(self):
        node = self.primary()
        while True:
            if self.at("punct", "."):
                self.take()
                name = self.expect("ident")[1]
                if self.at("punct", "("):
                    node = ("method", node, name, self.args())
                elif name == "length":
                    # Never a field segment: .length reads a string or list
                    # length, which the emitter refuses rather than guess.
                    node = ("prop", node, "length")
                elif node[0] == "field":
                    node = ("field", node[1] + [name])
                else:
                    raise Untranslatable("property access .%s is not supported"
                                         % name, self.peek()[2])
            elif self.at("punct", "["):
                if node[0] != "field":
                    self.fail("indexing is only supported on __e")
                self.take()
                key = self.expect("str")[1]
                self.expect("punct", "]")
                node = ("field", node[1] + key.split("."))
            elif self.at("punct") and self.peek()[1] in ("++", "--", "="):
                self.fail("assignment and increment are not expressions "
                          "the transpiler supports")
            else:
                return node

    def primary(self):
        t = self.peek()
        kind, value, offset = t
        if kind == "str":
            self.take()
            return ("str", value)
        if kind == "num":
            self.take()
            return ("num", value)
        if kind == "regex":
            self.take()
            return ("regex", value[0], value[1])
        if kind == "punct" and value == "(":
            self.take()
            node = self.conditional()
            self.expect("punct", ")")
            return node
        if kind == "punct" and value == "[":
            self.take()
            items = []
            if not self.at("punct", "]"):
                items.append(self.conditional())
                while self.at("punct", ","):
                    self.take()
                    items.append(self.conditional())
            self.expect("punct", "]")
            return ("array", items)
        if kind == "ident":
            if value in ("true", "false"):
                self.take()
                return ("bool", value == "true")
            if value == "null":
                self.take()
                return ("null",)
            if value == "undefined":
                self.take()
                return ("undef",)
            if value == "new":
                self.take()
                name = self.expect("ident")[1]
                if name != "Date":
                    raise Untranslatable("new %s is not supported" % name, offset)
                a = self.args()
                if len(a) != 1:
                    raise Untranslatable("new Date() needs exactly one argument", offset)
                return ("newdate", a[0])
            if value == "__e":
                self.take()
                if self.at("punct", "["):
                    self.take()
                    key = self.expect("str")[1]
                    self.expect("punct", "]")
                    return ("field", key.split("."))
                if self.at("punct", "."):
                    self.take()
                    name = self.expect("ident")[1]
                    return ("field", [name])
                raise Untranslatable("__e must be indexed", offset)
            if value in ("Date", "Math", "Array", "JSON"):
                self.take()
                self.expect("punct", ".")
                member = self.expect("ident")[1]
                name = "%s.%s" % (value, member)
                if name not in CALLS:
                    raise Untranslatable("%s is not supported" % name, offset)
                return ("call", name, self.args())
            if value in CALLS:
                self.take()
                return ("call", value, self.args())
            if value in KNOWN_GLOBALS:
                raise Untranslatable("%s is not supported here" % value, offset)
            raise Untranslatable("bare identifier %r (fields must be read as "
                                 "__e['%s'])" % (value, value), offset)
        self.fail()


def parse(src):
    return _Parser(src).parse()


# ---------------------------------------------------------------- emitter

FIELD_MAP = {"_time": "@timestamp", "_raw": "message"}
_PAINLESS_RESERVED = set("""if else while do for in continue break return new
try catch throw this instanceof def void boolean byte short char int long
float double true false null""".split())
_PAINLESS_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_STRING_PRODUCERS = ("toLowerCase", "toUpperCase", "trim", "replace",
                     "substring", "slice", "toISOString", "toString")
_NUMBER_PRODUCERS = ("getTime",)
_BOOL_METHODS = ("startsWith", "endsWith", "includes", "test", "match")
_TYPEOF_CLASSES = {"string": "String", "number": "Number", "boolean": "Boolean"}


class Painless(object):
    def __init__(self, source, reads=None, regex=False, is_constant=False,
                 constant=None, is_field=None):
        self.source = source
        self.reads = list(reads or [])
        self.regex = regex
        self.is_constant = is_constant
        self.constant = constant
        self.is_field = is_field


def painless_string(text):
    return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _escape_regex_slashes(pattern):
    """Escape the slashes a Painless /regex/ literal cannot carry bare.

    The tokenizer keeps backslash pairs as written, so an already-escaped
    ``\\/`` must be left alone; a bare ``/`` only survives tokenizing inside
    a character class (``[/]``) and has to be escaped here.
    """
    out = []
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c == "\\" and i + 1 < len(pattern):
            out.append(pattern[i:i + 2])
            i += 2
            continue
        out.append("\\/" if c == "/" else c)
        i += 1
    return "".join(out)


def map_field(name):
    if name in FIELD_MAP:
        return FIELD_MAP[name]
    if name.startswith("__"):
        raise Untranslatable("Cribl internal field %s has no Elasticsearch "
                             "equivalent" % name)
    for seg in name.split("."):
        if "/" in seg or ":" in seg:
            raise Untranslatable("URI-shaped key %r: whether its separators "
                                 "nest or are literal is a guess" % seg)
    return name


def _segment(seg):
    if _PAINLESS_IDENT.match(seg) and seg not in _PAINLESS_RESERVED:
        return ".", seg
    return "[", "['%s']" % seg.replace("'", "\\'")


def _segments(dotted):
    # The field map applies on read and on write, so both callers go through
    # map_field here; it is idempotent on an already-mapped name.
    return map_field(dotted).split(".")


def read_path(dotted):
    """Null-safe Painless read for a dotted path (the field map applies)."""
    out = "ctx"
    for i, seg in enumerate(_segments(dotted)):
        kind, text = _segment(seg)
        if kind == ".":
            out += ("." if i == 0 else "?.") + text
        else:
            out += text
    return out


def write_target(dotted):
    """(guards, target) - guards create intermediate maps, target assigns."""
    segs = _segments(dotted)
    guards = []
    path = "ctx"
    for seg in segs[:-1]:
        kind, text = _segment(seg)
        path += text if kind == "[" else "." + text
        guards.append("if (%s == null) { %s = [:]; }" % (path, path))
    kind, text = _segment(segs[-1])
    path += text if kind == "[" else "." + text
    return guards, path


class _Emitter(object):
    def __init__(self):
        self.reads = []
        self.regex = False

    def field(self, segs):
        mapped = map_field(".".join(segs))
        if mapped not in self.reads:
            self.reads.append(mapped)
        return read_path(mapped)

    # -- classification -------------------------------------------------
    def is_bool(self, node):
        k = node[0]
        if k == "bool":
            return True
        if k == "unary" and node[1] == "!":
            return True
        if k == "binary" and node[1] in ("||", "&&", "===", "!==", "==", "!=",
                                         "<", "<=", ">", ">="):
            return True
        if k == "method" and node[2] in _BOOL_METHODS:
            return True
        if k == "call" and node[1] in ("Array.isArray", "Boolean"):
            return True
        return False

    def is_stringy(self, node):
        k = node[0]
        if k == "str":
            return True
        if k == "call" and node[1] == "String":
            return True
        if k == "method" and node[2] in _STRING_PRODUCERS:
            return True
        return False

    def is_numeric(self, node):
        k = node[0]
        if k == "num":
            return True
        if k == "call" and node[1] in ("Date.parse", "parseInt", "parseFloat",
                                       "Number", "Math.floor", "Math.round",
                                       "Math.abs", "Math.max", "Math.min"):
            return True
        if k == "method" and node[2] in _NUMBER_PRODUCERS:
            return True
        if k == "unary" and node[1] in ("-", "+"):
            return True
        if k == "binary" and node[1] in ("-", "*", "/", "%"):
            return True
        return False

    def truthy(self, node):
        """Inlined JS truthiness, narrowed to what Painless will compile.

        Painless is statically typed: comparing the `long` from
        `...toEpochMilli()` with null, false or '' is a compile-time error that
        fails the whole script at PUT time.  So when the emitter already knows
        the operand's type statically, only the comparisons that type admits
        are emitted; untyped reads (`ctx.x` is `def`) keep the full template.
        """
        x = self.value(node)
        if self.is_numeric(node):
            return "(%s != 0)" % x
        if self.is_stringy(node):
            return "(%s != null && %s != '')" % (x, x)
        return "(%s != null && %s != false && %s != '' && %s != 0)" % (x, x, x, x)

    # -- condition mode -----------------------------------------------------
    def cond(self, node):
        k = node[0]
        if k == "binary" and node[1] in ("||", "&&"):
            return "(%s %s %s)" % (self.cond(node[2]), node[1], self.cond(node[3]))
        if k == "unary" and node[1] == "!":
            return "!" + self.cond(node[2])
        if k == "method" and node[2] == "match":
            return self.regex_test(node[1], node[3])
        if self.is_bool(node):
            return self.value(node)
        return self.truthy(node)

    def regex_test(self, subject, args):
        if len(args) != 1 or args[0][0] != "regex":
            raise Untranslatable(".match() needs one regex literal")
        return "(%s =~ %s)" % (self.value(subject), self.regex_literal(args[0]))

    def regex_literal(self, node, drop_g=True):
        pattern, flags = node[1], node[2]
        flags = flags.replace("g", "") if drop_g else flags
        bad = [f for f in flags if f not in "ims"]
        if bad:
            raise Untranslatable("regex flag %r has no Painless equivalent" % bad[0])
        self.regex = True
        return "/%s/%s" % (_escape_regex_slashes(pattern), flags)

    # -- value mode -------------------------------------------------------------
    def value(self, node):
        k = node[0]
        if k == "str":
            return painless_string(node[1])
        if k == "num":
            return node[1]
        if k == "bool":
            return "true" if node[1] else "false"
        if k in ("null", "undef"):
            return "null"
        if k == "array":
            return "[%s]" % ", ".join(self.value(n) for n in node[1])
        if k == "regex":
            raise Untranslatable("a regex literal is only supported in "
                                 ".test(), .match() and .replace()")
        if k == "field":
            return self.field(node[1])
        if k == "typeof":
            raise Untranslatable("typeof is only supported compared with "
                                 "'undefined', 'string', 'number' or 'boolean'")
        if k == "prop":
            raise Untranslatable(".length is ambiguous between strings and lists")
        if k == "unary":
            return self.unary(node)
        if k == "binary":
            return self.binary(node)
        if k == "cond":
            return "(%s ? %s : %s)" % (self.cond(node[1]), self.value(node[2]),
                                       self.value(node[3]))
        if k == "call":
            return self.call(node)
        if k == "newdate":
            raise Untranslatable("new Date(x) is only supported with "
                                 ".toISOString() or .getTime()")
        if k == "method":
            return self.method(node)
        raise Untranslatable("unsupported node %s" % k)

    def unary(self, node):
        op, operand = node[1], node[2]
        if op == "!":
            return "!" + self.cond(operand)
        if op == "-":
            return "(-%s)" % self.value(operand)
        return "Double.parseDouble(String.valueOf(%s).trim())" % self.value(operand)

    def binary(self, node):
        op, left, right = node[1], node[2], node[3]
        if op in ("||", "&&"):
            t = self.truthy(left)
            a, b = self.value(left), self.value(right)
            return "(%s ? %s : %s)" % ((t, a, b) if op == "||" else (t, b, a))
        if op in ("===", "!==", "==", "!="):
            return self.equality(op, left, right)
        if op in ("<", "<=", ">", ">=", "-", "*", "/", "%"):
            return "(%s %s %s)" % (self.value(left), op, self.value(right))
        if op == "+":
            if self.is_stringy(left) or self.is_stringy(right):
                return "(%s + %s)" % (self.stringify(left), self.stringify(right))
            if self.is_numeric(left) or self.is_numeric(right):
                return "(%s + %s)" % (self.value(left), self.value(right))
            raise Untranslatable("ambiguous + (string or numeric): %s"
                                 % " + ".join(x[0] for x in (left, right)))
        raise Untranslatable("operator %s" % op)

    def stringify(self, node):
        if node[0] == "str":
            return self.value(node)
        return "String.valueOf(%s)" % self.value(node)

    def equality(self, op, left, right):
        neg = op in ("!==", "!=")
        sym = "!=" if neg else "=="
        if left[0] == "typeof" or right[0] == "typeof":
            t, lit = (left, right) if left[0] == "typeof" else (right, left)
            if lit[0] != "str":
                raise Untranslatable("typeof must be compared with a string literal")
            subject = self.value(t[1])
            if lit[1] == "undefined":
                return "(%s %s null)" % (subject, sym)
            if lit[1] in _TYPEOF_CLASSES:
                test = "(%s instanceof %s)" % (subject, _TYPEOF_CLASSES[lit[1]])
                return "!" + test if neg else test
            raise Untranslatable("typeof compared with %r" % lit[1])
        if left[0] in ("null", "undef") or right[0] in ("null", "undef"):
            other = right if left[0] in ("null", "undef") else left
            return "(%s %s null)" % (self.value(other), sym)
        if op in ("==", "!=") and (left[0] in ("str", "num")) != (right[0] in ("str", "num")):
            lit, other = (left, right) if left[0] in ("str", "num") else (right, left)
            text = lit[1]
            return "(String.valueOf(%s) %s %s)" % (self.value(other), sym,
                                                    painless_string(text))
        return "(%s %s %s)" % (self.value(left), sym, self.value(right))

    def call(self, node):
        name, args = node[1], node[2]
        if name == "parseInt":
            if len(args) == 2 and args[1] != ("num", "10"):
                raise Untranslatable("parseInt with a radix other than 10")
            if not args:
                raise Untranslatable("parseInt needs an argument")
            return "(long) Double.parseDouble(String.valueOf(%s).trim())" % self.value(args[0])
        if name in ("parseFloat", "Number"):
            self._arity(name, args, 1)
            return "Double.parseDouble(String.valueOf(%s).trim())" % self.value(args[0])
        if name == "String":
            self._arity(name, args, 1)
            return "String.valueOf(%s)" % self.value(args[0])
        if name == "Boolean":
            self._arity(name, args, 1)
            return self.truthy(args[0])
        if name == "Date.parse":
            self._arity(name, args, 1)
            return ("ZonedDateTime.parse(String.valueOf(%s)).toInstant().toEpochMilli()"
                    % self.value(args[0]))
        if name == "Array.isArray":
            self._arity(name, args, 1)
            return "(%s instanceof List)" % self.value(args[0])
        if name.startswith("Math."):
            return "%s(%s)" % (name, ", ".join(self.value(a) for a in args))
        raise Untranslatable("%s is not supported" % name)

    def _arity(self, name, args, n):
        if len(args) != n:
            raise Untranslatable("%s needs %d argument(s)" % (name, n))

    def method(self, node):
        recv, name, args = node[1], node[2], node[3]
        if recv[0] == "newdate":
            inner = "ZonedDateTime.parse(String.valueOf(%s)).toInstant()" % self.value(recv[1])
            if name == "toISOString":
                return inner + ".toString()"
            if name == "getTime":
                return inner + ".toEpochMilli()"
            raise Untranslatable("new Date(x).%s()" % name)
        if recv[0] == "regex":
            if name == "test":
                self._arity(".test", args, 1)
                return "(%s =~ %s)" % (self.value(args[0]), self.regex_literal(recv))
            raise Untranslatable("regex.%s()" % name)
        r = self.value(recv)
        if name in ("toLowerCase", "toUpperCase", "trim"):
            self._arity(name, args, 0)
            return "%s.%s()" % (r, name)
        if name in ("startsWith", "endsWith", "indexOf"):
            self._arity(name, args, 1)
            return "%s.%s(%s)" % (r, name, self.value(args[0]))
        if name == "includes":
            self._arity(name, args, 1)
            return "%s.contains(%s)" % (r, self.value(args[0]))
        if name == "split":
            self._arity(name, args, 1)
            return "%s.splitOnToken(%s)" % (r, self.value(args[0]))
        if name in ("substring", "slice"):
            if not 1 <= len(args) <= 2:
                raise Untranslatable("%s needs one or two arguments" % name)
            for a in args:
                if a[0] == "unary" and a[1] == "-":
                    raise Untranslatable("negative %s index" % name)
            return "%s.substring(%s)" % (r, ", ".join(self.value(a) for a in args))
        if name == "toString":
            self._arity(name, args, 0)
            return "String.valueOf(%s)" % r
        if name == "replace":
            self._arity(name, args, 2)
            pat, repl = args
            if repl[0] != "str":
                raise Untranslatable("replace() needs a string literal replacement")
            if "$" in repl[1]:
                raise Untranslatable("replace() with $-backreferences")
            if pat[0] == "regex":
                fn = "replaceAll" if "g" in pat[2] else "replaceFirst"
                return "%s.%s(%s, m -> %s)" % (r, fn, self.regex_literal(pat),
                                                painless_string(repl[1]))
            if pat[0] == "str":
                return "%s.replace(%s, %s)" % (r, self.value(pat), self.value(repl))
            raise Untranslatable("replace() pattern must be a regex or string literal")
        if name == "match":
            raise Untranslatable(".match() is only supported as a condition")
        raise Untranslatable(".%s() is not supported" % name)


def _constant_of(node):
    """(is_constant, python value) for literal nodes."""
    k = node[0]
    if k == "str":
        return True, node[1]
    if k == "num":
        text = node[1]
        return True, (float(text) if ("." in text or "e" in text.lower()) else int(text))
    if k == "bool":
        return True, node[1]
    if k in ("null", "undef"):
        return True, None
    if k == "array":
        items = []
        for item in node[1]:
            ok, value = _constant_of(item)
            if not ok:
                return False, None
            items.append(value)
        return True, items
    return False, None


def _finish(em, node, source):
    ok, const = _constant_of(node)
    is_field = None
    if node[0] == "field":
        is_field = map_field(".".join(node[1]))
    return Painless(source, reads=em.reads, regex=em.regex, is_constant=ok,
                    constant=const, is_field=is_field)


def translate_value(js):
    node = parse(js)
    em = _Emitter()
    return _finish(em, node, em.value(node))


def translate_condition(js):
    node = parse(js)
    em = _Emitter()
    return _finish(em, node, em.cond(node))
