import copy
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from datamaps import model, render

ECS = {"ecs_version": "8.11.0", "fields": {
    "source.ip": {"type": "ip", "short": "src"},
    "destination.ip": {"type": "ip", "short": "dst"},
    "event.action": {"type": "keyword", "short": "act"},
    # Deliberately not required by any profile below: the ECS index has to
    # be able to carry a field no alerting profile asks for.
    "network.protocol": {"type": "keyword", "short": "proto"},
}}
PROFILES = {"profiles": {"network": {"required": ["source.ip",
                                                  "destination.ip",
                                                  "event.action"]}}}


def build_site(rows, techs):
    m = model.build_model({"technologies": rows}, techs,
                          copy.deepcopy(PROFILES), ECS)
    out = tempfile.mkdtemp()
    render.render_site(m, ROOT, out)
    return out


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as fh:
        return fh.read()


def row(tech_id, status="in-progress"):
    return {"id": tech_id, "name": tech_id.title(), "vendor": "V<endor>",
            "category": "network-security", "status": status,
            "priority": "core"}


def catalog(rows=None):
    return {"technologies": rows if rows is not None else [
        {"id": "paloalto-ngfw", "name": "Palo Alto NGFW",
         "vendor": "Palo Alto Networks", "category": "network-security",
         "status": "in-progress", "priority": "core"}]}


def fmt_entry(format="syslog-cef", mechanism="cribl-pack",
              fields=None, **extra):
    entry = {
        "format": format,
        "parsing": {"mechanism": mechanism},
        "recommendations": {
            "guarded": {
                "parse_location": "hybrid",
                "cribl": "Add a Cribl Pack for envelope parsing",
                "elastic": "Enrich with an ingest pipeline",
                "relay": "Stage on the low side before the guard"},
            "direct": {
                "parse_location": "low",
                "cribl": "Add a Cribl Pack for envelope parsing",
                "elastic": "Enrich with an ingest pipeline"},
        },
        "fields": fields if fields is not None else [
            {"vendor": "src", "ecs": "source.ip", "status": "mapped"}],
    }
    entry.update(extra)
    return entry


def dataset(ds_id="traffic", cats=("network",), fields=None, route=None,
            mechanism="cribl-pack", formats=None):
    if formats is None:
        formats = [fmt_entry(mechanism=mechanism,
                             fields=fields if fields is not None else [])]
    return {"id": ds_id, "name": ds_id.title(),
            "event_categories": list(cats),
            "route": route if route is not None else {
                "guarded": [{"hop": "cribl", "location": "enclave wg"},
                            {"hop": "guard", "device": "Everfox HSG",
                             "constraints": "syslog only"},
                            {"hop": "elastic",
                             "data_stream": "logs-x." + ds_id}],
                "direct": [{"hop": "cribl"},
                           {"hop": "elastic",
                            "data_stream": "logs-x." + ds_id}]},
            "formats": formats}


def tech():
    doc = {"id": "paloalto-ngfw", "name": "Palo Alto NGFW", "vendor": "V",
           "datasets": [dataset()]}
    return doc


def tech_doc(tech_id):
    return {"id": tech_id, "name": tech_id.title(), "vendor": "V<endor>",
            "draft": True,
            "datasets": [{
                "id": "traffic", "name": "Traffic",
                "description": "flows & <script>alert(1)</script>",
                "event_categories": ["network"],
                "route": {
                    "guarded": [
                        {"hop": "cribl", "location": "enclave wg"},
                        {"hop": "guard", "device": "Everfox HSG",
                         "constraints": "syslog only"},
                        {"hop": "elastic",
                         "data_stream": "logs-x.traffic"}],
                    "direct": [
                        {"hop": "cribl"},
                        {"hop": "elastic",
                         "data_stream": "logs-x.traffic"}]},
                "formats": [{
                    "format": "syslog-csv",
                    "parsing": {"mechanism": "cribl-pack",
                                "artifact": "Pack <1>"},
                    "recommendations": {
                        "guarded": {
                            "parse_location": "hybrid",
                            "cribl": "Add a Cribl Pack for envelope parsing",
                            "elastic": "Enrich with an ingest pipeline",
                            "relay": "Stage on the low side"},
                        "direct": {
                            "parse_location": "low",
                            "cribl": "Add a Cribl Pack for envelope parsing",
                            "elastic": "Enrich with an ingest pipeline"}},
                    "fields": [
                        {"vendor": "src", "ecs": "source.ip",
                         "status": "mapped", "type": "ip",
                         "description": "Source <ip>"},
                        {"vendor": "flags", "ecs": None,
                         "custom": "x.panos.flags", "status": "unmapped"}],
                }]}]}


