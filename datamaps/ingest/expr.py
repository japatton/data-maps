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
                    if e == "u" and i + 5 < n:
                        buf.append(chr(int(src[i + 2:i + 6], 16)))
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
                toks.append(("regex", ("".join(buf), flags), start))
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
