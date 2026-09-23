import copy
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import cribl_paths as cp


def pipe(*functions):
    return {"id": "dm_t_d_f", "conf": {"output": "default", "description": "t",
                                       "functions": list(functions)}}


def ev(add=None, remove=None, filt="true"):
    conf = {}
    if add is not None:
        conf["add"] = [{"name": n, "value": v} for n, v in add]
    if remove is not None:
        conf["remove"] = remove
    return {"id": "eval", "filter": filt, "conf": conf}


def fns(doc):
    return doc["conf"]["functions"]


def body(doc):
    """Functions without the trailing re-nest step."""
    out = fns(doc)
    assert cp.is_renest(out[-1]), out[-1]
    return out[:-1]


class TestExpressions(unittest.TestCase):
    def rw(self, src, flat, mode="expr"):
        out, problems = cp.rewrite_expr(src, cp.FlatSet(flat), mode)
        return out, problems

    def test_bare_and_member_and_bracket_chains(self):
        flat = ["event.action"]
        self.assertEqual(self.rw("event.action == 'x'", flat)[0],
                         "__e['event.action'] == 'x'")
        self.assertEqual(self.rw("__e.event.action", flat)[0], "__e['event.action']")
        self.assertEqual(self.rw("__e['event']['action']", flat)[0],
                         "__e['event.action']")
        self.assertEqual(self.rw("__e['event.action']", flat)[0], "__e['event.action']")

    def test_longest_prefix_keeps_the_tail(self):
        self.assertEqual(self.rw("event.action.indexOf('a') > -1", ["event.action"])[0],
                         "__e['event.action'].indexOf('a') > -1")
        self.assertEqual(self.rw("a.b.c", ["a.b"])[0], "__e['a.b'].c")
        self.assertEqual(self.rw("typeof x.y", ["x.y"])[0], "typeof __e['x.y']")

    def test_untouched(self):
        flat = ["event.action", "x.y"]
        for src in ("'event.action'", "\"x.y\"", "/event.action/.test(a)",
                    "id.orig_h", "Math.floor(n)", "C.Time.strftime(t, '%s')",
                    "Date.parse(t)", "event", "obj.x.y"):
            self.assertEqual(self.rw(src, flat)[0], src, src)

    def test_parent_read_is_reported_not_rewritten(self):
        out, problems = self.rw("event ? 1 : 0", ["event.action"])
        self.assertEqual(out, "event ? 1 : 0")
        self.assertEqual([p[0] for p in problems], ["parent-read-of-flat"])

    def test_null_safe_parent_idiom(self):
        flat = ["event.code", "event.end"]
        self.assertEqual(self.rw("Number((__e['event']||{})['code'])===0", flat)[0],
                         "Number(__e['event.code'])===0")
        self.assertEqual(self.rw("(__e.event || {}).end", flat)[0], "__e['event.end']")
        self.assertEqual(self.rw("(__e['attributes']||{})['jobType']", flat)[0],
                         "(__e['attributes']||{})['jobType']")

    def test_parent_guard_before_a_flat_child_is_dropped(self):
        flat = ["user.name", "observer.hostname", "event.original", "user.target.name"]
        self.assertEqual(self.rw("(__e['user'] && __e['user.name']) ? 1 : 0", flat)[0],
                         "(__e['user.name']) ? 1 : 0")
        self.assertEqual(
            self.rw("__e['observer']!==undefined && __e['observer.hostname']!==undefined", flat)[0],
            "__e['observer.hostname']!==undefined")
        self.assertEqual(
            self.rw("typeof __e['event'] === 'object' && typeof __e['event.original'] === 'string'", flat)[0],
            "typeof __e['event.original'] === 'string'")
        self.assertEqual(
            self.rw("__e['user'] && __e['user']['target'] && __e['user']['target']['name']", flat)[0],
            "__e['user.target.name']")

    def test_negated_parent_guard_is_kept(self):
        src = "!__e['user'] && __e['user.name'] ? 1 : 0"
        self.assertEqual(self.rw(src, ["user.name"])[0], src)

    def test_parent_guard_kept_without_a_flat_child_read(self):
        out, problems = self.rw("__e['user'] && __e['user'].indexOf('@') > -1", ["user.name"])
        self.assertEqual(out, "__e['user'] && __e['user'].indexOf('@') > -1")
        self.assertEqual([p[0] for p in problems], ["parent-read-of-flat"] * 2)

    def test_code_mode_only_rewrites_event_chains(self):
        src = "const x = {y: 1}; __e['o'] = x.y + __e.a.b;"
        self.assertEqual(self.rw(src, ["x.y", "a.b"], "code")[0],
                         "const x = {y: 1}; __e['o'] = x.y + __e['a.b'];")

    def test_code_comments_are_skipped(self):
        src = "// a.b here\n__e['o'] = __e.a.b; /* __e.a.b */"
        self.assertEqual(self.rw(src, ["a.b"], "code")[0],
                         "// a.b here\n__e['o'] = __e['a.b']; /* __e.a.b */")

    def test_flat_prefix_from_flatten(self):
        flat = cp.FlatSet([], prefixes=["call"])
        self.assertTrue(flat.has("call.id"))
        self.assertTrue(flat.has("call.leg.id"))
        self.assertFalse(flat.has("call"))
        self.assertFalse(flat.has("caller.id"))