class TestRenderSite(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = build_site(
            [row("fw"), row("stub", status="planned")],
            {"fw": tech_doc("fw")})

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.out)

    def test_pages_written(self):
        self.assertTrue(os.path.exists(os.path.join(self.out,
                                                    "index.html")))
        self.assertTrue(os.path.exists(os.path.join(self.out,
                                                    "ecs-index.html")))
        self.assertTrue(os.path.exists(os.path.join(self.out, "tech",
                                                    "fw.html")))
        self.assertFalse(os.path.exists(os.path.join(self.out, "tech",
                                                     "stub.html")))
        for name in ("styles.css", "app.js"):
            self.assertTrue(os.path.exists(os.path.join(self.out, name)))

    def test_index_content(self):
        html = read(self.out, "index.html")
        self.assertIn("Fw", html)
        self.assertIn("Stub", html)
        self.assertIn('data-status="planned"', html)
        self.assertIn('data-filter-group="status"', html)
        self.assertIn("ECS 8.11.0", html)
        self.assertIn("V&lt;endor&gt;", html)
        self.assertNotIn("V<endor>", html)

    def test_tech_page_content(self):
        html = read(self.out, "tech", "fw.html")
        self.assertIn("DRAFT", html)
        self.assertIn("Everfox HSG", html)
        self.assertIn("logs-x.traffic", html)
        self.assertIn("cribl-pack", html)
        self.assertIn("source.ip", html)
        self.assertIn("x.panos.flags", html)
        self.assertIn('href="../styles.css"', html)
        self.assertIn('href="../exports/fw.json"', html)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", html)
        self.assertNotIn("<script>alert", html)
        self.assertIn("parse: hybrid", html)
        self.assertIn("<strong>Cribl:</strong>", html)
        self.assertIn("<strong>Elastic:</strong>", html)

    def test_ecs_index_content(self):
        html = read(self.out, "ecs-index.html")
        self.assertIn("source.ip", html)
        self.assertIn("Unmapped required fields", html)
        # the name also appears as an index row, so read the gap section
        gaps = html.split("Unmapped required fields")[1].split("</section>")[0]
        self.assertIn('<span class="chip chip-gap mono">destination.ip</span>',
                      gaps)


class TestTechFormatsAndToggle(unittest.TestCase):
    def render_tech(self, guarded=True):
        doc = tech()
        ds = doc["datasets"][0]
        ds["formats"] = [fmt_entry(),
                         fmt_entry(format="syslog-leef")]
        if not guarded:
            del ds["route"]["guarded"]
            for fmt in ds["formats"]:
                fmt["recommendations"].pop("guarded", None)
        m = model.build_model(catalog(), {"paloalto-ngfw": doc},
                              copy.deepcopy(PROFILES), ECS)
        with tempfile.TemporaryDirectory() as tmp:
            render.render_site(m, ROOT, tmp)
            path = os.path.join(tmp, "tech", "paloalto-ngfw.html")
            with open(path, encoding="utf-8") as fh:
                return fh.read()

    def test_format_switcher_and_variants(self):
        html = self.render_tech()  # two formats: syslog-cef, leef
        self.assertIn('class="format-switch"', html)
        self.assertIn('data-format="syslog-leef"', html)
        self.assertIn("syslog-cef · recommended", html)
        # exactly one variant pre-activated
        self.assertEqual(html.count('format-variant active'), 1)

    def test_side_toggle_and_both_routes(self):
        html = self.render_tech()
        self.assertIn('id="side-toggle"', html)
        self.assertIn('class="route route-guarded"', html)
        self.assertIn('class="route route-direct"', html)
        self.assertIn('id="tech-page" class="side-guarded"', html)

    def test_direct_recs_have_no_relay(self):
        html = self.render_tech()
        guarded = html.split('recs-guarded')[1].split("</div>")[0]
        direct = html.split('recs-direct')[1].split("</div>")[0]
        self.assertIn("Relay:", guarded)
        self.assertNotIn("Relay:", direct)

    def test_no_cds_dataset_renders_single_route(self):
        html = self.render_tech(guarded=False)  # fixture drops route.guarded
        self.assertIn("no CDS crossing", html)
        self.assertNotIn("route-guarded", html)

    def test_page_help_panel(self):
        html = self.render_tech()
        self.assertIn("How to read this page", html)
        self.assertIn('class="panel page-help"', html)

    def test_ecs_index_separates_closable_gaps(self):
        doc = tech()
        ds = doc["datasets"][0]
        ds["formats"] = [fmt_entry(fields=[
            {"vendor": "s", "ecs": "source.ip", "status": "mapped"}]),
            fmt_entry(format="syslog-leef", fields=[
                {"vendor": "d", "ecs": "destination.ip",
                 "status": "mapped"}])]
        out = build_site(catalog()["technologies"],
                         {"paloalto-ngfw": doc})
        try:
            html = read(out, "ecs-index.html")
            self.assertIn("Closable by switching format", html)
            closable = html.split(
                "Closable by switching format")[1].split("</section>")[0]
            self.assertIn('<span class="chip chip-gap mono">destination.ip'
                          "</span>", closable)
        finally:
            shutil.rmtree(out)



