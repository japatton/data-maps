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

    def test_bad_unicode_escape_is_untranslatable(self):
        self.assertEqual(tokenize(r"'\u0041'")[0][1], "A")
        for src in (r"'\uZZZZ'", r"'\u12'", r"'\u'"):
            with self.assertRaises(Untranslatable, msg=src):
                tokenize(src)

    def test_bad_regex_literal_is_untranslatable(self):
        self.assertEqual(tokenize("/a/gi")[0], ("regex", ("a", "gi"), 0))
        for src in ("//comment", "/a/x", "/a/gz"):
            with self.assertRaises(Untranslatable, msg=src):
                tokenize(src)


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

    def test_length_is_its_own_node(self):
        self.assertEqual(parse("__e['s'].length"), ("prop", ("field", ["s"]), "length"))
        self.assertEqual(parse("__e['s.length']"), ("field", ["s", "length"]))
        self.assertEqual(parse("__e['s'].split(',').length"),
                         ("prop", ("method", ("field", ["s"]), "split",
                                   [("str", ",")]), "length"))

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

    def test_bare_identifier_is_a_field_read(self):
        self.assertEqual(parse("cdrRecordType=='2'"),
                         ("binary", "==", ("field", ["cdrRecordType"]), ("str", "2")))
        self.assertEqual(parse("cef_ext !== undefined"),
                         ("binary", "!==", ("field", ["cef_ext"]), ("undef",)))
        self.assertEqual(parse("a.b"), ("field", ["a", "b"]))
        self.assertEqual(parse("a.length"), ("prop", ("field", ["a"]), "length"))
        self.assertEqual(parse("_raw"), ("field", ["_raw"]))

    def test_bare_identifier_call_is_untranslatable(self):
        with self.assertRaises(Untranslatable) as ctx:
            parse("foo(1)")
        self.assertIn("foo", ctx.exception.reason)

    def test_cribl_namespace_is_untranslatable(self):
        # `C.*` is Cribl's own expression namespace (C.Lookup, C.vars, C.Time).
        # Without it in KNOWN_GLOBALS the bare-identifier rule would read it as
        # an event field called `C` and emit a silently wrong ctx.C.vars.t.
        with self.assertRaises(Untranslatable) as ctx:
            parse("C.vars.t")
        self.assertIn("C", ctx.exception.reason)

    def test_untranslatable_constructs(self):
        for src in ("foo(1)", "__e['a'] = 1", "x => x", "JSON.parse(__e['a'])",
                    "new Foo()", "__e['a']++", "function(){}", "a; b"):
            with self.assertRaises(Untranslatable, msg=src):
                parse(src)

    def test_error_names_the_token(self):
        with self.assertRaises(Untranslatable) as ctx:
            parse("__e['a'] + foo(1)")
        self.assertIn("foo", ctx.exception.reason)


from datamaps.ingest.expr import translate_condition, translate_value, read_path, write_target

T = "(%s != null && %s != false && %s != '' && %s != 0)"


def truthy(x):
    return T % (x, x, x, x)


class TestPaths(unittest.TestCase):
    def test_read_paths(self):
        self.assertEqual(read_path("Keywords"), "ctx.Keywords")
        self.assertEqual(read_path("source.ip"), "ctx.source?.ip")
        self.assertEqual(read_path("detail-type"), "ctx['detail-type']")
        self.assertEqual(read_path("_time"), "ctx['@timestamp']")
        self.assertEqual(read_path("_raw"), "ctx.message")
        self.assertEqual(read_path("in"), "ctx['in']")
        self.assertEqual(read_path("a.b-c"), "ctx.a['b-c']")

    def test_write_targets(self):
        self.assertEqual(write_target("event.dataset"),
                         (["if (ctx.event == null) { ctx.event = [:]; }"],
                          "ctx.event.dataset"))
        self.assertEqual(write_target("a.b.c"),
                         (["if (ctx.a == null) { ctx.a = [:]; }",
                           "if (ctx.a.b == null) { ctx.a.b = [:]; }"],
                          "ctx.a.b.c"))
        self.assertEqual(write_target("_time"), ([], "ctx['@timestamp']"))
        self.assertEqual(write_target("x"), ([], "ctx.x"))

    def test_internal_field_is_untranslatable(self):
        with self.assertRaises(Untranslatable):
            translate_value("__e['__inputId']")

    def test_uri_shaped_key_is_untranslatable(self):
        claim = ("__e['Claims_d']['http://schemas.xmlsoap.org/ws/2005/05/"
                 "identity/claims/upn']")
        with self.assertRaises(Untranslatable) as ctx:
            translate_value(claim)
        self.assertIn("URI-shaped key", ctx.exception.reason)
        with self.assertRaises(Untranslatable):
            expr.map_field("a.b:c")
        with self.assertRaises(Untranslatable):
            read_path("a.http://x.y")


