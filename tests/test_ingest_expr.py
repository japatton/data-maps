import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps.ingest import expr
from datamaps.ingest.expr import Untranslatable, parse, tokenize


class TestTokenize(unittest.TestCase):
    def test_kinds(self):
        toks = tokenize("__e['a'] !== undefined ? 1 : 'x'")
        self.assertEqual([t[0] for t in toks],
                         ["ident", "punct", "str", "punct", "punct", "ident",
                          "punct", "num", "punct", "str", "eof"])

    def test_regex_after_operator_or_start(self):
        toks = tokenize("/^a\\/b$/i.test(__e['x'])")
        self.assertEqual(toks[0], ("regex", ("^a\\/b$", "i"), 0))
        toks = tokenize("x.replace(/a/g, 'b')")
        self.assertIn(("regex", ("a", "g"), 10), toks)

    def test_slash_after_value_is_division(self):
        toks = tokenize("Date.parse(__e['t'])/1000")
        self.assertIn(("punct", "/", 20), toks)

    def test_string_escapes(self):
        self.assertEqual(tokenize(r"'it\'s'")[0][1], "it's")
        self.assertEqual(tokenize(r'"a\nb"')[0][1], "a\nb")

    def test_unterminated_string_is_untranslatable(self):
        with self.assertRaises(Untranslatable):
            tokenize("'abc")


class TestParse(unittest.TestCase):
    def test_literals(self):
        self.assertEqual(parse("'a'"), ("str", "a"))
        self.assertEqual(parse("12"), ("num", "12"))
        self.assertEqual(parse("1.5"), ("num", "1.5"))
        self.assertEqual(parse("true"), ("bool", True))
        self.assertEqual(parse("null"), ("null",))
        self.assertEqual(parse("undefined"), ("undef",))
        self.assertEqual(parse("['a', 'b']"), ("array", [("str", "a"), ("str", "b")]))

    def test_field_forms(self):
        self.assertEqual(parse("__e['a']"), ("field", ["a"]))
        self.assertEqual(parse('__e["a.b"]'), ("field", ["a", "b"]))
        self.assertEqual(parse("__e.a"), ("field", ["a"]))
        self.assertEqual(parse("__e['a'].b"), ("field", ["a", "b"]))
        self.assertEqual(parse("__e['a']['b']"), ("field", ["a", "b"]))
        self.assertEqual(parse("__e['detail-type']"), ("field", ["detail-type"]))

    def test_precedence(self):
        node = parse("__e['a'] === 'x' || __e['b'] === 'y' && !__e['c']")
        self.assertEqual(node[0], "binary")
        self.assertEqual(node[1], "||")
        self.assertEqual(node[3][1], "&&")
        self.assertEqual(node[3][3], ("unary", "!", ("field", ["c"])))

    def test_ternary_nests_right(self):
        node = parse("__e['l']==='C'?2:(__e['l']==='E'?3:undefined)")
        self.assertEqual(node[0], "cond")
        self.assertEqual(node[2], ("num", "2"))
        self.assertEqual(node[3][0], "cond")
        self.assertEqual(node[3][3], ("undef",))

    def test_calls_and_methods(self):
        self.assertEqual(parse("parseInt(__e['n'], 10)"),
                         ("call", "parseInt", [("field", ["n"]), ("num", "10")]))
        self.assertEqual(parse("Date.parse(__e['t'])"),
                         ("call", "Date.parse", [("field", ["t"])]))
        self.assertEqual(parse("Math.floor(1.5)"), ("call", "Math.floor", [("num", "1.5")]))
        self.assertEqual(parse("new Date(__e['t']).toISOString()"),
                         ("method", ("newdate", ("field", ["t"])), "toISOString", []))
        self.assertEqual(parse("__e['s'].toLowerCase()"),
                         ("method", ("field", ["s"]), "toLowerCase", []))
        self.assertEqual(parse("(__e['a']||'').replace(/^.*\\./,'')"),
                         ("method",
                          ("binary", "||", ("field", ["a"]), ("str", "")),
                          "replace", [("regex", "^.*\\.", ""), ("str", "")]))
        self.assertEqual(parse("typeof __e['m'] !== 'undefined'"),
                         ("binary", "!==", ("typeof", ("field", ["m"])), ("str", "undefined")))

    def test_untranslatable_constructs(self):
        for src in ("foo", "__e['a'] = 1", "x => x", "JSON.parse(__e['a'])",
                    "new Foo()", "__e['a']++", "function(){}", "a; b"):
            with self.assertRaises(Untranslatable, msg=src):
                parse(src)

    def test_error_names_the_token(self):
        with self.assertRaises(Untranslatable) as ctx:
            parse("__e['a'] + foo")
        self.assertIn("foo", ctx.exception.reason)