# A dataset may serve several alerting categories, and the usage chip
# carries every one of them in a single data-category attribute.  The
# separator is load-bearing: app.js matches by wrapping the value in spaces
# and looking for " <category> ", so join(",") would silently stop every
# multi-category chip from matching any filter.
class TestUsageChipCategories(unittest.TestCase):
    PROFILES = {"profiles": {
        "network": {"required": ["source.ip"]},
        "endpoint": {"required": ["event.action"]},
    }}

    def render(self, cats):
        doc = {"id": "paloalto-ngfw", "name": "Palo Alto NGFW", "vendor": "V",
               "datasets": [dataset("traffic", cats=cats, formats=[
                   fmt_entry(format="syslog-cef", fields=[
                       {"vendor": "src", "ecs": "source.ip",
                        "status": "mapped"},
                       {"vendor": "act", "ecs": "event.action",
                        "status": "mapped"}])])]}
        m = model.build_model(catalog(), {"paloalto-ngfw": doc},
                              copy.deepcopy(self.PROFILES), ECS)
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out, True)
        render.render_site(m, ROOT, out)
        return read(out, "ecs-index.html")

    def test_two_categories_are_one_space_separated_attribute(self):
        html = self.render(("network", "endpoint"))
        # The whole attribute, so a comma (or any other separator) fails.
        self.assertIn('data-category="network endpoint"', html)
        self.assertNotIn('data-category="network,endpoint"', html)
        # Both filter buttons are offered, one per category.
        row = html.split('<div id="filter-row">')[1].split("</div>")[0]
        for cat in ("network", "endpoint"):
            self.assertIn('data-usage-group="category" data-filter-value="'
                          + cat + '"', row)

    def test_one_category_carries_no_separator(self):
        html = self.render(("network",))
        self.assertIn('data-category="network"', html)
        self.assertNotIn('data-category="network ', html)