class TestEmitValue(unittest.TestCase):
    def v(self, js):
        return translate_value(js).source

    def test_constants(self):
        r = translate_value("'active_directory.account_management'")
        self.assertEqual(r.source, "'active_directory.account_management'")
        self.assertTrue(r.is_constant)
        self.assertEqual(r.constant, "active_directory.account_management")
        r = translate_value("['network','dns','web']")
        self.assertEqual(r.source, "['network', 'dns', 'web']")
        self.assertEqual(r.constant, ["network", "dns", "web"])
        r = translate_value("12")
        self.assertEqual(r.constant, 12)
        r = translate_value("1.5")
        self.assertEqual(r.constant, 1.5)
        r = translate_value("true")
        self.assertIs(r.constant, True)
        r = translate_value("undefined")
        self.assertTrue(r.is_constant)
        self.assertIsNone(r.constant)
        self.assertEqual(r.source, "null")

    def test_string_escaping(self):
        self.assertEqual(self.v(r"'it\'s \\ ok'"), r"'it\'s \\ ok'")

    def test_single_field(self):
        r = translate_value("__e['Keywords']")
        self.assertEqual(r.source, "ctx.Keywords")
        self.assertEqual(r.is_field, "Keywords")
        self.assertEqual(r.reads, ["Keywords"])
        self.assertFalse(r.is_constant)
        r = translate_value("__e['_raw']")
        self.assertEqual(r.is_field, "message")

    def test_ternary_with_parseint(self):
        js = "__e['BadPasswordCount'] !== undefined ? parseInt(__e['BadPasswordCount'], 10) : undefined"
        self.assertEqual(self.v(js),
                         "((ctx.BadPasswordCount != null) ? (long) Double.parseDouble("
                         "String.valueOf(ctx.BadPasswordCount).trim()) : null)")

    def test_nested_ternary_strict_equality(self):
        js = "__e['Level']==='Critical'?2:(__e['Level']==='Error'?3:undefined)"
        self.assertEqual(self.v(js),
                         "((ctx.Level == 'Critical') ? 2 : ((ctx.Level == 'Error') ? 3 : null))")

    def test_truthy_test_and_date(self):
        js = "__e['t'] ? new Date(__e['t']).toISOString() : undefined"
        self.assertEqual(self.v(js),
                         "(%s ? ZonedDateTime.parse(String.valueOf(ctx.t)).toInstant()"
                         ".toString() : null)" % truthy("ctx.t"))

    def test_or_default_then_replace(self):
        js = "(__e['actionType']||'').replace(/^.*\\./,'')"
        r = translate_value(js)
        self.assertEqual(r.source,
                         "(%s ? ctx.actionType : '').replaceFirst(/^.*\\./, m -> '')"
                         % truthy("ctx.actionType"))
        self.assertTrue(r.regex)

    def test_replace_global_and_string_pattern(self):
        self.assertEqual(self.v("__e['s'].replace(/a/g, 'b')"),
                         "ctx.s.replaceAll(/a/, m -> 'b')")
        self.assertEqual(self.v("__e['s'].replace(/a/gi, 'b')"),
                         "ctx.s.replaceAll(/a/i, m -> 'b')")
        self.assertEqual(self.v("__e['s'].replace('a', 'b')"), "ctx.s.replace('a', 'b')")
        with self.assertRaises(Untranslatable):
            self.v("__e['s'].replace(/(a)/, '$1')")

    def test_regex_slashes_are_escaped_once(self):
        self.assertEqual(self.v("__e['s'].replace(/[/]/g, '-')"),
                         r"ctx.s.replaceAll(/[\/]/, m -> '-')")
        self.assertEqual(translate_condition(r"/^a\/b$/.test(__e['a'])").source,
                         r"(ctx.a =~ /^a\/b$/)")

    def test_date_parse_division(self):
        self.assertEqual(self.v("Date.parse(__e['TimeGenerated'])/1000"),
                         "(ZonedDateTime.parse(String.valueOf(ctx.TimeGenerated))"
                         ".toInstant().toEpochMilli() / 1000)")

    def test_casts(self):
        self.assertEqual(self.v("String(__e['externalId'])"), "String.valueOf(ctx.externalId)")
        self.assertEqual(self.v("Number(__e['Severity'])"),
                         "Double.parseDouble(String.valueOf(ctx.Severity).trim())")
        self.assertEqual(self.v("parseFloat(__e['x'])"),
                         "Double.parseDouble(String.valueOf(ctx.x).trim())")
        with self.assertRaises(Untranslatable):
            self.v("parseInt(__e['x'], 16)")

    def test_or_chain(self):
        self.assertEqual(self.v("__e['a'] || __e['b']"),
                         "(%s ? ctx.a : ctx.b)" % truthy("ctx.a"))
        self.assertEqual(self.v("__e['a'] && __e['b']"),
                         "(%s ? ctx.b : ctx.a)" % truthy("ctx.a"))

    def test_truthiness_is_type_aware(self):
        epoch = "ZonedDateTime.parse(String.valueOf(ctx.t)).toInstant().toEpochMilli()"
        self.assertEqual(self.v("Date.parse(__e['t']) || 0"),
                         "((%s != 0) ? %s : 0)" % (epoch, epoch))
        self.assertEqual(self.v("__e['s'].trim() || 'x'"),
                         "((ctx.s.trim() != null && ctx.s.trim() != '') "
                         "? ctx.s.trim() : 'x')")
        self.assertEqual(self.v("__e['a'] || 'x'"),
                         "(%s ? ctx.a : 'x')" % truthy("ctx.a"))

    def test_concatenation_narrows_to_string_truthiness(self):
        # A concatenation is a String, and `String != false` is a Painless
        # compile error that fails the whole PUT, so the def template must
        # narrow here exactly as it does for .trim() above.
        cat = "('a' + String.valueOf(ctx.b))"
        self.assertEqual(self.v("('a' + __e['b']) || 'z'"),
                         "((%s != null && %s != '') ? %s : 'z')" % (cat, cat, cat))

    def test_boolean_operand_is_its_own_truthiness(self):
        self.assertEqual(self.v("(__e['a'] === 'x') || __e['b']"),
                         "((ctx.a == 'x') ? (ctx.a == 'x') : ctx.b)")
        self.assertEqual(self.v("!__e['a'] || __e['b']"),
                         "(!%s ? !%s : ctx.b)" % (truthy("ctx.a"), truthy("ctx.a")))

    def test_logical_operand_keeps_the_def_template(self):
        inner = "(%s ? ctx.a : ctx.b)" % truthy("ctx.a")
        self.assertEqual(self.v("__e['a'] || __e['b'] || 'z'"),
                         "(%s ? %s : 'z')" % (truthy(inner), inner))

    def test_comparison_as_value(self):
        self.assertEqual(self.v("__e['signed_flag'] === 'S'"), "(ctx.signed_flag == 'S')")

    def test_loose_equality_with_literals(self):
        self.assertEqual(self.v("__e['EventID']=='512'"),
                         "(String.valueOf(ctx.EventID) == '512')")
        self.assertEqual(self.v("__e['EventID']!=512"),
                         "(String.valueOf(ctx.EventID) != '512')")
        self.assertEqual(self.v("__e['a'] == __e['b']"), "(ctx.a == ctx.b)")
        self.assertEqual(self.v("__e['a'] == null"), "(ctx.a == null)")

    def test_string_concat_and_numeric_plus(self):
        self.assertEqual(self.v("'x-' + __e['a']"), "('x-' + String.valueOf(ctx.a))")
        self.assertEqual(self.v("__e['a'].toLowerCase() + __e['b']"),
                         "(String.valueOf(ctx.a.toLowerCase()) + String.valueOf(ctx.b))")
        self.assertEqual(self.v("Date.parse(__e['t']) + 1"),
                         "(ZonedDateTime.parse(String.valueOf(ctx.t)).toInstant()"
                         ".toEpochMilli() + 1)")
        with self.assertRaises(Untranslatable):
            self.v("__e['a'] + __e['b']")

    def test_methods(self):
        self.assertEqual(self.v("__e['s'].split(',')"), "ctx.s.splitOnToken(',')")
        self.assertEqual(self.v("__e['s'].includes('x')"), "ctx.s.contains('x')")
        self.assertEqual(self.v("__e['s'].substring(0, 4)"), "ctx.s.substring(0, 4)")
        self.assertEqual(self.v("__e['s'].slice(2)"), "ctx.s.substring(2)")
        self.assertEqual(self.v("__e['s'].toString()"), "String.valueOf(ctx.s)")
        with self.assertRaises(Untranslatable):
            self.v("__e['s'].slice(-2)")
        with self.assertRaises(Untranslatable):
            self.v("__e['s'].length")

    def test_math_and_isarray(self):
        self.assertEqual(self.v("Math.floor(__e['n'])"), "Math.floor(ctx.n)")
        self.assertEqual(self.v("Array.isArray(__e['n'])"), "(ctx.n instanceof List)")

    def test_unary(self):
        self.assertEqual(self.v("-__e['n']"), "(-ctx.n)")
        self.assertEqual(self.v("+__e['n']"), "Double.parseDouble(String.valueOf(ctx.n).trim())")

    def test_reads_are_collected(self):
        r = translate_value("__e['a'] === 'x' ? __e['b.c'] : __e['_raw']")
        self.assertEqual(r.reads, ["a", "b.c", "message"])


