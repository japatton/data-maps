import test from "node:test";
import assert from "node:assert/strict";
import {
  errorFor, filledStrings, toggleSelection, textField, textArea, selectField,
  checkbox, checkboxGroup, listEditor, stringList, ecsPicker,
} from "../lib/forms.js";

// The widgets need a document. This is the whole of what dom.js's h() and
// clear() touch — enough to pin the order of the nodes a widget emits
// without a browser or a dependency.
function fakeDocument() {
  const byId = new Map();
  function element(tag) {
    return {
      nodeType: 1,
      tagName: tag,
      attrs: {},
      childNodes: [],
      className: "",
      dataset: {},
      style: {},
      get firstChild() {
        return this.childNodes.length ? this.childNodes[0] : null;
      },
      appendChild(child) { this.childNodes.push(child); return child; },
      removeChild(child) {
        const at = this.childNodes.indexOf(child);
        if (at !== -1) this.childNodes.splice(at, 1);
        return child;
      },
      setAttribute(name, value) {
        this.attrs[name] = value;
        if (name === "id") byId.set(value, this);
      },
      addEventListener() {},
    };
  }
  return {
    body: element("body"),
    createElement: element,
    createTextNode: (value) => ({ nodeType: 3, textContent: String(value) }),
    getElementById: (id) => (byId.has(id) ? byId.get(id) : null),
  };
}

// The class of every element child, in order, so a widget's shape reads as
// one list.
function shape(node) {
  return node.childNodes
    .filter((child) => child.nodeType === 1)
    .map((child) => child.className || child.tagName);
}

function withDom(fn) {
  const saved = global.document;
  global.document = fakeDocument();
  try {
    return fn(global.document);
  } finally {
    if (saved === undefined) delete global.document;
    else global.document = saved;
  }
}

test("errorFor matches exact path", () => {
  const issues = [{ path: ["datasets", 0, "id"], message: "m1" }, { path: ["name"], message: "m2" }];
  assert.equal(errorFor(issues, ["name"]), "m2");
  assert.equal(errorFor(issues, ["datasets", 0, "id"]), "m1");
  assert.equal(errorFor(issues, ["datasets", 1, "id"]), null);
});

test("errorFor returns the first match and ignores prefixes", () => {
  const issues = [
    { path: ["datasets", 0], message: "whole dataset" },
    { path: ["datasets", 0, "id"], message: "first" },
    { path: ["datasets", 0, "id"], message: "second" },
  ];
  assert.equal(errorFor(issues, ["datasets", 0, "id"]), "first");
  assert.equal(errorFor(issues, ["datasets"]), null);
  assert.equal(errorFor(issues, ["datasets", 0, "id", "extra"]), null);
});

test("errorFor tolerates missing issues and unknown paths", () => {
  assert.equal(errorFor([], ["name"]), null);
  assert.equal(errorFor(null, ["name"]), null);
  assert.equal(errorFor(undefined, ["name"]), null);
  assert.equal(errorFor([{ message: "no path" }], ["name"]), null);
});

test("forms.js imports without a DOM", async () => {
  const forms = await import("../lib/forms.js");
  for (const name of ["textField", "textArea", "selectField", "checkbox",
                      "checkboxGroup", "listEditor", "stringList", "ecsPicker"]) {
    assert.equal(typeof forms[name], "function", name);
  }
});

test("filledStrings drops the rows nobody typed into", () => {
  assert.deepEqual(filledStrings(["https://a", "", "https://b"]),
                   ["https://a", "https://b"]);
  assert.deepEqual(filledStrings(["  ", "\t"]), []);
  assert.deepEqual(filledStrings([null, undefined, 0, "x"]), ["0", "x"]);
  assert.deepEqual(filledStrings([]), []);
  assert.deepEqual(filledStrings(undefined), []);
  // Values are reported as typed; only the blank rows go.
  assert.deepEqual(filledStrings([" https://a "]), [" https://a "]);
});