class TestEcsIndexPage(unittest.TestCase):
    """The CSOC reading: the matrix, the required badges, the filters."""

    @classmethod
    def setUpClass(cls):
        traffic = dataset("traffic", formats=[
            fmt_entry(format="syslog-cef", fields=[
                {"vendor": "src", "ecs": "source.ip", "status": "mapped"},
                {"vendor": "dst", "ecs": "destination.ip",
                 "status": "partial", "transform": "hostname, not an IP"},
                {"vendor": "act", "ecs": "event.action",
                 "status": "mapped"},
                # No profile requires network.protocol, so its index row
                # is the one that must carry no badge.
                {"vendor": "proto", "ecs": "network.protocol",
                 "status": "mapped"}]),
            fmt_entry(format="syslog-leef", fields=[
                {"vendor": "d", "ecs": "destination.ip",
                 "status": "mapped"}])])
        threat = dataset("threat", formats=[
            fmt_entry(format="syslog-cef", fields=[
                {"vendor": "src", "ecs": "source.ip",
                 "status": "mapped"}])])
        doc = {"id": "paloalto-ngfw", "name": "Palo Alto NGFW",
               "vendor": "V", "datasets": [traffic, threat]}
        cls.out = build_site(catalog()["technologies"],
                             {"paloalto-ngfw": doc})
        cls.html = read(cls.out, "ecs-index.html")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.out)

    def test_matrix_summarises_each_category(self):
        self.assertIn("Alerting coverage by category (1)", self.html)
        self.assertIn("network &mdash; 2 of 3 required fields satisfied "
                      "by at least one dataset; 2 datasets, 0 satisfy all",
                      self.html)

    def test_matrix_columns_carry_their_counts(self):
        self.assertIn("<th>Satisfied (3)</th>", self.html)
        self.assertIn("<th>Partial (1)</th>", self.html)
        self.assertIn("<th>Missing (2)</th>", self.html)

    def test_matrix_chips_link_to_the_dataset_anchor(self):
        self.assertIn('<a class="chip chip-satisfied" '
                      'href="tech/paloalto-ngfw.html#ds-traffic">'
                      'paloalto-ngfw/traffic</a>', self.html)
        self.assertIn('<a class="chip chip-partial" '
                      'href="tech/paloalto-ngfw.html#ds-traffic">'
                      'paloalto-ngfw/traffic</a>', self.html)
        self.assertIn('<a class="chip chip-gap" '
                      'href="tech/paloalto-ngfw.html#ds-threat">'
                      'paloalto-ngfw/threat</a>', self.html)

    def test_the_dataset_anchor_exists_on_the_technology_page(self):
        tech_html = read(self.out, "tech", "paloalto-ngfw.html")
        self.assertIn('id="ds-traffic"', tech_html)
        self.assertIn('id="ds-threat"', tech_html)

    def test_required_field_carries_its_categories_badge(self):
        table = self.html.split('id="ecs-rows"')[1]
        cell = table.split('<td class="mono">source.ip')[1].split("</td>")[0]
        self.assertIn('class="badge badge-required"', cell)
        self.assertIn("required: network", cell)

    def test_unrequired_field_carries_no_badge(self):
        """network.protocol is in use and required by nothing."""
        rows = self.html.split('<tbody id="ecs-rows">')[1]
        by_field = dict((chunk.split('">')[0], chunk)
                        for chunk in rows.split('<tr data-search="')[1:])
        self.assertIn("network.protocol", by_field)
        self.assertNotIn("badge-required", by_field["network.protocol"])
        for name in ("source.ip", "destination.ip", "event.action"):
            self.assertIn("badge-required", by_field[name], name)
        # One badge per required field in use, and no more.
        self.assertEqual(self.html.count('class="badge badge-required"'), 3)

    def test_recommended_usage_is_marked_and_names_its_format(self):
        self.assertIn('class="chip usage-chip chip-recommended"', self.html)
        self.assertIn('title="recommended format: syslog-cef"', self.html)
        self.assertIn('title="syslog-leef"', self.html)
        alternate = self.html.split(
            'title="syslog-leef"')[0].rsplit("<a ", 1)[1]
        self.assertNotIn("chip-recommended", alternate)

    def test_every_usage_chip_names_its_format(self):
        # two formats can offer the same vendor field of the same dataset,
        # so the format is what tells the two chips apart
        self.assertIn('data-format="syslog-cef"', self.html)
        self.assertIn('data-format="syslog-leef"', self.html)
        self.assertIn("paloalto-ngfw/traffic: <span class=\"mono\">dst"
                      "</span> (syslog-cef, partial)", self.html)
        self.assertIn("paloalto-ngfw/traffic: <span class=\"mono\">d"
                      "</span> (syslog-leef, mapped)", self.html)

    def test_usage_chips_carry_the_filter_attributes(self):
        self.assertIn('href="tech/paloalto-ngfw.html#ds-traffic" '
                      'class="chip usage-chip chip-recommended" '
                      'data-category="network" data-status="mapped" '
                      'data-format="syslog-cef" data-recommended="1"',
                      self.html)
        self.assertIn('data-category="network" data-status="partial"',
                      self.html)

    def test_filter_row_offers_categories_status_and_the_toggle(self):
        row = self.html.split('<div id="filter-row">')[1].split("</div>")[0]
        self.assertIn('data-usage-group="category" data-filter-value=""',
                      row)
        self.assertIn('data-usage-group="category" '
                      'data-filter-value="network"', row)
        for status in ("mapped", "partial"):
            self.assertIn('data-usage-group="status" data-filter-value="'
                          + status + '"', row)
        # a field with no ECS target never reaches the index, so today no
        # usage is "unmapped" and the button is not offered
        self.assertNotIn('data-filter-value="unmapped"', row)
        self.assertIn('class="active" id="recommended-only" '
                      'data-usage-toggle="recommended"', row)
        self.assertIn('id="ecs-row-count"', row)