class TestEmitCondition(unittest.TestCase):
    def c(self, js):
        return translate_condition(js).source

    def test_boolean_combos(self):
        self.assertEqual(self.c("__e['EventID']=='512' || __e['EventID']=='516'"),
                         "((String.valueOf(ctx.EventID) == '512') || "
                         "(String.valueOf(ctx.EventID) == '516'))")
        self.assertEqual(self.c("__e['a'] && !__e['b']"),
                         "(%s && !%s)" % (truthy("ctx.a"), truthy("ctx.b")))

    def test_field_alone_is_truthy(self):
        self.assertEqual(self.c("__e['a']"), truthy("ctx.a"))

    def test_typeof(self):
        self.assertEqual(self.c("typeof __e['_metric'] !== 'undefined'"), "(ctx._metric != null)")
        self.assertEqual(self.c("typeof __e['m'] === 'string'"), "(ctx.m instanceof String)")
        with self.assertRaises(Untranslatable):
            self.c("typeof __e['m'] === 'object'")

    def test_regex_test_and_match(self):
        r = translate_condition("/^\\d+$/.test(__e['a'])")
        self.assertEqual(r.source, "(ctx.a =~ /^\\d+$/)")
        self.assertTrue(r.regex)
        self.assertEqual(self.c("__e['a'].match(/x/i)"), "(ctx.a =~ /x/i)")
        with self.assertRaises(Untranslatable):
            translate_value("__e['a'].match(/x/)")

    def test_comparison_stays_boolean(self):
        self.assertEqual(self.c("__e['ProviderName'] !== 'AD FS'"),
                         "(ctx.ProviderName != 'AD FS')")

    def test_true_literal(self):
        self.assertEqual(self.c("true"), "true")

    def test_bare_identifier_reads_ctx(self):
        self.assertEqual(self.c("cdrRecordType=='2'"),
                         "(String.valueOf(ctx.cdrRecordType) == '2')")
        self.assertEqual(translate_value("_raw").source, "ctx.message")