class TestPipelineRewrite(unittest.TestCase):
    def test_eval_write_quoted_and_later_read_rewritten(self):
        doc = pipe(ev(add=[("o0", "event.action"),
                           ("event.action", "'x'"),
                           ("o", "event.action == 'x' ? 1 : 0")]))
        out, changes, problems = cp.rewrite_pipeline(doc)
        rows = body(out)[0]["conf"]["add"]
        self.assertEqual(rows[0]["value"], "event.action")  # read before write
        self.assertEqual(rows[1]["name"], "'event.action'")
        self.assertEqual(rows[2]["value"], "__e['event.action'] == 'x' ? 1 : 0")
        self.assertTrue(changes)
        self.assertEqual(problems, [])

    def test_input_is_not_mutated(self):
        doc = pipe(ev(add=[("a.b", "1")]))
        before = copy.deepcopy(doc)
        cp.rewrite_pipeline(doc)
        self.assertEqual(doc, before)

    def test_rename_moves_flatness(self):
        doc = pipe(ev(add=[("tmp.v", "'1'")]),
                   {"id": "rename", "filter": "true", "conf": {"rename": [
                       {"currentName": "tmp.v", "newName": "source.ip"},
                       {"currentName": "src", "newName": "user"}]}},
                   ev(add=[("s", "source.ip"), ("t", "tmp.v")]))
        out, _, _ = cp.rewrite_pipeline(doc)
        pairs = body(out)[1]["conf"]["rename"]
        self.assertEqual(pairs[0], {"currentName": "'tmp.v'", "newName": "'source.ip'"})
        self.assertEqual(pairs[1], {"currentName": "src", "newName": "user"})
        rows = body(out)[2]["conf"]["add"]
        self.assertEqual(rows[0]["value"], "__e['source.ip']")
        self.assertEqual(rows[1]["value"], "tmp.v")

    def test_remove_quoted_mask_untouched(self):
        doc = pipe(ev(add=[("a.b", "'1'")]),
                   {"id": "mask", "filter": "true", "conf": {
                       "rules": [{"matchRegex": "/x/g", "replaceExpr": "'y'"}],
                       "fields": ["a.b"]}},
                   ev(remove=["a.b", "c.d", "a.*"]))
        out, _, _ = cp.rewrite_pipeline(doc)
        self.assertEqual(body(out)[1]["conf"]["fields"], ["a.b"])
        self.assertEqual(body(out)[2]["conf"]["remove"], ["'a.b'", "c.d", "a.*"])

    def test_flatten_makes_its_fields_flat(self):
        doc = pipe({"id": "flatten", "filter": "true", "conf": {
                        "fields": ["call"], "depth": 5, "type": "flatten",
                        "delimiter": "."}},
                   {"id": "rename", "filter": "true", "conf": {"rename": [
                       {"currentName": "call.id", "newName": "event.id"}]}})
        out, _, _ = cp.rewrite_pipeline(doc)
        self.assertEqual(body(out)[1]["conf"]["rename"],
                         [{"currentName": "'call.id'", "newName": "'event.id'"}])

    def test_code_flat_assignment_counts(self):
        doc = pipe({"id": "code", "filter": "true",
                    "conf": {"code": "__e['x.y'] = 1; __e['z'] = __e.x.y;"}},
                   ev(add=[("o", "x.y")]))
        out, _, _ = cp.rewrite_pipeline(doc)
        self.assertEqual(body(out)[0]["conf"]["code"],
                         "__e['x.y'] = 1; __e['z'] = __e['x.y'];")
        self.assertEqual(body(out)[1]["conf"]["add"][0]["value"], "__e['x.y']")

    def test_filters_and_timestamp_fields(self):
        doc = pipe(ev(add=[("a.b", "'1'")]),
                   {"id": "auto_timestamp", "filter": "a.b != null",
                    "conf": {"srcField": "a.b", "dstField": "event.start"}},
                   ev(add=[("o", "event.start")]))
        out, _, _ = cp.rewrite_pipeline(doc)
        ts = body(out)[1]
        self.assertEqual(ts["filter"], "__e['a.b'] != null")
        self.assertEqual(ts["conf"], {"srcField": "'a.b'", "dstField": "'event.start'"})
        self.assertEqual(body(out)[2]["conf"]["add"][0]["value"], "__e['event.start']")

    def test_disabled_functions_untouched(self):
        off = ev(add=[("a.b", "'1'")])
        off["disabled"] = True
        doc = pipe(off, ev(add=[("o", "a.b")]))
        out, _, _ = cp.rewrite_pipeline(doc)
        self.assertEqual(body(out)[0], off)
        self.assertEqual(body(out)[1]["conf"]["add"][0]["value"], "a.b")

    def test_renest_appended_once_and_rewrite_is_idempotent(self):
        doc = pipe(ev(add=[("a.b", "'1'"), ("o", "a.b")]))
        once, changes, _ = cp.rewrite_pipeline(doc)
        self.assertEqual(sum(1 for f in fns(once) if cp.is_renest(f)), 1)
        twice, changes2, _ = cp.rewrite_pipeline(once)
        self.assertEqual(twice, once)
        self.assertEqual(changes2, [])

    def test_renest_moves_to_the_end(self):
        doc = pipe(cp.renest_function(), ev(add=[("a.b", "'1'")]))
        out, changes, _ = cp.rewrite_pipeline(doc)
        self.assertTrue(cp.is_renest(fns(out)[-1]))
        self.assertEqual(sum(1 for f in fns(out) if cp.is_renest(f)), 1)
        self.assertTrue(changes)

    def test_parent_read_problem_names_the_function(self):
        doc = pipe(ev(add=[("event.kind", "'e'"), ("o", "Object.keys(event)")]))
        _, _, problems = cp.rewrite_pipeline(doc)
        self.assertEqual(problems[0][0], "parent-read-of-flat")
        self.assertIn("functions[0]", problems[0][1])


if __name__ == "__main__":
    unittest.main()