class TestExamples(unittest.TestCase):
    def render_with(self, records):
        doc = tech()
        m = model.build_model(
            catalog(), {"paloalto-ngfw": doc}, copy.deepcopy(PROFILES),
            ECS, {("paloalto-ngfw", "traffic"): records})
        with tempfile.TemporaryDirectory() as tmp:
            render.render_site(m, ROOT, tmp)
            return read(tmp, "tech", "paloalto-ngfw.html")

    def rec(self, **over):
        base = {"tech": "paloalto-ngfw", "dataset": "traffic",
                "label": "failed login", "path": "/tmp/x.log",
                "relpath": "paloalto-ngfw/traffic-failed-login.log",
                "size": 42, "text": "raw record", "truncated": False}
        base.update(over)
        return base

    def test_no_examples_renders_no_block(self):
        self.assertNotIn('class="examples"', self.render_with([]))

    def test_example_renders_collapsed_with_label_size_and_download(self):
        html = self.render_with([self.rec()])
        self.assertIn('class="examples"', html)
        self.assertIn("failed login", html)
        self.assertIn("42 bytes", html)
        self.assertIn('href="../examples/'
                      'paloalto-ngfw/traffic-failed-login.log"', html)
        self.assertIn("raw record", html)
        # collapsed: no open attribute
        self.assertNotIn('<details class="panel example" open', html)

    def test_example_text_is_escaped(self):
        html = self.render_with(
            [self.rec(text="<script>alert(1)</script>")])
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", html)
        self.assertNotIn("<script>alert", html)

    def test_truncated_example_carries_the_notice(self):
        html = self.render_with([self.rec(truncated=True, size=99999)])
        self.assertIn('class="example-truncated"', html)
        self.assertIn("download the full record", html)

    def test_example_names_its_source_and_licence(self):
        src = {"name": "elastic-integrations",
               "repo": "https://github.com/elastic/integrations",
               "commit": "0123456789abcdef0123", "license": "Elastic-2.0",
               "paths": ["packages/panw/x/test-traffic.log"]}
        html = self.render_with([self.rec(
            source=src, root="samples",
            relpath="paloalto-ngfw/traffic-syslog-csv-elastic.log")])
        self.assertIn("Sample record", html)
        self.assertIn('href="../samples/'
                      'paloalto-ngfw/traffic-syslog-csv-elastic.log"', html)
        self.assertIn('class="example-source"', html)
        self.assertIn("elastic/integrations", html)
        self.assertIn("0123456789ab", html)
        self.assertIn("Elastic-2.0", html)
        self.assertIn('href="https://github.com/elastic/integrations/blob/'
                      '0123456789abcdef0123/packages/panw/x/test-traffic.log"',
                      html)
        self.assertIn('href="../samples/NOTICE.md"', html)

    def test_synthetic_record_is_labelled_and_names_its_structure(self):
        syn = {"structure_from": [{"what": "PAN-OS CEF format string",
                                   "url": "https://docs.example/cef",
                                   "ref": "read 2026-09-23"}],
               "method": "placeholders filled with invented values"}
        html = self.render_with([self.rec(
            root="synthetic", synthetic=syn,
            relpath="paloalto-ngfw/traffic-syslog-cef-synthetic.log")])
        self.assertIn("Synthetic record", html)
        self.assertIn('class="panel example example-synthetic"', html)
        self.assertIn('class="example-structure"', html)
        self.assertIn('href="https://docs.example/cef"', html)
        self.assertIn("PAN-OS CEF format string", html)
        self.assertIn("Values invented, not captured", html)
        self.assertIn('href="../synthetic/NOTICE.md"', html)
        self.assertIn('href="../synthetic/'
                      'paloalto-ngfw/traffic-syslog-cef-synthetic.log"', html)
        self.assertNotIn("example-source", html)

    def test_example_without_source_has_no_source_line(self):
        html = self.render_with([self.rec()])
        self.assertNotIn("example-source", html)
        self.assertIn("Example record", html)

    def test_untruncated_example_has_no_notice(self):
        self.assertNotIn("example-truncated",
                         self.render_with([self.rec()]))

    def test_reading_guide_explains_examples(self):
        guide = self.render_with([]).split(
            'class="panel page-help"')[1].split("</details>")[0]
        self.assertIn("Example record", guide)