class TestTruthinessNarrowing(unittest.TestCase):
    """Operands whose static type Painless can see must not get the four-way test.

    `long != null` and `String != false` are compile-time errors, so a wrongly
    untyped operand fails the whole PUT rather than just misbehaving.
    """

    PARSEINT = "(long) Double.parseDouble(String.valueOf(ctx.a).trim())"

    def v(self, js):
        return translate_value(js).source

    def test_numeric_sum_of_a_parseint_narrows_to_zero(self):
        total = "(%s + 1)" % self.PARSEINT
        self.assertEqual(self.v("(parseInt(__e['a']) + 1) || 0"),
                         "((%s != 0) ? %s : 0)" % (total, total))

    def test_numeric_sum_of_a_def_and_an_int_narrows_to_zero(self):
        self.assertEqual(self.v("(__e['a'] + 1) || 0"),
                         "(((ctx.a + 1) != 0) ? (ctx.a + 1) : 0)")

    def test_string_concat_keeps_the_stringy_template(self):
        cat = "(String.valueOf(ctx.a) + 'x')"
        self.assertEqual(self.v("(__e['a'] + 'x') || 0"),
                         "((%s != null && %s != '') ? %s : 0)" % (cat, cat, cat))

    def test_two_stringy_branches_make_the_ternary_stringy(self):
        tern = "(%s ? 'x' : 'y')" % truthy("ctx.t")
        self.assertEqual(self.v("(__e['t'] ? 'x' : 'y') || __e['z']"),
                         "((%s != null && %s != '') ? %s : ctx.z)"
                         % (tern, tern, tern))

    def test_two_numeric_branches_make_the_ternary_numeric(self):
        tern = "(%s ? 1 : 2)" % truthy("ctx.t")
        self.assertEqual(self.v("(__e['t'] ? 1 : 2) || __e['z']"),
                         "((%s != 0) ? %s : ctx.z)" % (tern, tern))

    def test_disagreeing_branches_keep_the_four_way_template(self):
        tern = "(%s ? ctx.a : 'y')" % truthy("ctx.t")
        self.assertEqual(self.v("(__e['t'] ? __e['a'] : 'y') || __e['z']"),
                         "(%s ? %s : ctx.z)" % (truthy(tern), tern))

    def test_two_boolean_branches_are_their_own_truthiness(self):
        tern = "(%s ? true : false)" % truthy("ctx.t")
        self.assertEqual(self.v("(__e['t'] ? true : false) || __e['z']"),
                         "(%s ? %s : ctx.z)" % (tern, tern))


if __name__ == "__main__":
    unittest.main()
