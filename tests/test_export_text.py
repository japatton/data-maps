import copy
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import export_text, model

ECS = {"ecs_version": "8.11.0", "fields": {"source.ip": {"type": "ip", "short": "s"}}}
PROFILES = {"profiles": {"network": {"required": ["source.ip"]}}}
ROW = {"id": "t", "name": "Tech", "vendor": "V", "category": "network-security",
       "status": "in-progress", "priority": "core"}
TECH = {"id": "t", "name": "Tech", "vendor": "V", "datasets": [{
    "id": "d", "name": "Data", "description": "what it is",
    "event_categories": ["network"],
    "route": {"direct": [{"hop": "cribl", "location": "core"},
                         {"hop": "elastic", "data_stream": "logs-t"}]},
    "formats": [{
        "format": "json",
        "parsing": {"mechanism": "cribl-pipeline", "artifact": "dm_t_d_json",
                    "notes": "parse it"},
        "recommendations": {"direct": {"parse_location": "high",
                                       "cribl": "do x", "elastic": "do y"}},
        "fields": [
            {"vendor": "src", "type": "ip", "description": "source, \"quoted\"",
             "ecs": "source.ip", "status": "mapped"},
            {"vendor": "note", "type": "text", "description": "multi\nline",
             "ecs": None, "custom": "t.note", "status": "unmapped",
             "transform": "trim", "notes": "n"}]}]}]}


def views():
    # A deep copy per call for the same reason PROFILES gets one: build_model
    # keeps references to the authored dicts, so a test that writes through a
    # view (test_pipes_in_cells_are_escaped) would otherwise edit the fixture
    # every later test reads.
    m = model.build_model({"technologies": [ROW]}, {"t": copy.deepcopy(TECH)},
                          copy.deepcopy(PROFILES), ECS)
    tv = m["technologies"][0]
    return tv, tv["datasets"][0], tv["datasets"][0]["formats"][0]


class TestCsv(unittest.TestCase):
    def test_header_and_rows(self):
        text = export_text.block_csv(*views())
        lines = text.split("\r\n")
        self.assertEqual(lines[0], ",".join(export_text.CSV_COLUMNS))
        self.assertEqual(lines[1],
                         't,d,json,1,src,ip,"source, ""quoted""",source.ip,mapped,,,')
        self.assertTrue(lines[2].startswith('t,d,json,2,note,text,"multi\nline",,unmapped,t.note,trim,n'))
        self.assertEqual(text[-2:], "\r\n")

    def test_columns_are_studios(self):
        self.assertEqual(export_text.CSV_COLUMNS,
                         ["technology", "dataset", "format", "#", "vendor", "type",
                          "description", "ecs", "status", "custom", "transform", "notes"])


class TestMarkdown(unittest.TestCase):
    def test_sections(self):
        md = export_text.block_markdown(*views())
        self.assertTrue(md.startswith("# Tech — d — json\n"))
        for heading in ("## Route", "## Parsing", "## Recommendations", "## Fields"):
            self.assertIn(heading, md)
        self.assertIn("`cribl-pipeline`", md)
        self.assertIn("**Cribl:** do x", md)
        self.assertIn("| `src` | ip | source, \"quoted\" | `source.ip` |  |  | mapped | ● |", md)
        self.assertIn("| `note` | text | multi line |  | `t.note` | trim n | unmapped |  |", md)
        self.assertIn("cribl: core → elastic: logs-t", md)

    def test_pipes_in_cells_are_escaped(self):
        tv, dv, fv = views()
        fv["fields"][0]["field"]["description"] = "a | b"
        md = export_text.block_markdown(tv, dv, fv)
        self.assertIn("a \\| b", md)


if __name__ == "__main__":
    unittest.main()