class TestFieldsOmitted(unittest.TestCase):
    def render_formats(self, formats):
        doc = tech()
        doc["datasets"][0]["formats"] = formats
        m = model.build_model(catalog(), {"paloalto-ngfw": doc},
                              copy.deepcopy(PROFILES), ECS)
        with tempfile.TemporaryDirectory() as tmp:
            render.render_site(m, ROOT, tmp)
            return read(tmp, "tech", "paloalto-ngfw.html")

    def test_rationale_replaces_the_empty_table(self):
        leef = fmt_entry(format="syslog-leef", fields=[])
        leef["fields_omitted"] = ("Same alert columns as the deployed JSON, "
                                  "serialized as flat pairs.")
        html = self.render_formats([fmt_entry(), leef])
        self.assertIn('class="fields-omitted"', html)
        self.assertIn("Same alert columns as the deployed JSON", html)
        # the deployed format still gets a real table
        self.assertIn("<th>Vendor field</th>", html)

    def test_reading_guide_status_legend_covers_custom_only_partial(self):
        html = self.render_formats([fmt_entry()])
        guide = html.split('class="panel page-help"')[1].split("</details>")[0]
        self.assertIn("no ECS work outstanding", guide)

    def test_reading_guide_explains_the_missing_table(self):
        html = self.render_formats([fmt_entry()])
        guide = html.split('class="panel page-help"')[1].split("</details>")[0]
        self.assertIn("No field table", guide)

    def test_empty_table_without_a_rationale_still_renders_the_table(self):
        leef = fmt_entry(format="syslog-leef", fields=[])
        html = self.render_formats([fmt_entry(), leef])
        self.assertNotIn("fields-omitted", html)


class TestRouteDetail(unittest.TestCase):
    def render_route(self, route):
        doc = tech()
        doc["datasets"][0]["route"] = route
        m = model.build_model(catalog(), {"paloalto-ngfw": doc},
                              copy.deepcopy(PROFILES), ECS)
        with tempfile.TemporaryDirectory() as tmp:
            render.render_site(m, ROOT, tmp)
            return read(tmp, "tech", "paloalto-ngfw.html")

    def bare_route(self):
        return {"direct": [{"hop": "cribl", "location": "core wg"},
                           {"hop": "elastic",
                            "data_stream": "logs-x.traffic"}]}

    def test_other_hop_renders_its_name(self):
        html = self.render_route({"direct": [
            {"hop": "other", "name": "Arkime capture node"},
            {"hop": "elastic", "data_stream": "logs-x.traffic"}]})
        self.assertIn("other: Arkime capture node", html)

    def test_route_detail_carries_constraints_and_notes(self):
        html = self.render_route({"direct": [
            {"hop": "cribl", "location": "core wg",
             "notes": "Agent ships straight to the core worker group."},
            {"hop": "guard", "device": "Everfox HSG",
             "constraints": "Per-feed content-filter policy not yet defined.",
             "notes": "Plan of record is an HTTP destination carrying NDJSON."},
            {"hop": "elastic", "data_stream": "logs-x.traffic"}]})
        self.assertIn('class="panel route-detail"', html)
        self.assertIn("Route detail", html)
        self.assertIn("Per-feed content-filter policy not yet defined.", html)
        self.assertIn("Plan of record is an HTTP destination carrying NDJSON.",
                      html)
        self.assertIn("Agent ships straight to the core worker group.", html)

    def test_no_route_detail_when_no_hop_has_any(self):
        html = self.render_route(self.bare_route())
        self.assertNotIn("route-detail", html)

    def test_route_detail_stays_inside_its_own_side(self):
        html = self.render_route({
            "guarded": [{"hop": "cribl", "location": "edge wg",
                         "notes": "GUARDED-SIDE-NOTE"},
                        {"hop": "guard", "device": "Everfox HSG",
                         "constraints": "policy pending"},
                        {"hop": "elastic",
                         "data_stream": "logs-x.traffic"}],
            "direct": [{"hop": "cribl", "location": "core wg",
                        "notes": "DIRECT-SIDE-NOTE"},
                       {"hop": "elastic",
                        "data_stream": "logs-x.traffic"}]})
        guarded = html.split('class="route route-direct"')[0]
        direct = html.split('class="route route-direct"')[1]
        self.assertIn("GUARDED-SIDE-NOTE", guarded)
        self.assertNotIn("DIRECT-SIDE-NOTE", guarded)
        self.assertIn("DIRECT-SIDE-NOTE", direct)

    def test_reading_guide_explains_route_detail(self):
        html = self.render_route(self.bare_route())
        guide = html.split('class="panel page-help"')[1].split("</details>")[0]
        self.assertIn("Route detail", guide)

    def test_hop_detail_is_escaped(self):
        html = self.render_route({"direct": [
            {"hop": "cribl", "location": "core wg",
             "notes": "pipe <script>alert(1)</script>"},
            {"hop": "elastic", "data_stream": "logs-x.traffic"}]})
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", html)
        self.assertNotIn("<script>alert", html)


