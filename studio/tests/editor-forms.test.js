// The editor's pure helpers: what the field table counts and what the hop
// forms are allowed to show.  The widgets themselves need a DOM and are
// exercised by hand against the dev server.

import test from "node:test";
import assert from "node:assert/strict";
import { SCHEMA } from "./fixtures.js";
import {
  requiredEcs, fieldSummary, summaryLine, pathLabel, hopKeys, newDataset,
  newField, newFormat, tabAria, panelAria, tabTarget, pendingFor,
  orphanExamples,
} from "../views/editor-forms.js";

test("requiredEcs unions the profiles of every event category", () => {
  const one = requiredEcs(SCHEMA, ["network"]);
  assert.deepEqual(Array.from(one).sort(),
                   ["destination.ip", "destination.port", "event.action",
                    "event.outcome", "host.name", "network.transport",
                    "source.ip", "source.port"]);
  // authentication adds exactly one target the network profile does not ask
  // for; everything else it wants is already in the union.
  const both = requiredEcs(SCHEMA, ["network", "authentication"]);
  assert.deepEqual(Array.from(both).sort(),
                   ["destination.ip", "destination.port", "event.action",
                    "event.outcome", "host.name", "network.transport",
                    "source.ip", "source.port", "user.name"]);
});

test("requiredEcs ignores unknown or missing categories", () => {
  assert.equal(requiredEcs(SCHEMA, ["nope"]).size, 0);
  assert.equal(requiredEcs(SCHEMA, []).size, 0);
  assert.equal(requiredEcs(SCHEMA, null).size, 0);
  assert.equal(requiredEcs({}, ["network"]).size, 0);
});

test("fieldSummary counts fields, mappings and covered targets", () => {
  const required = requiredEcs(SCHEMA, ["network"]);
  const summary = fieldSummary([
    { vendor: "a", ecs: "source.ip", status: "mapped" },
    { vendor: "b", ecs: "event.action", status: "partial" },
    { vendor: "c", ecs: null, status: "unmapped" },
  ], required);
  assert.deepEqual(summary,
                   { count: 3, mapped: 1, covered: 2,
                     required: SCHEMA.profiles.network.length });
});

test("fieldSummary does not credit an unmapped row with a target", () => {
  const required = requiredEcs(SCHEMA, ["network"]);
  const summary = fieldSummary([
    { vendor: "a", ecs: "source.ip", status: "unmapped" },
  ], required);
  assert.equal(summary.covered, 0);
  assert.equal(summary.mapped, 0);
});

test("fieldSummary counts each target once and ignores off-profile ones", () => {
  const required = requiredEcs(SCHEMA, ["network"]);
  const summary = fieldSummary([
    { vendor: "a", ecs: "source.ip", status: "mapped" },
    { vendor: "b", ecs: "source.ip", status: "mapped" },
    // in the ECS dictionary, but not a target the network profile asks for
    { vendor: "c", ecs: "client.ip", status: "mapped" },
  ], required);
  assert.equal(summary.covered, 1);
  assert.equal(summary.mapped, 3);
});

test("fieldSummary tolerates a broken inventory", () => {
  assert.deepEqual(fieldSummary(undefined, undefined),
                   { count: 0, mapped: 0, covered: 0, required: 0 });
  assert.deepEqual(fieldSummary([null, "x"], ["source.ip"]),
                   { count: 2, mapped: 0, covered: 0, required: 1 });
});

test("summaryLine reads as the line above the table", () => {
  assert.equal(
    summaryLine({ count: 12, mapped: 9, covered: 2, required: 3 }),
    "12 fields · 9 mapped · 2 alerting-required targets covered of 3");
});

test("pathLabel prints a validator path the way the file reads", () => {
  assert.equal(pathLabel(["datasets", 0, "formats", 1, "fields", 2, "ecs"]),
               "datasets[0].formats[1].fields[2].ecs");
  assert.equal(pathLabel(["row", "category"]), "row.category");
  assert.equal(pathLabel([]), "");
});

test("hopKeys drops the discriminator and follows the kind", () => {
  assert.deepEqual(hopKeys(SCHEMA, "cribl"), ["location", "notes"]);
  assert.deepEqual(hopKeys(SCHEMA, "guard"),
                   ["device", "constraints", "notes"]);
  assert.deepEqual(hopKeys(SCHEMA, "elastic"), ["data_stream", "notes"]);
  assert.deepEqual(hopKeys(SCHEMA, "nonesuch"), []);
});