test("toggleSelection keeps the existing order and appends new ticks", () => {
  assert.deepEqual(toggleSelection(["network", "authentication"], "file", true),
                   ["network", "authentication", "file"]);
  assert.deepEqual(toggleSelection(["network", "authentication"], "network", false),
                   ["authentication"]);
  // Already ticked: the list is left exactly as it was.
  assert.deepEqual(toggleSelection(["network", "file"], "network", true),
                   ["network", "file"]);
  assert.deepEqual(toggleSelection([], "network", true), ["network"]);
  assert.deepEqual(toggleSelection(undefined, "network", false), []);
  // Unticking one that is not there changes nothing.
  assert.deepEqual(toggleSelection(["network"], "file", false), ["network"]);
});

// One tail, one order: what the field is for, then what is wrong with it.
test("every widget ends with its help line before its error line", () => {
  withDom(() => {
    const opts = { label: "L", help: "H", error: "E" };
    assert.deepEqual(shape(textField(opts)), ["field-label", "input", "help", "error"]);
    assert.deepEqual(shape(textArea(opts)), ["field-label", "textarea", "help", "error"]);
    assert.deepEqual(shape(selectField({ ...opts, options: ["a"] })),
                     ["field-label", "select", "help", "error"]);
    assert.deepEqual(shape(checkbox(opts)), ["check-line", "help"]);
    assert.deepEqual(shape(checkboxGroup({ ...opts, options: ["a"] })),
                     ["field-label", "check-grid", "help", "error"]);
    // One row, so the only "help" here is the widget's own help line rather
    // than the "nothing yet" placeholder an empty list draws.
    assert.deepEqual(shape(listEditor({ ...opts, items: ["x"],
                                        render: () => null,
                                        onAdd: () => {} })),
                     ["field-label", "list-item", "help", "error", "btn"]);
    // Empty: the placeholder, then the help line, then the error.
    assert.deepEqual(shape(listEditor({ ...opts, items: [], onAdd: () => {} })),
                     ["field-label", "help", "help", "error", "btn"]);
    assert.deepEqual(shape(stringList({ ...opts, items: ["x"] })),
                     ["field-label", "div", "help", "error", "btn"]);
    assert.deepEqual(shape(ecsPicker({ ...opts, ecs: { "source.ip": {} } })),
                     ["field-label", "mono", "help ecs-hint", "help", "error"]);
    // Nothing to say: no trailing lines at all.
    assert.deepEqual(shape(textField({ label: "L" })), ["field-label", "input"]);
  });
});

// A second dictionary must get its own list rather than silently offering
// the first one's names.
test("each ECS dictionary gets its own datalist", () => {
  withDom((doc) => {
    const one = { "source.ip": {}, "destination.ip": {} };
    const two = { "user.name": {} };
    const first = ecsPicker({ label: "a", ecs: one }).childNodes[1].attrs.list;
    const again = ecsPicker({ label: "b", ecs: one }).childNodes[1].attrs.list;
    const other = ecsPicker({ label: "c", ecs: two }).childNodes[1].attrs.list;
    assert.equal(again, first, "the same dictionary reuses its list");
    assert.notEqual(other, first);
    assert.equal(doc.getElementById(first).childNodes.length, 2);
    assert.equal(doc.getElementById(other).childNodes.length, 1);
    assert.deepEqual(doc.getElementById(other).childNodes.map((o) => o.value),
                     ["user.name"]);
    // Only one list per dictionary, however many pickers were drawn.
    assert.equal(doc.body.childNodes.length, 2);
    // Nothing to offer: no list, and no empty <datalist> left on the page.
    assert.equal(ecsPicker({ label: "d" }).childNodes[1].attrs.list, undefined);
    assert.equal(ecsPicker({ label: "e", ecs: null }).childNodes[1].attrs.list,
                 undefined);
    assert.equal(doc.body.childNodes.length, 2);
  });
});