class TestRecommendationRender(unittest.TestCase):
    def render(self, formats):
        doc = tech()
        doc["datasets"][0]["formats"] = formats
        m = model.build_model(catalog(), {"paloalto-ngfw": doc},
                              copy.deepcopy(PROFILES), ECS)
        with tempfile.TemporaryDirectory() as tmp:
            render.render_site(m, ROOT, tmp)
            return read(tmp, "tech", "paloalto-ngfw.html")

    def test_switcher_marks_recommended_and_scores(self):
        a = fmt_entry(fields=[{"vendor": "s", "ecs": "source.ip",
                               "status": "mapped"}])
        b = fmt_entry(format="syslog-leef", fields=[])
        b["fields_omitted"] = "unpublished"
        html = self.render([a, b])
        self.assertIn("· recommended", html)
        self.assertNotIn("· deployed", html)
        self.assertIn('class="fmt-score"', html)

    def test_override_shows_both_readings(self):
        a = fmt_entry(recommended=True,
                      recommended_because="LEEF keys are unpublished",
                      fields=[])
        a["fields_omitted"] = "unpublished"
        b = fmt_entry(format="syslog-leef", fields=[
            {"vendor": "s", "ecs": "source.ip", "status": "mapped"}])
        html = self.render([a, b])
        self.assertIn('class="recommendation-note"', html)
        note = html.split('class="recommendation-note"')[1].split("</p>")[0]
        self.assertIn("LEEF keys are unpublished", note)
        self.assertIn("syslog-leef", note)
        self.assertIn("1/3", note)

    def test_parse_provenance_rendered(self):
        html = self.render([fmt_entry(mechanism="elastic-integration")])
        self.assertIn('class="parse-provenance', html)

    def test_parse_provenance_reads_doctrine_when_authored_matches(self):
        entry = fmt_entry(mechanism="elastic-integration")
        entry["recommendations"]["guarded"]["parse_location"] = "high"
        entry["recommendations"]["direct"]["parse_location"] = "high"
        html = self.render([entry])
        self.assertIn('class="parse-provenance">doctrine<', html)
        self.assertNotIn("parse-conflict", html)

    def test_parse_provenance_flags_a_conflict_with_doctrine(self):
        entry = fmt_entry(mechanism="elastic-integration")
        entry["recommendations"]["guarded"]["parse_location"] = "low"
        entry["recommendations"]["direct"]["parse_location"] = "low"
        html = self.render([entry])
        self.assertIn('class="parse-provenance parse-conflict"', html)
        self.assertIn("doctrine says high", html)

    def test_switch_gain_line(self):
        a = fmt_entry(fields=[{"vendor": "s", "ecs": "source.ip",
                               "status": "mapped"}])
        b = fmt_entry(format="syslog-leef", fields=[
            {"vendor": "d", "ecs": "destination.ip", "status": "mapped"}])
        html = self.render([a, b])
        self.assertIn('class="switch-gain"', html)
        self.assertIn("would satisfy", html)

    def test_no_switch_gain_line_when_nothing_to_gain(self):
        self.assertNotIn("switch-gain", self.render([fmt_entry()]))

    def test_export_choice_block(self):
        a = fmt_entry()
        b = fmt_entry(format="syslog-leef")
        self.assertIn('id="export-choice"', self.render([a, b]))

    def test_export_choice_sentence_when_no_format_is_universal(self):
        doc = tech()
        doc["datasets"] = [
            dataset(ds_id="a", formats=[fmt_entry(format="syslog-cef")]),
            dataset(ds_id="b", formats=[fmt_entry(format="json")]),
        ]
        m = model.build_model(catalog(), {"paloalto-ngfw": doc},
                              copy.deepcopy(PROFILES), ECS)
        with tempfile.TemporaryDirectory() as tmp:
            render.render_site(m, ROOT, tmp)
            html = read(tmp, "tech", "paloalto-ngfw.html")
        self.assertIn(
            "No single format is offered by every dataset", html)
        block = html.split('id="export-choice"')[1].split("</details>")[0]
        self.assertNotIn("<table>", block)

    def test_reading_guide_explains_the_recommendation(self):
        guide = self.render([fmt_entry()]).split(
            'class="panel page-help"')[1].split("</details>")[0]
        self.assertIn("recommended", guide)