// The format strip is a tablist, so it has to be one all the way through:
// every tab names the panel it controls, the open one is the only tab stop,
// and the panel names the tab it belongs to.
test("a format tab declares the panel it controls and the tab stop", () => {
  assert.deepEqual(tabAria(7, 1, 1), {
    id: "format-tab-7-1",
    role: "tab",
    "aria-selected": "true",
    "aria-controls": "format-panel-7",
    tabindex: "0",
  });
  const other = tabAria(7, 0, 1);
  assert.equal(other["aria-selected"], "false");
  // Roving: only the open tab is reached by Tab.
  assert.equal(other.tabindex, "-1");
  assert.equal(other["aria-controls"], "format-panel-7");
  // Two strips on one page never share an id.
  assert.notEqual(tabAria(8, 1, 1).id, tabAria(7, 1, 1).id);
});

test("the format panel points back at the open tab", () => {
  assert.deepEqual(panelAria(7, 2), {
    id: "format-panel-7",
    role: "tabpanel",
    "aria-labelledby": "format-tab-7-2",
  });
  assert.equal(panelAria(7, 2).id, tabAria(7, 2, 2)["aria-controls"]);
  assert.equal(panelAria(7, 2)["aria-labelledby"], tabAria(7, 2, 2).id);
});

test("the arrow keys move along the strip and wrap; other keys do not", () => {
  assert.equal(tabTarget("ArrowRight", 0, 3), 1);
  assert.equal(tabTarget("ArrowRight", 2, 3), 0);
  assert.equal(tabTarget("ArrowLeft", 0, 3), 2);
  assert.equal(tabTarget("ArrowLeft", 2, 3), 1);
  assert.equal(tabTarget("Home", 2, 3), 0);
  assert.equal(tabTarget("End", 0, 3), 2);
  // Everything else belongs to the browser.
  for (const key of ["Enter", " ", "ArrowDown", "a", "Tab", undefined]) {
    assert.equal(tabTarget(key, 1, 3), null, String(key));
  }
  // A single tab has nowhere to go but itself; no tabs, nowhere at all.
  assert.equal(tabTarget("ArrowRight", 0, 1), 0);
  assert.equal(tabTarget("ArrowRight", 0, 0), null);
  assert.equal(tabTarget("ArrowRight", 0, -1), null);
  // A selection the document has outgrown still lands somewhere real.
  assert.equal(tabTarget("ArrowRight", 9, 2), 0);
  assert.equal(tabTarget("ArrowLeft", -3, 2), 1);
});

test("the new-item factories match what the schema requires", () => {
  const ds = newDataset();
  assert.deepEqual(Object.keys(ds).sort(),
                   ["event_categories", "formats", "id", "name", "route"]);
  assert.equal(ds.route.guarded, undefined);
  assert.equal(ds.route.direct.length, 1);
  assert.deepEqual(newField(), { vendor: "", ecs: null, status: "unmapped" });
  const format = newFormat("json");
  assert.equal(format.format, "json");
  assert.ok(SCHEMA.vocab.mechanisms.includes(format.parsing.mechanism));
  assert.deepEqual(format.fields, []);
});

// The Example records panel is drawn per dataset, but the store keeps one
// flat list: the index it carries is the one removeExample and the
// validator's ["examples", i, ...] paths both address, so it has to survive
// the filtering.
test("pendingFor keeps each record's index in the flat list", () => {
  const examples = [
    { dataset: "a", label: "", content: "1" },
    { dataset: "b", label: "", content: "2" },
    { dataset: "a", label: "vpn", content: "3" },
  ];
  assert.deepEqual(pendingFor(examples, "a").map((item) => item.index),
                   [0, 2]);
  assert.equal(pendingFor(examples, "a")[1].entry.label, "vpn");
  assert.deepEqual(pendingFor(examples, "c"), []);
  assert.deepEqual(pendingFor(null, "a"), []);
  assert.deepEqual(pendingFor([null, undefined], "a"), []);
});

// A record whose dataset is gone belongs to no dataset panel, so the
// technology form lists it - with a Remove, because the error alone leaves
// the admin unable to reach review and with no button to fix it.
test("orphanExamples finds the records no dataset panel would draw", () => {
  const examples = [
    { dataset: "a", label: "", content: "1" },
    { dataset: "gone", label: "", content: "2" },
    { dataset: "b", label: "vpn", content: "3" },
  ];
  const datasets = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(orphanExamples(examples, datasets).map((i) => i.index),
                   [1]);
  assert.equal(orphanExamples(examples, datasets)[0].entry.dataset, "gone");
  // Nothing to list is the normal case.
  assert.deepEqual(orphanExamples(examples, [{ id: "a" }, { id: "b" },
                                             { id: "gone" }]), []);
  assert.deepEqual(orphanExamples([], datasets), []);
  assert.deepEqual(orphanExamples(null, datasets), []);
  // No datasets at all makes every record an orphan; a broken dataset entry
  // names nothing and shelters nothing.
  assert.deepEqual(orphanExamples(examples, null).map((i) => i.index),
                   [0, 1, 2]);
  assert.deepEqual(orphanExamples(examples, [null]).map((i) => i.index),
                   [0, 1, 2]);
});