class TestFragment(unittest.TestCase):
    def test_fragment_is_a_substring_of_the_technology_page(self):
        techs = {"paloalto-ngfw": {
            "id": "paloalto-ngfw", "name": "Palo Alto NGFW", "vendor": "PAN",
            "datasets": [{
                "id": "traffic", "name": "Traffic", "description": "flows",
                "event_categories": ["network"],
                "route": {"direct": [{"hop": "cribl", "location": "core"},
                                     {"hop": "elastic", "data_stream": "logs-panw"}]},
                "formats": [{
                    "format": "syslog-csv",
                    "parsing": {"mechanism": "cribl-pipeline",
                                "artifact": "dm_paloalto_ngfw_traffic_syslog_csv",
                                "notes": "positional CSV"},
                    "recommendations": {"direct": {"parse_location": "high",
                                                   "cribl": "split the CSV",
                                                   "elastic": "index as-is"}},
                    "fields": [{"vendor": "src", "type": "ip",
                                "description": "source", "ecs": "source.ip",
                                "status": "mapped"},
                               {"vendor": "odd <field>", "type": "keyword",
                                "description": "x & y", "ecs": None,
                                "custom": "panw.odd", "status": "unmapped"}]}]}]}}
        m = model.build_model(catalog(), techs, copy.deepcopy(PROFILES), ECS)
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out, True)
        render.render_site(m, ROOT, out)
        page = read(out, "tech", "paloalto-ngfw.html")
        env = render.build_env(ROOT)
        view = m["technologies"][0]
        frag = render.fragment_html(env, view["datasets"][0],
                                    view["datasets"][0]["formats"][0], "../")
        self.assertIn("odd &lt;field&gt;", frag)
        self.assertIn("x &amp; y", frag)
        self.assertIn(frag.strip(), page)


class TestPickerPage(unittest.TestCase):
    def test_picker_page_and_scripts_are_emitted(self):
        out = build_site(catalog()["technologies"], {})
        self.addCleanup(shutil.rmtree, out, True)
        page = read(out, "picker.html")
        self.assertIn('id="pick-tech"', page)
        self.assertIn('src="picker/picker.js"', page)
        self.assertIn('href="picker.html">Picker</a>', read(out, "index.html"))
        for name in ("picker.js", "hash.js", "state.js", "render.js"):
            self.assertTrue(os.path.exists(os.path.join(out, "picker", name)), name)
        self.assertFalse(os.path.exists(os.path.join(out, "picker", "tests")))


if __name__ == "__main__":
    unittest.main()
